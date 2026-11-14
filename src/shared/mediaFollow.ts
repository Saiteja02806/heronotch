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
  if (wanted && wanted !== 'auto') return isSpotifySource(wanted)
  if (!sessionId) return true
  return isSpotifySource(sessionId)
}
