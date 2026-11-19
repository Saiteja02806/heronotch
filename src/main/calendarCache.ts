import { mkdirSync, promises as fs, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  CALENDAR_CACHE_MAX_DAYS,
  calendarDayCacheKey,
  pruneDayCacheEntries,
  type CachedCalendarDay,
  type CalendarSnapshot,
  type CalendarStatus,
  type GoogleCalendar
} from '../shared/calendar'

export interface CalendarCipher {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(bytes: Buffer): string
}

export interface CalendarDiskCacheOptions {
  filePath: () => string | null
  cipher: CalendarCipher
  maxDays?: number
  debounceMs?: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseSnapshot(raw: string): CalendarSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isPlainObject(parsed)) return null
    if (parsed.version !== 1 || typeof parsed.userId !== 'string' || !parsed.userId) return null
    if (!isPlainObject(parsed.status) || !isPlainObject(parsed.days)) return null
    if (parsed.calendars !== null && !Array.isArray(parsed.calendars)) return null
    const cleanDays: Record<string, CachedCalendarDay> = {}
    for (const [key, entry] of Object.entries(parsed.days)) {
      if (!isPlainObject(entry) || !Array.isArray(entry.events) || !Number.isFinite(entry.fetchedAt)) {
        continue
      }
      cleanDays[key] = {
        events: entry.events as CalendarSnapshot['days'][string]['events'],
        truncated: entry.truncated === true,
        fetchedAt: Number(entry.fetchedAt)
      }
    }
    return {
      version: 1,
      userId: parsed.userId,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      status: parsed.status as unknown as CalendarStatus,
      statusFetchedAt: Number.isFinite(parsed.statusFetchedAt) ? Number(parsed.statusFetchedAt) : 0,
      calendars: (parsed.calendars as GoogleCalendar[] | null) ?? null,
      calendarsFetchedAt: Number.isFinite(parsed.calendarsFetchedAt) ? Number(parsed.calendarsFetchedAt) : 0,
      picked: typeof parsed.picked === 'string' ? parsed.picked : null,
      days: cleanDays
    }
  } catch {
    return null
  }
}

/**
 * Bounded, fail-open encrypted snapshot cache for Google Calendar metadata and
 * recently viewed day agendas. Corrupted or unreadable cache files are quietly
 * discarded so Calendar access never fails because of stale local storage.
 */
export function createCalendarDiskCache(options: CalendarDiskCacheOptions) {
  const maxDays = options.maxDays ?? CALENDAR_CACHE_MAX_DAYS
  const debounceMs = options.debounceMs ?? 200

  let snapshot: CalendarSnapshot | null = null
  let loadedForPath: string | null | undefined = undefined
  let dirty = false
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let writeRevision = 0
  let writeChain: Promise<void> = Promise.resolve()

  function emptySnapshot(userId: string, email: string | null): CalendarSnapshot {
    return {
      version: 1,
      userId,
      email,
      status: {
        configured: true,
        signedIn: true,
        connected: true,
        userId,
        email
      },
      statusFetchedAt: 0,
      calendars: null,
      calendarsFetchedAt: 0,
      picked: null,
      days: {}
    }
  }

  function ensureSnapshot(userId: string, email: string | null): CalendarSnapshot {
    if (snapshot && snapshot.userId === userId) {
      if (email && !snapshot.email) {
        snapshot.email = email
        snapshot.status = { ...snapshot.status, email }
      }
      return snapshot
    }
    if (snapshot && snapshot.userId !== userId) {
      snapshot = null
      loadedForPath = undefined
    }
    snapshot = emptySnapshot(userId, email)
    loadedForPath = options.filePath()
    return snapshot
  }

  async function removeFile(target: string | null): Promise<void> {
    if (!target) return
    await fs.unlink(target).catch(() => undefined)
    await fs.unlink(`${target}.tmp`).catch(() => undefined)
  }

  function cancelTimer(): void {
    if (!saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = null
  }

  function persistAsync(): Promise<void> {
    const rev = ++writeRevision
    const target = options.filePath()
    const payloadSnapshot = snapshot ? JSON.stringify(snapshot) : null
    if (!target || !payloadSnapshot || !dirty || !options.cipher.available()) {
      return writeChain
    }
    writeChain = writeChain.catch(() => undefined).then(async () => {
      if (rev !== writeRevision || !options.cipher.available()) return
      try {
        const encrypted = options.cipher.encrypt(payloadSnapshot)
        await fs.mkdir(path.dirname(target), { recursive: true })
        const tmp = `${target}.tmp`
        await fs.writeFile(tmp, encrypted, { mode: 0o600 })
        if (rev !== writeRevision) {
          await fs.unlink(tmp).catch(() => undefined)
          return
        }
        await fs.rename(tmp, target).catch(async () => {
          await fs.writeFile(target, encrypted, { mode: 0o600 })
          await fs.unlink(tmp).catch(() => undefined)
        })
        if (rev === writeRevision) dirty = false
      } catch {
        await fs.unlink(`${target}.tmp`).catch(() => undefined)
      }
    })
    return writeChain
  }

  function scheduleSave(): void {
    dirty = true
    const target = options.filePath()
    if (!target || !options.cipher.available()) return
    cancelTimer()
    saveTimer = setTimeout(() => {
      saveTimer = null
      void persistAsync()
    }, debounceMs)
  }

  async function readSnapshot(expectedUserId: string, email: string | null): Promise<CalendarSnapshot | null> {
    const target = options.filePath()
    if (snapshot && snapshot.userId === expectedUserId) {
      return snapshot
    }
    if (snapshot && snapshot.userId !== expectedUserId) {
      await clear()
      return null
    }
    if (!target || !options.cipher.available()) return null
    if (loadedForPath === target) return snapshot

    loadedForPath = target
    try {
      const bytes = await fs.readFile(target)
      const parsed = parseSnapshot(options.cipher.decrypt(bytes))
      if (!parsed || parsed.userId !== expectedUserId) {
        await removeFile(target)
        snapshot = null
        return null
      }
      parsed.days = pruneDayCacheEntries(parsed.days, maxDays)
      if (email && !parsed.email) {
        parsed.email = email
        parsed.status = { ...parsed.status, email }
      }
      snapshot = parsed
      dirty = false
      return snapshot
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await removeFile(target)
      }
      snapshot = null
      return null
    }
  }

  function recordStatus(status: CalendarStatus, now = Date.now()): void {
    if (!status.signedIn || !status.connected || !status.userId) {
      void clear()
      return
    }
    const current = ensureSnapshot(status.userId, status.email)
    current.status = status
    current.email = status.email
    current.statusFetchedAt = now
    scheduleSave()
  }

  function recordCalendars(
    userId: string,
    email: string | null,
    calendars: GoogleCalendar[],
    now = Date.now()
  ): void {
    const current = ensureSnapshot(userId, email)
    current.calendars = calendars
    current.calendarsFetchedAt = now
    if (current.picked && !calendars.some((entry) => entry.id === current.picked)) {
      current.picked = null
    }
    if (!current.picked) {
      const writable = calendars.filter((entry) => entry.writable)
      current.picked =
        calendars.find((entry) => entry.primary)?.id ?? writable[0]?.id ?? calendars[0]?.id ?? null
    }
    scheduleSave()
  }

  function recordDayEvents(
    userId: string,
    email: string | null,
    calendarId: string,
    date: string,
    timeZone: string | undefined,
    entry: CachedCalendarDay
  ): void {
    const current = ensureSnapshot(userId, email)
    current.picked = calendarId
    const key = calendarDayCacheKey(calendarId, date, timeZone)
    current.days = pruneDayCacheEntries({ ...current.days, [key]: entry }, maxDays)
    scheduleSave()
  }

  function invalidateCalendar(calendarId: string): void {
    if (!snapshot) return
    const prefix = `${calendarId}\n`
    let changed = false
    const nextDays: Record<string, CachedCalendarDay> = {}
    for (const [key, value] of Object.entries(snapshot.days)) {
      if (key.startsWith(prefix)) changed = true
      else nextDays[key] = value
    }
    if (!changed) return
    snapshot.days = nextDays
    scheduleSave()
  }

  async function clear(): Promise<void> {
    cancelTimer()
    writeRevision += 1
    snapshot = null
    loadedForPath = undefined
    dirty = false
    const target = options.filePath()
    await writeChain.catch(() => undefined)
    await removeFile(target)
  }

  function flushSync(): void {
    cancelTimer()
    const target = options.filePath()
    if (!target || !snapshot || !dirty || !options.cipher.available()) return
    writeRevision += 1
    const tmp = `${target}.tmp`
    try {
      const encrypted = options.cipher.encrypt(JSON.stringify(snapshot))
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(tmp, encrypted, { mode: 0o600 })
      try {
        renameSync(tmp, target)
      } catch {
        writeFileSync(target, encrypted, { mode: 0o600 })
        unlinkSync(tmp)
      }
      dirty = false
    } catch {
      try {
        unlinkSync(tmp)
      } catch {
        // Never block app quit because of cache flush failure.
      }
    }
  }

  return {
    readSnapshot,
    recordStatus,
    recordCalendars,
    recordDayEvents,
    invalidateCalendar,
    clear,
    flushSync
  }
}
