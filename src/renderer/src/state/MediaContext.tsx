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
import { useNow } from './clock'

export type PlaybackPhase = 'idle' | 'opening' | 'no-device' | 'premium'

interface MediaContextValue {
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
  if (/no spotify device|no active spotify device/i.test(message)) return 'no-device'
  return 'idle'
}

const MediaContext = createContext<MediaContextValue | null>(null)

function readCachedPlayback(): SpotifyPlayback | null {
  try {
    const raw = window.localStorage.getItem('notch:spotify:playback')
    if (!raw) return null
    const parsed = JSON.parse(raw) as SpotifyPlayback
    if (!parsed?.track?.id || !/^[A-Za-z0-9]{10,}$/.test(parsed.track.id)) return null
    return { ...parsed, playing: false, device: null }
  } catch {
    return null
  }
}

function spotifyTrackTarget(trackId: string | undefined): string | undefined {
  if (!trackId || !/^[A-Za-z0-9]{10,}$/.test(trackId)) return undefined
  return `spotify:track:${trackId}`
}

export function MediaProvider({ children }: { children: ReactNode }) {
  const { showToast, state, update } = useApp()
  const now = useNow()
  const [status, setStatus] = useState<SpotifyStatus | null>(null)
  const [playback, setPlayback] = useState<SpotifyPlayback | null>(
    () => readCachedPlayback() ?? playbackFromMemory(state.spotifyMemory)
  )
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
  const cachedRef = useRef(playback)
  const statusRef = useRef<SpotifyStatus | null>(null)
  const memoryRef = useRef(state.spotifyMemory)
  const pollSuppressUntil = useRef(0)
  memoryRef.current = state.spotifyMemory

  const applyPlayback = useCallback((next: SpotifyPlayback | null) => {
    playbackRef.current = next
    setPlayback(next)
    if (!next?.track) return
    cachedRef.current = next
    const trackId = next.track.id
    if (!trackId || !/^[A-Za-z0-9]{10,}$/.test(trackId)) return
    try {
      window.localStorage.setItem('notch:spotify:playback', JSON.stringify(next))
    } catch {
      // ignore
    }
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
  }, [update])

  const refreshStatus = useCallback(async () => {
    try {
      const next = await window.notch.spotify.status()
      statusRef.current = next
      setStatus(next)
      if (!next.connected && !next.localAvailable) {
        // Keep the last known track visible when Spotify is closed.
        if (playbackRef.current?.track) {
          setPlayback(playbackRef.current)
        } else {
          applyPlayback(null)
        }
      }
    } catch {
      setStatus(null)
    }
  }, [applyPlayback])

  const refreshPlayer = useCallback(
    async (quiet = false) => {
      if (polling.current || actionPending.current || Date.now() < pollSuppressUntil.current) return
      polling.current = true
      const version = pollVersion.current
      try {
        const next = await window.notch.spotify.player()
        if (version !== pollVersion.current || actionPending.current) return
        if (next?.track) {
          applyPlayback(next)
        } else {
          const cached = cachedRef.current?.track ? cachedRef.current : playbackRef.current
          const held = cached?.track
          if (cached && held) {
            const frozen: SpotifyPlayback = {
              ...cached,
              track: held,
              playing: false,
              device: next?.device?.active ? next.device : null,
              connected: Boolean(next?.connected),
              fetchedAt: Date.now()
            }
            const visible = playbackRef.current
            const unchanged =
              visible?.track?.id === held.id &&
              visible.playing === false &&
              (visible.device?.id ?? null) === (frozen.device?.id ?? null)
            if (!unchanged) applyPlayback(frozen)
          } else {
            applyPlayback(next)
          }
        }
        setError(null)
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Spotify is unavailable.'
        setError(message)
        if (!quiet) showToast('Spotify', message, 'error')
      } finally {
        polling.current = false
      }
    },
    [applyPlayback, showToast]
  )

  const refreshQueue = useCallback(async () => {
    try {
      setQueue(await window.notch.spotify.queue())
    } catch {
      setQueue([])
    }
  }, [])

  const refreshLibrary = useCallback(async () => {
    try {
      setLibrary(await window.notch.spotify.library())
    } catch {
      setLibrary(EMPTY_LIBRARY)
    }
  }, [])

  const hasSource = Boolean(status?.connected || status?.localAvailable)

  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    void refreshStatus()
    const interval = setInterval(() => void refreshStatus(), 5000)
    return () => clearInterval(interval)
  }, [refreshStatus])

  useEffect(() => {
    if (!hasSource) return
    void refreshPlayer(true)
    const pollMs = status?.connected ? 5000 : 1000
    const interval = setInterval(() => void refreshPlayer(true), pollMs)
    return () => clearInterval(interval)
  }, [hasSource, status?.connected, refreshPlayer])

  useEffect(() => {
    if (!status?.connected) return
    void refreshQueue()
    void refreshLibrary()
    const queueTimer = setInterval(() => void refreshQueue(), 20_000)
    const libraryTimer = setInterval(() => void refreshLibrary(), 60_000)
    return () => {
      clearInterval(queueTimer)
      clearInterval(libraryTimer)
    }
  }, [status?.connected, refreshQueue, refreshLibrary])

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
        const result = await window.notch.spotify.action(nextAction)
        if (seq !== actionSeq.current) return
        actionPending.current = false
        pollVersion.current += 1
        setPending(null)
        const visible =
          result.track || !playbackRef.current?.track
            ? result
            : {
                ...result,
                track: playbackRef.current.track,
                contextUri: result.contextUri ?? playbackRef.current.contextUri
              }
        applyPlayback(visible)
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
        if (seq !== actionSeq.current) return
        actionPending.current = false
        pollVersion.current += 1
        setPending(null)
        const message = caught instanceof Error ? caught.message : 'That Spotify control did not work.'
        if (!phaseFromDemo(statusRef.current?.demoPhase)) setPhase(phaseFromError(message))
        showToast('Spotify', message, 'error')
        setError(message)
      }
    },
    [applyPlayback, refreshPlayer, refreshQueue, showToast]
  )

  const openSpotify = useCallback(
    async (resumeTrack: boolean) => {
      const target = resumeTrack ? spotifyTrackTarget(playbackRef.current?.track?.id) : undefined
      try {
        const ok = await window.notch.spotify.launch(target)
        if (!ok) return false
        // Spotify can take several seconds to publish a media session after a
        // cold start. Keep checking, then resume once that session exists.
        const deadline = Date.now() + 12000
        let live = playbackRef.current
        while (Date.now() < deadline) {
          pollSuppressUntil.current = deadline
          await new Promise((resolve) => setTimeout(resolve, 1000))
          pollSuppressUntil.current = 0
          await refreshStatus()
          await refreshPlayer(true)
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
      await action({ type: 'play' })
      return
    }
    if (!current?.track) return
    const optimistic: SpotifyPlayback = { ...current, playing: !current.playing }
    applyPlayback(optimistic)
    try {
      await action({ type: optimistic.playing ? 'play' : 'pause' })
    } catch {
      applyPlayback(current)
    }
  }, [action, applyPlayback, openSpotify, showToast])

  const launchSpotify = useCallback(async () => openSpotify(false), [openSpotify])

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

  const value: MediaContextValue = {
    status,
    playback,
    queue,
    library,
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
    connect,
    disconnect,
    progressMs,
    pending
  }

  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>
}

export function useMedia(): MediaContextValue {
  const value = useContext(MediaContext)
  if (!value) throw new Error('useMedia must be used inside MediaProvider')
  return value
}
