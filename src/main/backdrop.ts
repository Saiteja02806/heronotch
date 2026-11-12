import { app, desktopCapturer, screen } from 'electron'

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
    const display = screen.getPrimaryDisplay()
    const scale = display.scaleFactor || 1
    const sourceWidth = display.size.width * scale
    const sourceHeight = display.size.height * scale
    const ratio = Math.min(1, 1280 / Math.max(1, sourceWidth))
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
    const dataUrl = image.toDataURL()
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

export function refreshBackdrop(): void {
  if (suspended || inFlight) return
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
  setTimeout(() => {
    refreshBackdrop()
  }, 900)
}
