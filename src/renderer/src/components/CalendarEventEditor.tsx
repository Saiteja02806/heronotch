import { useState, type FormEvent } from 'react'
import { Trash2, X } from 'lucide-react'
import type { CalendarDraft, CalendarEvent } from '../../../shared/calendar'
import { calendarDraftFromEvent, nextDay } from '../../../shared/calendarDraft'
import { shortTimeZoneLabel } from '../lib/time'
import { useApp } from '../state/AppContext'
import type { GoogleCalendarBook } from '../state/useGoogleCalendar'

/**
 * Calendar events are edited where they are read: in the day. Tasks own their
 * mirrored event, so only events that no task points at are opened here.
 */
export function CalendarEventEditor({
  event,
  book,
  timeZone,
  onClose
}: {
  event: CalendarEvent
  book: GoogleCalendarBook
  timeZone: string
  onClose: () => void
}) {
  const { showToast } = useApp()
  const [draft, setDraft] = useState<CalendarDraft>(() => calendarDraftFromEvent(event, timeZone))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const readOnly = !book.writable || !book.picked
  const activeZoneLabel = shortTimeZoneLabel(draft.timeZone || timeZone)

  const submit = async (native: FormEvent): Promise<void> => {
    native.preventDefault()
    if (!draft.title.trim()) {
      setError('Give the event a name.')
      return
    }
    setBusy(true)
    const result = await book.saveEvent(event, draft)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    showToast('Event updated', 'Saved to Google Calendar', 'success')
    onClose()
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    const result = await book.removeEvent(event.id)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    showToast('Event deleted', 'Removed from Google Calendar', 'success')
    onClose()
  }

  return (
    <form className="task-editor" onSubmit={(native) => void submit(native)}>
      <button type="button" className="task-editor-close" onClick={onClose} aria-label="Close">
        <X size={14} />
      </button>
      <span className="eyebrow">Google Calendar event</span>
      <input
        className="task-editor-title"
        value={draft.title}
        onChange={(native) => setDraft({ ...draft, title: native.target.value })}
        placeholder="What is happening?"
        disabled={readOnly || busy}
        autoFocus
      />
      <div className="task-editor-grid">
        {draft.allDay ? (
          <>
            <label>
              <span>Date</span>
              <input
                type="date"
                value={draft.start}
                disabled={readOnly || busy}
                onChange={(native) =>
                  setDraft({ ...draft, start: native.target.value, end: nextDay(native.target.value) })
                }
              />
            </label>
            <label>
              <span>Ends before</span>
              <input
                type="date"
                value={draft.end}
                disabled={readOnly || busy}
                onChange={(native) => setDraft({ ...draft, end: native.target.value })}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              <span>Starts ({activeZoneLabel})</span>
              <input
                type="datetime-local"
                value={draft.start}
                disabled={readOnly || busy}
                onChange={(native) => setDraft({ ...draft, start: native.target.value })}
              />
            </label>
            <label>
              <span>Ends ({activeZoneLabel})</span>
              <input
                type="datetime-local"
                value={draft.end}
                disabled={readOnly || busy}
                onChange={(native) => setDraft({ ...draft, end: native.target.value })}
              />
            </label>
          </>
        )}
      </div>
      <label className="task-editor-check">
        <input
          type="checkbox"
          checked={draft.allDay}
          disabled={readOnly || busy}
          onChange={(native) =>
            setDraft(
              native.target.checked
                ? { ...draft, allDay: true, start: draft.start.slice(0, 10), end: nextDay(draft.end.slice(0, 10)) }
                : { ...draft, allDay: false, start: `${draft.start.slice(0, 10)}T09:00`, end: `${draft.start.slice(0, 10)}T10:00` }
            )
          }
        />
        All day
      </label>
      <label>
        <span>Place (optional)</span>
        <input
          className="task-editor-line"
          value={draft.location}
          disabled={readOnly || busy}
          onChange={(native) => setDraft({ ...draft, location: native.target.value })}
          placeholder="Where?"
        />
      </label>
      <textarea
        value={draft.description}
        disabled={readOnly || busy}
        onChange={(native) => setDraft({ ...draft, description: native.target.value })}
        placeholder="Notes, links, an agenda…"
        rows={2}
      />
      {event.url?.startsWith('https://calendar.google.com/') && (
        <a className="event-editor-link" href={event.url} target="_blank" rel="noreferrer">
          Open in Google Calendar
        </a>
      )}
      {error && <span className="form-error">{error}</span>}
      <div className="modal-actions">
        <button type="button" className="danger-text link-button" disabled={readOnly || busy} onClick={() => void remove()}>
          <Trash2 size={12} /> Delete event
        </button>
        <span className="modal-spacer" />
        <button type="button" className="soft-button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="primary-button" disabled={readOnly || busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
      {readOnly && <span className="form-error">This calendar is read only.</span>}
    </form>
  )
}
