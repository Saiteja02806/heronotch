import type { NotchPosition, NotchStyle } from './types'

/**
 * Geometry shared by the main process and the renderer.
 *
 * The saved anchor places the *visible tab* inside the work area, using the
 * same formula as the Settings map: top-left = anchor × (area − tab size).
 * The window is only a larger, mostly invisible box so a notice can unfold
 * and Windows can keep a click-through margin. It is shifted so the tab stays
 * on the anchor.
 *
 * The open panel is not anchored to the same point. It is a top-docked card
 * (flat top, rounded bottom). It stays on the top edge and lines up
 * horizontally with the tab, clamped on screen. A bottom or corner anchor
 * still grows into that top edge instead of hanging a 600px card off the
 * bottom of the display.
 */

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface TabMetrics {
  x: number
  y: number
  width: number
  height: number
  radius: number
}

export interface NotchMetrics {
  /** Tab origin inside the collapsed window. */
  tab: TabMetrics
  /** Tab origin on screen. The open animation flies back to this point. */
  tabScreen: { x: number; y: number; width: number; height: number }
  noticeAbove: boolean
}

interface TabSpec {
  width: number
  height: number
  radius: number
}

export const TAB_SPECS: Record<NotchStyle, TabSpec> = {
  full: { width: 400, height: 38, radius: 16 },
  compact: { width: 320, height: 32, radius: 14 },
  minimal: { width: 200, height: 28, radius: 12 },
  pill: { width: 320, height: 32, radius: 999 },
  'pill-tiny': { width: 120, height: 22, radius: 999 },
  'notch-wide': { width: 240, height: 30, radius: 14 },
  'notch-micro': { width: 110, height: 20, radius: 10 }
}

const NOTICE_WIDTH = 368
const NOTICE_GAP = 8
const NOTICE_BLOCK = 64
const WINDOW_PAD = 8

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return clamp(value, 0, 1)
}

export function tabSpec(style: NotchStyle | undefined, workWidth: number): TabSpec {
  const spec = TAB_SPECS[style || 'minimal'] || TAB_SPECS.minimal
  return {
    width: Math.round(Math.min(spec.width, Math.max(80, workWidth - 12))),
    height: spec.height,
    radius: spec.radius
  }
}

export function tabScreenBox(anchor: NotchPosition | undefined, work: Box, style: NotchStyle | undefined): Box {
  const spec = tabSpec(style, work.width)
  const x = work.x + clamp01(anchor?.x ?? 0.5) * Math.max(0, work.width - spec.width)
  const y = work.y + clamp01(anchor?.y ?? 0) * Math.max(0, work.height - spec.height)
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: spec.width,
    height: spec.height
  }
}

export interface CollapsedLayout {
  window: Box
  metrics: NotchMetrics
}

export function collapsedLayout(
  anchor: NotchPosition | undefined,
  work: Box,
  style: NotchStyle | undefined
): CollapsedLayout {
  const spec = tabSpec(style, work.width)
  const tab = tabScreenBox(anchor, work, style)
  const roomBelow = work.y + work.height - (tab.y + tab.height)
  const noticeAbove = roomBelow < NOTICE_GAP + NOTICE_BLOCK

  const windowWidth = Math.min(work.width, Math.max(tab.width, NOTICE_WIDTH) + WINDOW_PAD * 2)
  const windowHeight = Math.min(work.height, tab.height + NOTICE_GAP + NOTICE_BLOCK + WINDOW_PAD)

  let windowX = Math.round(tab.x + tab.width / 2 - windowWidth / 2)
  let windowY = noticeAbove
    ? Math.round(tab.y + tab.height + WINDOW_PAD - windowHeight)
    : Math.round(tab.y)

  windowX = Math.round(clamp(windowX, work.x, work.x + work.width - windowWidth))
  windowY = Math.round(clamp(windowY, work.y, work.y + work.height - windowHeight))

  const tabX = Math.round(clamp(tab.x - windowX, 0, windowWidth - tab.width))
  const tabY = Math.round(clamp(tab.y - windowY, 0, windowHeight - tab.height))

  return {
    window: {
      x: windowX,
      y: windowY,
      width: Math.round(windowWidth),
      height: Math.round(windowHeight)
    },
    metrics: {
      tab: {
        x: tabX,
        y: tabY,
        width: tab.width,
        height: tab.height,
        radius: Math.min(spec.radius, tab.height / 2)
      },
      tabScreen: { x: tab.x, y: tab.y, width: tab.width, height: tab.height },
      noticeAbove
    }
  }
}

/** Matches the panel's CSS caps so the flight ends on the settled size. */
export function dockedPanelSize(
  viewportWidth: number,
  viewportHeight: number,
  compact: boolean
): { width: number; height: number } {
  if (compact) {
    // A short single-column card. Keep this in step with the compact panel
    // rule in styles.css — the flight lands on these numbers.
    return {
      width: Math.round(Math.min(440, viewportWidth - 32)),
      height: Math.round(Math.min(360, Math.max(300, viewportHeight * 0.42)))
    }
  }
  return {
    width: Math.round(Math.min(1120, Math.max(900, viewportWidth * 0.76), viewportWidth - 40)),
    height: Math.round(Math.min(600, Math.max(560, viewportHeight * 0.72)))
  }
}

/** Horizontal alignment with the tab, kept fully on screen. Top stays 0. */
export function dockedPanelLeft(tabCenter: number, panelWidth: number, viewportWidth: number): number {
  const margin = 20
  const maxLeft = Math.max(margin, viewportWidth - panelWidth - margin)
  return Math.round(clamp(tabCenter - panelWidth / 2, margin, maxLeft))
}

/** Settings map glyph. Same anchor math as the real tab; sized so it stays grabbable. */
export function placementPreview(style: NotchStyle | undefined): { width: number; height: number; radius: number } {
  const spec = TAB_SPECS[style || 'minimal'] || TAB_SPECS.minimal
  const width = Math.round(28 + ((spec.width - 110) / (400 - 110)) * 78)
  const height = Math.round(8 + ((spec.height - 20) / (38 - 20)) * 8)
  return {
    width,
    height,
    radius: spec.radius >= 999 ? 999 : Math.max(4, Math.round(spec.height * 0.35))
  }
}
