import { app, safeStorage, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CalendarDraft, CalendarEvent, CalendarStatus, CalendarSaveResult, GoogleCalendar } from '../shared/calendar'

const BASE = 'https://gswnffijfmhinavyxitz.supabase.co'
// Dev preview: NOTCH_CALENDAR_STUB=1 runs this UI against fixtures so the
// agenda can be built and checked before the backend is deployed.
const STUB = process.env.NOTCH_CALENDAR_STUB === '1'
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

async function request(url: string, init: RequestInit = {}) {
  let response: Response
  try { response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(25000) }) }
  catch { throw new Error('Calendar could not be reached. Check your connection and try again.') }
  let data: any
  try { data = await response.json() } catch { throw new Error('Calendar returned an unreadable response. Try again.') }
  if (!response.ok) {
    if (response.status === 404) throw new Error('The Notch Calendar backend is not available yet.')
    const message = url.includes('/functions/v1/notch-calendar') && typeof data.error === 'string'
      ? data.error.slice(0, 240) : 'Todaywise sign-in failed. Please reconnect Google Calendar.'
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
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable. Calendar sign-in was not saved.')
  await fs.mkdir(path.dirname(sessionPath()), { recursive: true })
  const tmp = `${sessionPath()}.tmp`
  await fs.writeFile(tmp, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 })
  await fs.rename(tmp, sessionPath())
  current = value
}
function sessionFrom(data: any): Session {
  if (!data.access_token || !data.refresh_token || !data.user?.id || !Number.isFinite(data.expires_in)) throw new Error('Todaywise returned an incomplete sign-in.')
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
export async function calendarStatus(): Promise<CalendarStatus> {
  if (STUB) return { configured: true, signedIn: true, connected: true, userId: 'stub', email: 'preview@example.com' }
  const saved = await loadSession()
  if (!saved) return { configured: true, signedIn: false, connected: false, userId: null, email: null }
  const signedIn = await session()
  const data = await backend({ action: 'status' }, signedIn)
  return { configured: true, signedIn: true, connected: data.connected === true, userId: signedIn.userId, email: signedIn.email }
}
export function cancelCalendarConnect(): void { cancelLogin?.() }
export function connectCalendar(): Promise<CalendarStatus> {
  if (connecting) return connecting
  connecting = beginConnect().finally(() => { connecting = null })
  return connecting
}
async function beginConnect(): Promise<CalendarStatus> {
  if (STUB) return calendarStatus()
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable.')
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
      if (error) reject(error); else resolve(result!)
    }
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', REDIRECT)
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
        res.end('Google Calendar is connected. You can close this tab and return to Notch.')
        finish(undefined, { configured: true, signedIn: true, connected: true, userId: next.userId, email: next.email })
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
  const saved = await loadSession()
  if (saved) await backend({ action: 'disconnect' })
  generation++
  await fs.unlink(sessionPath()).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
  current = null
}
export async function listCalendars(): Promise<GoogleCalendar[]> {
  if (STUB) {
    return [
      { id: 'stub-primary', name: 'preview@example.com', primary: true, writable: true, timeZone: 'UTC' },
      { id: 'stub-work', name: 'Work', primary: false, writable: true, timeZone: 'UTC' }
    ]
  }
  const data = await backend({ action: 'calendars' })
  if (!Array.isArray(data.calendars)) throw new Error('Calendar list was incomplete.')
  return data.calendars
}
export function calendarDayRange(date: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Choose a valid date.')
  const [year, month, day] = date.split('-').map(Number)
  const start = new Date(year, month - 1, day)
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) throw new Error('Choose a valid date.')
  return { start: start.toISOString(), end: new Date(year, month - 1, day + 1).toISOString() }
}
export async function calendarEvents(calendarId: string, date: string): Promise<{ events: CalendarEvent[]; truncated: boolean }> {
  if (STUB) {
    const [sy, sm, sd] = date.split('-').map(Number)
    const at = (hour: number): string => new Date(sy, sm - 1, sd, hour).toISOString()
    return {
      events: [
        { id: 'stub-1', etag: '1', title: 'Design review', description: 'Weekly sync with the team', location: 'Zoom',
          start: at(10), end: at(11), allDay: false, timeZone: 'UTC', url: 'https://calendar.google.com/' },
        { id: 'stub-2', etag: '2', title: 'Ship Notch 1.1', description: '', location: '',
          start: `${date}T00:00:00`, end: `${date}T00:00:00`, allDay: true, timeZone: 'UTC', url: null },
        { id: 'stub-3', etag: '3', title: 'Gym', description: '', location: 'Gold\'s',
          start: at(18), end: at(19), allDay: false, timeZone: 'UTC', url: null }
      ],
      truncated: false
    }
  }
  if (typeof calendarId !== 'string' || !calendarId || calendarId.length > 1024) throw new Error('Choose a calendar.')
  const data = await backend({ action: 'events', calendarId, ...calendarDayRange(date) })
  if (!Array.isArray(data.events)) throw new Error('Calendar event data was incomplete.')
  return data
}
export async function saveCalendarEvent(calendarId: string, draft: CalendarDraft, editing: boolean): Promise<CalendarSaveResult> {
  if (STUB) {
    return { ok: true, event: { ...draft, id: `stub-new-${Date.now()}`, etag: '', url: null } }
  }
  if (typeof calendarId !== 'string' || !calendarId || calendarId.length > 1024 || typeof editing !== 'boolean') throw new Error('Choose a calendar and event.')
  try {
    const data = await backend({ action: editing ? 'update' : 'create', calendarId, draft })
    if (!data.event?.id) throw new Error('Google did not confirm the saved event. Refresh before trying again.')
    return { ok: true, event: data.event }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Calendar save could not be confirmed.',
      uncertain: !(error instanceof CalendarRequestError) || error.status >= 500 || error.status === 409 }
  }
}
