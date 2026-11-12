import {
  Activity,
  Camera,
  CameraOff,
  Check,
  Loader2,
  PersonStanding,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Sparkles
} from 'lucide-react'
import { useEffect, useRef, type CSSProperties } from 'react'
import type { PostureHistoryPoint } from '../state/PostureContext'
import { ProgressRing } from '../components/ProgressRing'
import { usePosture } from '../state/PostureContext'
import { formatMinutes } from '../lib/time'

const CHART_WINDOW_MS = 60_000

function chartSegments(
  history: PostureHistoryPoint[],
  windowMs = CHART_WINDOW_MS
): string[] {
  const now = history.at(-1)?.t ?? 0
  const segments: string[] = []
  let current: string[] = []
  for (const point of history) {
    if (now - point.t > windowMs) continue
    const x = ((point.t - (now - windowMs)) / windowMs) * 100
    if (point.score === null) {
      if (current.length) {
        segments.push(current.join(' '))
        current = []
      }
      continue
    }
    const y = 40 - (point.score / 100) * 36 - 2
    current.push(`${x.toFixed(2)},${y.toFixed(2)}`)
  }
  if (current.length) segments.push(current.join(' '))
  return segments
}

function scoreColor(score: number, threshold: number): string {
  if (score >= threshold) return '#a8e36b'
  if (score >= threshold - 12) return '#f6c85f'
  return '#ff6f61'
}

export function PosturePage() {
  const posture = usePosture()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !posture.stream) return
    video.srcObject = posture.stream
    void video.play().catch(() => undefined)
    return () => {
      video.srcObject = null
    }
  }, [posture.stream])

  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    const context = canvas.getContext('2d')
    if (!context) return
    const videoWidth = video.videoWidth || 640
    const videoHeight = video.videoHeight || 480
    const rect = video.getBoundingClientRect()
    const width = Math.max(1, Math.round(rect.width))
    const height = Math.max(1, Math.round(rect.height))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    context.clearRect(0, 0, width, height)

    const landmarks = posture.landmarks
    if (!landmarks) return
    const scale = Math.max(width / videoWidth, height / videoHeight)
    const drawWidth = videoWidth * scale
    const drawHeight = videoHeight * scale
    const offsetX = (width - drawWidth) / 2
    const offsetY = (height - drawHeight) / 2
    const point = (index: number): { x: number; y: number } | null => {
      const landmark = landmarks[index]
      if (!landmark) return null
      const visibility = typeof landmark.visibility === 'number' ? landmark.visibility : 1
      if (visibility < 0.35) return null
      return {
        x: offsetX + landmark.x * drawWidth,
        y: offsetY + landmark.y * drawHeight
      }
    }
    const sets: [number, number][] = [
      [7, 11],
      [8, 12],
      [11, 12],
      [11, 23],
      [12, 24]
    ]
    context.strokeStyle = 'rgba(168, 227, 107, 0.72)'
    context.lineWidth = Math.max(2, width / 320)
    context.shadowColor = 'rgba(168, 227, 107, 0.45)'
    context.shadowBlur = 8
    for (const [from, to] of sets) {
      const a = point(from)
      const b = point(to)
      if (!a || !b) continue
      context.beginPath()
      context.moveTo(a.x, a.y)
      context.lineTo(b.x, b.y)
      context.stroke()
    }
    context.shadowBlur = 0
    context.fillStyle = 'rgba(236, 255, 217, 0.9)'
    for (const index of [0, 7, 8, 11, 12, 23, 24]) {
      const p = point(index)
      if (!p) continue
      context.beginPath()
      context.arc(p.x, p.y, Math.max(2.5, width / 190), 0, Math.PI * 2)
      context.fill()
    }
  }, [posture.landmarks])

  const total = posture.goodSeconds + posture.badSeconds
  const goodPercent = total > 0 ? Math.round((posture.goodSeconds / total) * 100) : 0
  const score = posture.score ?? 0
  const hasScore = posture.status === 'running' && posture.score !== null
  const color = hasScore ? scoreColor(score, posture.threshold) : 'var(--accent)'
  const title =
    posture.status === 'off'
      ? 'Sit tall without thinking about it.'
      : posture.status === 'loading'
        ? 'Waking up the coach.'
        : posture.status === 'error'
          ? 'The camera needs a moment.'
          : posture.status === 'no-pose'
            ? 'Find your seat in the frame.'
            : hasScore && score >= posture.threshold
              ? 'You are stacked.'
              : hasScore && score >= posture.threshold - 12
                ? 'Slipping a little.'
                : 'Sit up, shrimp.'

  return (
    <div
      className="posture-page"
      data-posture-status={posture.status}
      data-posture-error={posture.error || ''}
      data-posture-enabled={String(posture.enabled)}
    >
      <section className={`posture-stage ${posture.enabled ? 'is-live' : ''}`}>
        {posture.enabled ? (
          <>
            {posture.stream && (
              <div className="posture-camera-feed">
                <video ref={videoRef} muted playsInline className="posture-video" />
                <canvas ref={canvasRef} className="posture-skeleton" />
              </div>
            )}
            {!posture.stream && (
              <div className="posture-camera-placeholder">
                {posture.status === 'error' ? (
                  <>
                    <CameraOff size={30} />
                    <strong>Camera unavailable</strong>
                    <span>{posture.error || 'Check Windows camera privacy settings.'}</span>
                    <button
                      className="soft-button"
                      onClick={() => {
                        posture.disable()
                        setTimeout(() => posture.enable(), 60)
                      }}
                    >
                      <RefreshCw size={13} /> Try again
                    </button>
                  </>
                ) : (
                  <>
                    <Camera size={30} />
                    <strong>Starting the camera…</strong>
                    <span>Loading the local pose model. The first run downloads it once.</span>
                    <Loader2 size={16} className="spin" />
                  </>
                )}
              </div>
            )}
            {posture.setupRunning && (
              <div className="posture-setup-overlay">
                <span className="eyebrow">Posture setup test</span>
                <h3>Hold your tallest seat.</h3>
                <p>
                  Face the camera and sit as tall as you comfortably can, with your head over
                  your shoulders. This becomes your good-posture baseline. Waist visibility is
                  optional — Notch uses head, shoulders and depth.
                </p>
                <div className="posture-setup-checks">
                  <span className={posture.coverage.ears ? 'is-ok' : ''}>
                    <Check size={10} /> Head
                  </span>
                  <span className={posture.coverage.shoulders ? 'is-ok' : ''}>
                    <Check size={10} /> Shoulders
                  </span>
                  <span className={posture.coverage.hips ? 'is-ok optional' : 'optional'}>
                    <Check size={10} /> Waist {posture.coverage.hips ? 'visible' : 'optional'}
                  </span>
                </div>
                <div className="posture-setup-progress">
                  <span style={{ width: `${Math.round(posture.setupProgress * 100)}%` }} />
                </div>
                <span className="posture-setup-caption">
                  {posture.setupProgress < 0.2
                    ? 'Measuring the frame…'
                    : posture.setupProgress < 0.85
                      ? 'Capturing your baseline…'
                      : 'Almost there…'}
                </span>
              </div>
            )}
            <div className="posture-camera-top">
              <span className={`posture-live ${hasScore ? 'is-on' : ''}`}>
                <i /> {hasScore ? 'Tracking' : posture.status === 'no-pose' ? 'Searching' : 'Starting'}
              </span>
              <span className="posture-privacy-pill">
                <ShieldCheck size={10} /> On-device
              </span>
            </div>
            {hasScore && (
              <div className="posture-camera-score" style={{ '--score-color': color } as CSSProperties}>
                <strong>{score}</strong>
                <span>{posture.metrics?.advice || 'Posture score'}</span>
              </div>
            )}
          </>
        ) : (
          <div className="posture-invite">
            <div className="posture-orbit" aria-hidden="true">
              <span className="posture-orbit-ring one" />
              <span className="posture-orbit-ring two" />
              <PersonStanding size={52} />
              <span className="posture-orbit-dot" />
            </div>
            <span className="eyebrow">Posture coach · local camera</span>
            <h1>{title}</h1>
            <p>
              Use your webcam as a quiet posture coach. Notch scores your alignment in real time and
              nudges you when you start to shrimp. Frames are processed on this computer and never
              stored or uploaded.
            </p>
            <button className="primary-button" onClick={posture.enable}>
              <Camera size={15} /> Turn on posture coach
            </button>
            <div className="posture-feature-row">
              <span><Activity size={12} /> Live 0–100 score</span>
              <span><Sparkles size={12} /> Slouch alerts</span>
              <span><ShieldCheck size={12} /> Private &amp; local</span>
            </div>
          </div>
        )}
      </section>

      <aside className="posture-panel">
        <div className="posture-panel-head">
          <span className="eyebrow"><PersonStanding size={12} /> Posture</span>
          <h2>{title}</h2>
          <p>
            {posture.status === 'off'
              ? 'Turn it on for continuous coaching. Turn it off to release the camera.'
              : posture.status === 'no-pose'
                ? 'Shoulders and ears need to be visible. Sit back a little if you are too close.'
                : posture.status === 'error'
                  ? posture.error || 'Camera unavailable.'
                  : 'Runs continuously while on. The Windows camera indicator stays lit.'}
          </p>
        </div>

        {posture.enabled && (
          <>
            <div className="posture-score-row">
              <div className="posture-gauge">
                <ProgressRing
                  progress={(hasScore ? score : 0) / 100}
                  size={102}
                  stroke={7}
                  color={color}
                  track="rgba(255,255,255,.08)"
                >
                  <strong>{hasScore ? score : '—'}</strong>
                  <span>score</span>
                </ProgressRing>
              </div>
              <div className="posture-advice">
                <span className="eyebrow">Coach says</span>
                <strong>
                  {posture.status === 'error'
                    ? 'Camera off'
                    : posture.status === 'no-pose'
                      ? 'Move into frame'
                      : posture.metrics?.advice || 'Hold this position.'}
                </strong>
                <span>
                  {goodPercent > 0 ? `${goodPercent}% good today` : 'Your baseline starts today.'}
                </span>
              </div>
            </div>

            {posture.history.length > 1 && (
              <div className="posture-chart">
                <svg viewBox="0 0 100 40" preserveAspectRatio="none">
                  <line
                    className="chart-threshold"
                    x1="0"
                    x2="100"
                    y1={40 - (posture.threshold / 100) * 36 - 2}
                    y2={40 - (posture.threshold / 100) * 36 - 2}
                  />
                  {chartSegments(posture.history).map((points, index) => (
                    <polyline key={points + index} className="chart-line" points={points} />
                  ))}
                </svg>
                <span className="chart-caption">Last 60 seconds</span>
              </div>
            )}

            <div className="posture-controls">
              <label className="posture-slider">
                <span>
                  <span>Slouch alert threshold</span>
                  <strong>{posture.threshold}</strong>
                </span>
                <input
                  type="range"
                  min={30}
                  max={90}
                  value={posture.threshold}
                  onChange={(event) => posture.setThreshold(Number(event.target.value))}
                  style={{ '--filled': `${((posture.threshold - 30) / 60) * 100}%` } as CSSProperties}
                />
              </label>
              <div className="posture-toggle-row">
                <span>
                  <strong>Notification alerts</strong>
                  <small>Nudge me after a few seconds of slouching.</small>
                </span>
                <button
                  className={`switch ${posture.notifications ? 'is-on' : ''}`}
                  onClick={() => posture.setNotifications(!posture.notifications)}
                  role="switch"
                  aria-checked={posture.notifications}
                >
                  <span style={{ transform: posture.notifications ? 'translateX(16px)' : 'none' }} />
                </button>
              </div>
              <div className="posture-always-on">
                <Camera size={13} />
                <span>
                  <strong>Always coaching</strong>
                  <small>
                    Camera and Windows indicator stay on while the coach is on. Turn it off
                    below to release both.
                  </small>
                </span>
              </div>
              {posture.baseline &&
                (!posture.baseline.version || posture.baseline.version < 2) && (
                  <div className="posture-upgrade">
                    <Sparkles size={13} />
                    <div>
                      <strong>Retake setup for better slouch detection</strong>
                      <span>
                        This baseline predates forward-lean and depth tracking, so it can
                        read a slouch as perfect.
                      </span>
                    </div>
                    <button
                      className="soft-button compact"
                      onClick={posture.startSetupTest}
                      disabled={posture.setupRunning}
                    >
                      Retake
                    </button>
                  </div>
                )}
              <div className="posture-button-row">
                <button
                  className="soft-button"
                  onClick={posture.startSetupTest}
                  disabled={posture.setupRunning}
                >
                  <ScanLine size={13} />
                  {posture.setupRunning ? 'Running setup…' : 'Test posture setup'}
                </button>
                <button className="soft-button danger-text" onClick={posture.disable}>
                  <CameraOff size={13} /> Turn off camera
                </button>
              </div>
              {posture.setupMessage && (
                <p className={`posture-setup-message ${posture.baseline ? 'is-good' : ''}`}>
                  {posture.setupMessage}
                </p>
              )}
              {!posture.baseline && !posture.setupMessage && (
                <p className="posture-setup-message">
                  Run the 8-second test first so the score matches your camera and chair.
                </p>
              )}
            </div>

            <div className="posture-stats">
              <div>
                <span className="posture-stat-dot good" />
                <strong>{formatMinutes(Math.round(posture.goodSeconds / 60))}</strong>
                <small>good posture</small>
              </div>
              <div>
                <span className="posture-stat-dot bad" />
                <strong>{formatMinutes(Math.round(posture.badSeconds / 60))}</strong>
                <small>slouching</small>
              </div>
              <div>
                <span className="posture-stat-check"><Check size={11} /></span>
                <strong>
                  {posture.baseline
                    ? posture.baseline.coverage === 'full'
                      ? 'Full'
                      : 'Upper'
                    : 'Not yet'}
                </strong>
                <small>seat baseline</small>
              </div>
            </div>
            <span className="posture-footnote">
              <ShieldCheck size={11} /> Camera frames are processed locally and never saved.
            </span>
          </>
        )}

        {!posture.enabled && (
          <div className="posture-side-note">
            <strong>Why this exists</strong>
            <p>
              Small posture changes compound. A gentle nudge when your head drifts forward is more
              useful than a reminder to “sit straight” once a day.
            </p>
            <strong>What it stores</strong>
            <p>
              Only a score baseline and time totals. No images, no video, no cloud. The pose model
              runs in the notch process and the camera stops when you turn it off.
            </p>
          </div>
        )}
      </aside>
    </div>
  )
}
