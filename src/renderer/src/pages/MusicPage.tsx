import {
  ArrowUpRight,
  AudioLines,
  CheckCircle2,
  Copy,
  ExternalLink,
  ListMusic,
  Loader2,
  LogOut,
  Music2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Volume2,
  VolumeX
} from 'lucide-react'
import { motion } from 'framer-motion'
import { useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { formatDuration } from '../lib/time'
import { useApp } from '../state/AppContext'
import { useMedia } from '../state/MediaContext'

function Cover({
  image,
  seed,
  size,
  className = ''
}: {
  image?: string | null
  seed: string
  size?: number
  className?: string
}) {
  const hue = useMemo(() => {
    let hash = 0
    for (let index = 0; index < seed.length; index += 1) hash = seed.charCodeAt(index) + ((hash << 5) - hash)
    return Math.abs(hash) % 360
  }, [seed])

  return (
    <div
      className={`music-page-cover ${className}`}
      style={{
        width: size,
        height: size,
        background: image
          ? undefined
          : `radial-gradient(circle at 30% 22%, hsl(${hue} 78% 64%), transparent 55%),
             radial-gradient(circle at 74% 76%, hsl(${(hue + 60) % 360} 62% 46%), transparent 58%),
             linear-gradient(150deg, hsl(${hue} 35% 24%), #0c0d0f)`
      }}
    >
      {image ? <img src={image} alt="" /> : <AudioLines size={size ? size * 0.24 : 44} />}
    </div>
  )
}

function ConnectSpotify() {
  const { state, openSettings } = useApp()
  const { status, connecting, connect } = useMedia()
  const [copied, setCopied] = useState(false)
  const redirectUri = status?.redirectUri || `http://127.0.0.1:${state.settings.spotifyRedirectPort}/callback`
  const hasClientId = Boolean(state.settings.spotifyClientId.trim())

  const copy = (): void => {
    window.notch.copyText(redirectUri)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="spotify-connect">
      <div className="spotify-hero">
        <div className="spotify-glow glow-one" />
        <div className="spotify-glow glow-two" />
        <div className="spotify-cover-wrap">
          <Cover seed="notch-spotify" size={236} />
          <span className="spotify-wave">
            <i /><i /><i /><i /><i />
          </span>
        </div>
        <div className="spotify-hero-copy">
          <span className="eyebrow"><span className="spotify-dot" /> Spotify</span>
          <h1>Your soundtrack,<br />in the notch.</h1>
          <p>
            Control play, pause, skip, volume and queue from the top of your screen. Notch talks
            straight to Spotify — no extra app running in between.
          </p>
          <div className="spotify-hero-actions">
            {hasClientId ? (
              <button className="primary-button spotify-primary" onClick={() => void connect()} disabled={connecting}>
                {connecting ? <Loader2 size={15} className="spin" /> : <Music2 size={15} />}
                {connecting ? 'Waiting for Spotify…' : 'Connect Spotify'}
              </button>
            ) : (
              <button className="primary-button spotify-primary" onClick={() => openSettings('spotify')}>
                <SlidersHorizontal size={15} />
                Add Client ID in Settings
              </button>
            )}
            <button
              className="soft-button"
              onClick={() => window.notch.openExternal('https://developer.spotify.com/dashboard')}
            >
              <ExternalLink size={13} /> Spotify developer
            </button>
          </div>
          <span className="spotify-note">
            Playback control requires Spotify Premium. Notch uses PKCE — no client secret is stored.
          </span>
        </div>
      </div>

      <div className="connect-steps">
        {hasClientId ? (
          <div className="connect-step connect-step-ready">
            <span className="step-index"><CheckCircle2 size={14} /></span>
            <div>
              <strong>Client ID saved</strong>
              <p>
                Everything is set. Press <em>Connect Spotify</em> above and approve the sign-in in
                your browser — the notch keeps the session refreshed from then on.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="connect-step">
              <span className="step-index">01</span>
              <div>
                <strong>Create a Spotify app</strong>
                <p>Open the developer dashboard and create an app. Any name works.</p>
              </div>
            </div>
            <div className="connect-step">
              <span className="step-index">02</span>
              <div>
                <strong>Add this redirect URI</strong>
                <button className="redirect-uri" onClick={copy}>
                  <code>{redirectUri}</code>
                  {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                </button>
                <p>Paste it into the app’s Redirect URIs, exactly as written, then save.</p>
              </div>
            </div>
            <div className="connect-step">
              <span className="step-index">03</span>
              <div>
                <strong>Paste the Client ID</strong>
                <p>Add it in Settings, then come back here to connect.</p>
                <button className="link-button" onClick={() => openSettings('spotify')}>
                  Go to Spotify settings <ArrowUpRight size={11} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function MusicPage() {
  const { openSettings, state } = useApp()
  const artSize = state.settings.panelSize === 'compact' ? 84 : 226
  const {
    status,
    playback,
    queue,
    action,
    togglePlay,
    launchSpotify,
    progressMs,
    disconnect,
    pending
  } = useMedia()
  const [scrub, setScrub] = useState<number | null>(null)
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null)
  const [queuePendingUri, setQueuePendingUri] = useState<string | null>(null)
  const queuePending = useRef<string | null>(null)
  const track = playback?.track
  const duration = track?.duration || 0
  const rawProgress = scrub ?? progressMs
  const shownProgress = duration ? Math.min(rawProgress, duration) : rawProgress
  const volume = volumeDraft ?? playback?.volume ?? 0

  const hasCachedTrack = Boolean(playback?.track)

  if (!status?.connected && !status?.localAvailable && !hasCachedTrack) return <ConnectSpotify />

  const apiConnected = Boolean(status?.connected)
  const localMode = !apiConnected && Boolean(status?.localAvailable)
  const changing = pending === 'next' || pending === 'previous'

  const commitSeek = (): void => {
    if (scrub === null) return
    void action({ type: 'seek', position: scrub })
    setScrub(null)
  }

  const commitVolume = (): void => {
    if (volumeDraft === null) return
    void action({ type: 'volume', volume: volumeDraft })
    setVolumeDraft(null)
  }

  const cycleRepeat = (): void => {
    const next = playback?.repeat === 'off' ? 'context' : playback?.repeat === 'context' ? 'track' : 'off'
    void action({ type: 'repeat', state: next })
  }

  const openTrack = (event: MouseEvent): void => {
    event.stopPropagation()
    if (track?.url) window.notch.openExternal(track.url)
  }

  return (
    <div className="music-page">
      <section className="player-panel">
        <div className="player-ambient" aria-hidden="true">
          {track?.image && <img src={track.image} alt="" />}
        </div>
        <header className="player-head">
          <div>
            <span className="eyebrow">
              <span className="spotify-dot" /> Spotify ·{' '}
              {track && !playback?.device?.active && !status?.localAvailable
                ? 'Closed · cached'
                : status?.connected || status?.localAvailable
                  ? playback?.device?.name || 'No device'
                  : 'Closed · cached'}
            </span>
            <h1>{track ? 'Now playing' : 'Quiet for a moment'}</h1>
          </div>
          <div className="player-head-actions">
            {status?.profile?.image && <img className="profile-face" src={status.profile.image} alt="" />}
            <button className="soft-button compact" onClick={() => openSettings('spotify')} title="Spotify settings">
              <SlidersHorizontal size={13} />
            </button>
          </div>
        </header>

        {track ? (
          <div className="player-main">
            <button className="player-art-button" onClick={openTrack} title="Open track in Spotify">
              <Cover image={track.image} seed={track.id} size={artSize} />
              <span className="art-open"><ArrowUpRight size={13} /> Spotify</span>
            </button>
            <div className={`player-details ${changing ? 'is-changing' : ''}`}>
              <span className="eyebrow">{track.album || 'Single'}</span>
              <h2>{track.name}</h2>
              <p>{track.artists}</p>

              <div className="player-progress">
                <input
                  type="range"
                  min={0}
                  max={duration || 1}
                  value={Math.min(shownProgress, duration)}
                  onChange={(event) => setScrub(Number(event.target.value))}
                  onPointerUp={commitSeek}
                  onKeyUp={commitSeek}
                  style={{ '--filled': `${duration ? (shownProgress / duration) * 100 : 0}%` } as CSSProperties}
                  aria-label="Seek"
                />
                <div className="player-times">
                  <span>{formatDuration(shownProgress)}</span>
                  <span>{formatDuration(duration)}</span>
                </div>
              </div>

              <div className="player-controls">
                {apiConnected && (
                  <button
                    className={`player-control ${playback?.shuffle ? 'is-on' : ''}`}
                    onClick={() => void action({ type: 'shuffle', state: !playback?.shuffle })}
                    title="Shuffle"
                  >
                    <Shuffle size={17} />
                  </button>
                )}
                <button className="player-control" onClick={() => void action({ type: 'previous' })} title="Previous">
                  <SkipBack size={21} fill="currentColor" />
                </button>
                <motion.button
                  className="player-play"
                  onClick={() => void togglePlay()}
                  whileTap={{ scale: 0.93 }}
                  title={playback?.playing ? 'Pause' : 'Play'}
                >
                  {playback?.playing ? <Pause size={23} fill="currentColor" /> : <Play size={23} fill="currentColor" />}
                </motion.button>
                <button className="player-control" onClick={() => void action({ type: 'next' })} title="Next">
                  <SkipForward size={21} fill="currentColor" />
                </button>
                {apiConnected && (
                  <button
                    className={`player-control ${playback?.repeat !== 'off' ? 'is-on' : ''}`}
                    onClick={cycleRepeat}
                    title={`Repeat: ${playback?.repeat || 'off'}`}
                  >
                    {playback?.repeat === 'track' ? <Repeat1 size={17} /> : <Repeat size={17} />}
                  </button>
                )}
              </div>

              {localMode ? (
                <button className="local-session-note" onClick={() => openSettings('spotify')}>
                  Spotify Desktop · local controls <span>Unlock queue and full controls</span>
                </button>
              ) : (
                <div className="volume-row">
                  <button
                    className="volume-button"
                    onClick={() => void action({ type: 'volume', volume: volume > 0 ? 0 : 70 })}
                    title={volume > 0 ? 'Mute' : 'Unmute'}
                  >
                    {volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={volume}
                    onChange={(event) => setVolumeDraft(Number(event.target.value))}
                    onPointerUp={commitVolume}
                    onKeyUp={commitVolume}
                    style={{ '--filled': `${volume}%` } as CSSProperties}
                    aria-label="Volume"
                  />
                  <span className="volume-value">{volume}%</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="player-empty">
            <div className="player-empty-icon"><Music2 size={30} /></div>
            <h2>{apiConnected ? 'Nothing playing right now.' : 'Start something on Spotify.'}</h2>
            <p>
              {apiConnected
                ? `Spotify is connected${
                    status?.profile?.name ? ` as ${status.profile.name}` : ''
                  }. Press play on any device and the track will appear here.`
                : 'Open Spotify on this computer and press play. Notch reads the Windows media session, so there is nothing to set up.'}
            </p>
            <div>
              <button
                className="primary-button"
                onClick={() => {
                  void launchSpotify().then((opened) => {
                    if (!opened) window.notch.openExternal('https://open.spotify.com')
                  })
                }}
              >
                <ExternalLink size={14} /> Open Spotify
              </button>
              {!apiConnected && (
                <button className="soft-button" onClick={() => openSettings('spotify')}>
                  <SlidersHorizontal size={13} /> Settings
                </button>
              )}
            </div>
            {playback === null && (
              <span className="player-hint">Waiting for playback data…</span>
            )}
          </div>
        )}
      </section>

      <aside className="queue-panel">
        <div className="queue-head">
          <div>
            <span className="eyebrow">{localMode ? 'Desktop session' : 'Up next'}</span>
            <h2>{localMode ? 'Queue' : 'Up next'}</h2>
          </div>
          <ListMusic size={16} />
        </div>

        {localMode ? (
          <div className="local-queue-state">
            <div className="local-queue-icon">
              <Music2 size={22} />
            </div>
            <h3>Playing from Spotify Desktop</h3>
            <p>
              Your current track and transport controls work without any setup. Spotify does not
              expose the upcoming queue through Windows, so connect a Spotify app to see what is next,
              use volume, shuffle and repeat.
            </p>
            <button className="primary-button" onClick={() => openSettings('spotify')}>
              <SlidersHorizontal size={14} /> Unlock full Spotify
            </button>
            <span className="local-queue-note">One-time setup · optional</span>
          </div>
        ) : (
          <div className="queue-list">
            {queue.length === 0 && (
              <div className="queue-empty">
                <ListMusic size={20} />
                <span>Nothing queued yet.</span>
              </div>
            )}
            {queue.map((item, index) => (
              <button
                type="button"
                className={`queue-item ${queuePendingUri === item.uri ? 'is-loading' : ''}`}
                key={`${item.id}-${index}`}
                onClick={() => {
                  if (!item.uri || queuePending.current) return
                  queuePending.current = item.uri
                  setQueuePendingUri(item.uri)
                  void action({
                    type: 'play-track',
                    uri: item.uri,
                    contextUri: playback?.contextUri || undefined,
                    deviceId:
                      playback?.device?.id && playback.device.id !== 'spotify-desktop'
                        ? playback.device.id
                        : undefined
                  }).finally(() => {
                    queuePending.current = null
                    setQueuePendingUri(null)
                  })
                }}
                title={`Play ${item.name}`}
                aria-label={`Play ${item.name} by ${item.artists}`}
                aria-busy={queuePendingUri === item.uri}
                disabled={!item.uri}
              >
                <span className="queue-index">{String(index + 1).padStart(2, '0')}</span>
                <Cover image={item.image} seed={item.id} size={34} className="queue-cover" />
                <span className="queue-meta">
                  <strong>{item.name}</strong>
                  <small>{item.artists}</small>
                </span>
                <span className="queue-time">{formatDuration(item.duration)}</span>
                {queuePendingUri === item.uri ? (
                  <Loader2 size={12} className="queue-play spin" />
                ) : (
                  <Play size={11} className="queue-play" fill="currentColor" />
                )}
              </button>
            ))}
          </div>
        )}

        <div className="account-card">
          <div className="account-profile">
            {status?.profile?.image ? (
              <img src={status.profile.image} alt="" />
            ) : (
              <span className="profile-fallback">
                {localMode ? <Music2 size={13} /> : status?.profile?.name?.slice(0, 1) || 'S'}
              </span>
            )}
            <div>
              <strong>{status?.profile?.name || (localMode ? 'Spotify Desktop' : 'Spotify listener')}</strong>
              <span>
                {localMode
                  ? 'Local Windows media session'
                  : `${status?.profile?.product === 'premium' ? 'Premium' : 'Free'} account`}
              </span>
            </div>
            <span className="account-live">{localMode ? 'Local' : 'Live'}</span>
          </div>
          <div className="account-actions">
            <button className="link-button" onClick={() => window.notch.openExternal('https://open.spotify.com')}>
              <ExternalLink size={11} /> Open Spotify
            </button>
            {localMode ? (
              <button className="link-button" onClick={() => openSettings('spotify')}>
                <SlidersHorizontal size={11} /> Full connection
              </button>
            ) : (
              <button className="link-button danger-text" onClick={() => void disconnect()}>
                <LogOut size={11} /> Disconnect
              </button>
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}
