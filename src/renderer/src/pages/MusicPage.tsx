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
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { formatDuration } from '../lib/time'
import { useApp } from '../state/AppContext'
import { useMedia } from '../state/MediaContext'
import { isSpotifySource, normalizeMediaPreference, playbackHeading, playbackSessionId } from '../../../shared/mediaFollow'

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
  const tone = useMemo(() => {
    let hash = 0
    for (let index = 0; index < seed.length; index += 1) hash = seed.charCodeAt(index) + ((hash << 5) - hash)
    return 5 + (Math.abs(hash) % 6)
  }, [seed])

  return (
    <div
      className={`music-page-cover ${className}`}
      style={{
        width: size,
        height: size,
        background: image
          ? undefined
          : `radial-gradient(circle at 30% 22%, hsl(0 0% ${tone + 11}%), transparent 55%),
             radial-gradient(circle at 74% 76%, hsl(0 0% ${tone}%), transparent 58%),
             linear-gradient(150deg, hsl(0 0% ${tone - 2}%), #050505)`
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
          <Cover seed="notch-spotify" size={state.settings.panelSize === 'compact' ? 72 : 236} />
          <span className="spotify-wave">
            <i /><i /><i /><i /><i />
          </span>
        </div>
        <div className="spotify-hero-copy">
          <span className="eyebrow"><span className="spotify-dot" /> Music &amp; Media</span>
          <h1>Your soundtrack,<br />in the notch.</h1>
          <p>
            Play in Spotify and {window.notchDemo ? 'Hero Notch' : 'Notch'} follows it through Windows: play/pause, skip, seek and
            the current track, no setup needed. Connect a Spotify Client ID to unlock the queue,
            volume and your library. YouTube Music is followed too when it is the only music
            playing.
          </p>
          <div className="spotify-hero-actions">
            {hasClientId ? (
              <button className="primary-button spotify-primary" onClick={() => void connect()} disabled={connecting}>
                {connecting ? <Loader2 size={15} className="spin" /> : <Music2 size={15} />}
                {connecting ? 'Waiting for Spotify…' : 'Connect Spotify'}
              </button>
            ) : (
              <button
                className="primary-button spotify-primary"
                onClick={() => {
                  void window.notch.spotify.launch('spotify:').then((opened) => {
                    if (!opened) window.notch.openExternal('https://open.spotify.com')
                  })
                }}
              >
                <ExternalLink size={15} /> Open Spotify
              </button>
            )}
            <button
              className="soft-button"
              onClick={() => openSettings('spotify')}
            >
              <SlidersHorizontal size={13} />
              {hasClientId ? 'Music settings' : 'Add Client ID (optional)'}
            </button>
          </div>
          <span className="spotify-note">
            Only Spotify and YouTube Music are followed. No Client ID is needed for play/pause,
            skip, seek and track info.
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
  const artSize = state.settings.panelSize === 'compact' ? 112 : 226
  const preference = normalizeMediaPreference(state.settings.mediaSource)
  const {
    status,
    playback,
    queue,
    action,
    togglePlay,
    launchSpotify,
    clearCachedPlayback,
    connect,
    connecting,
    progressMs,
    disconnect,
    pending,
    library,
    phase,
    playerName,
    playerAvailable,
    spotifyControls
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
  const sessionId = playbackSessionId(playback)
  useEffect(() => {
    setScrub(null)
    setVolumeDraft(null)
  }, [sessionId, state.settings.mediaSource])

  const hasCachedTrack = Boolean(playback?.track)

  if (preference === 'auto' &&
      !status?.connected && !status?.localAvailable && !hasCachedTrack) return <ConnectSpotify />

  const apiConnected = spotifyControls
  const localMode = !apiConnected
  const spotifyPlayer = apiConnected || isSpotifySource(sessionId || preference)
  const changing = pending === 'next' || pending === 'previous'
  const phaseCopy =
    phase === 'opening'
      ? 'Opening Spotify…'
      : phase === 'no-device'
        ? 'Spotify is not open yet'
        : phase === 'premium'
          ? 'A song from Notch needs Spotify Premium'
          : null

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
              <span className="spotify-dot" />{' '}
              {playerName} ·{' '}
              {phase === 'opening'
                ? 'Opening Spotify…'
                : phase === 'no-device'
                  ? 'Not open'
                  : !playerAvailable
                    ? 'Unavailable'
                    : playerAvailable
                      ? playback?.device?.name &&
                        playback.device.name.toLowerCase() !== playerName.toLowerCase()
                        ? playback.device.name
                        : 'This PC'
                      : 'Closed · cached'}
            </span>
            <h1>{playbackHeading(playback)}</h1>
          </div>
          <div className="player-head-actions">
            {apiConnected && status?.profile?.image && <img className="profile-face" src={status.profile.image} alt="" />}
            {!playerAvailable && track && (
              <button
                className="soft-button compact"
                onClick={clearCachedPlayback}
                title="Clear remembered track and switch player"
              >
                Switch player
              </button>
            )}
            <button className="soft-button compact" onClick={() => openSettings('spotify')} title="Music settings">
              <SlidersHorizontal size={13} />
            </button>
          </div>
        </header>

        {track ? (
          <div className="player-main">
            <button className="player-art-button" onClick={openTrack} title={track.url ? `Open track in ${playerName}` : playerName} disabled={!track.url}>
              <Cover image={track.image} seed={track.id} size={artSize} />
              {track.url && <span className="art-open"><ArrowUpRight size={13} /> {playerName}</span>}
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
                  disabled={!playerAvailable || playback?.controls?.seek === false}
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
                <button className="player-control" onClick={() => void action({ type: 'previous' })} title="Previous" disabled={!playerAvailable || playback?.controls?.previous === false}>
                  <SkipBack size={21} fill="currentColor" />
                </button>
                <motion.button
                  className="player-play"
                  onClick={() => void togglePlay()}
                  whileTap={{ scale: 0.93 }}
                  title={phase === 'opening' ? 'Opening Spotify…' : playback?.playing ? 'Pause' : 'Play'}
                  aria-busy={phase === 'opening'}
                  disabled={!playerAvailable && preference !== 'auto'}
                >
                  {phase === 'opening' ? (
                    <Loader2 size={22} className="spin" />
                  ) : playback?.playing ? (
                    <Pause size={23} fill="currentColor" />
                  ) : (
                    <Play size={23} fill="currentColor" />
                  )}
                </motion.button>
                <button className="player-control" onClick={() => void action({ type: 'next' })} title="Next" disabled={!playerAvailable || playback?.controls?.next === false}>
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

              {apiConnected ? (
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
              ) : (
                <button className="local-session-note" onClick={() => openSettings('spotify')}>
                  {playerName} · {playerAvailable ? 'local controls' : 'unavailable'}
                  <span>Windows media session</span>
                </button>
              )}
              {phaseCopy && (
                <div className={`player-phase is-${phase}`}>
                  <span>{phaseCopy}</span>
                  {phase === 'no-device' && (
                    <button type="button" onClick={() => void launchSpotify()}>
                      Open Spotify
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="player-empty">
            <div className="player-empty-icon"><Music2 size={30} /></div>
            <h2>{playerAvailable ? 'Nothing playing right now.' : `${playerName} is unavailable.`}</h2>
            <p>
              {apiConnected
                ? `Spotify is connected${
                    status?.profile?.name ? ` as ${status.profile.name}` : ''
                  }. Press play on any device and the track will appear here.`
                : `Start playback in ${playerName}. The notch will follow it when its media session returns.`}
            </p>
            {phaseCopy && <p className={`player-phase is-${phase}`}>{phaseCopy}</p>}
            <div>
              {apiConnected && (
                <button className="primary-button" onClick={() => void togglePlay()}>
                  {phase === 'opening' ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
                  {phase === 'opening' ? 'Opening Spotify…' : 'Play'}
                </button>
              )}
              {spotifyPlayer && <button
                className={apiConnected ? 'soft-button' : 'primary-button'}
                onClick={() => {
                  void launchSpotify().then((opened) => {
                    if (!opened) window.notch.openExternal('https://open.spotify.com')
                  })
                }}
              >
                <ExternalLink size={14} /> Open Spotify
              </button>}
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
            <span className="eyebrow">
              {localMode ? (window.notchDemo ? 'Native media · zero setup' : 'Windows media') : 'Up next'}
            </span>
            <h2>{localMode ? 'Player' : 'Up next'}</h2>
          </div>
          <ListMusic size={16} />
        </div>

        {localMode ? (
          <div className="local-queue-state">
            <div className="local-queue-icon">
              <Music2 size={22} />
            </div>
            <h3>{playerAvailable ? playerName : `${playerName} is closed`}</h3>
            <p>
              {playerAvailable
                ? window.notchDemo
                  ? 'Zero-setup native media control. Optional Spotify PKCE adds queue, library & volume.'
                  : `Playing through Windows. Notch follows Spotify and YouTube Music only.`
                : `Open Spotify and press play, and ${window.notchDemo ? 'Hero Notch' : 'Notch'} picks it up. It follows Spotify and YouTube Music only.`}
            </p>
            <div className="local-queue-actions">
              <button className="primary-button compact" onClick={() => void launchSpotify()}>
                <ExternalLink size={13} /> Open Spotify
              </button>
              <button className="soft-button compact" onClick={() => openSettings('spotify')}>
                <SlidersHorizontal size={13} /> Settings
              </button>
            </div>
            <span className="local-queue-note">
              Connect Spotify for queue, volume, shuffle and repeat.
            </span>
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

        {apiConnected && (
          <section className="jump-back">
            <div className="jump-head">
              <span className="eyebrow">Continue</span>
              <h2>Jump back in</h2>
            </div>
            {status?.needsConsent ? (
              <div className="jump-consent">
                <p>Reconnect Spotify to show what you were just listening to. Your playback connection stays.</p>
                <button className="soft-button compact" onClick={() => void connect()} disabled={connecting}>
                  {connecting ? <Loader2 size={12} className="spin" /> : <Music2 size={12} />}
                  Reconnect
                </button>
              </div>
            ) : (
              <div className="jump-list">
                {library.recent.length === 0 && library.playlists.length === 0 && (
                  <p className="jump-empty">Recently played shows up here after the next track.</p>
                )}
                {library.playlists.length > 0 && (
                  <div className="jump-playlists">
                    {library.playlists.map((playlist) => (
                      <button
                        type="button"
                        key={playlist.id}
                        className="jump-playlist"
                        onClick={() => void action({ type: 'play-context', contextUri: playlist.uri })}
                      >
                        <Cover image={playlist.image} seed={playlist.id} size={22} className="queue-cover" />
                        <span>{playlist.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                {library.recent.map((item) => (
                  <button
                    type="button"
                    key={`${item.uri}-${item.playedAt}`}
                    className="jump-item"
                    onClick={() =>
                      void action({
                        type: 'play-track',
                        uri: item.uri,
                        contextUri:
                          item.contextType === 'album' || item.contextType === 'playlist' || item.contextType === 'show'
                            ? item.contextUri || undefined
                            : undefined
                      })
                    }
                  >
                    <Cover image={item.image} seed={item.id} size={34} className="queue-cover" />
                    <span className="queue-meta">
                      <strong>{item.name}</strong>
                      <small>
                        {item.artists}
                        {item.contextName ? ` · ${item.contextName}` : ''}
                      </small>
                    </span>
                    <Play size={11} className="queue-play" fill="currentColor" />
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        <div className="account-card">
          <div className="account-profile">
            {apiConnected && status?.profile?.image ? (
              <img src={status.profile.image} alt="" />
            ) : (
              <span className="profile-fallback">
                {localMode ? <Music2 size={13} /> : status?.profile?.name?.slice(0, 1) || 'S'}
              </span>
            )}
            <div>
              <strong>{apiConnected ? status?.profile?.name || 'Spotify listener' : playerName}</strong>
              <span>
                {localMode
                  ? window.notchDemo
                    ? 'Native OS media · Spotify PKCE ready'
                    : 'Local Windows media session'
                  : apiConnected
                    ? `${status?.profile?.product === 'premium' ? 'Premium' : 'Free'} account`
                    : 'Last track, saved on this computer'}
              </span>
            </div>
            <span className="account-live">{localMode ? 'Local' : apiConnected ? 'Live' : 'Cached'}</span>
          </div>
          <div className="account-actions">
            {!localMode && (
              <button className="link-button" onClick={() => window.notch.openExternal('https://open.spotify.com')}>
                <ExternalLink size={11} /> Open Spotify
              </button>
            )}
            {localMode ? (
              <button className="link-button" onClick={() => openSettings('spotify')}>
                <SlidersHorizontal size={11} /> Connect Spotify
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
