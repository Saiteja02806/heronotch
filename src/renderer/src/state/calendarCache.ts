import {
  CALENDAR_CACHE_MAX_DAYS,
  calendarDayCacheKey,
  eventBelongsToDay,
  pruneDayCacheEntries,
  type CachedCalendarDay,
  type CalendarApi,
  type CalendarDeleteResult,
  type CalendarDraft,
  type CalendarEvent,
  type CalendarSaveResult,
  type CalendarStatus,
  type GoogleCalendar
} from '../../../shared/calendar'
import { serializeCalendarDraft } from '../../../shared/calendarDraft'

export type CalendarPhase = 'checking' | 'connecting' | 'ready' | 'error'

export interface PendingSave {
  calendarId: string
  draft: CalendarDraft
  editing: boolean
}

export interface CalendarStoreStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface CalendarStoreState {
  hydrated: boolean
  phase: CalendarPhase
  status: CalendarStatus | null
  statusFetchedAt: number
  calendars: GoogleCalendar[] | null
  calendarsFetchedAt: number
  picked: string | null
  days: Record<string, CachedCalendarDay>
  loadingViews: Record<string, boolean>
  metadataLoading: boolean
  viewErrors: Record<string, string>
  error: string | null
  saving: boolean
  pending: PendingSave | null
}

export interface CalendarStoreOptions {
  api: CalendarApi
  storage?: CalendarStoreStorage
  now?: () => number
  onToast?: (title: string, message?: string, tone?: 'default' | 'success' | 'error') => void
  statusFreshMs?: number
  calendarsFreshMs?: number
  eventsFreshMs?: number
  maxDays?: number
}

export const DEFAULT_STATUS_FRESH_MS = 10 * 60 * 1000
export const DEFAULT_CALENDARS_FRESH_MS = 15 * 60 * 1000
export const DEFAULT_EVENTS_FRESH_MS = 90 * 1000

const NOOP_STORAGE: CalendarStoreStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined
}

function defaultStorage(): CalendarStoreStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    // Renderer storage can be unavailable in isolated test contexts.
  }
  return NOOP_STORAGE
}

function readPending(storage: CalendarStoreStorage, userId: string): PendingSave | null {
  try {
    return JSON.parse(storage.getItem(`notch:calendar:pending:${userId}`) || 'null')
  } catch {
    return null
  }
}

function readSelection(storage: CalendarStoreStorage, userId: string): string | null {
  try {
    return storage.getItem(`notch:calendar:selected:${userId}`)
  } catch {
    return null
  }
}

function pickCalendarId(
  calendars: GoogleCalendar[],
  currentPicked: string | null,
  remembered: string | null,
  snapshotPicked: string | null
): string | null {
  if (currentPicked && calendars.some((entry) => entry.id === currentPicked)) return currentPicked
  if (remembered && calendars.some((entry) => entry.id === remembered)) return remembered
  if (snapshotPicked && calendars.some((entry) => entry.id === snapshotPicked)) return snapshotPicked
  const writable = calendars.filter((entry) => entry.writable)
  return calendars.find((entry) => entry.primary)?.id ?? writable[0]?.id ?? calendars[0]?.id ?? null
}

function parseKey(viewKey: string): { calendarId: string; date: string; timeZone: string } | null {
  const parts = viewKey.split('\n')
  if (parts.length !== 3) return null
  return { calendarId: parts[0], date: parts[1], timeZone: parts[2] }
}

function upsertEvent(list: CalendarEvent[], event: CalendarEvent): CalendarEvent[] {
  const next = list.filter((entry) => entry.id !== event.id)
  next.push(event)
  return next.sort((a, b) => a.start.localeCompare(b.start))
}

/**
 * App-wide Stale-While-Revalidate (SWR) store for Google Calendar state and
 * day views. Preserves loaded calendars and events across page navigation,
 * skips redundant round-trips inside freshness windows, deduplicates in-flight
 * refreshes, and keeps cached events visible while background checks run.
 */
export function createCalendarStore(options: CalendarStoreOptions) {
  const api = options.api
  const storage = options.storage ?? defaultStorage()
  const now = options.now ?? (() => Date.now())
  const statusFreshMs = options.statusFreshMs ?? DEFAULT_STATUS_FRESH_MS
  const calendarsFreshMs = options.calendarsFreshMs ?? DEFAULT_CALENDARS_FRESH_MS
  const eventsFreshMs = options.eventsFreshMs ?? DEFAULT_EVENTS_FRESH_MS
  const maxDays = options.maxDays ?? CALENDAR_CACHE_MAX_DAYS

  let epoch = 0
  let activeViewKey: string | null = null
  let hydratePromise: Promise<void> | null = null
  let statusInflight: Promise<CalendarStatus | null> | null = null
  let calendarsInflight: Promise<GoogleCalendar[] | null> | null = null
  const eventInflight = new Map<string, Promise<void>>()

  let state: CalendarStoreState = {
    hydrated: false,
    phase: 'checking',
    status: null,
    statusFetchedAt: 0,
    calendars: null,
    calendarsFetchedAt: 0,
    picked: null,
    days: {},
    loadingViews: {},
    metadataLoading: false,
    viewErrors: {},
    error: null,
    saving: false,
    pending: null
  }

  const listeners = new Set<() => void>()

  function emit(next: CalendarStoreState): void {
    state = next
    for (const listener of listeners) listener()
  }

  function patch(partial: Partial<CalendarStoreState>): void {
    emit({ ...state, ...partial })
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function getState(): CalendarStoreState {
    return state
  }

  function setLoadingView(viewKey: string, loading: boolean): void {
    const currentlyLoading = Boolean(state.loadingViews[viewKey])
    if (currentlyLoading === loading) return
    const nextLoading = { ...state.loadingViews }
    if (loading) nextLoading[viewKey] = true
    else delete nextLoading[viewKey]
    patch({ loadingViews: nextLoading })
  }

  function resetDisconnected(error: string | null): void {
    epoch += 1
    statusInflight = null
    calendarsInflight = null
    eventInflight.clear()
    patch({
      hydrated: true,
      phase: 'error',
      status: state.status?.userId ? { ...state.status, connected: false } : null,
      statusFetchedAt: now(),
      calendars: null,
      calendarsFetchedAt: 0,
      picked: null,
      days: {},
      loadingViews: {},
      metadataLoading: false,
      viewErrors: {},
      error,
      pending: null
    })
  }

  async function hydrate(): Promise<void> {
    if (state.hydrated) return
    if (hydratePromise) return hydratePromise
    const startEpoch = epoch
    hydratePromise = (async () => {
      try {
        const snap = typeof api.snapshot === 'function' ? await api.snapshot() : null
        if (startEpoch !== epoch) return
        if (!snap || !snap.userId || !snap.status?.connected || !snap.status?.signedIn) {
          patch({ hydrated: true })
          return
        }
        const calendars = snap.calendars
        const picked = calendars
          ? pickCalendarId(calendars, state.picked, readSelection(storage, snap.userId), snap.picked)
          : snap.picked
        patch({
          hydrated: true,
          phase: 'ready',
          status: snap.status,
          statusFetchedAt: snap.statusFetchedAt,
          calendars,
          calendarsFetchedAt: snap.calendarsFetchedAt,
          picked,
          days: pruneDayCacheEntries(snap.days || {}, maxDays),
          pending: readPending(storage, snap.userId),
          error: null
        })
      } catch {
        if (startEpoch === epoch) patch({ hydrated: true })
      }
    })().finally(() => {
      hydratePromise = null
    })
    return hydratePromise
  }

  async function refreshCalendars(userId: string, force = false): Promise<GoogleCalendar[] | null> {
    if (!force && state.calendars && now() - state.calendarsFetchedAt < calendarsFreshMs) {
      return state.calendars
    }
    if (calendarsInflight) return calendarsInflight
    const startEpoch = epoch
    calendarsInflight = (async () => {
      patch({ metadataLoading: true })
      try {
        const list = await api.calendars()
        if (startEpoch !== epoch) return null
        const remembered = readSelection(storage, userId)
        const nextPicked = pickCalendarId(list, state.picked, remembered, null)
        patch({
          calendars: list,
          calendarsFetchedAt: now(),
          picked: nextPicked,
          pending: readPending(storage, userId),
          metadataLoading: false,
          error: null
        })
        return list
      } catch (cause) {
        if (startEpoch !== epoch) return null
        const message = cause instanceof Error ? cause.message : String(cause)
        if (/needs to be reconnected|session has expired|Connect Google Calendar first|sign-in failed/i.test(message)) {
          resetDisconnected(message)
          return null
        }
        patch({
          metadataLoading: false,
          phase: state.calendars ? state.phase : 'error',
          error: state.calendars ? `Showing cached calendars — ${message}` : message
        })
        return null
      } finally {
        calendarsInflight = null
      }
    })()
    return calendarsInflight
  }

  async function refreshStatus(force = false): Promise<CalendarStatus | null> {
    if (!force && state.statusFetchedAt > 0 && now() - state.statusFetchedAt < statusFreshMs) {
      return state.status
    }
    if (statusInflight) return statusInflight
    const startEpoch = epoch
    statusInflight = (async () => {
      const hadCache = state.phase === 'ready' && Boolean(state.status?.connected)
      patch({ metadataLoading: true })
      try {
        const next = await api.status()
        if (startEpoch !== epoch) return null
        if (next.signedIn && next.connected && next.userId) {
          const sameUser = state.status?.userId === next.userId
          patch({
            phase: 'ready',
            status: next,
            statusFetchedAt: now(),
            pending: readPending(storage, next.userId),
            days: sameUser ? state.days : {},
            calendars: sameUser ? state.calendars : null,
            calendarsFetchedAt: sameUser ? state.calendarsFetchedAt : 0,
            picked: sameUser ? state.picked : null,
            metadataLoading: false,
            error: null
          })
          return next
        }
        resetDisconnected(null)
        return next
      } catch (cause) {
        if (startEpoch !== epoch) return null
        const message = cause instanceof Error ? cause.message : String(cause)
        if (/needs to be reconnected|session has expired|Connect Google Calendar first|sign-in failed/i.test(message)) {
          resetDisconnected(message)
          return null
        }
        if (hadCache) {
          patch({
            metadataLoading: false,
            error: `Showing cached calendar — ${message}`
          })
        } else {
          patch({
            status: null,
            statusFetchedAt: now(),
            phase: 'error',
            metadataLoading: false,
            error: message
          })
        }
        return null
      } finally {
        statusInflight = null
      }
    })()
    return statusInflight
  }

  async function refreshDay(
    calendarId: string,
    date: string,
    timeZone: string | undefined,
    force = false
  ): Promise<void> {
    const viewKey = calendarDayCacheKey(calendarId, date, timeZone)
    const cached = state.days[viewKey]
    if (!force && cached && now() - cached.fetchedAt < eventsFreshMs) {
      if (state.viewErrors[viewKey]) {
        const nextErrors = { ...state.viewErrors }
        delete nextErrors[viewKey]
        patch({ viewErrors: nextErrors })
      }
      return
    }
    const existing = eventInflight.get(viewKey)
    if (existing) return existing

    const startEpoch = epoch
    setLoadingView(viewKey, true)
    const work = (async () => {
      try {
        const data = await api.events(calendarId, date, timeZone)
        if (startEpoch !== epoch) return
        const nextDays = pruneDayCacheEntries(
          {
            ...state.days,
            [viewKey]: {
              events: data.events,
              truncated: data.truncated,
              fetchedAt: now()
            }
          },
          maxDays
        )
        const nextErrors = { ...state.viewErrors }
        delete nextErrors[viewKey]
        patch({
          days: nextDays,
          viewErrors: nextErrors,
          error: state.error?.startsWith('Showing cached') ? null : state.error
        })
      } catch (cause) {
        if (startEpoch !== epoch) return
        const message = cause instanceof Error ? cause.message : String(cause)
        if (/needs to be reconnected|session has expired|Connect Google Calendar first|sign-in failed/i.test(message)) {
          resetDisconnected(message)
          return
        }
        const hasCachedEvents = Boolean(state.days[viewKey])
        patch({
          viewErrors: {
            ...state.viewErrors,
            [viewKey]: hasCachedEvents ? `Showing saved events — ${message}` : message
          }
        })
      } finally {
        eventInflight.delete(viewKey)
        if (startEpoch === epoch) setLoadingView(viewKey, false)
      }
    })()
    eventInflight.set(viewKey, work)
    return work
  }

  async function ensureView(date: string, timeZone?: string, force = false): Promise<void> {
    await hydrate()
    const currentNow = now()

    if (state.phase === 'ready' && state.status?.userId && state.picked) {
      activeViewKey = calendarDayCacheKey(state.picked, date, timeZone)
      const userId = state.status.userId
      const tasks: Promise<unknown>[] = []
      if (force || !state.statusFetchedAt || currentNow - state.statusFetchedAt >= statusFreshMs) {
        tasks.push(refreshStatus(force))
      }
      if (force || !state.calendars || currentNow - state.calendarsFetchedAt >= calendarsFreshMs) {
        tasks.push(refreshCalendars(userId, force))
      }
      tasks.push(refreshDay(state.picked, date, timeZone, force))
      await Promise.all(tasks)
      return
    }

    const nextStatus = await refreshStatus(force)
    if (!nextStatus?.signedIn || !nextStatus?.connected || !nextStatus?.userId) return
    await refreshCalendars(nextStatus.userId, force)
    if (state.picked) {
      activeViewKey = calendarDayCacheKey(state.picked, date, timeZone)
      await refreshDay(state.picked, date, timeZone, force)
    }
  }

  function setPicked(id: string | null): void {
    patch({ picked: id, error: null })
    const userId = state.status?.userId
    if (!userId || !id) return
    try {
      storage.setItem(`notch:calendar:selected:${userId}`, id)
    } catch {
      // Losing selection persistence only falls back to primary calendar.
    }
  }

  async function connect(): Promise<void> {
    epoch += 1
    statusInflight = null
    calendarsInflight = null
    eventInflight.clear()
    patch({ phase: 'connecting', error: null })
    const startEpoch = epoch
    try {
      const next = await api.connect()
      if (startEpoch !== epoch) return
      const sameUser = state.status?.userId === next.userId
      patch({
        hydrated: true,
        status: next,
        statusFetchedAt: now(),
        calendars: sameUser ? state.calendars : null,
        calendarsFetchedAt: 0,
        picked: sameUser ? state.picked : null,
        days: sameUser ? state.days : {},
        viewErrors: {},
        phase: next.connected ? 'ready' : 'error',
        pending: next.userId ? readPending(storage, next.userId) : null
      })
      if (next.connected && next.userId) {
        await refreshCalendars(next.userId, true)
      }
    } catch (cause) {
      if (startEpoch !== epoch) return
      const message = cause instanceof Error ? cause.message : String(cause)
      patch({ phase: 'error', error: message })
      options.onToast?.('Google Calendar', message, 'error')
    }
  }

  async function disconnect(): Promise<void> {
    epoch += 1
    statusInflight = null
    calendarsInflight = null
    eventInflight.clear()
    patch({ phase: 'checking', loadingViews: {} })
    const startEpoch = epoch
    try {
      await api.disconnect()
      if (startEpoch !== epoch) return
      patch({
        hydrated: true,
        phase: 'error',
        status: null,
        statusFetchedAt: 0,
        calendars: null,
        calendarsFetchedAt: 0,
        picked: null,
        days: {},
        loadingViews: {},
        metadataLoading: false,
        viewErrors: {},
        pending: null,
        error: null
      })
    } catch (cause) {
      if (startEpoch !== epoch) return
      patch({ phase: 'error', error: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  function applySavedEventToCache(calendarId: string, savedEvent: CalendarEvent): void {
    const prefix = `${calendarId}\n`
    const nextDays: Record<string, CachedCalendarDay> = {}
    for (const [key, entry] of Object.entries(state.days)) {
      if (!key.startsWith(prefix)) {
        nextDays[key] = entry
        continue
      }
      if (key !== activeViewKey) {
        // Drop sibling day/timezone entries so cross-day moves re-fetch on visit.
        continue
      }
      const parsed = parseKey(key)
      const nextEvents =
        parsed && eventBelongsToDay(savedEvent, parsed.date, parsed.timeZone)
          ? upsertEvent(entry.events, savedEvent)
          : entry.events.filter((item) => item.id !== savedEvent.id)
      nextDays[key] = { ...entry, events: nextEvents, fetchedAt: 0 }
    }
    patch({ days: nextDays })
  }

  function applyDeletedEventToCache(calendarId: string, eventId: string): void {
    const prefix = `${calendarId}\n`
    const nextDays: Record<string, CachedCalendarDay> = {}
    for (const [key, entry] of Object.entries(state.days)) {
      if (!key.startsWith(prefix)) {
        nextDays[key] = entry
        continue
      }
      if (key !== activeViewKey) continue
      nextDays[key] = {
        ...entry,
        events: entry.events.filter((item) => item.id !== eventId),
        fetchedAt: 0
      }
    }
    patch({ days: nextDays })
  }

  async function runSave(
    calendarId: string,
    draft: CalendarDraft,
    editing: boolean
  ): Promise<CalendarSaveResult> {
    const userId = state.status?.userId
    const key = userId ? `notch:calendar:pending:${userId}` : ''
    const operation: PendingSave = { calendarId, draft, editing }
    patch({ saving: true })
    try {
      if (key) {
        try {
          storage.setItem(key, JSON.stringify(operation))
        } catch {
          // Non-fatal if storage quota is unavailable.
        }
        patch({ pending: operation })
      }
      const result = await api.save(calendarId, draft, editing)
      if (result.ok || !result.uncertain) {
        if (key) {
          try {
            storage.removeItem(key)
          } catch {
            // Ignore cleanup failure.
          }
        }
        patch({ pending: null })
      }
      if (result.ok) {
        applySavedEventToCache(calendarId, result.event)
        const active = activeViewKey ? parseKey(activeViewKey) : null
        if (active && active.calendarId === calendarId) {
          void refreshDay(active.calendarId, active.date, active.timeZone, true)
        }
      }
      return result
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
        uncertain: true
      }
    } finally {
      patch({ saving: false })
    }
  }

  async function saveDraft(draft: CalendarDraft, editing: boolean): Promise<CalendarSaveResult> {
    if (!state.picked) return { ok: false, error: 'Choose a Google calendar first.', uncertain: false }
    if (state.saving) return { ok: false, error: 'A calendar save is already running.', uncertain: true }
    let payload: CalendarDraft
    try {
      payload = serializeCalendarDraft(draft, null)
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause), uncertain: false }
    }
    return runSave(state.picked, payload, editing)
  }

  async function saveEvent(event: CalendarEvent, draft: CalendarDraft): Promise<CalendarSaveResult> {
    if (!state.picked) return { ok: false, error: 'Choose a Google calendar first.', uncertain: false }
    if (state.saving) return { ok: false, error: 'A calendar save is already running.', uncertain: true }
    let payload: CalendarDraft
    try {
      payload = serializeCalendarDraft(draft, event)
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause), uncertain: false }
    }
    return runSave(state.picked, payload, true)
  }

  async function removeEvent(eventId: string): Promise<CalendarDeleteResult> {
    if (!state.picked) return { ok: false, error: 'Choose a Google calendar first.' }
    const targetCalendarId = state.picked
    try {
      const result = await api.remove(targetCalendarId, eventId)
      if (result.ok) {
        applyDeletedEventToCache(targetCalendarId, eventId)
        const active = activeViewKey ? parseKey(activeViewKey) : null
        if (active && active.calendarId === targetCalendarId) {
          void refreshDay(active.calendarId, active.date, active.timeZone, true)
        }
      }
      return result
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  async function retryPending(): Promise<void> {
    if (!state.pending) return
    const result = await runSave(state.pending.calendarId, state.pending.draft, state.pending.editing)
    if (result.ok) options.onToast?.('Event saved', 'Google confirmed the pending change.', 'success')
    else options.onToast?.('Still not confirmed', result.error, 'error')
  }

  function clearPending(activeDate?: string, activeTimeZone?: string): void {
    const userId = state.status?.userId
    if (!userId) return
    try {
      storage.removeItem(`notch:calendar:pending:${userId}`)
    } catch {
      // Ignore cleanup failure.
    }
    patch({ pending: null })
    if (activeDate) void ensureView(activeDate, activeTimeZone, true)
  }

  return {
    subscribe,
    getState,
    hydrate,
    ensureView,
    setPicked,
    connect,
    disconnect,
    saveDraft,
    saveEvent,
    removeEvent,
    retryPending,
    clearPending
  }
}
