import type { CalendarDraft, CalendarEvent } from './calendar'
import {
  canonicalTimeZone,
  formatDateTimeInZone,
  resolveSystemTimeZone,
  shiftCalendarDate,
  zonedDateTimeToIso
} from './timeZone'

export function nextDay(date: string): string {
  return shiftCalendarDate(date, 1)
}

export function newCalendarDraft(date: string, timeZone?: string): CalendarDraft {
  return {
    id: crypto.randomUUID().replace(/-/g, ''),
    title: '',
    description: '',
    location: '',
    start: `${date}T09:00`,
    end: `${date}T10:00`,
    allDay: false,
    timeZone: canonicalTimeZone(timeZone || resolveSystemTimeZone())
  }
}

export function calendarDraftFromEvent(
  event: CalendarEvent,
  displayTimeZone?: string
): CalendarDraft {
  const { id, etag, title, description, location, allDay, timeZone, start, end } = event
  const activeZone = canonicalTimeZone(displayTimeZone || timeZone || resolveSystemTimeZone())
  return {
    id,
    etag,
    title,
    description,
    location,
    allDay,
    timeZone: activeZone,
    start: allDay ? start : formatDateTimeInZone(start, activeZone),
    end: allDay ? end : formatDateTimeInZone(end, activeZone)
  }
}

export function serializeCalendarDraft(
  draft: CalendarDraft,
  original: CalendarEvent | null
): CalendarDraft {
  const zone = canonicalTimeZone(draft.timeZone || resolveSystemTimeZone())

  function timestamp(value: string, previous?: string): string {
    if (draft.allDay) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Enter valid event dates.')
      return value
    }
    if (previous && !original?.allDay && formatDateTimeInZone(previous, zone) === value) {
      return previous
    }
    return zonedDateTimeToIso(value, zone)
  }

  const start = timestamp(draft.start, original?.start)
  const end = timestamp(draft.end, original?.end)
  if (
    !draft.title.trim() ||
    !Number.isFinite(Date.parse(start)) ||
    !(Date.parse(end) > Date.parse(start))
  ) {
    throw new Error('Enter a title and an end after the start.')
  }
  return {
    ...draft,
    start,
    end,
    title: draft.title.trim(),
    timeZone: zone
  }
}
