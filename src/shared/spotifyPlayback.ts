/** Pure Spotify Connect helpers. The Web API never plays audio itself. */

export const RECENTLY_PLAYED_SCOPE = 'user-read-recently-played'

export interface ConnectDevice {
  id: string | null
  name?: string
  type?: string
  is_active?: boolean
  is_restricted?: boolean
}

export interface SpotifyFailure {
  status: number
  reason: 'NO_ACTIVE_DEVICE' | 'PREMIUM_REQUIRED' | 'RATE_LIMIT' | 'OTHER'
  message: string
}

export function needsRecentScope(scope: string | null | undefined): boolean {
  if (!scope) return true
  return !scope.split(/\s+/).includes(RECENTLY_PLAYED_SCOPE)
}

/** Prefer this computer, then any active device, then the first one Notch can control. */
export function pickConnectDevice<T extends ConnectDevice>(devices: T[]): T | null {
  const usable = devices.filter((device) => Boolean(device.id) && !device.is_restricted)
  return (
    usable.find((device) => device.is_active && device.type === 'Computer') ||
    usable.find((device) => device.type === 'Computer') ||
    usable.find((device) => device.is_active) ||
    usable[0] ||
    null
  )
}

export function readSpotifyFailure(status: number, text: string): SpotifyFailure {
  let reason: string | null = null
  let message = ''
  try {
    const body = JSON.parse(text) as { error?: { reason?: string; message?: string } }
    reason = body.error?.reason || null
    message = body.error?.message || ''
  } catch {
    message = text
  }
  if (status === 404 || reason === 'NO_ACTIVE_DEVICE') {
    return {
      status: 404,
      reason: 'NO_ACTIVE_DEVICE',
      message: 'No active Spotify device. Open Spotify and start a track first.'
    }
  }
  if (status === 403 || reason === 'PREMIUM_REQUIRED') {
    return {
      status: 403,
      reason: 'PREMIUM_REQUIRED',
      message: 'Spotify Premium is required to start playback from Notch.'
    }
  }
  if (status === 429) {
    return {
      status: 429,
      reason: 'RATE_LIMIT',
      message: 'Spotify is rate-limiting requests. Try again in a moment.'
    }
  }
  return {
    status,
    reason: 'OTHER',
    message: (message || text || 'Spotify request failed.').slice(0, 200)
  }
}

const CONTEXT_URI = /^spotify:(album|playlist|show):[A-Za-z0-9]+$/

/** Resume a playlist, album, or show at a track. Anything else plays the track on its own. */
export function resumeRequest(uri: string, contextUri?: string | null): { context_uri: string; offset: { uri: string } } | { uris: string[] } {
  if (contextUri && CONTEXT_URI.test(contextUri)) {
    return { context_uri: contextUri, offset: { uri } }
  }
  return { uris: [uri] }
}
