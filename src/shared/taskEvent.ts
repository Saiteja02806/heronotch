import type { CalendarDraft } from './calendar'
import {
  canonicalTimeZone,
  formatDateTimeInZone,
  resolveSystemTimeZone,
  shiftCalendarDate,
  zonedDateTimeToTimestamp
} from './timeZone'

/** Google Calendar accepts a client-supplied event id of 32 lowercase hex characters. */
export function newEventId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const TASK_EVENT_MINUTES = 30

export interface TaskEventSource {
  title: string
  notes?: string
  date: string
  time?: string
  timeZone?: string
}

/**
 * A task becomes a calendar event: timed tasks get a 30 minute block in the
 * active time zone, timeless tasks become an all-day event. Only tasks without
 * a time are allowed to span the day, so an end always follows the start.
 */
export function taskEventDraft(
  source: TaskEventSource,
  eventId: string,
  etag?: string,
  timeZone?: string
): CalendarDraft {
  const zone = canonicalTimeZone(timeZone || source.timeZone || resolveSystemTimeZone())
  const draft: CalendarDraft = {
    id: eventId,
    etag,
    title: source.title.trim(),
    description: source.notes?.trim() || '',
    location: '',
    allDay: !source.time,
    start: source.date,
    end: shiftCalendarDate(source.date, 1),
    timeZone: zone
  }
  if (!source.time) return draft

  const startEpoch = zonedDateTimeToTimestamp(source.date, source.time, zone, {
    allowDstGap: true
  })
  if (startEpoch === null) {
    return {
      ...draft,
      allDay: false,
      start: `${source.date}T09:00`,
      end: `${source.date}T09:30`
    }
  }
  const endEpoch = startEpoch + TASK_EVENT_MINUTES * 60_000
  return {
    ...draft,
    allDay: false,
    start: formatDateTimeInZone(startEpoch, zone),
    end: formatDateTimeInZone(endEpoch, zone)
  }
}
