import { canonicalTimeZone, dayBoundsInTimeZone, resolveSystemTimeZone } from './timeZone'

export interface CalendarStatus {
  configured: boolean
  signedIn: boolean
  connected: boolean
  userId: string | null
  email: string | null
}

export interface GoogleCalendar {
  id: string
  name: string
  primary: boolean
  writable: boolean
  timeZone: string
}

export interface CalendarEvent {
  id: string
  etag: string
  title: string
  description: string
  location: string
  start: string
  end: string
  allDay: boolean
  timeZone: string
  url: string | null
}

/**
 * A day is requested as an absolute time range, so Google also returns an
 * all-day event that belongs to the previous day (it starts before midnight in
 * the active time zone). Keep only events that really sit on `date` in
 * `timeZone`, including multi-day all-day events whose end date is exclusive.
 */
export function eventBelongsToDay(
  event: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>,
  date: string,
  timeZone?: string
): boolean {
  const dayOf = (value: string): string => String(value || '').slice(0, 10)
  if (event.allDay) {
    const from = dayOf(event.start)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return true
    const to = dayOf(event.end)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to) || to <= from) return date === from
    return from <= date && date < to
  }
  const start = Date.parse(event.start)
  if (Number.isNaN(start)) return true
  const end = Date.parse(event.end)
  const bounds = dayBoundsInTimeZone(date, timeZone || resolveSystemTimeZone())
  if (!bounds) return true
  return start < bounds.endMs && (Number.isNaN(end) ? start : end) > bounds.startMs
}

export interface CalendarDraft {
  id: string
  etag?: string
  title: string
  description: string
  location: string
  start: string
  end: string
  allDay: boolean
  timeZone: string
}

export interface CachedCalendarDay {
  events: CalendarEvent[]
  truncated: boolean
  fetchedAt: number
}

export interface CalendarSnapshot {
  version: 1
  userId: string
  email: string | null
  status: CalendarStatus
  statusFetchedAt: number
  calendars: GoogleCalendar[] | null
  calendarsFetchedAt: number
  picked: string | null
  days: Record<string, CachedCalendarDay>
}

export const CALENDAR_CACHE_MAX_DAYS = 30

export function calendarDayCacheKey(calendarId: string, date: string, timeZone?: string): string {
  const zone = timeZone ? canonicalTimeZone(timeZone) : resolveSystemTimeZone()
  return `${calendarId}\n${date}\n${zone}`
}

export function pruneDayCacheEntries(
  days: Record<string, CachedCalendarDay>,
  maxDays = CALENDAR_CACHE_MAX_DAYS
): Record<string, CachedCalendarDay> {
  const entries = Object.entries(days)
  if (entries.length <= maxDays) return days
  entries.sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
  return Object.fromEntries(entries.slice(0, maxDays))
}

export interface CalendarApi {
  snapshot(): Promise<CalendarSnapshot | null>
  status(): Promise<CalendarStatus>
  connect(): Promise<CalendarStatus>
  cancelConnect(): Promise<void>
  disconnect(): Promise<void>
  calendars(): Promise<GoogleCalendar[]>
  events(
    calendarId: string,
    date: string,
    timeZone?: string
  ): Promise<{ events: CalendarEvent[]; truncated: boolean }>
  save(calendarId: string, draft: CalendarDraft, editing: boolean): Promise<CalendarSaveResult>
  remove(calendarId: string, eventId: string): Promise<CalendarDeleteResult>
}

export type CalendarDeleteResult = { ok: true } | { ok: false; error: string }

export type CalendarSaveResult =
  | { ok: true; event: CalendarEvent }
  | { ok: false; error: string; uncertain: boolean }
