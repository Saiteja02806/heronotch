export interface ForegroundSample {
  process: string
  fullscreen: boolean
  /** The foreground window belongs to Notch itself. */
  own: boolean
  browserOpen: boolean
}

export interface PresenceSettings {
  autoHideFullscreen?: boolean
  browserOnly?: boolean
  neverOver?: string[]
}

function cleanName(value: string): string {
  return value.trim().toLowerCase().replace(/\.exe$/, '')
}

export function shouldAutoHide(
  sample: ForegroundSample | null,
  settings: PresenceSettings,
  explicitOpen = false
): boolean {
  if (settings.browserOnly && !sample?.browserOpen && !explicitOpen) return true
  if (!sample || sample.own || !sample.process) return false
  const blocked = (settings.neverOver || []).some((name) => cleanName(name) === cleanName(sample.process))
  if (blocked) return true
  if (settings.autoHideFullscreen === false) return false
  return sample.fullscreen
}
