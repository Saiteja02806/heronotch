import { screen } from 'electron'
import type { NotchDisplay, NotchStyle } from '../shared/types'
import { demoDisplays, isDemoMode } from '@demo/main'
import { getState } from './state'

let demoStageBounds = { width: 1280, height: 720 }

export function setDemoStageSize(width: number, height: number): void {
  if (width > 100 && height > 100) {
    demoStageBounds = { width: Math.round(width), height: Math.round(height) }
  }
}

/**
 * Which display the notch lives on.
 *
 * The setting stores `primary` or a display id. A monitor that is unplugged
 * falls back to the primary one, and comes back when it is plugged in again
 * because the saved id is checked on every layout pass.
 */
export function notchDisplay(): Electron.Display {
  if (isDemoMode) {
    const wanted = getState().settings.notchDisplay
    const isSecondary = wanted === 'demo-win11'
    const base = screen.getPrimaryDisplay()
    return {
      ...base,
      id: isSecondary ? 2 : base.id,
      bounds: { x: 0, y: 0, width: demoStageBounds.width, height: demoStageBounds.height },
      workArea: { x: 0, y: 0, width: demoStageBounds.width, height: demoStageBounds.height },
      size: { width: demoStageBounds.width, height: demoStageBounds.height },
      workAreaSize: { width: demoStageBounds.width, height: demoStageBounds.height }
    }
  }
  const wanted = getState().settings.notchDisplay
  if (wanted && wanted !== 'primary') {
    const found = screen.getAllDisplays().find((display) => String(display.id) === wanted)
    if (found) return found
  }
  return screen.getPrimaryDisplay()
}

export function isPrimaryDisplay(display: Electron.Display): boolean {
  if (isDemoMode) return true
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

/** Physical pixels and screen center point, which is what the Windows foreground watcher compares against. */
export function displayPhysicalSize(display: Electron.Display): {
  width: number
  height: number
  centerX?: number
  centerY?: number
} {
  const scale = display.scaleFactor || 1
  let centerX: number | undefined
  let centerY: number | undefined
  try {
    const pt = screen.dipToScreenPoint({
      x: Math.round(display.bounds.x + display.bounds.width / 2),
      y: Math.round(display.bounds.y + display.bounds.height / 2)
    })
    centerX = Math.round(pt.x)
    centerY = Math.round(pt.y)
  } catch {
    // Fallback to size-only comparison if dipToScreenPoint is unavailable.
  }
  return {
    width: Math.round(display.bounds.width * scale),
    height: Math.round(display.bounds.height * scale),
    ...(centerX !== undefined && centerY !== undefined ? { centerX, centerY } : {})
  }
}

export function listDisplays(): NotchDisplay[] {
  if (isDemoMode) return demoDisplays()
  const primary = screen.getPrimaryDisplay()
  return screen.getAllDisplays().map((display, index) => ({
    id: String(display.id),
    label: display.label?.trim() || `Display ${index + 1}`,
    width: Math.round(display.bounds.width),
    height: Math.round(display.bounds.height),
    primary: display.id === primary.id
  }))
}
