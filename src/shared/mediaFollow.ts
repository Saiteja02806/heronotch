import type { SpotifyPlayback } from './types'

/** A Windows media session the notch can follow. */
export interface MediaSessionInfo {
  id: string
  title?: string
  artist?: string
  album?: string
  status?: string
  position?: number
  end?: number
  canNext?: boolean
  canPrevious?: boolean
  canSeek?: boolean
  current?: boolean
  /** Absolute path of a cached album-art file, when Windows exposes one. */
  art?: string | null
}

const KNOWN_PLAYERS: { test: RegExp; label: string }[] = [
  { test: /spotify/i, label: 'Spotify' },
  { test: /apple[\s._-]*music|applemusic/i, label: 'Apple Music' },
  { test: /msedge|microsoftedge/i, label: 'Edge' },
  { test: /chrome/i, label: 'Chrome' },
  { test: /firefox/i, label: 'Firefox' },
  { test: /youtube/i, label: 'YouTube' },
  { test: /vlc/i, label: 'VLC' },
  { test: /foobar/i, label: 'foobar2000' },
  { test: /musicbee/i, label: 'MusicBee' },
  { test: /aimp/i, label: 'AIMP' }
]

export function friendlyMediaName(id: string): string {
  const known = KNOWN_PLAYERS.find((entry) => entry.test.test(id))
  if (known) return known.label
  const parts = id.split(/[!\\/._-]/).filter((part) => part && part.length > 1)
  const last = parts[parts.length - 1] || id
  return last.replace(/([a-z])([A-Z])/g, '$1 $2')
}

export function isSpotifySource(id: string | null | undefined): boolean {
  return Boolean(id && /spotify/i.test(id))
}

export function playbackSessionId(playback: SpotifyPlayback | null): string | null {
  return playback?.localSessionId || (playback?.source === 'local' ? playback.device?.id : null) || null
}

export function playbackMatchesPreference(playback: SpotifyPlayback | null, preference: string): boolean {
  return preference === 'auto' || playbackSessionId(playback) === preference
}

export function playbackLabel(playback: SpotifyPlayback | null, preference: string): string {
  const sessionId = playbackSessionId(playback)
  if (sessionId) return friendlyMediaName(sessionId)
  if (preference !== 'auto') return friendlyMediaName(preference)
  return playback?.source === 'api' || playback?.track ? 'Spotify' : 'Music'
}

/** Preserve real history after a failed read, without claiming it is still live. */
export function unavailablePlayback(playback: SpotifyPlayback | null): SpotifyPlayback | null {
  if (!playback) return null
  return {
    ...playback,
    localSessionId: playbackSessionId(playback) || undefined,
    connected: false,
    playing: false,
    device: null,
    source: 'none',
    queueAvailable: false,
    controls: { next: false, previous: false, seek: false }
  }
}

export function playbackHeading(playback: SpotifyPlayback | null): string {
  if (!playback?.track) return 'Nothing playing'
  if (!playback.connected && !playback.device?.active) return 'Last played'
  return playback.playing ? 'Now playing' : 'Paused'
}

/** Remember a closed player's track only for the same source and selection. */
export function retainPlayback(
  next: SpotifyPlayback,
  previous: SpotifyPlayback | null,
  preference: string
): SpotifyPlayback {
  if (next.track || !previous?.track || !playbackMatchesPreference(previous, preference)) return next
  const nextId = playbackSessionId(next)
  const previousId = playbackSessionId(previous)
  if (nextId && nextId !== previousId) return next
  if (next.source === 'api' && previousId && !isSpotifySource(previousId)) return next
  return {
    ...next,
    track: previous.track,
    localSessionId: previousId || undefined,
    playing: false,
    contextUri: previous.contextUri
  }
}

/**
 * Auto follows the session that is actually playing, then the system current
 * session. A saved app id must match that app, not a substring of another.
 */
export function pickMediaSession<T extends MediaSessionInfo>(sessions: T[], preference: string | undefined): T | null {
  const usable = sessions.filter((session) => session.id)
  if (usable.length === 0) return null
  const wanted = (preference || 'auto').trim()
  if (wanted && wanted !== 'auto') {
    return usable.find((session) => session.id === wanted) || null
  }
  const playing = usable.filter((session) => session.status === 'Playing')
  return (
    playing.find((session) => session.current) ||
    playing[0] ||
    usable.find((session) => session.current) ||
    null
  )
}

/**
 * The Web API is the enhanced Spotify path. It is used when Spotify is the
 * session being followed. Another player's media session wins over it.
 */
export function followWithSpotifyApi(
  preference: string | undefined,
  sessionId: string | null,
  apiConnected: boolean
): boolean {
  if (!apiConnected) return false
  const wanted = (preference || 'auto').trim()
  if (wanted && wanted !== 'auto') return wanted === sessionId && isSpotifySource(wanted)
  if (!sessionId) return true
  return isSpotifySource(sessionId)
}
