import { app, safeStorage, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { eventBelongsToDay } from '../shared/calendar'
import type { CalendarDraft, CalendarEvent, CalendarSnapshot, CalendarStatus, CalendarSaveResult, GoogleCalendar } from '../shared/calendar'
import { canonicalTimeZone, dayBoundsInTimeZone, resolveSystemTimeZone } from '../shared/timeZone'
import { createCalendarDiskCache } from './calendarCache'

const BASE = 'https://gswnffijfmhinavyxitz.supabase.co'
// Dev preview: NOTCH_CALENDAR_STUB=1 runs this UI against fixtures so the
// agenda can be built and checked before the backend is deployed.
const STUB = !app.isPackaged && process.env.NOTCH_CALENDAR_STUB === '1'
// Public client key. No management token, service-role key or Google secret belongs here.
const PUBLIC_KEY = 'sb_publishable_fB-rNuZeIxz_bsQQNy_v4A_zby4Dz51'
const REDIRECT = 'http://127.0.0.1:43822/calendar/callback'
const SCOPES = 'openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly'
interface Session { accessToken: string; refreshToken: string; expiresAt: number; userId: string; email: string }
let current: Session | null | undefined
let refreshing: Promise<Session> | null = null
let connecting: Promise<CalendarStatus> | null = null
let cancelLogin: (() => void) | null = null
let generation = 0
class CalendarRequestError extends Error {
  constructor(message: string, public status: number) { super(message) }
}
const sessionPath = () => path.join(app.getPath('userData'), 'calendar-session.enc')
const cachePath = (): string | null => {
  if (!app.isPackaged && process.env.NOTCH_CALENDAR_CACHE_PATH) return process.env.NOTCH_CALENDAR_CACHE_PATH
  if (STUB) return null
  return path.join(app.getPath('userData'), 'calendar-cache.enc')
}
const diskCache = createCalendarDiskCache({
  filePath: cachePath,
  cipher: {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (bytes) => safeStorage.decryptString(bytes)
  }
})
export function flushCalendarCache(): void {
  diskCache.flushSync()
}

async function request(url: string, init: RequestInit = {}) {
  let response: Response
  try { response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(25000) }) }
  catch { throw new Error('Calendar could not be reached. Check your connection and try again.') }
  let data: any
  try { data = await response.json() } catch { throw new Error('Calendar returned an unreadable response. Try again.') }
  if (!response.ok) {
    if (response.status === 404 && data.code === 'NOT_FOUND') throw new CalendarRequestError('The Notch Calendar backend is not available yet.', 404)
    const message = url.includes('/functions/v1/notch-calendar') && typeof data.error === 'string'
      ? data.error.slice(0, 240) : 'Notch Calendar sign-in failed. Please reconnect Google Calendar.'
    throw new CalendarRequestError(message, response.status)
  }
  return data
}
async function loadSession(): Promise<Session | null> {
  if (current !== undefined) return current
  try {
    const bytes = await fs.readFile(sessionPath())
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable.')
    const value = JSON.parse(safeStorage.decryptString(bytes)) as Session
    if (!value.accessToken || !value.refreshToken || !value.userId || !Number.isFinite(value.expiresAt)) throw new Error('Invalid saved sign-in.')
    current = value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved Calendar sign-in cannot be read. Reconnect to restore access.')
    current = null
  }
  return current
}
async function saveSession(value: Session) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable. Calendar sign-in was not saved.')
  const target = sessionPath()
  await fs.mkdir(path.dirname(target), { recursive: true })
  const encrypted = safeStorage.encryptString(JSON.stringify(value))
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, encrypted, { mode: 0o600 })
  await fs.rename(tmp, target).catch(async () => {
    await fs.writeFile(target, encrypted, { mode: 0o600 })
    await fs.unlink(tmp).catch(() => undefined)
  })
  current = value
}
function sessionFrom(data: any): Session {
  if (!data.access_token || !data.refresh_token || !data.user?.id || !Number.isFinite(data.expires_in)) throw new Error('Notch Calendar returned an incomplete sign-in.')
  return { accessToken: data.access_token, refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000, userId: data.user.id, email: data.user.email || '' }
}
async function session(): Promise<Session> {
  const saved = await loadSession()
  if (!saved) throw new Error('Connect Google Calendar first.')
  if (saved.expiresAt > Date.now() + 60000) return saved
  if (!refreshing) {
    const version = generation
    refreshing = (async () => {
      const data = await request(`${BASE}/auth/v1/token?grant_type=refresh_token`, { method: 'POST',
        headers: { apikey: PUBLIC_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: saved.refreshToken }) })
      const next = sessionFrom(data)
      if (version !== generation || next.userId !== saved.userId) throw new Error('Calendar account changed. Connect again.')
      await saveSession(next)
      return next
    })().finally(() => { refreshing = null })
  }
  return refreshing
}
async function backend(body: unknown, signedIn?: Session) {
  const auth = signedIn || await session()
  return request(`${BASE}/functions/v1/notch-calendar`, { method: 'POST',
    headers: { apikey: PUBLIC_KEY, Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body) })
}
export async function calendarSnapshot(): Promise<CalendarSnapshot | null> {
  if (STUB) {
    return diskCache.readSnapshot('stub', 'preview@example.com')
  }
  try {
    const saved = await loadSession()
    if (!saved) {
      await diskCache.clear()
      return null
    }
    return diskCache.readSnapshot(saved.userId, saved.email)
  } catch {
    return null
  }
}
export async function calendarStatus(): Promise<CalendarStatus> {
  if (STUB) {
    const stubStatus: CalendarStatus = { configured: true, signedIn: true, connected: true, userId: 'stub', email: 'preview@example.com' }
    diskCache.recordStatus(stubStatus)
    return stubStatus
  }
  const saved = await loadSession()
  if (!saved) {
    await diskCache.clear()
    return { configured: true, signedIn: false, connected: false, userId: null, email: null }
  }
  try {
    const signedIn = await session()
    const data = await backend({ action: 'status' }, signedIn)
    const nextStatus: CalendarStatus = { configured: true, signedIn: true, connected: data.connected === true, userId: signedIn.userId, email: signedIn.email }
    if (!nextStatus.connected) await diskCache.clear()
    else diskCache.recordStatus(nextStatus)
    return nextStatus
  } catch (error) {
    if (error instanceof CalendarRequestError && (error.status === 400 || error.status === 401 || error.status === 403)) {
      current = null
      await diskCache.clear()
      await fs.unlink(sessionPath()).catch(() => undefined)
      return { configured: true, signedIn: false, connected: false, userId: null, email: null }
    }
    throw error
  }
}
export function cancelCalendarConnect(): void { cancelLogin?.() }
export function connectCalendar(): Promise<CalendarStatus> {
  if (connecting) return connecting
  connecting = beginConnect().finally(() => { connecting = null })
  return connecting
}
async function beginConnect(): Promise<CalendarStatus> {
  if (STUB) return calendarStatus()
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable.')
  const version = ++generation
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const authorize = new URL(`${BASE}/auth/v1/authorize`)
  for (const [key, value] of Object.entries({ provider: 'google', redirect_to: REDIRECT,
    code_challenge: challenge, code_challenge_method: 's256', scopes: SCOPES, access_type: 'offline', prompt: 'consent' })) authorize.searchParams.set(key, value)
  return new Promise<CalendarStatus>((resolve, reject) => {
    let settled = false
    let processing = false
    const finish = (error?: Error, result?: CalendarStatus) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      cancelLogin = null
      server.close()
      server.closeAllConnections?.()
      if (error) reject(error); else resolve(result!)
    }
    const server = createServer(async (req, res) => {
      let url: URL
      try {
        url = new URL(req.url || '/', REDIRECT)
      } catch {
        res.writeHead(400).end('Bad request')
        return
      }
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      if (req.method !== 'GET' || req.headers.host !== '127.0.0.1:43822' || url.pathname !== '/calendar/callback') {
        res.writeHead(404).end('Not found'); return
      }
      if (settled || processing) { res.writeHead(409).end('Sign-in is already being handled.'); return }
      if (url.searchParams.has('error')) { res.end('Google sign-in was not completed. Return to Notch.'); finish(new Error('Google sign-in was cancelled or denied.')); return }
      const code = url.searchParams.get('code')
      if (!code || code.length > 4096) { res.writeHead(400).end('Missing sign-in code.'); return }
      processing = true
      try {
        const data = await request(`${BASE}/auth/v1/token?grant_type=pkce`, { method: 'POST',
          headers: { apikey: PUBLIC_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ auth_code: code, code_verifier: verifier }) })
        const next = sessionFrom(data)
        if (settled || version !== generation) throw new Error('Sign-in was cancelled.')
        if (!data.provider_token || !data.provider_refresh_token) throw new Error('Google did not return Calendar offline access. Reconnect and approve the requested permissions.')
        await backend({ action: 'connect', accessToken: data.provider_token, refreshToken: data.provider_refresh_token }, next)
        if (settled || version !== generation) throw new Error('Sign-in was cancelled.')
        await saveSession(next)
        const nextStatus: CalendarStatus = { configured: true, signedIn: true, connected: true, userId: next.userId, email: next.email }
        diskCache.recordStatus(nextStatus)
        res.end('Google Calendar is connected. You can close this tab and return to Notch.')
        finish(undefined, nextStatus)
      } catch (error) {
        res.writeHead(400).end('Calendar could not be connected. Return to Notch for details.')
        finish(error instanceof Error ? error : new Error('Calendar sign-in failed.'))
      }
    })
    const timeout = setTimeout(() => finish(new Error('Calendar sign-in timed out. Try again.')), 180000)
    cancelLogin = () => { generation++; finish(new Error('Calendar sign-in cancelled.')) }
    server.on('error', () => finish(new Error('The Calendar sign-in port is busy. Close the other sign-in window and try again.')))
    server.listen(43822, '127.0.0.1', () => {
      void shell.openExternal(authorize.toString()).catch(() => finish(new Error('The browser could not be opened.')))
    })
  })
}
export async function disconnectCalendar(): Promise<void> {
  cancelCalendarConnect()
  const saved = await loadSession().catch(() => null)
  if (saved) {
    await backend({ action: 'disconnect' }).catch(() => undefined)
  }
  generation++
  await diskCache.clear()
  await fs.unlink(sessionPath()).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
  current = null
}
export async function listCalendars(): Promise<GoogleCalendar[]> {
  if (STUB) {
    const stubCalendars: GoogleCalendar[] = [
      { id: 'stub-primary', name: 'preview@example.com', primary: true, writable: true, timeZone: 'UTC' },
      { id: 'stub-work', name: 'Work', primary: false, writable: true, timeZone: 'UTC' }
    ]
    diskCache.recordCalendars('stub', 'preview@example.com', stubCalendars)
    return stubCalendars
  }
  const signedIn = await session()
  const data = await backend({ action: 'calendars' }, signedIn)
  if (!Array.isArray(data.calendars)) throw new Error('Calendar list was incomplete.')
  diskCache.recordCalendars(signedIn.userId, signedIn.email, data.calendars)
  return data.calendars
}
export function calendarDayRange(date: string, timeZone?: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Choose a valid date.')
  const zone = timeZone ? canonicalTimeZone(timeZone) : resolveSystemTimeZone()
  const bounds = dayBoundsInTimeZone(date, zone)
  if (!bounds) throw new Error('Choose a valid date.')
  return { start: bounds.startIso, end: bounds.endIso }
}
export async function calendarEvents(calendarId: string, date: string, timeZone?: string): Promise<{ events: CalendarEvent[]; truncated: boolean }> {
  const zone = timeZone ? canonicalTimeZone(timeZone) : resolveSystemTimeZone()
  if (STUB) {
    const [sy, sm, sd] = date.split('-').map(Number)
    const at = (hour: number): string => new Date(sy, sm - 1, sd, hour).toISOString()
    const events: CalendarEvent[] = [
      { id: 'stub-1', etag: '1', title: 'Design review', description: 'Weekly sync with the team', location: 'Zoom',
        start: at(10), end: at(11), allDay: false, timeZone: 'UTC', url: 'https://calendar.google.com/' },
      { id: 'stub-2', etag: '2', title: 'Ship Notch 1.1', description: '', location: '',
        start: `${date}T00:00:00`, end: `${date}T00:00:00`, allDay: true, timeZone: 'UTC', url: null },
      { id: 'stub-3', etag: '3', title: 'Gym', description: '', location: 'Gold\'s',
        start: at(18), end: at(19), allDay: false, timeZone: 'UTC', url: null }
    ]
    diskCache.recordDayEvents('stub', 'preview@example.com', calendarId, date, zone, { events, truncated: false, fetchedAt: Date.now() })
    return { events, truncated: false }
  }
  if (typeof calendarId !== 'string' || !calendarId || calendarId.length > 1024) throw new Error('Choose a calendar.')
  const signedIn = await session()
  const data = await backend({ action: 'events', calendarId, ...calendarDayRange(date, zone) }, signedIn)
  if (!Array.isArray(data.events)) throw new Error('Calendar event data was incomplete.')
  // The range is absolute, so a previous day's all-day event can overlap it.
  const events = (data.events as CalendarEvent[]).filter((event) => eventBelongsToDay(event, date, zone))
  const truncated = data.truncated === true
  diskCache.recordDayEvents(signedIn.userId, signedIn.email, calendarId, date, zone, { events, truncated, fetchedAt: Date.now() })
  return { events, truncated }
}

export interface CalendarDeleteResult { ok: boolean; error?: string }
export async function deleteCalendarEvent(calendarId: string, eventId: string): Promise<CalendarDeleteResult> {
  if (STUB) {
    diskCache.invalidateCalendar(calendarId)
    return { ok: true }
  }
  if (typeof calendarId !== 'string' || !calendarId || calendarId.length > 1024) throw new Error('Choose a calendar.')
  if (typeof eventId !== 'string' || !/^[a-zA-Z0-9_-]{1,1024}$/.test(eventId)) throw new Error('Choose an event.')
  try {
    await backend({ action: 'delete', calendarId, eventId })
    diskCache.invalidateCalendar(calendarId)
    return { ok: true }
  } catch (error) {
    // A 404 from the function itself means the backend is missing; a 404 for the
    // event means Google no longer has it, which is the state we wanted.
    if (error instanceof CalendarRequestError && error.status === 404 && !/backend is not available/.test(error.message)) {
      diskCache.invalidateCalendar(calendarId)
      return { ok: true }
    }
    return { ok: false, error: error instanceof Error ? error.message : 'The Google event could not be removed.' }
  }
}
export async function saveCalendarEvent(calendarId: string, draft: CalendarDraft, editing: boolean): Promise<CalendarSaveResult> {
  if (STUB) {
    diskCache.invalidateCalendar(calendarId)
    return { ok: true, event: { ...draft, id: `stub-new-${Date.now()}`, etag: '', url: null } }
  }
  if (typeof calendarId !== 'string' || !calendarId || calendarId.length > 1024 || typeof editing !== 'boolean') throw new Error('Choose a calendar and event.')
  try {
    const data = await backend({ action: editing ? 'update' : 'create', calendarId, draft })
    if (!data.event?.id || (editing && data.event.id !== draft.id)) throw new Error('Google did not confirm the selected event. Refresh before trying again.')
    diskCache.invalidateCalendar(calendarId)
    return { ok: true, event: data.event }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Calendar save could not be confirmed.',
      uncertain: !(error instanceof CalendarRequestError) || error.status >= 500 || error.status === 409 }
  }
}
