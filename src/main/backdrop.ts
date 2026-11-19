import { app, desktopCapturer, screen } from 'electron'
import { notchDisplay } from './notchDisplay'

let cachedBackdrop: string | null = null
let cachedAt = 0
let inFlight: Promise<string | null> | null = null
let suspended = false

export function getCachedBackdrop(): string | null {
  return cachedBackdrop
}

export function getCachedAt(): number {
  return cachedAt
}

// Electron can grab the desktop itself, which is far cheaper than shelling out
// to PowerShell: no extra process, no window flash, and it finishes in a few
// frames instead of seconds. That matters because a slow capture used to delay
// (or cancel) opening the notch and stall mouse input while it ran.
async function capture(force: boolean): Promise<string | null> {
  try {
    const display = notchDisplay()
    const scale = display.scaleFactor || 1
    const sourceWidth = display.size.width * scale
    const sourceHeight = display.size.height * scale
    // The panel blurs this into a 480px image, so a bigger capture only costs
    // time and memory.
    const ratio = Math.min(1, 480 / Math.max(1, sourceWidth))
    const thumbnailSize = {
      width: Math.max(1, Math.round(sourceWidth * ratio)),
      height: Math.max(1, Math.round(sourceHeight * ratio))
    }

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize,
      fetchWindowIcons: false
    })
    if (!sources.length) return null
    const source =
      sources.find((entry) => String(entry.display_id) === String(display.id)) ?? sources[0]
    const image = source.thumbnail
    if (!image || image.isEmpty()) return null
    const dataUrl = `data:image/jpeg;base64,${image.toJPEG(70).toString('base64')}`
    // While the notch covers the screen, a capture would only show the notch
    // itself, so background refreshes are ignored. An explicit request from the
    // expand path is allowed through.
    if (suspended && !force) return null
    cachedBackdrop = dataUrl
    cachedAt = Date.now()
    return dataUrl
  } catch {
    return null
  }
}

export function captureDesktopBackdrop(force = false): Promise<string | null> {
  if (inFlight) return inFlight
  inFlight = capture(force).finally(() => {
    inFlight = null
  })
  return inFlight
}

// `desktopCapturer.getSources` blocks the main process for about a second no
// matter how small the thumbnail is, and the main process also routes the
// click that opens the notch. A capture that overlaps an open makes the notch
// answer a second late, so a capture waits while the pointer is on or near
// the tab and tries again shortly.
let nearZone: () => Electron.Rectangle | null = () => null
let retryTimer: ReturnType<typeof setTimeout> | null = null

export function setBackdropNearZone(provider: () => Electron.Rectangle | null): void {
  nearZone = provider
}

function pointerNearNotch(): boolean {
  const zone = nearZone()
  if (!zone) return false
  const point = screen.getCursorScreenPoint()
  return (
    point.x >= zone.x &&
    point.x <= zone.x + zone.width &&
    point.y >= zone.y &&
    point.y <= zone.y + zone.height
  )
}

export function refreshBackdrop(): void {
  if (suspended || inFlight) return
  if (pointerNearNotch()) {
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null
        refreshBackdrop()
      }, 2500)
      retryTimer.unref?.()
    }
    return
  }
  void captureDesktopBackdrop()
}

export function suspendBackdropCapture(): void {
  suspended = true
}

export function resumeBackdropCapture(): void {
  suspended = false
}

export function scheduleBackdropRefresh(): void {
  if (!app.isReady()) return
  const timer = setTimeout(() => {
    refreshBackdrop()
  }, 8_000)
  timer.unref?.()
}
