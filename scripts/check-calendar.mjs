import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripTypeScriptTypes } from 'node:module'

function toDataUrl(relativePath, replacements = {}) {
  let source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  source = source.replace(/import type \{[^}]*\} from '[^']*'\r?\n?/g, '')
  for (const [specifier, replacement] of Object.entries(replacements)) {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    source = source.replace(new RegExp(`from '${escaped}'`, 'g'), `from '${replacement}'`)
  }
  return `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`
}
const timeZoneUrl = toDataUrl('../src/shared/timeZone.ts')
const calendarUrl = toDataUrl('../src/shared/calendar.ts', { './timeZone': timeZoneUrl })
const calendarDraftUrl = toDataUrl('../src/shared/calendarDraft.ts', { './timeZone': timeZoneUrl })
const timeZone = await import(timeZoneUrl)
const { createCalendarHandler } = await import(toDataUrl('../supabase/functions/notch-calendar/handler.ts'))
const { calendarDraftFromEvent, newCalendarDraft, serializeCalendarDraft } = await import(calendarDraftUrl)
const { calendarDayCacheKey, eventBelongsToDay } = await import(calendarUrl)
const { taskEventDraft } = await import(
  toDataUrl('../src/shared/taskEvent.ts', { './timeZone': timeZoneUrl })
)
const { createCalendarDiskCache } = await import(
  toDataUrl('../src/main/calendarCache.ts', { '../shared/calendar': calendarUrl })
)
const { createCalendarStore } = await import(
  toDataUrl('../src/renderer/src/state/calendarCache.ts', {
    '../../../shared/calendar': calendarUrl,
    '../../../shared/calendarDraft': calendarDraftUrl
  })
)

const scopes = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
].join(' ')
const json = (data, status = 200) => Response.json(data, { status })

function fixture() {
  const grants = new Map()
  const events = new Map()
  const writes = []
  const google = []
  const fixture = { grants, events, writes, google, mismatch: false, refreshRace: null, expiresIn: 3600 }
  const handler = createCalendarHandler({
    supabaseUrl: 'https://example.test', serviceKey: 'test-only',
    googleClientId: 'test-client', googleClientSecret: 'test-secret',
    encryptionKey: Buffer.alloc(32, 67).toString('base64')
  }, async (input, init) => {
    const url = new URL(input)
    const headers = new Headers(init.headers)
    if (url.pathname === '/auth/v1/user') {
      const id = headers.get('Authorization')?.match(/^Bearer (alice|bob)$/)?.[1]
      return id ? json({ id, identities: [{ provider: 'google', identity_data: { sub: id } }] }) : json({}, 401)
    }
    if (url.pathname === '/rest/v1/notch_calendar_grants') {
      if (init.method === 'POST') {
        const row = JSON.parse(init.body)
        grants.set(row.user_id, row.encrypted_grant)
        return new Response(null, { status: 201 })
      }
      const id = url.searchParams.get('user_id').slice(3)
      if (init.method === 'DELETE') {
        grants.delete(id)
        return new Response(null, { status: 204 })
      }
      if (init.method === 'PATCH') {
        if (fixture.refreshRace === 'disconnect') {
          grants.delete(id)
          return json([])
        }
        if (url.searchParams.get('encrypted_grant') !== `eq.${grants.get(id)}`) return json([])
        grants.set(id, JSON.parse(init.body).encrypted_grant)
        return json(fixture.refreshRace === 'winner' ? [] : [{ user_id: id }])
      }
      return json(grants.has(id) ? [{ encrypted_grant: grants.get(id) }] : [])
    }
    if (url.hostname === 'oauth2.googleapis.com') {
      assert.equal(init.body.get('client_id'), 'test-client')
      return json({ access_token: fixture.mismatch ? 'bob-token' : 'alice-token', expires_in: fixture.expiresIn, scope: scopes })
    }
    if (url.hostname === 'openidconnect.googleapis.com') return json({ sub: headers.get('Authorization')?.includes('bob') ? 'bob' : 'alice' })
    if (url.hostname === 'www.googleapis.com') {
      assert.equal(headers.get('Authorization'), 'Bearer alice-token')
      google.push(url)
      if (url.pathname.endsWith('/calendarList')) return json({ items: [{ id: 'A calendar', summary: 'A', accessRole: 'owner' }, { id: 'B calendar', summary: 'B', accessRole: 'reader' }] })
      const [, calendarId, id] = url.pathname.match(/\/calendars\/([^/]+)\/events(?:\/(.*))?$/) || []
      const key = `${calendarId}/${id}`
      if (init.method === 'POST') {
        const payload = JSON.parse(init.body)
        const createKey = `${calendarId}/${payload.id}`
        if (events.has(createKey)) return json({}, 409)
        writes.push({ calendarId, payload })
        const saved = { ...payload, etag: '"v1"' }
        events.set(createKey, saved)
        return json(saved)
      }
      if (init.method === 'DELETE') {
        if (!events.has(key)) return json({}, 404)
        events.delete(key)
        writes.push({ calendarId, id, deleted: true })
        return new Response(null, { status: 204 })
      }
      if (init.method === 'PATCH') {
        const current = events.get(key)
        if (headers.get('If-Match') !== current?.etag) return json({}, 412)
        const payload = JSON.parse(init.body)
        writes.push({ calendarId, id, payload })
        const saved = { ...current, ...payload, etag: '"v2"' }
        events.set(key, saved)
        return json(saved)
      }
      return id ? json(events.get(key)) : json({ items: [...events].filter(([key]) => key.startsWith(`${calendarId}/`)).map(([, event]) => event) })
    }
    throw new Error('Unexpected test request')
  })
  fixture.call = (body, token = 'alice') => handler(new Request('http://local.test', {
    method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body)
  }))
  fixture.connect = () => fixture.call({ action: 'connect', accessToken: 'alice-token', refreshToken: 'test-refresh' })
  return fixture
}

test('requires verified ownership before connecting or returning calendar data', async () => {
  const f = fixture()
  assert.equal((await f.call({ action: 'calendars' }, '')).status, 401)
  f.mismatch = true
  assert.equal((await f.connect()).status, 403)
  assert.equal(f.grants.size, 0)
  f.mismatch = false
  assert.equal((await f.connect()).status, 200)
  assert.ok(!f.grants.get('alice').includes('test-refresh'))
  assert.equal((await f.call({ action: 'calendars', userId: 'alice' }, 'bob')).status, 409)
  assert.equal((await f.call({ action: 'disconnect' })).status, 200)
  assert.equal(f.grants.size, 0)
})

test('Planner draft reaches selected Google calendar and retries create with the same ID', async () => {
  const f = fixture()
  assert.equal((await f.connect()).status, 200)
  const { calendars } = await (await f.call({ action: 'calendars' })).json()
  assert.deepEqual(calendars.map((entry) => [entry.id, entry.writable]), [['A calendar', true], ['B calendar', false]])
  const draft = serializeCalendarDraft({
    ...newCalendarDraft('2026-11-16'), title: 'Planning', allDay: true, start: '2026-11-16', end: '2026-11-17'
  }, null)
  const request = { action: 'create', calendarId: calendars[0].id, draft }
  assert.equal((await f.call(request)).status, 200)
  assert.equal((await f.call(request)).status, 200)
  assert.equal((await f.call({ ...request, draft: { ...draft, title: 'Different' } })).status, 409)
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].calendarId, 'A%20calendar')
  assert.deepEqual(f.writes[0].payload.start, { date: '2026-11-16' })
  const dates = { action: 'events', start: '2026-11-16T00:00:00Z', end: '2026-11-17T00:00:00Z' }
  assert.deepEqual((await (await f.call({ ...dates, calendarId: calendars[1].id })).json()).events, [])
  const { events } = await (await f.call({ ...dates, calendarId: calendars[0].id })).json()
  assert.equal(events[0].id, draft.id)
  const updated = serializeCalendarDraft({ ...calendarDraftFromEvent(events[0]), title: 'Updated' }, events[0])
  const patch = { action: 'update', calendarId: calendars[0].id, draft: updated }
  const saved = await (await f.call(patch)).json()
  assert.equal(saved.event.id, draft.id)
  assert.equal(saved.event.title, 'Updated')
  assert.equal((await f.call(patch)).status, 412)
  assert.equal(f.writes.length, 2)
})

test('all-day and timed edits explicitly clear the opposite Google date fields', async () => {
  const f = fixture()
  await f.connect()
  const draft = serializeCalendarDraft({ ...newCalendarDraft('2026-11-19'), title: 'Transition' }, null)
  const created = await (await f.call({ action: 'create', calendarId: 'A calendar', draft })).json()
  const allDay = { ...draft, etag: created.event.etag, allDay: true, start: '2026-11-19', end: '2026-11-20' }
  const changed = await (await f.call({ action: 'update', calendarId: 'A calendar', draft: allDay })).json()
  assert.deepEqual(f.writes.at(-1).payload.start, { date: '2026-11-19', dateTime: null, timeZone: null })
  assert.deepEqual(f.writes.at(-1).payload.end, { date: '2026-11-20', dateTime: null, timeZone: null })
  assert.equal(changed.event.allDay, true)
  const timed = { ...draft, etag: changed.event.etag }
  const back = await (await f.call({ action: 'update', calendarId: 'A calendar', draft: timed })).json()
  assert.deepEqual(f.writes.at(-1).payload.start, { date: null, dateTime: draft.start, timeZone: draft.timeZone })
  assert.deepEqual(f.writes.at(-1).payload.end, { date: null, dateTime: draft.end, timeZone: draft.timeZone })
  assert.equal(back.event.allDay, false)
})

test('refresh conflict reuses the winning grant but does not revive a disconnected grant', async () => {
  for (const race of ['winner', 'disconnect']) {
    const f = fixture()
    f.expiresIn = 1
    await f.connect()
    f.expiresIn = 3600
    f.refreshRace = race
    const result = await f.call({ action: 'calendars' })
    assert.equal(result.status, race === 'winner' ? 200 : 409)
    assert.equal(f.grants.size, race === 'winner' ? 1 : 0)
    assert.equal(f.google.length, race === 'winner' ? 1 : 0)
  }
})

test('a deleted task event is removed from the selected calendar', async () => {
  const f = fixture()
  assert.equal((await f.connect()).status, 200)
  const draft = serializeCalendarDraft({ ...newCalendarDraft('2026-11-17'), title: 'Walk the dog' }, null)
  assert.equal((await f.call({ action: 'create', calendarId: 'A calendar', draft })).status, 200)
  const remove = { action: 'delete', calendarId: 'A calendar', eventId: draft.id }
  assert.equal((await f.call(remove)).status, 200)
  assert.equal((await f.call(remove)).status, 404)
  assert.equal(f.events.size, 0)
  assert.equal((await f.call({ ...remove, eventId: '../oops' })).status, 400)
  assert.equal((await f.call({ ...remove, calendarId: 'B calendar', eventId: draft.id })).status, 404)
})

test('editing an event title preserves the original cross-midnight timestamps', () => {
  const event = {
    id: 'event-1', etag: '"v1"', title: 'Original', description: '', location: '',
    start: '2026-11-16T23:40:21+05:30', end: '2026-11-17T00:20:42+05:30',
    allDay: false, timeZone: 'Asia/Kolkata', url: null
  }
  const draft = serializeCalendarDraft({ ...calendarDraftFromEvent(event), title: 'Edited' }, event)
  assert.equal(draft.start, event.start)
  assert.equal(draft.end, event.end)
  assert.equal(draft.etag, event.etag)
})

test('an all-day event from the previous day does not leak into today', () => {
  // Google reported Christmas Eve while Notch asked for the 25th.
  const eve = { start: '2026-12-24', end: '2026-12-25', allDay: true }
  const day = { start: '2026-12-25', end: '2026-12-26', allDay: true }
  assert.equal(eventBelongsToDay(eve, '2026-12-24'), true)
  assert.equal(eventBelongsToDay(eve, '2026-12-25'), false)
  assert.equal(eventBelongsToDay(day, '2026-12-25'), true)
  assert.equal(eventBelongsToDay(day, '2026-12-26'), false)

  // A multi-day all-day event covers every day it spans.
  const trip = { start: '2026-12-24', end: '2026-12-27', allDay: true }
  assert.equal(eventBelongsToDay(trip, '2026-12-25'), true)
  assert.equal(eventBelongsToDay(trip, '2026-12-27'), false)

  // Timed events stay on the day they overlap.
  const evening = { start: '2026-11-17T18:30:00+05:30', end: '2026-11-17T19:30:00+05:30', allDay: false }
  const overnight = { start: '2026-11-17T23:00:00+05:30', end: '2026-11-18T01:00:00+05:30', allDay: false }
  assert.equal(eventBelongsToDay(evening, '2026-11-17'), true)
  assert.equal(eventBelongsToDay(evening, '2026-11-18'), false)
  assert.equal(eventBelongsToDay(overnight, '2026-11-18'), true)
})

test('time zones adapt cleanly across India, US, China, Europe, and UTC', () => {
  const utcEvent = {
    id: 'ev-1',
    etag: '"1"',
    title: 'sdsd',
    description: '',
    location: '',
    start: '2026-11-18T07:30:00Z',
    end: '2026-11-18T08:30:00Z',
    allDay: false,
    timeZone: 'UTC',
    url: null
  }

  // Same instant shows 1 - 2 PM in India, 7:30 - 8:30 AM in UTC, 2:30 - 3:30 AM in US East, 3:30 - 4:30 PM in China, 8:30 - 9:30 AM in Europe.
  assert.equal(timeZone.clockSortKeyInZone(utcEvent.start, 'Asia/Kolkata'), '13:00')
  assert.equal(timeZone.clockSortKeyInZone(utcEvent.start, 'Asia/Calcutta'), '13:00')
  assert.equal(timeZone.clockSortKeyInZone(utcEvent.start, 'UTC'), '07:30')
  assert.equal(timeZone.clockSortKeyInZone(utcEvent.start, 'America/New_York'), '02:30')
  assert.equal(timeZone.clockSortKeyInZone(utcEvent.start, 'Asia/Shanghai'), '15:30')
  assert.equal(timeZone.clockSortKeyInZone(utcEvent.start, 'Europe/Berlin'), '08:30')

  assert.equal(timeZone.sameTimeZoneOffset('Asia/Calcutta', 'Asia/Kolkata'), true)
  assert.equal(timeZone.sameTimeZoneOffset('UTC', 'Asia/Kolkata'), false)

  // Editing in India keeps Indian wall clock and serializes with +05:30 offset.
  const indiaDraft = calendarDraftFromEvent(utcEvent, 'Asia/Kolkata')
  assert.equal(indiaDraft.start, '2026-11-18T13:00')
  assert.equal(indiaDraft.end, '2026-11-18T14:00')
  const serializedIndia = serializeCalendarDraft({ ...indiaDraft, title: 'Updated' }, null)
  assert.equal(serializedIndia.start, '2026-11-18T13:00:00+05:30')
  assert.equal(serializedIndia.end, '2026-11-18T14:00:00+05:30')
  assert.equal(serializedIndia.timeZone, 'Asia/Kolkata')

  // Task created at 13:00 IST converts accurately across UTC, US, China, and crosses midnight cleanly.
  const convertedUtc = timeZone.convertTaskSchedule('2026-11-18', '13:00', 'Asia/Kolkata', 'UTC')
  assert.equal(convertedUtc.date, '2026-11-18')
  assert.equal(convertedUtc.time, '07:30')
  const earlyIstToNewYork = timeZone.convertTaskSchedule('2026-11-18', '01:00', 'Asia/Kolkata', 'America/New_York')
  assert.equal(earlyIstToNewYork.date, '2026-11-17')
  assert.equal(earlyIstToNewYork.time, '14:30')

  // Task synced to Google Calendar uses active timezone and carries exact offset.
  const taskDraft = taskEventDraft(
    { title: 'Standup', date: '2026-11-18', time: '23:45', timeZone: 'Asia/Kolkata' },
    '0123456789abcdef0123456789abcdef'
  )
  assert.equal(taskDraft.start, '2026-11-18T23:45')
  assert.equal(taskDraft.end, '2026-11-19T00:15')
  const serializedTask = serializeCalendarDraft(taskDraft, null)
  assert.equal(serializedTask.start, '2026-11-18T23:45:00+05:30')
  assert.equal(serializedTask.end, '2026-11-19T00:15:00+05:30')

  // DST awareness: America/New_York is -04:00 in July and -05:00 in November.
  const summerNy = serializeCalendarDraft(
    { ...newCalendarDraft('2026-07-15', 'America/New_York'), title: 'Summer', start: '2026-07-15T09:00', end: '2026-07-15T10:00' },
    null
  )
  assert.equal(summerNy.start, '2026-07-15T09:00:00-04:00')
  const winterNy = serializeCalendarDraft(
    { ...newCalendarDraft('2026-11-18', 'America/New_York'), title: 'Winter', start: '2026-11-18T09:00', end: '2026-11-18T10:00' },
    null
  )
  assert.equal(winterNy.start, '2026-11-18T09:00:00-05:00')

  // eventBelongsToDay respects selected display timezone when event crosses UTC midnight.
  const lateIst = { start: '2026-11-18T19:00:00Z', end: '2026-11-18T20:00:00Z', allDay: false } // 00:30-01:30 Nov 19 IST
  assert.equal(eventBelongsToDay(lateIst, '2026-11-18', 'UTC'), true)
  assert.equal(eventBelongsToDay(lateIst, '2026-11-19', 'UTC'), false)
  assert.equal(eventBelongsToDay(lateIst, '2026-11-18', 'Asia/Kolkata'), false)
  assert.equal(eventBelongsToDay(lateIst, '2026-11-19', 'Asia/Kolkata'), true)
})

test('disk snapshot cache persists per user, caps days via LRU, and fails open on corruption', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'notch-cal-disk-'))
  try {
    const file = path.join(dir, 'calendar-cache.enc')
    const xorCipher = {
      available: () => true,
      encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a)),
      decrypt: (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x5a)).toString('utf8')
    }

    const cacheA = createCalendarDiskCache({ filePath: () => file, cipher: xorCipher, maxDays: 2, debounceMs: 5 })
    cacheA.recordStatus({ configured: true, signedIn: true, connected: true, userId: 'alice', email: 'alice@example.com' }, 100)
    cacheA.recordCalendars('alice', 'alice@example.com', [
      { id: 'primary', name: 'Main', primary: true, writable: true, timeZone: 'UTC' }
    ], 101)
    cacheA.recordDayEvents('alice', 'alice@example.com', 'primary', '2026-11-16', 'UTC', { events: [], truncated: false, fetchedAt: 100 })
    cacheA.recordDayEvents('alice', 'alice@example.com', 'primary', '2026-11-17', 'UTC', { events: [], truncated: false, fetchedAt: 200 })
    cacheA.recordDayEvents('alice', 'alice@example.com', 'primary', '2026-11-18', 'Asia/Kolkata', {
      events: [{ id: 'e1', etag: '1', title: 'Standup', description: '', location: '', start: '2026-11-18T07:30:00Z', end: '2026-11-18T08:00:00Z', allDay: false, timeZone: 'UTC', url: null }],
      truncated: false,
      fetchedAt: 300
    })
    cacheA.flushSync()

    // Encrypted on disk (does not expose plaintext title)
    const rawBytes = readFileSync(file)
    assert.equal(rawBytes.toString('utf8').includes('Standup'), false)

    // Cold read in fresh cache instance gets newest 2 days (LRU dropped 2026-11-16)
    const cacheB = createCalendarDiskCache({ filePath: () => file, cipher: xorCipher, maxDays: 2, debounceMs: 5 })
    const snap = await cacheB.readSnapshot('alice', 'alice@example.com')
    assert.ok(snap)
    assert.equal(Object.keys(snap.days).length, 2)
    assert.equal(Boolean(snap.days[calendarDayCacheKey('primary', '2026-11-16', 'UTC')]), false)
    assert.equal(snap.days[calendarDayCacheKey('primary', '2026-11-18', 'Asia/Kolkata')].events[0].title, 'Standup')

    // User mismatch clears cache rather than leaking alice's events to bob
    const mismatch = await cacheB.readSnapshot('bob', 'bob@example.com')
    assert.equal(mismatch, null)

    // Corrupt ciphertext fails open and cleans up bad file
    writeFileSync(file, Buffer.from('not-valid-ciphertext'))
    const cacheC = createCalendarDiskCache({ filePath: () => file, cipher: xorCipher, maxDays: 2, debounceMs: 5 })
    assert.equal(await cacheC.readSnapshot('alice', 'alice@example.com'), null)

    // Unavailable encryption degrades gracefully to no disk writes
    const noCipher = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' }
    const cacheD = createCalendarDiskCache({ filePath: () => file, cipher: noCipher })
    assert.equal(await cacheD.readSnapshot('alice', 'alice@example.com'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SWR calendar store serves fresh memory/snapshot cache with zero calls, revalidates quietly, and invalidates on writes', async () => {
  let clock = 10_000
  const calls = { snapshot: 0, status: 0, calendars: 0, events: 0, save: 0, remove: 0 }
  let serverEvents = [
    {
      id: 'ev-1',
      etag: '"v1"',
      title: 'Initial event',
      description: '',
      location: '',
      start: '2026-11-18T07:30:00Z',
      end: '2026-11-18T08:30:00Z',
      allDay: false,
      timeZone: 'UTC',
      url: null
    }
  ]
  let failEvents = false

  const memoryStorage = new Map()
  const storage = {
    getItem: (k) => (memoryStorage.has(k) ? memoryStorage.get(k) : null),
    setItem: (k, v) => memoryStorage.set(k, String(v)),
    removeItem: (k) => memoryStorage.delete(k)
  }

  const key = calendarDayCacheKey('cal-1', '2026-11-18', 'Asia/Kolkata')
  const api = {
    async snapshot() {
      calls.snapshot += 1
      return {
        version: 1,
        userId: 'user-1',
        email: 'user@example.com',
        status: { configured: true, signedIn: true, connected: true, userId: 'user-1', email: 'user@example.com' },
        statusFetchedAt: clock,
        calendars: [{ id: 'cal-1', name: 'Work', primary: true, writable: true, timeZone: 'UTC' }],
        calendarsFetchedAt: clock,
        picked: 'cal-1',
        days: { [key]: { events: serverEvents, truncated: false, fetchedAt: clock } }
      }
    },
    async status() {
      calls.status += 1
      return { configured: true, signedIn: true, connected: true, userId: 'user-1', email: 'user@example.com' }
    },
    async connect() {
      return api.status()
    },
    async cancelConnect() {},
    async disconnect() {},
    async calendars() {
      calls.calendars += 1
      return [{ id: 'cal-1', name: 'Work', primary: true, writable: true, timeZone: 'UTC' }]
    },
    async events() {
      calls.events += 1
      if (failEvents) throw new Error('Calendar could not be reached.')
      return { events: serverEvents, truncated: false }
    },
    async save(calendarId, draft, editing) {
      calls.save += 1
      const saved = { ...draft, id: draft.id || 'ev-2', etag: '"v2"', url: null }
      serverEvents = editing ? serverEvents.map((e) => (e.id === saved.id ? saved : e)) : [...serverEvents, saved]
      return { ok: true, event: saved }
    },
    async remove(_calendarId, eventId) {
      calls.remove += 1
      serverEvents = serverEvents.filter((e) => e.id !== eventId)
      return { ok: true }
    }
  }

  const store = createCalendarStore({
    api,
    storage,
    now: () => clock,
    statusFreshMs: 600_000,
    calendarsFreshMs: 600_000,
    eventsFreshMs: 90_000
  })

  // 1) Initial hydration from snapshot serves Plan with zero network calls inside TTL
  await store.ensureView('2026-11-18', 'Asia/Kolkata')
  assert.deepEqual(calls, { snapshot: 1, status: 0, calendars: 0, events: 0, save: 0, remove: 0 })
  assert.equal(store.getState().days[key].events[0].title, 'Initial event')

  // 2) After TTL expires, stale events stay visible while a single deduplicated background refresh runs
  clock += 100_000
  serverEvents = [{ ...serverEvents[0], title: 'Updated externally' }]
  await Promise.all([
    store.ensureView('2026-11-18', 'Asia/Kolkata'),
    store.ensureView('2026-11-18', 'Asia/Kolkata')
  ])
  assert.equal(calls.events, 1)
  assert.equal(store.getState().days[key].events[0].title, 'Updated externally')

  // 3) Offline/network error during revalidation keeps cached events visible and reports honest error
  clock += 100_000
  failEvents = true
  await store.ensureView('2026-11-18', 'Asia/Kolkata')
  assert.equal(store.getState().days[key].events[0].title, 'Updated externally')
  assert.match(store.getState().viewErrors[key], /Calendar could not be reached/)
  failEvents = false

  // 4) Manual force reload clears error and refreshes even inside TTL
  await store.ensureView('2026-11-18', 'Asia/Kolkata', true)
  assert.equal(store.getState().viewErrors[key], undefined)

  // 5) Write & delete update cache cleanly
  const draft = { ...newCalendarDraft('2026-11-18', 'Asia/Kolkata'), title: 'Added locally', start: '2026-11-18T15:00', end: '2026-11-18T16:00' }
  const saved = await store.saveDraft(draft, false)
  assert.equal(saved.ok, true)
  assert.equal(store.getState().days[key].events.some((e) => e.title === 'Added locally'), true)
  await store.removeEvent(saved.event.id)
  assert.equal(store.getState().days[key].events.some((e) => e.title === 'Added locally'), false)

  // 6) Disconnect clears all cached state
  await store.disconnect()
  assert.deepEqual(store.getState().days, {})
  assert.equal(store.getState().calendars, null)
})
