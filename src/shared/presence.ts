export interface ForegroundSample {
  process: string
  fullscreen: boolean
  /** The foreground window belongs to Notch itself. */
  own: boolean
}

export interface PresenceSettings {
  autoHideFullscreen?: boolean
  neverOver?: string[]
}

function cleanName(value: string): string {
  return value.trim().toLowerCase().replace(/\.exe$/, '')
}

/** Hide the tab over a fullscreen app, or over an app the user listed. */
export function shouldAutoHide(sample: ForegroundSample | null, settings: PresenceSettings): boolean {
  if (!sample || sample.own || !sample.process) return false
  const blocked = (settings.neverOver || []).some((name) => cleanName(name) === cleanName(sample.process))
  if (blocked) return true
  if (settings.autoHideFullscreen === false) return false
  return sample.fullscreen
}
