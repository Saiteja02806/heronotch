import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarDays, ExternalLink, Loader2, Plus, RefreshCw } from 'lucide-react'
import type { CalendarEvent, CalendarStatus, GoogleCalendar } from '../../../shared/calendar'
import { useApp } from '../state/AppContext'

type Phase = 'checking' | 'connecting' | 'ready' | 'error'

const STORAGE_KEY = 'notch-calendar-pick'

/** Today's Google Calendar agenda for one day: connect, browse, add events.
 * All Google traffic goes through the main process; this is pure UI. */
export function GoogleCalendarAgenda({ date, dateLabel }: { date: string; dateLabel: string }) {
  const { showToast } = useApp()
  const [phase, setPhase] = useState<Phase>('checking')
  const [status, setStatus] = useState<CalendarStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [calendars, setCalendars] = useState<GoogleCalendar[] | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [events, setEvents] = useState<CalendarEvent[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loadingEvents, setLoadingEvents] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ title: '', start: '09:00', end: '10:00', allDay: false, location: '', description: '' })
  const [saving, setSaving] = useState(false)
  const alive = useRef(true)
  const watchConnect = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const loadEvents = useCallback(async (calendarId: string, day: string) => {
    setLoadingEvents(true)
    setError(null)
    try {
      const data = await window.notch.calendar.events(calendarId, day)
      if (!alive.current) return
      setEvents(data.events)
      setTruncated(data.truncated)
    } catch (cause) {
      if (!alive.current) return
      setEvents(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (alive.current) setLoadingEvents(false)
    }
  }, [])

  const loadCalendars = useCallback(async (day: string) => {
    try {
      const list = await window.notch.calendar.calendars()
      if (!alive.current) return
      const writable = list.filter((entry) => entry.writable)
      setCalendars(list)
      const stored = localStorage.getItem(STORAGE_KEY)
      const initial =
        (stored && list.find((entry) => entry.id === stored)?.id) ||
        (list.find((entry) => entry.primary)?.id ?? writable[0]?.id ?? list[0]?.id ?? null)
      setPicked(initial)
      if (initial) void loadEvents(initial, day)
    } catch (cause) {
      if (!alive.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [loadEvents])

  // Check the saved sign-in once; refresh events whenever the day changes.
  useEffect(() => {
    let cancelled = false
    setEvents(null)
    setTruncated(false)
    void (async () => {
      try {
        const next = await window.notch.calendar.status()
        if (cancelled) return
        setStatus(next)
        if (next.signedIn && next.connected) {
          setPhase('ready')
          void loadCalendars(date)
        } else {
          setPhase('error')
          setError(null)
        }
      } catch (cause) {
        if (cancelled) return
        setStatus(null)
        setPhase('error')
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (phase !== 'ready' || !picked) return
    void loadEvents(picked, date)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, picked])

  async function connect(): Promise<void> {
    setPhase('connecting')
    setError(null)
    watchConnect.current = true
    try {
      const next = await window.notch.calendar.connect()
      if (!alive.current) return
      setStatus(next)
      setPhase(next.connected ? 'ready' : 'error')
      if (next.connected) void loadCalendars(date)
    } catch (cause) {
      if (!alive.current) return
      setPhase('error')
      setError(cause instanceof Error ? cause.message : String(cause))
      showToast('Google Calendar', cause instanceof Error ? cause.message : String(cause), 'error')
    } finally {
      watchConnect.current = false
    }
  }

  async function save(): Promise<void> {
    if (!picked || !draft.title.trim()) return
    setSaving(true)
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      const [sy, sm, sd] = date.split('-').map(Number)
      if (draft.allDay) {
        const day = (offset: number) => {
          const d = new Date(sy, sm - 1, sd + offset)
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
          return `${key}T00:00:00`
        }
        const result = await window.notch.calendar.save(picked, {
          id: '', title: draft.title.trim(), description: draft.description.trim(),
          location: draft.location.trim(), start: day(0), end: day(1), allDay: true, timeZone
        }, false)
        if (!result.ok) throw new Error(result.error)
      } else {
        const stamp = (time: string, offsetDays = 0) => {
          const [hours, minutes] = time.split(':').map(Number)
          const d = new Date(sy, sm - 1, sd + offsetDays, hours || 0, minutes || 0)
          return d.toISOString()
        }
        let end = stamp(draft.end)
        if (new Date(end) <= new Date(stamp(draft.start))) end = stamp(draft.end, 1)
        const result = await window.notch.calendar.save(picked, {
          id: '', title: draft.title.trim(), description: draft.description.trim(),
          location: draft.location.trim(), start: stamp(draft.start), end, allDay: false, timeZone
        }, false)
        if (!result.ok) throw new Error(result.error)
      }
      if (!alive.current) return
      setEditing(false)
      setDraft({ title: '', start: '09:00', end: '10:00', allDay: false, location: '', description: '' })
      showToast('Event added', `Saved to ${calendars?.find((entry) => entry.id === picked)?.name || 'Google Calendar'}`, 'success')
      void loadEvents(picked, date)
    } catch (cause) {
      if (!alive.current) return
      showToast('Could not save the event', cause instanceof Error ? cause.message : String(cause), 'error')
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  const usable = phase === 'ready' && picked

  return (
    <div className="google-calendar-agenda">
      <div className="google-calendar-heading">
        <span className="eyebrow">Google Calendar · {dateLabel}</span>
        {usable && (
          <span className="google-calendar-actions">
            <button
              className="icon-button subtle"
              aria-label="Refresh events"
              disabled={loadingEvents}
              onClick={() => void loadEvents(picked!, date)}
            >
              <RefreshCw size={11} className={loadingEvents ? 'spin' : ''} />
            </button>
            <button className="soft-button compact" onClick={() => setEditing((value) => !value)}>
              <Plus size={12} /> Add event
            </button>
          </span>
        )}
      </div>

      {phase === 'checking' && (
        <p className="google-calendar-hint"><Loader2 size={11} className="spin" /> Checking your Google Calendar…</p>
      )}

      {phase === 'connecting' && (
        <p className="google-calendar-hint">
          <Loader2 size={11} className="spin" /> Finish the sign-in in your browser — Notch picks it up automatically.
          <button className="soft-button compact" onClick={() => void window.notch.calendar.cancelConnect()}>
            Cancel
          </button>
        </p>
      )}

      {phase === 'error' && (
        <>
          {error ? (
            <>
              <p className="google-calendar-error">{error}</p>
              {error.includes('not available yet') && (
                <p className="google-calendar-hint">The Todaywise service is not deployed yet — connect will work once it is live.</p>
              )}
              <button className="soft-button compact" onClick={() => void connect()}>
                <ExternalLink size={11} /> Try connecting anyway
              </button>
            </>
          ) : (
            <>
              <p className="google-calendar-hint">See your day at a glance. Nothing leaves this machine except the events themselves.</p>
              <button className="soft-button compact" onClick={() => void connect()}>
                <ExternalLink size={11} /> Connect Google Calendar
              </button>
            </>
          )}
        </>
      )}

      {usable && calendars && (
        <div className="google-calendar-actions">
          <label>
            <span className="google-calendar-hint">Calendar</span>
            <select
              value={picked || ''}
              onChange={(event) => {
                const id = event.target.value
                setPicked(id)
                localStorage.setItem(STORAGE_KEY, id)
                void loadEvents(id, date)
              }}
            >
              {calendars.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {usable && editing && (
        <form
          className="google-calendar-editor"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <fieldset>
            <label>
              <span>Title</span>
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus placeholder="What is happening?" />
            </label>
            {!draft.allDay && (
              <div className="google-calendar-actions">
                <label>
                  <span>Starts</span>
                  <input type="time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
                </label>
                <label>
                  <span>Ends</span>
                  <input type="time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
                </label>
                <label className="google-calendar-hint">
                  <input type="checkbox" checked={draft.allDay} onChange={(e) => setDraft({ ...draft, allDay: e.target.checked })} />
                  All day
                </label>
              </div>
            )}
            {draft.allDay && (
              <label className="google-calendar-hint">
                <input type="checkbox" checked={draft.allDay} onChange={(e) => setDraft({ ...draft, allDay: e.target.checked })} />
                All day
              </label>
            )}
            <label>
              <span>Place (optional)</span>
              <input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} placeholder="Where?" />
            </label>
            <label>
              <span>Notes (optional)</span>
              <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={2} />
            </label>
            <div className="google-calendar-actions">
              <button type="submit" className="primary-button compact" disabled={saving || !draft.title.trim()}>
                {saving ? 'Saving…' : 'Add to Google'}
              </button>
              <button type="button" className="soft-button compact" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </fieldset>
        </form>
      )}

      {usable && (
        <div className="google-calendar-events">
          {loadingEvents && !events && <p className="google-calendar-hint">Loading events…</p>}
          {events && events.length === 0 && (
            <p className="google-calendar-hint"><CalendarDays size={11} /> Nothing on this day.</p>
          )}
          {events && events.length > 0 && (
            <>
              {events.map((event) => (
                <div className="google-calendar-event" key={event.id}>
                  <div>
                    <strong>{event.title || '(no title)'}</strong>
                    <span className="google-calendar-hint">
                      {event.allDay
                        ? 'All day'
                        : `${formatClock(event.start)} – ${formatClock(event.end)}`}
                      {event.location ? ` · ${event.location}` : ''}
                    </span>
                  </div>
                  {event.url && (
                    <a className="soft-button compact" href={event.url} target="_blank" rel="noreferrer" title="Open in Google Calendar">
                      <ExternalLink size={10} />
                    </a>
                  )}
                </div>
              ))}
              {truncated && <p className="google-calendar-hint">Showing the first events of a packed day.</p>}
            </>
          )}
          {error && <p className="google-calendar-error">{error}</p>}
        </div>
      )}
    </div>
  )
}

function formatClock(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
