import { screen } from 'electron'
import type { NotchDisplay, NotchStyle } from '../shared/types'
import { getState } from './state'

/**
 * Which display the notch lives on.
 *
 * The setting stores `primary` or a display id. A monitor that is unplugged
 * falls back to the primary one, and comes back when it is plugged in again
 * because the saved id is checked on every layout pass.
 */
export function notchDisplay(): Electron.Display {
  const wanted = getState().settings.notchDisplay
  if (wanted && wanted !== 'primary') {
    const found = screen.getAllDisplays().find((display) => String(display.id) === wanted)
    if (found) return found
  }
  return screen.getPrimaryDisplay()
}

export function isPrimaryDisplay(display: Electron.Display): boolean {
  return display.id === screen.getPrimaryDisplay().id
}

/** On a second monitor the physical notch is missing, so a small pill reads better. */
export function effectiveNotchStyle(display: Electron.Display): NotchStyle {
  const settings = getState().settings
  const style = settings.notchStyle || 'minimal'
  if (isPrimaryDisplay(display)) return style
  if (settings.pillOnOtherDisplays === false) return style
  return 'pill-tiny'
}

/** Physical pixels, which is what the Windows foreground watcher compares against. */
export function displayPhysicalSize(display: Electron.Display): { width: number; height: number } {
  const scale = display.scaleFactor || 1
  return {
    width: Math.round(display.bounds.width * scale),
    height: Math.round(display.bounds.height * scale)
  }
}

export function listDisplays(): NotchDisplay[] {
  const primary = screen.getPrimaryDisplay()
  return screen.getAllDisplays().map((display, index) => ({
    id: String(display.id),
    label: display.label?.trim() || `Display ${index + 1}`,
    width: Math.round(display.bounds.width),
    height: Math.round(display.bounds.height),
    primary: display.id === primary.id
  }))
}
