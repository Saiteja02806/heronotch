export interface TimeZonePreset {
  id: string
  label: string
  region: string
}

export const PLANNER_TIME_ZONES: TimeZonePreset[] = [
  { id: 'Asia/Kolkata', label: 'India (IST)', region: 'Asia/Kolkata' },
  { id: 'America/New_York', label: 'US Eastern (ET)', region: 'America/New_York' },
  { id: 'America/Chicago', label: 'US Central (CT)', region: 'America/Chicago' },
  { id: 'America/Denver', label: 'US Mountain (MT)', region: 'America/Denver' },
  { id: 'America/Los_Angeles', label: 'US Pacific (PT)', region: 'America/Los_Angeles' },
  { id: 'Asia/Shanghai', label: 'China (CST)', region: 'Asia/Shanghai' },
  { id: 'Asia/Tokyo', label: 'Japan (JST)', region: 'Asia/Tokyo' },
  { id: 'Asia/Singapore', label: 'Singapore (SGT)', region: 'Asia/Singapore' },
  { id: 'Asia/Dubai', label: 'Dubai (GST)', region: 'Asia/Dubai' },
  { id: 'Europe/London', label: 'UK (London)', region: 'Europe/London' },
  { id: 'Europe/Berlin', label: 'Central Europe (CET)', region: 'Europe/Berlin' },
  { id: 'Australia/Sydney', label: 'Australia (Sydney)', region: 'Australia/Sydney' },
  { id: 'UTC', label: 'UTC', region: 'UTC' }
]

const CANONICAL_ALIASES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Etc/UTC': 'UTC',
  'Etc/GMT': 'UTC',
  GMT: 'UTC'
}

const KNOWN_SHORT_NAMES: Record<string, string> = {
  'Asia/Kolkata': 'IST',
  'Asia/Shanghai': 'CST',
  'Asia/Tokyo': 'JST',
  'Asia/Singapore': 'SGT',
  'Asia/Dubai': 'GST',
  UTC: 'UTC'
}

const pad = (value: number, length = 2): string => String(value).padStart(length, '0')

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format(0)
    return true
  } catch {
    return false
  }
}

export function canonicalTimeZone(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'UTC'
  const trimmed = value.trim()
  const mapped = CANONICAL_ALIASES[trimmed] || trimmed
  return isValidTimeZone(mapped) ? mapped : isValidTimeZone(trimmed) ? trimmed : 'UTC'
}

export function resolveSystemTimeZone(): string {
  return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
}

/**
 * Plan shows times the way Google Calendar does: in the picked calendar's zone,
 * falling back to the PC zone until a calendar is known.
 */
export function resolvePlannerTimeZone(calendarTimeZone?: string | null): string {
  return isValidTimeZone(calendarTimeZone)
    ? canonicalTimeZone(calendarTimeZone)
    : resolveSystemTimeZone()
}

export interface ZonedDateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export function getZonedParts(epochMs: number, timeZone: string): ZonedDateParts {
  const zone = canonicalTimeZone(timeZone)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
  const parts = formatter.formatToParts(new Date(epochMs))
  const pick = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value || '0')
  const rawHour = pick('hour')
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: pick('minute'),
    second: pick('second')
  }
}

export function getTimeZoneOffsetMinutes(epochMs: number, timeZone: string): number {
  const parts = getZonedParts(epochMs, timeZone)
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  )
  const roundedEpoch = Math.floor(epochMs / 1000) * 1000
  return Math.round((asUtc - roundedEpoch) / 60_000)
}

export function formatOffsetString(offsetMinutes: number): string {
  if (offsetMinutes === 0) return 'Z'
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const hours = Math.floor(abs / 60)
  const minutes = abs % 60
  return `${sign}${pad(hours)}:${pad(minutes)}`
}

export function formatOffsetBadge(offsetMinutes: number): string {
  if (offsetMinutes === 0) return 'UTC'
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const hours = Math.floor(abs / 60)
  const minutes = abs % 60
  return minutes ? `UTC${sign}${hours}:${pad(minutes)}` : `UTC${sign}${hours}`
}

export function shortTimeZoneLabel(timeZone: string, at = Date.now()): string {
  const zone = canonicalTimeZone(timeZone)
  if (KNOWN_SHORT_NAMES[zone]) return KNOWN_SHORT_NAMES[zone]
  try {
    const token = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'short'
    })
      .formatToParts(new Date(at))
      .find((part) => part.type === 'timeZoneName')?.value
    if (token && !/^GMT[+-]/i.test(token)) return token
  } catch {
    // Fall back to offset badge below.
  }
  return formatOffsetBadge(getTimeZoneOffsetMinutes(at, zone))
}

export function friendlyTimeZoneLabel(timeZone: string, at = Date.now()): string {
  const zone = canonicalTimeZone(timeZone)
  const preset = PLANNER_TIME_ZONES.find((entry) => entry.id === zone)
  const offset = formatOffsetBadge(getTimeZoneOffsetMinutes(at, zone))
  if (preset) return preset.id === 'UTC' ? 'UTC' : `${preset.label} · ${offset}`
  const city = zone.split('/').pop()?.replace(/_/g, ' ') || zone
  return `${city} (${offset})`
}

export function sameTimeZoneOffset(left: string, right: string, at = Date.now()): boolean {
  const a = canonicalTimeZone(left)
  const b = canonicalTimeZone(right)
  if (a === b) return true
  return getTimeZoneOffsetMinutes(at, a) === getTimeZoneOffsetMinutes(at, b)
}

export function shiftCalendarDate(date: string, deltaDays: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ''
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays))
  return shifted.toISOString().slice(0, 10)
}

/**
 * Convert a wall-clock `YYYY-MM-DD` + `HH:mm` in `timeZone` to epoch ms.
 * Refines the UTC offset twice so DST transitions resolve accurately.
 */
export function zonedDateTimeToTimestamp(
  date: string,
  time: string,
  timeZone = resolveSystemTimeZone(),
  options?: { allowDstGap?: boolean }
): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim())
  if (!match) return null
  const [year, month, day] = date.split('-').map(Number)
  const hour = Number(match[1])
  const minute = Number(match[2])
  const second = Number(match[3] || '0')
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null
  }
  const check = new Date(Date.UTC(year, month - 1, day))
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null
  }

  const zone = canonicalTimeZone(timeZone)
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  let offset = getTimeZoneOffsetMinutes(wallUtc, zone)
  let epoch = wallUtc - offset * 60_000
  const refinedOffset = getTimeZoneOffsetMinutes(epoch, zone)
  if (refinedOffset !== offset) {
    const candidate = wallUtc - refinedOffset * 60_000
    const candidateParts = getZonedParts(candidate, zone)
    if (
      candidateParts.year === year &&
      candidateParts.month === month &&
      candidateParts.day === day &&
      candidateParts.hour === hour &&
      candidateParts.minute === minute
    ) {
      epoch = candidate
      offset = refinedOffset
    } else if (!options?.allowDstGap) {
      return null
    }
  }

  const verified = getZonedParts(epoch, zone)
  const exact =
    verified.year === year &&
    verified.month === month &&
    verified.day === day &&
    verified.hour === hour &&
    verified.minute === minute
  if (!exact && !options?.allowDstGap) return null
  return epoch
}

export function zonedDateTimeToIso(
  dateTimeLocal: string,
  timeZone = resolveSystemTimeZone()
): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/.exec(dateTimeLocal.trim())
  if (!match) throw new Error('Enter valid event times in your selected time zone.')
  const zone = canonicalTimeZone(timeZone)
  const epoch = zonedDateTimeToTimestamp(
    match[1],
    `${match[2]}:${match[3] || '00'}`,
    zone,
    { allowDstGap: false }
  )
  if (epoch === null) {
    throw new Error('Enter valid event times in your selected time zone.')
  }
  const parts = getZonedParts(epoch, zone)
  const offset = getTimeZoneOffsetMinutes(epoch, zone)
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${formatOffsetString(offset)}`
}

export function formatDateTimeInZone(
  value: string | number,
  timeZone = resolveSystemTimeZone()
): string {
  const epoch = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(epoch)) return ''
  const parts = getZonedParts(epoch, timeZone)
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`
}

export function formatDateKeyInZone(
  epochMs: number,
  timeZone = resolveSystemTimeZone()
): string {
  const parts = getZonedParts(epochMs, timeZone)
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`
}

export function todayKeyInZone(timeZone = resolveSystemTimeZone()): string {
  return formatDateKeyInZone(Date.now(), timeZone)
}

export function dayBoundsInTimeZone(
  date: string,
  timeZone = resolveSystemTimeZone()
): { startMs: number; endMs: number; startIso: string; endIso: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const zone = canonicalTimeZone(timeZone)
  const next = shiftCalendarDate(date, 1)
  if (!next) return null
  const startMs = zonedDateTimeToTimestamp(date, '00:00', zone, { allowDstGap: true })
  const endMs = zonedDateTimeToTimestamp(next, '00:00', zone, { allowDstGap: true })
  if (startMs === null || endMs === null || endMs <= startMs) return null
  return {
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString()
  }
}

export function formatClockInZone(
  value: string | number,
  timeZone = resolveSystemTimeZone(),
  dropZeroMinutes = true
): string {
  const epoch = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(epoch)) return String(value)
  const zone = canonicalTimeZone(timeZone)
  const parts = getZonedParts(epoch, zone)
  if (dropZeroMinutes && parts.minute === 0) {
    return new Date(epoch).toLocaleTimeString([], { timeZone: zone, hour: 'numeric' })
  }
  return new Date(epoch).toLocaleTimeString([], {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function clockRangeInZone(
  start: string,
  end: string,
  timeZone = resolveSystemTimeZone()
): string {
  const from = formatClockInZone(start, timeZone, true)
  const to = formatClockInZone(end, timeZone, true)
  const split = (value: string): { time: string; suffix: string } => {
    const match = value.match(/^(.*?)\s*([^\d\s.:]+)$/)
    return match ? { time: match[1], suffix: match[2] } : { time: value, suffix: '' }
  }
  const left = split(from)
  const right = split(to)
  if (left.suffix && left.suffix.toLowerCase() === right.suffix.toLowerCase()) {
    return `${left.time} – ${to}`
  }
  return `${from} – ${to}`
}

export function clockSortKeyInZone(
  value: string,
  timeZone = resolveSystemTimeZone()
): string {
  const epoch = Date.parse(value)
  if (Number.isNaN(epoch)) return '99:99'
  const parts = getZonedParts(epoch, timeZone)
  return `${pad(parts.hour)}:${pad(parts.minute)}`
}

export function convertTaskSchedule(
  date: string,
  time: string | undefined,
  fromTimeZone: string | undefined,
  toTimeZone: string
): { date: string; time?: string; timestamp: number | null; shifted: boolean } {
  if (!time) return { date, time: undefined, timestamp: null, shifted: false }
  const sourceZone = isValidTimeZone(fromTimeZone)
    ? canonicalTimeZone(fromTimeZone)
    : resolveSystemTimeZone()
  const targetZone = canonicalTimeZone(toTimeZone)
  const timestamp = zonedDateTimeToTimestamp(date, time, sourceZone, { allowDstGap: true })
  if (timestamp === null) return { date, time, timestamp: null, shifted: false }
  if (sourceZone === targetZone) {
    return { date, time, timestamp, shifted: false }
  }
  const parts = getZonedParts(timestamp, targetZone)
  const nextDate = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`
  const nextTime = `${pad(parts.hour)}:${pad(parts.minute)}`
  return {
    date: nextDate,
    time: nextTime,
    timestamp,
    shifted: nextDate !== date || nextTime !== time
  }
}

export function formatTaskClock(
  date: string,
  time: string,
  timeZone = resolveSystemTimeZone(),
  dropZeroMinutes = false
): string {
  const ts = zonedDateTimeToTimestamp(date, time, timeZone, { allowDstGap: true })
  if (ts === null) return time
  return formatClockInZone(ts, timeZone, dropZeroMinutes)
}
