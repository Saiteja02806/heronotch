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
  SpotifyPlayback,
  SpotifyQueueItem,
  SpotifyStatus
} from '../../../shared/types'
import { useApp } from './AppContext'

interface MediaContextValue {
  status: SpotifyStatus | null
  playback: SpotifyPlayback | null
  queue: SpotifyQueueItem[]
  loading: boolean
  connecting: boolean
  error: string | null
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

const MediaContext = createContext<MediaContextValue | null>(null)

function readCachedPlayback(): SpotifyPlayback | null {
  try {
    const raw = window.localStorage.getItem('notch:spotify:playback')
    if (!raw) return null
    const parsed = JSON.parse(raw) as SpotifyPlayback
    if (!parsed?.track?.id) return null
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
  const { showToast, now, state } = useApp()
  const [status, setStatus] = useState<SpotifyStatus | null>(null)
  const [playback, setPlayback] = useState<SpotifyPlayback | null>(() => readCachedPlayback())
  const [queue, setQueue] = useState<SpotifyQueueItem[]>([])
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
  const pollSuppressUntil = useRef(0)

  const applyPlayback = useCallback((next: SpotifyPlayback | null) => {
    playbackRef.current = next
    setPlayback(next)
    if (next?.track) {
      cachedRef.current = next
      try {
        window.localStorage.setItem('notch:spotify:playback', JSON.stringify(next))
      } catch {
        // ignore
      }
    }
  }, [])

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
          if (cached?.track) {
            const frozen: SpotifyPlayback = {
              ...cached,
              playing: false,
              device: next?.device?.active ? next.device : null,
              connected: Boolean(next?.connected),
              fetchedAt: Date.now()
            }
            const visible = playbackRef.current
            const unchanged =
              visible?.track?.id === frozen.track.id &&
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
    const interval = setInterval(() => void refreshQueue(), 20_000)
    return () => clearInterval(interval)
  }, [status?.connected, refreshQueue])

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
      try {
        const result = await window.notch.spotify.action(nextAction)
        if (seq !== actionSeq.current) return
        actionPending.current = false
        pollVersion.current += 1
        setPending(null)
        applyPlayback(result)
        setError(null)
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
    // OAuth can stay connected after the desktop app closes. A paused cache has
    // no active device, so Play has to open Spotify instead of calling the API.
    const deviceReady = Boolean(
      statusRef.current?.localAvailable || current?.device?.active || current?.playing
    )
    if (!deviceReady) {
      showToast('Spotify', current?.track ? 'Opening Spotify and starting the last track…' : 'Opening Spotify…')
      const opened = await openSpotify(true)
      if (!opened) showToast('Spotify', 'Could not open Spotify on this computer.', 'error')
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
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Could not connect Spotify.'
      showToast('Spotify sign-in failed', message, 'error')
    } finally {
      setConnecting(false)
    }
  }, [showToast, refreshPlayer, refreshQueue])

  const disconnect = useCallback(async () => {
    try {
      const next = await window.notch.spotify.disconnect()
      setStatus(next)
      applyPlayback(null)
      setQueue([])
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
    loading,
    connecting,
    error,
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
