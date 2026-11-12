export function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function todayKey(): string {
  return dateKey(new Date())
}

export function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, (month || 1) - 1, day || 1)
}

export function addDays(key: string, amount: number): string {
  const date = parseDateKey(key)
  date.setDate(date.getDate() + amount)
  return dateKey(date)
}

export function formatMinutes(minutes: number): string {
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest ? `${hours}h ${rest}m` : `${hours}h`
  }
  return `${minutes}m`
}

export function formatTimer(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${pad(minutes)}:${pad(seconds)}`
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${pad(seconds)}`
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function formatDateLong(key: string): string {
  return parseDateKey(key).toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })
}

export function formatDateShort(key: string): string {
  return parseDateKey(key).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function timeToTimestamp(date: string, time?: string): number | null {
  if (!time) return null
  const parsed = parseDateKey(date)
  const [hours, minutes] = time.split(':').map(Number)
  parsed.setHours(hours || 0, minutes || 0, 0, 0)
  return parsed.getTime()
}

export function isToday(key: string): boolean {
  return key === todayKey()
}

export function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
}

export function monthMatrix(year: number, month: number): (Date | null)[][] {
  const first = new Date(year, month, 1)
  const offset = (first.getDay() + 6) % 7
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const cells: (Date | null)[] = []
  for (let index = 0; index < offset; index += 1) cells.push(null)
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(new Date(year, month, day))
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: (Date | null)[][] = []
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7))
  return weeks
}

export function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 5) return 'Still up'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function percent(value: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)))
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
