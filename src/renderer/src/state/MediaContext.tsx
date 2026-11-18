import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type {
  SpotifyAction,
  SpotifyLibrary,
  SpotifyMemory,
  SpotifyPlayback,
  SpotifyQueueItem,
  SpotifyStatus
} from '../../../shared/types'
import { useApp } from './AppContext'
import { useNowWhen } from './clock'
import { isSpotifySource, isMusicSourceId, normalizeMediaPreference, playbackLabel, playbackMatchesPreference, playbackSessionId, retainPlayback, unavailablePlayback } from '../../../shared/mediaFollow'

export type PlaybackPhase = 'idle' | 'opening' | 'no-device' | 'premium'

interface MediaContextValue {
  playerName: string
  spotifyControls: boolean
  playerAvailable: boolean
  status: SpotifyStatus | null
  playback: SpotifyPlayback | null
  queue: SpotifyQueueItem[]
  library: SpotifyLibrary
  loading: boolean
  connecting: boolean
  error: string | null
  phase: PlaybackPhase
  refreshStatus: () => Promise<void>
  refreshPlayer: (quiet?: boolean) => Promise<void>
  refreshQueue: () => Promise<void>
  action: (action: SpotifyAction) => Promise<void>
  togglePlay: () => Promise<void>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  launchSpotify: () => Promise<boolean>
  clearCachedPlayback: () => void
  progressMs: number
  pending: SpotifyAction['type'] | null
}

const EMPTY_LIBRARY: SpotifyLibrary = { recent: [], playlists: [] }

function playbackFromMemory(memory: SpotifyMemory | null | undefined): SpotifyPlayback | null {
  if (!memory?.track?.name) return null
  return {
    connected: false,
    playing: false,
    track: memory.track,
    device: null,
    shuffle: false,
    repeat: 'off',
    volume: 0,
    fetchedAt: memory.updatedAt,
    source: 'none',
    queueAvailable: false,
    contextUri: memory.contextUri
  }
}

function phaseFromDemo(phase: SpotifyStatus['demoPhase']): PlaybackPhase | null {
  if (phase === 'opening') return 'opening'
  if (phase === 'nodevice') return 'no-device'
  if (phase === 'premium') return 'premium'
  return null
}

function phaseFromError(message: string): PlaybackPhase {
  if (/premium/i.test(message)) return 'premium'
  if (/no spotify device|no active spotify device|not open yet|isn't open/i.test(message)) return 'no-device'
  return 'idle'
}

const MediaContext = createContext<MediaContextValue | null>(null)

/** Real Spotify track ids are base62-ish. Locally detected sessions use `local-…`. */
function isSpotifyTrackId(trackId: string | undefined): boolean {
  return Boolean(trackId && /^[A-Za-z0-9]{10,}$/.test(trackId))
}

function readCachedPlayback(preference: string): SpotifyPlayback | null {
  try {
    const raw = window.localStorage.getItem('notch:spotify:playback')
    if (!raw) return null
    const parsed = JSON.parse(raw) as SpotifyPlayback
    // Keep any remembered track, including tracks read from the Windows media
    // session while Spotify was closed.
    if (!parsed?.track?.id || !parsed.track.name) return null
    // A remembered session from an app that is no longer followed (a browser
    // video, say) must not come back when the page opens.
    const rememberedSource = playbackSessionId(parsed)
    if (rememberedSource && !isMusicSourceId(rememberedSource)) return null
    if (!playbackMatchesPreference(parsed, normalizeMediaPreference(preference))) return null
    return { ...parsed, localSessionId: playbackSessionId(parsed) || undefined, playing: false, device: null, connected: false }
  } catch {
    return null
  }
}

function spotifyTrackTarget(trackId: string | undefined): string | undefined {
  if (!isSpotifyTrackId(trackId)) return undefined
  return `spotify:track:${trackId}`
}

function sameTrack(a: SpotifyPlayback['track'], b: SpotifyPlayback['track']): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.artists === b.artists &&
    a.album === b.album &&
    a.image === b.image &&
    a.duration === b.duration &&
    a.url === b.url
  )
}

function samePlayback(a: SpotifyPlayback | null, b: SpotifyPlayback | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (
    a.connected !== b.connected ||
    a.playing !== b.playing ||
    a.source !== b.source ||
    a.queueAvailable !== b.queueAvailable ||
    a.shuffle !== b.shuffle ||
    a.repeat !== b.repeat ||
    a.volume !== b.volume ||
    a.localSessionId !== b.localSessionId ||
    a.contextUri !== b.contextUri ||
    Boolean(a.controls?.next) !== Boolean(b.controls?.next) ||
    Boolean(a.controls?.previous) !== Boolean(b.controls?.previous) ||
    Boolean(a.controls?.seek) !== Boolean(b.controls?.seek) ||
    a.device?.id !== b.device?.id ||
    a.device?.name !== b.device?.name ||
    a.device?.type !== b.device?.type ||
    a.device?.active !== b.device?.active ||
    a.device?.volume !== b.device?.volume ||
    !sameTrack(a.track, b.track)
  ) {
    return false
  }
  const atA = a.track?.progress ?? 0
  const atB = b.track?.progress ?? 0
  if (!a.playing) return Math.abs(atA - atB) < 250
  const projectedA = atA + Math.max(0, b.fetchedAt - a.fetchedAt)
  return Math.abs(projectedA - atB) < 1500
}

export function MediaProvider({ children }: { children: ReactNode }) {
  const { showToast, state, update, expanded, presenceHidden } = useApp()
  const preference = normalizeMediaPreference(state.settings.mediaSource)
  const selection = useRef({ preference, version: 0 })
  if (selection.current.preference !== preference) {
    selection.current = { preference, version: selection.current.version + 1 }
  }
  const [status, setStatus] = useState<SpotifyStatus | null>(null)
  const [playback, setPlayback] = useState<SpotifyPlayback | null>(
    () => readCachedPlayback(preference) ?? (preference === 'auto' ? playbackFromMemory(state.spotifyMemory) : null)
  )
  // The progress bar is the only thing that needs a clock here. A paused player
  // reads its last position, so nothing has to re-render every second.
  const now = useNowWhen(playback?.playing === true)
  const [queue, setQueue] = useState<SpotifyQueueItem[]>([])
  const [library, setLibrary] = useState<SpotifyLibrary>(EMPTY_LIBRARY)
  const [phase, setPhase] = useState<PlaybackPhase>('idle')
  const [loading, setLoading] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<SpotifyAction['type'] | null>(null)
  const polling = useRef(false)
  const pollVersion = useRef(0)
  const actionPending = useRef(false)
  const actionSeq = useRef(0)
  const playbackRef = useRef(playback)
  const statusRef = useRef<SpotifyStatus | null>(null)
  const memoryRef = useRef(state.spotifyMemory)
  const pollSuppressUntil = useRef(0)
  const lastStorageWriteRef = useRef(0)
  const lastStoredTrackRef = useRef<{ id: string | undefined; playing: boolean }>({
    id: undefined,
    playing: false
  })
  memoryRef.current = state.spotifyMemory

  const applyPlayback = useCallback(
    (next: SpotifyPlayback | null) => {
      if (!samePlayback(playbackRef.current, next)) {
        playbackRef.current = next
        setPlayback(next)
      }
      if (!next?.track) return
      const trackId = next.track.id
      if (!trackId) return
      const nowMs = Date.now()
      const trackOrPlayChanged =
        lastStoredTrackRef.current.id !== trackId || lastStoredTrackRef.current.playing !== next.playing
      if (trackOrPlayChanged || nowMs - lastStorageWriteRef.current >= 15_000) {
        lastStorageWriteRef.current = nowMs
        lastStoredTrackRef.current = { id: trackId, playing: next.playing }
        try {
          window.localStorage.setItem('notch:spotify:playback', JSON.stringify(next))
        } catch {
          // ignore
        }
      }
      // Only real Spotify tracks can be resumed through the Web API, so a
      // locally detected track never replaces the remembered one.
      if (!isSpotifyTrackId(trackId)) return
      const contextUri = next.contextUri || null
      const previous = memoryRef.current
      if (previous?.track.id === trackId && (previous.contextUri || null) === contextUri) return
      const memory: SpotifyMemory = {
        track: next.track,
        contextUri,
        updatedAt: Date.now()
      }
      memoryRef.current = memory
      update({ spotifyMemory: memory })
    },
    [update]
  )

  const refreshStatus = useCallback(async () => {
    const version = selection.current.version
    try {
      const next = await window.notch.spotify.status()
      if (version !== selection.current.version) return
      if (JSON.stringify(next) === JSON.stringify(statusRef.current)) return
      statusRef.current = next
      setStatus(next)
    } catch {
      if (version === selection.current.version) {
        statusRef.current = null
        setStatus((prev) => (prev === null ? prev : null))
      }
    }
  }, [])

  const refreshPlayer = useCallback(
    async (quiet = false) => {
      if (polling.current || actionPending.current || Date.now() < pollSuppressUntil.current) return
      polling.current = true
      const version = pollVersion.current
      const selected = selection.current
      try {
        const next = await window.notch.spotify.player()
        if (version !== pollVersion.current || selected !== selection.current || actionPending.current) return
        applyPlayback(retainPlayback(next, playbackRef.current, selected.preference))
        setError(null)
      } catch (caught) {
        if (selected !== selection.current || version !== pollVersion.current) return
        const message = caught instanceof Error ? caught.message : 'The selected player is unavailable.'
        applyPlayback(unavailablePlayback(playbackRef.current))
        setError(message)
        if (!quiet) showToast('Music', message, 'error')
      } finally {
        if (selected === selection.current) polling.current = false
      }
    },
    [applyPlayback, showToast]
  )

  const refreshQueue = useCallback(async () => {
    const selected = selection.current
    try {
      const next = await window.notch.spotify.queue()
      if (selected === selection.current) setQueue(next)
    } catch {
      if (selected === selection.current) setQueue([])
    }
  }, [])

  const refreshLibrary = useCallback(async () => {
    const selected = selection.current
    try {
      const next = await window.notch.spotify.library()
      if (selected === selection.current) setLibrary(next)
    } catch {
      if (selected === selection.current) setLibrary(EMPTY_LIBRARY)
    }
  }, [])

  const hasSource = Boolean(status?.connected || status?.localAvailable)

  useEffect(() => {
    pollVersion.current += 1
    actionSeq.current += 1
    polling.current = false
    actionPending.current = false
    pollSuppressUntil.current = 0
    setPending(null)
    setError(null)
    setPhase('idle')
    setQueue([])
    setLibrary(EMPTY_LIBRARY)
    const cached = readCachedPlayback(preference)
    applyPlayback(cached ?? (preference === 'auto' ? playbackFromMemory(memoryRef.current) : null))
    void refreshStatus()
    void refreshPlayer(true)
  }, [preference, applyPlayback, refreshStatus, refreshPlayer])

  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    if (presenceHidden) return
    void refreshStatus()
    const interval = setInterval(() => void refreshStatus(), 5000)
    return () => clearInterval(interval)
  }, [presenceHidden, refreshStatus])

  useEffect(() => {
    if (presenceHidden) return
    void refreshPlayer(true)
    // A collapsed notch only draws a slim progress line, and that line is
    // extrapolated from the last sample, so it does not need a read a second.
    const pollMs = status?.connected ? 5000 : expanded ? 1000 : 3000
    const interval = setInterval(() => void refreshPlayer(true), pollMs)
    return () => clearInterval(interval)
  }, [hasSource, expanded, presenceHidden, status?.connected, refreshPlayer])

  useEffect(() => {
    if (!status?.connected || !expanded || presenceHidden) return
    void refreshQueue()
    void refreshLibrary()
    const queueTimer = setInterval(() => void refreshQueue(), 20_000)
    const libraryTimer = setInterval(() => void refreshLibrary(), 60_000)
    return () => {
      clearInterval(queueTimer)
      clearInterval(libraryTimer)
    }
  }, [status?.connected, expanded, presenceHidden, refreshQueue, refreshLibrary])

  useEffect(() => {
    const next = phaseFromDemo(status?.demoPhase)
    if (next) setPhase(next)
  }, [status?.demoPhase])

  useEffect(() => {
    if (!hasSource) return
    const refresh = (): void => void refreshPlayer(true)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [hasSource, refreshPlayer])

  useEffect(() => {
    if (!state.settings.spotifyClientId) return
    void refreshStatus()
  }, [state.settings.spotifyClientId, refreshStatus])

  const action = useCallback(
    async (nextAction: SpotifyAction) => {
      const selected = selection.current
      const current = playbackRef.current
      if (!playbackMatchesPreference(current, selected.preference)) return
      const seq = ++actionSeq.current
      actionPending.current = true
      pollVersion.current += 1
      setPending(nextAction.type)
      const starting =
        nextAction.type === 'play' || nextAction.type === 'play-track' || nextAction.type === 'play-context'
      const deviceReady = Boolean(
        statusRef.current?.localAvailable || playbackRef.current?.device?.active || playbackRef.current?.playing
      )
      if (starting && statusRef.current?.connected && !deviceReady && !phaseFromDemo(statusRef.current.demoPhase)) {
        setPhase('opening')
      }
      try {
        const result = await window.notch.spotify.action(nextAction, {
          preference: selected.preference,
          sessionId: playbackSessionId(current)
        })
        if (seq !== actionSeq.current || selected !== selection.current) return
        actionPending.current = false
        pollVersion.current += 1
        setPending(null)
        applyPlayback(retainPlayback(result, playbackRef.current, selected.preference))
        setError(null)
        if (!phaseFromDemo(statusRef.current?.demoPhase)) setPhase('idle')
        if (nextAction.type === 'play' || nextAction.type === 'pause') {
          pollSuppressUntil.current = Date.now() + 2000
        } else if (
          nextAction.type === 'next' ||
          nextAction.type === 'previous' ||
          nextAction.type === 'play-track'
        ) {
          pollSuppressUntil.current = Date.now() + 600
        }
        if (
          nextAction.type === 'next' ||
          nextAction.type === 'previous' ||
          nextAction.type === 'play-track'
        ) {
          setTimeout(() => {
            void refreshQueue()
          }, 600)
          setTimeout(() => {
            void refreshPlayer(true)
            void refreshQueue()
          }, 1800)
        }
      } catch (caught) {
        if (seq !== actionSeq.current || selected !== selection.current) return
        actionPending.current = false
        pollVersion.current += 1
        setPending(null)
        const message = caught instanceof Error ? caught.message : 'That player did not accept the control.'
        if (!phaseFromDemo(statusRef.current?.demoPhase)) setPhase(phaseFromError(message))
        showToast(playbackLabel(current, selected.preference), message, 'error')
        setError(message)
        await refreshPlayer(true)
      }
    },
    [applyPlayback, refreshPlayer, refreshQueue, showToast]
  )

  const openSpotify = useCallback(
    async (resumeTrack: boolean) => {
      const selected = selection.current
      const target = resumeTrack ? spotifyTrackTarget(playbackRef.current?.track?.id) : undefined
      try {
        const ok = await window.notch.spotify.launch(target)
        if (!ok || selected !== selection.current) return false
        // Spotify can take several seconds to publish a media session after a
        // cold start. Keep checking, then resume once that session exists.
        const deadline = Date.now() + 5000
        let live = playbackRef.current
        while (Date.now() < deadline) {
          pollSuppressUntil.current = deadline
          await new Promise((resolve) => setTimeout(resolve, 1000))
          if (selected !== selection.current) return false
          pollSuppressUntil.current = 0
          await refreshStatus()
          await refreshPlayer(true)
          if (selected !== selection.current) return false
          live = playbackRef.current
          if (live?.playing) break
          if (live?.device?.active || statusRef.current?.localAvailable) break
        }
        pollSuppressUntil.current = 0
        if (
          resumeTrack &&
          live?.track &&
          !live.playing &&
          (live.device?.active || statusRef.current?.localAvailable)
        ) {
          await action({ type: 'play' })
        } else if (
          resumeTrack &&
          !live?.playing &&
          !live?.device?.active &&
          !statusRef.current?.localAvailable
        ) {
          showToast('Spotify opened', 'Press Play in Spotify to start playback.', 'default')
        }
        return true
      } catch {
        pollSuppressUntil.current = 0
        return false
      }
    },
    [action, refreshPlayer, refreshStatus]
  )

  const togglePlay = useCallback(async () => {
    const current = playbackRef.current
    const selected = selection.current.preference
    // A chosen Windows player always goes through the exact-session command.
    // Closing it must not launch Spotify or resume a different session.
    if (selected !== 'auto' || (playbackSessionId(current) && !isSpotifySource(playbackSessionId(current)))) {
      await action({ type: current?.playing ? 'pause' : 'play' })
      return
    }
    const apiConnected = Boolean(statusRef.current?.connected)
    const deviceReady = Boolean(
      statusRef.current?.localAvailable || current?.device?.active || current?.playing
    )
    // A Client ID can control any Connect device. Play asks the API to transfer
    // or open Spotify. Without a Client ID, the Windows media session is enough
    // when the desktop app is already publishing one.
    if (!apiConnected && !deviceReady) {
      setPhase('opening')
      showToast('Spotify', current?.track ? 'Opening Spotify and starting the last track…' : 'Opening Spotify…')
      const opened = await openSpotify(true)
      setPhase(opened ? 'idle' : 'no-device')
      if (!opened) showToast('Spotify', 'Could not open Spotify on this computer.', 'error')
      return
    }
    if (apiConnected && (!current?.playing || !deviceReady)) {
      // A cached track read from the Windows media session has no Spotify id,
      // so the Web API cannot resume it. Open the desktop app instead.
      if (!deviceReady && current?.track && !isSpotifyTrackId(current.track.id)) {
        setPhase('opening')
        showToast('Spotify', 'Opening Spotify and starting the last track…')
        const opened = await openSpotify(true)
        setPhase(opened ? 'idle' : 'no-device')
        if (!opened) showToast('Spotify', 'Could not open Spotify on this computer.', 'error')
        return
      }
      await action({ type: 'play' })
      return
    }
    if (!current?.track) return
    await action({ type: current.playing ? 'pause' : 'play' })
  }, [action, applyPlayback, openSpotify, showToast])

  const launchSpotify = useCallback(async () => openSpotify(false), [openSpotify])

  const clearCachedPlayback = useCallback(() => {
    try {
      window.localStorage.removeItem('notch:spotify:playback')
    } catch {
      // ignore
    }
    playbackRef.current = null
    setPlayback(null)
    setError(null)
    setPhase('idle')
  }, [])

  const connect = useCallback(async () => {
    setConnecting(true)
    try {
      const next = await window.notch.spotify.connect()
      setStatus(next)
      showToast('Spotify connected', next.profile?.name ? `Signed in as ${next.profile.name}.` : 'Ready to play.', 'success')
      await refreshPlayer()
      await refreshQueue()
      await refreshLibrary()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Could not connect Spotify.'
      showToast('Spotify sign-in failed', message, 'error')
    } finally {
      setConnecting(false)
    }
  }, [showToast, refreshPlayer, refreshQueue, refreshLibrary])

  const disconnect = useCallback(async () => {
    try {
      const next = await window.notch.spotify.disconnect()
      setStatus(next)
      applyPlayback(null)
      setQueue([])
      setLibrary(EMPTY_LIBRARY)
      setPhase('idle')
      showToast('Spotify disconnected', undefined, 'default')
    } catch (caught) {
      showToast('Spotify', caught instanceof Error ? caught.message : 'Could not disconnect.', 'error')
    }
  }, [applyPlayback, showToast])

  const progressMs = useMemo(() => {
    if (!playback?.track) return 0
    if (!playback.playing) return playback.track.progress
    return Math.min(
      playback.track.duration,
      playback.track.progress + (now - playback.fetchedAt)
    )
  }, [playback, now])

  const displayed = useMemo(
    () => (playbackMatchesPreference(playback, preference) ? playback : null),
    [playback, preference]
  )
  const spotifyControls = displayed?.source === 'api'
  const playerAvailable = Boolean(displayed?.connected || displayed?.device?.active)
  const playerName = useMemo(() => playbackLabel(displayed, preference), [displayed, preference])
  const visibleQueue = spotifyControls ? queue : []
  const visibleLibrary = spotifyControls ? library : EMPTY_LIBRARY
  const value = useMemo<MediaContextValue>(
    () => ({
      playerName,
      spotifyControls,
      playerAvailable,
      status,
      playback: displayed,
      queue: visibleQueue,
      library: visibleLibrary,
      loading,
      connecting,
      error,
      phase,
      refreshStatus,
      refreshPlayer,
      refreshQueue,
      action,
      togglePlay,
      launchSpotify,
      clearCachedPlayback,
      connect,
      disconnect,
      progressMs,
      pending
    }),
    [
      playerName,
      spotifyControls,
      playerAvailable,
      status,
      displayed,
      visibleQueue,
      visibleLibrary,
      loading,
      connecting,
      error,
      phase,
      refreshStatus,
      refreshPlayer,
      refreshQueue,
      action,
      togglePlay,
      launchSpotify,
      clearCachedPlayback,
      connect,
      disconnect,
      progressMs,
      pending
    ]
  )

  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>
}

export function useMedia(): MediaContextValue {
  const value = useContext(MediaContext)
  if (!value) throw new Error('useMedia must be used inside MediaProvider')
  return value
}
