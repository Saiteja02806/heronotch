import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2, MoreHorizontal, RefreshCw } from 'lucide-react'
import type { GoogleCalendarBook } from '../state/useGoogleCalendar'

/**
 * The calendar's connection and target, kept deliberately small: the day itself
 * shows the events, so this card never repeats them.
 */
export function GoogleCalendarStrip({ book }: { book: GoogleCalendarBook }) {
  const [manageOpen, setManageOpen] = useState(false)
  const manageRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!manageOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (manageRef.current && !manageRef.current.contains(event.target as Node)) setManageOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setManageOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [manageOpen])

  const reconnect = useCallback(() => {
    setManageOpen(false)
    void book.connect()
  }, [book])

  const disconnect = useCallback(() => {
    setManageOpen(false)
    void book.disconnect()
  }, [book])

  return (
    <div className="side-card google-side">
      <div className="side-card-head">
        <span className="eyebrow">Google Calendar</span>
        {book.phase === 'ready' && (
          <span className="google-strip-actions">
            <button
              className="icon-button subtle"
              aria-label="Refresh events"
              title="Refresh events"
              disabled={book.loading}
              onClick={book.reload}
            >
              <RefreshCw size={11} className={book.loading ? 'spin' : ''} />
            </button>
            <div className="google-calendar-manage" ref={manageRef}>
              <button
                className="icon-button subtle"
                aria-label="Google Calendar settings"
                aria-haspopup="menu"
                aria-expanded={manageOpen}
                title="Google Calendar settings"
                onClick={() => setManageOpen((value) => !value)}
              >
                <MoreHorizontal size={13} />
              </button>
              {manageOpen && (
                <div className="google-calendar-menu" role="menu">
                  <button className="soft-button compact" role="menuitem" disabled={book.saving} onClick={reconnect}>
                    Reconnect
                  </button>
                  <button className="soft-button compact" role="menuitem" disabled={book.saving} onClick={disconnect}>
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          </span>
        )}
      </div>

      {book.phase === 'checking' && (
        <p className="google-strip-note">
          <Loader2 size={11} className="spin" /> Checking your Google Calendar…
        </p>
      )}

      {book.phase === 'connecting' && (
        <p className="google-strip-note">
          <Loader2 size={11} className="spin" /> Finish the sign-in in your browser — Notch picks it up
          automatically.
          <button className="soft-button compact" onClick={() => void window.notch.calendar.cancelConnect()}>
            Cancel
          </button>
        </p>
      )}

      {book.phase === 'error' && (
        <>
          {book.error ? (
            <>
              <p className="google-strip-note is-error">{book.error}</p>
              <button className="soft-button compact" onClick={() => void book.connect()}>
                <ExternalLink size={11} /> Try connecting anyway
              </button>
            </>
          ) : (
            <>
              <p className="google-strip-note">
                Connect to add your Google events to this day. Tasks you write here are saved to the
                same calendar.
              </p>
              <button className="soft-button compact" onClick={() => void book.connect()}>
                <ExternalLink size={11} /> Connect Google Calendar
              </button>
            </>
          )}
        </>
      )}

      {book.phase === 'ready' && (
        <>
          {book.calendars && book.calendars.length > 0 && (
            <label className="google-strip-field">
              <select
                value={book.picked || ''}
                aria-label="Calendar"
                onChange={(event) => book.setPicked(event.target.value)}
              >
                {book.calendars.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!book.calendars && <p className="google-strip-note">Loading calendars…</p>}
          {book.calendars && !book.picked && (
            <p className="google-strip-note">{book.error || 'No Google calendars available.'}</p>
          )}
          {book.picked && (
            <p className="google-strip-note">
              {book.canSync
                ? 'Tasks you add here are written to this calendar, and its events appear in the day.'
                : 'This calendar is read only, so tasks stay local.'}
            </p>
          )}
          {book.pending.exists && (
            <div className="google-strip-pending">
              <p className="google-strip-note">
                Google has not confirmed the last save. Retrying sends the same request.
              </p>
              <span className="google-strip-actions">
                <button className="soft-button compact" disabled={book.saving} onClick={() => void book.pending.save()}>
                  Retry save
                </button>
                <button className="soft-button compact" disabled={book.saving} onClick={book.pending.clear}>
                  Dismiss
                </button>
              </span>
            </div>
          )}
          {book.error && !book.pending.exists && <p className="google-strip-note is-error">{book.error}</p>}
        </>
      )}
    </div>
  )
}
