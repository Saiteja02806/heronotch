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
  progressMs: number
  pending: SpotifyAction['type'] | null
}

const MediaContext = createContext<MediaContextValue | null>(null)

export function MediaProvider({ children }: { children: ReactNode }) {
  const { showToast, now, state } = useApp()
  const [status, setStatus] = useState<SpotifyStatus | null>(null)
  const [playback, setPlayback] = useState<SpotifyPlayback | null>(null)
  const [queue, setQueue] = useState<SpotifyQueueItem[]>([])
  const [loading, setLoading] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<SpotifyAction['type'] | null>(null)
  const polling = useRef(false)
  const pollVersion = useRef(0)
  const actionPending = useRef(false)
  const actionSeq = useRef(0)
  const playbackRef = useRef<SpotifyPlayback | null>(null)
  const pollSuppressUntil = useRef(0)

  const applyPlayback = useCallback((next: SpotifyPlayback | null) => {
    playbackRef.current = next
    setPlayback(next)
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      const next = await window.notch.spotify.status()
      setStatus(next)
      if (!next.connected && !next.localAvailable) applyPlayback(null)
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
        applyPlayback(next)
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

  const togglePlay = useCallback(async () => {
    const current = playbackRef.current
    if (!current) return
    const optimistic: SpotifyPlayback = { ...current, playing: !current.playing }
    applyPlayback(optimistic)
    await action({ type: optimistic.playing ? 'play' : 'pause' })
  }, [action, applyPlayback])

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
