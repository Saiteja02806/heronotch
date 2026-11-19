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
  {
    test: /youtubemusic|youtube[^a-z0-9]*music|music[^a-z0-9]*youtube|ytmusic/i,
    label: 'YouTube Music'
  },
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
 * The only apps the notch follows. A browser playing a video is not one, even
 * though Windows reports its media session like any other.
 */
export type MusicApp = 'spotify' | 'youtube-music'

const MUSIC_APP_LABELS: Record<MusicApp, string> = {
  spotify: 'Spotify',
  'youtube-music': 'YouTube Music'
}

const YOUTUBE_MUSIC_ID = /youtubemusic|youtube[^a-z0-9]*music|music[^a-z0-9]*youtube|ytmusic/i
const BROWSER_ID = /chrome|msedge|microsoftedge|brave|firefox|opera|vivaldi/i

/** Where a session comes from, or null when it is not a music app. */
export function musicAppFor(session: {
  id?: string
  title?: string
  artist?: string
  album?: string
}): MusicApp | null {
  const id = session.id || ''
  if (/spotify/i.test(id)) return 'spotify'
  if (YOUTUBE_MUSIC_ID.test(id)) return 'youtube-music'
  // Chrome and Edge announce only the song, so YouTube Music is recognised by
  // the site name it stamps into the metadata, or by the album it publishes.
  // A plain YouTube video has no album and no site name, which keeps it out.
  const text = `${session.album || ''} ${session.title || ''} ${session.artist || ''}`
  if (/youtube\s*music/i.test(text)) return 'youtube-music'
  if (BROWSER_ID.test(id) && (session.album || '').trim()) return 'youtube-music'
  return null
}

export function musicAppLabel(app: MusicApp): string {
  return MUSIC_APP_LABELS[app]
}

export function isMusicSourceId(id: string | null | undefined): boolean {
  return Boolean(id && musicAppFor({ id }))
}

/**
 * Older saves may point at a browser or video app. Those are no longer
 * followed, so they fall back to the default instead of hiding playback.
 */
export function normalizeMediaPreference(preference: string | null | undefined): string {
  const wanted = (preference || 'auto').trim()
  if (!wanted || wanted === 'auto') return 'auto'
  // Allow both dedicated music app IDs and browser IDs (Chrome/Edge can host
  // YouTube Music; pickMediaSession still enforces album/YouTube Music checks).
  return musicAppFor({ id: wanted }) || BROWSER_ID.test(wanted) ? wanted : 'auto'
}

export function playbackSessionId(playback: SpotifyPlayback | null): string | null {
  return playback?.localSessionId || (playback?.source === 'local' ? playback.device?.id : null) || null
}

export function playbackMatchesPreference(playback: SpotifyPlayback | null, preference: string): boolean {
  const wanted = normalizeMediaPreference(preference)
  return wanted === 'auto' || playbackSessionId(playback) === wanted
}

export function playbackLabel(playback: SpotifyPlayback | null, preference: string): string {
  const sessionId = playbackSessionId(playback)
  if (sessionId) return friendlyMediaName(sessionId)
  const wanted = normalizeMediaPreference(preference)
  if (wanted !== 'auto') return friendlyMediaName(wanted)
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
 * Auto follows Spotify first, then YouTube Music, and ignores everything else
 * (browser videos, VLC, games). A saved app id must match that exact music app;
 * stale non-music selections fall back to auto.
 */
export function pickMediaSession<T extends MediaSessionInfo>(sessions: T[], preference: string | undefined): T | null {
  const usable = sessions.filter((session) => session.id)
  if (usable.length === 0) return null
  const wanted = normalizeMediaPreference(preference)
  const music = usable.filter((session) => musicAppFor(session))
  if (wanted !== 'auto') {
    return music.find((session) => session.id === wanted) || null
  }
  const playing = music.filter((session) => session.status === 'Playing')
  const spotifyPlaying = playing.filter((session) => musicAppFor(session) === 'spotify')
  const spotifyAny = music.filter((session) => musicAppFor(session) === 'spotify')
  return (
    spotifyPlaying.find((session) => session.current) ||
    playing.find((session) => session.current) ||
    spotifyPlaying[0] ||
    playing[0] ||
    spotifyAny.find((session) => session.current) ||
    spotifyAny[0] ||
    music.find((session) => session.current) ||
    music[0] ||
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
  const wanted = normalizeMediaPreference(preference)
  if (wanted !== 'auto') return wanted === sessionId && isSpotifySource(wanted)
  if (!sessionId) return true
  return isSpotifySource(sessionId)
}
