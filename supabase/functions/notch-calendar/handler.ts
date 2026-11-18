interface Config {
  supabaseUrl: string
  serviceKey: string
  googleClientId: string
  googleClientSecret: string
  encryptionKey: string
}
interface Grant { accessToken: string; refreshToken: string; expiresAt: number; subject: string }
interface StoredGrant { grant: Grant; ciphertext: string }
type Data = Record<string, any>
class Failure extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
const EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
})

export function createCalendarHandler(config: Config, fetcher: typeof fetch = fetch) {
  const base = config.supabaseUrl.replace(/\/$/, '')
  async function request(url: string, init: RequestInit): Promise<Response> {
    return fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) })
  }
  async function encryptionKey() {
    let bytes: Uint8Array<ArrayBuffer>
    try { bytes = Uint8Array.from(atob(config.encryptionKey), c => c.charCodeAt(0)) }
    catch { throw new Failure(503, 'Calendar credential storage is not configured.') }
    if (bytes.length !== 32) throw new Failure(503, 'Calendar credential storage is not configured.')
    return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
  }
  async function encrypt(userId: string, grant: Grant) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
      additionalData: new TextEncoder().encode(userId) }, await encryptionKey(),
    new TextEncoder().encode(JSON.stringify(grant))))
    return btoa(String.fromCharCode(...iv, ...ciphertext))
  }
  async function decrypt(userId: string, value: string): Promise<Grant> {
    const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0))
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12),
      additionalData: new TextEncoder().encode(userId) }, await encryptionKey(), bytes.slice(12))
    return JSON.parse(new TextDecoder().decode(plain))
  }
  const dbHeaders = () => ({ apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}`,
    'Content-Type': 'application/json' })
  async function readGrant(userId: string): Promise<StoredGrant | null> {
    const response = await request(`${base}/rest/v1/notch_calendar_grants?user_id=eq.${encodeURIComponent(userId)}&select=encrypted_grant`, { headers: dbHeaders() })
    if (!response.ok) throw new Failure(503, 'Calendar storage is unavailable.')
    const rows = await response.json()
    if (!rows[0]) return null
    const ciphertext = rows[0].encrypted_grant
    return { grant: await decrypt(userId, ciphertext), ciphertext }
  }
  async function saveGrant(userId: string, grant: Grant) {
    const response = await request(`${base}/rest/v1/notch_calendar_grants?on_conflict=user_id`, {
      method: 'POST', headers: { ...dbHeaders(), Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id: userId, encrypted_grant: await encrypt(userId, grant), updated_at: new Date().toISOString() })
    })
    if (!response.ok) throw new Failure(503, 'Calendar connection could not be saved.')
  }
  async function identity(accessToken: string, expectedSubjects: string[]) {
    const response = await request('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!response.ok) throw new Failure(403, 'Reconnect Google Calendar to verify its owner.')
    const profile = await response.json()
    if (!profile.sub || !expectedSubjects.includes(profile.sub)) throw new Failure(403, 'The Google account does not match your signed-in account.')
    return String(profile.sub)
  }
  async function refresh(userId: string, saved: StoredGrant, subjects: string[]): Promise<Grant> {
    const { grant } = saved
    if (!subjects.includes(grant.subject)) throw new Failure(403, 'Reconnect the Google account used to sign in.')
    if (grant.expiresAt > Date.now() + 60000) return grant
    const response = await request('https://oauth2.googleapis.com/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: grant.refreshToken,
        client_id: config.googleClientId, client_secret: config.googleClientSecret }) })
    if (!response.ok) throw new Failure(409, 'Google Calendar needs to be reconnected.')
    const token = await response.json()
    if (!token.access_token || !Number.isFinite(token.expires_in)) throw new Failure(502, 'Google returned an incomplete token response.')
    await identity(token.access_token, subjects)
    const next = { ...grant, accessToken: token.access_token, refreshToken: token.refresh_token || grant.refreshToken,
      expiresAt: Date.now() + token.expires_in * 1000 }
    const query = new URLSearchParams({ user_id: `eq.${userId}`, encrypted_grant: `eq.${saved.ciphertext}`, select: 'user_id' })
    const updated = await request(`${base}/rest/v1/notch_calendar_grants?${query}`, {
      method: 'PATCH',
      headers: { ...dbHeaders(), Prefer: 'return=representation' },
      body: JSON.stringify({ encrypted_grant: await encrypt(userId, next), updated_at: new Date().toISOString() })
    })
    if (!updated.ok) throw new Failure(503, 'Calendar authorization could not be refreshed.')
    if (!(await updated.json()).length) throw new Failure(409, 'Calendar authorization changed. Try again.')
    return next
  }
  async function google(grant: Grant, path: string, init: RequestInit = {}) {
    const response = await request(`https://www.googleapis.com/calendar/v3/${path}`, {
      ...init, headers: { Authorization: `Bearer ${grant.accessToken}`, 'Content-Type': 'application/json', ...init.headers }
    })
    if (response.status === 401) throw new Failure(409, 'Google Calendar needs to be reconnected.')
    if (response.status === 403) throw new Failure(403, 'This Google account cannot perform that calendar action.')
    if (response.status === 412) throw new Failure(412, 'This event changed in Google Calendar. Refresh and open it again before editing.')
    if (response.status === 404) throw new Failure(404, 'The selected calendar or event is no longer available.')
    return response
  }
  function event(value: Data, timeZone = '') {
    return { id: value.id, etag: value.etag, title: value.summary || '(Untitled event)',
      description: value.description || '', location: value.location || '',
      start: value.start?.dateTime || value.start?.date || '', end: value.end?.dateTime || value.end?.date || '',
      allDay: Boolean(value.start?.date), timeZone: value.start?.timeZone || timeZone, url: value.htmlLink || null }
  }
  function calendarId(input: unknown): string {
    if (typeof input !== 'string' || !input || input === '.' || input === '..' || input.length > 1024 || /[\x00-\x1f]/.test(input)) throw new Failure(400, 'Choose a calendar.')
    return encodeURIComponent(input)
  }
  function eventBody(input: Data) {
    if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 1024 ||
      typeof input.description !== 'string' || input.description.length > 16000 ||
      typeof input.location !== 'string' || input.location.length > 2048 || typeof input.allDay !== 'boolean') {
      throw new Failure(400, 'Enter an event title and valid event details.')
    }
    if (typeof input.start !== 'string' || typeof input.end !== 'string') throw new Failure(400, 'Enter a start and end time.')
    const datePattern = input.allDay ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/
    const start = Date.parse(input.start), end = Date.parse(input.end)
    if (!datePattern.test(input.start) || !datePattern.test(input.end) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Failure(400, 'The event end must be after its start.')
    }
    if (input.allDay && (new Date(start).toISOString().slice(0, 10) !== input.start || new Date(end).toISOString().slice(0, 10) !== input.end)) {
      throw new Failure(400, 'Enter valid calendar dates.')
    }
    if (!input.allDay) {
      try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format() }
      catch { throw new Failure(400, 'Choose a valid time zone.') }
      if (typeof input.timeZone !== 'string' || !input.timeZone) throw new Failure(400, 'A time zone is required.')
    }
    return { summary: input.title.trim(), description: input.description, location: input.location,
      start: input.allDay ? { date: input.start } : { dateTime: input.start, timeZone: input.timeZone },
      end: input.allDay ? { date: input.end } : { dateTime: input.end, timeZone: input.timeZone } }
  }
  return async (req: Request): Promise<Response> => {
    try {
      if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405)
      if (!Object.values(config).every(Boolean)) throw new Failure(503, 'Calendar backend is not configured.')
      const authorization = req.headers.get('Authorization') || ''
      if (!/^Bearer \S+$/.test(authorization)) throw new Failure(401, 'Sign in to Todaywise first.')
      const auth = await request(`${base}/auth/v1/user`, { headers: { apikey: config.serviceKey, Authorization: authorization } })
      if (!auth.ok) throw new Failure(401, 'Your Todaywise session has expired. Sign in again.')
      const user = await auth.json()
      if (typeof user.id !== 'string') throw new Failure(401, 'Invalid session.')
      const subjects: string[] = (user.identities || []).filter((i: Data) => i.provider === 'google')
        .map((i: Data) => i.identity_data?.sub || i.provider_id).filter((v: unknown) => typeof v === 'string')
      const raw = await req.text()
      if (raw.length > 40000) throw new Failure(413, 'Calendar request is too large.')
      let body: Data
      try { body = JSON.parse(raw) } catch { throw new Failure(400, 'Invalid Calendar request.') }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Failure(400, 'Invalid Calendar request.')
      if (body.action === 'disconnect') {
        const response = await request(`${base}/rest/v1/notch_calendar_grants?user_id=eq.${encodeURIComponent(user.id)}`, { method: 'DELETE', headers: dbHeaders() })
        if (!response.ok) throw new Failure(503, 'Could not disconnect. Try again.')
        return json({ connected: false })
      }
      if (body.action === 'connect') {
        if (typeof body.accessToken !== 'string' || typeof body.refreshToken !== 'string' || !body.refreshToken || body.refreshToken.length > 8192) {
          throw new Failure(400, 'Google did not return offline access. Sign in again and approve Calendar access.')
        }
        const subject = await identity(body.accessToken, subjects)
        // Confirm this refresh grant belongs to the same Google account and client,
        // and carries the scopes required by the actual list/create/edit consumers.
        const response = await request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: body.refreshToken,
            client_id: config.googleClientId, client_secret: config.googleClientSecret }) })
        if (!response.ok) throw new Failure(403, 'Google Calendar authorization could not be verified.')
        const token = await response.json()
        if (!token.access_token || !Number.isFinite(token.expires_in)) throw new Failure(502, 'Google returned an incomplete token response.')
        await identity(token.access_token, [subject])
        const scopes = new Set(String(token.scope || '').split(' '))
        if (!scopes.has(EVENTS_SCOPE) || !scopes.has(LIST_SCOPE)) throw new Failure(403, 'Approve Calendar events and calendar-list access when connecting.')
        await saveGrant(user.id, { subject, accessToken: token.access_token, refreshToken: token.refresh_token || body.refreshToken,
          expiresAt: Date.now() + token.expires_in * 1000 })
        return json({ connected: true })
      }
      const saved = await readGrant(user.id)
      if (body.action === 'status') return json({ connected: Boolean(saved && subjects.includes(saved.grant.subject)) })
      if (!saved) throw new Failure(409, 'Connect Google Calendar first.')
      const grant = await refresh(user.id, saved, subjects)
      if (body.action === 'calendars') {
        const calendars: Data[] = []
        let page = ''
        for (let n = 0; n < 10; n++) {
          const response = await google(grant, `users/me/calendarList?maxResults=250${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`)
          if (!response.ok) throw new Failure(502, 'Google could not list your calendars. Try again.')
          const result = await response.json()
          calendars.push(...(result.items || []).map((c: Data) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id,
            primary: Boolean(c.primary), writable: c.accessRole === 'owner' || c.accessRole === 'writer', timeZone: c.timeZone || 'UTC' })))
          page = result.nextPageToken || ''
          if (!page) return json({ calendars })
        }
        throw new Failure(502, 'Too many calendars to load completely.')
      }
      const selected = calendarId(body.calendarId)
      if (body.action === 'events') {
        const from = Date.parse(body.start), to = Date.parse(body.end)
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 32 * 86400000) throw new Failure(400, 'Choose a valid date range up to 32 days.')
        const params = new URLSearchParams({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250' })
        const response = await google(grant, `calendars/${selected}/events?${params}`)
        if (!response.ok) throw new Failure(502, 'Google could not load events. Try again.')
        const result = await response.json()
        return json({ events: (result.items || []).filter((e: Data) => e.status !== 'cancelled').map((e: Data) => event(e, result.timeZone)), truncated: Boolean(result.nextPageToken) })
      }
      if (body.action === 'delete') {
        const eventId = body.eventId
        if (typeof eventId !== 'string' || !/^[a-zA-Z0-9_-]{1,1024}$/.test(eventId)) throw new Failure(400, 'Invalid event identifier.')
        const response = await google(grant, `calendars/${selected}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' })
        // 410 means the event is already gone, which is the state we wanted.
        if (!response.ok && response.status !== 410) throw new Failure(502, 'Google could not remove this event. Try again.')
        return json({ deleted: true })
      }
      if (body.action === 'create' || body.action === 'update') {
        const draft = body.draft
        const payload = eventBody(draft)
        if (typeof draft.id !== 'string' || !/^[a-zA-Z0-9_-]{1,1024}$/.test(draft.id)) throw new Failure(400, 'Invalid event identifier.')
        if (body.action === 'update') {
          if (typeof draft.etag !== 'string' || !draft.etag || /[\r\n]/.test(draft.etag)) throw new Failure(400, 'Refresh the event before editing.')
          const response = await google(grant, `calendars/${selected}/events/${encodeURIComponent(draft.id)}`, {
            method: 'PATCH', headers: { 'If-Match': draft.etag }, body: JSON.stringify(payload)
          })
          if (!response.ok) throw new Failure(502, 'Google could not save this event. Refresh to check its current state.')
          return json({ event: event(await response.json(), draft.timeZone) })
        }
        if (!/^[a-f0-9]{32}$/.test(draft.id)) throw new Failure(400, 'Invalid event creation identifier.')
        const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))
        const hash = await crypto.subtle.digest('SHA-256', payloadBytes)
        const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
        const response = await google(grant, `calendars/${selected}/events`, { method: 'POST', body: JSON.stringify({ ...payload, id: draft.id,
          extendedProperties: { private: { notch_owner: user.id, notch_request: digest } } }) })
        if (response.status === 409) {
          const found = await google(grant, `calendars/${selected}/events/${draft.id}`)
          if (!found.ok) throw new Failure(409, 'Event creation is unresolved. Refresh before trying again.')
          const existing = await found.json()
          if (existing.id !== draft.id || existing.status === 'cancelled' || existing.extendedProperties?.private?.notch_owner !== user.id || existing.extendedProperties?.private?.notch_request !== digest) {
            throw new Failure(409, 'This pending event differs from the saved event. Refresh before starting another.')
          }
          return json({ event: event(existing, draft.timeZone) })
        }
        if (!response.ok) throw new Failure(502, 'Google could not confirm the new event. Retry this same draft to avoid a duplicate.')
        return json({ event: event(await response.json(), draft.timeZone) })
      }
      throw new Failure(400, 'Unsupported Calendar action.')
    } catch (error) {
      return error instanceof Failure ? json({ error: error.message }, error.status) : json({ error: 'Calendar service is unavailable. Try again.' }, 503)
    }
  }
}
