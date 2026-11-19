import {
  Activity,
  BellOff,
  Camera,
  CameraOff,
  Check,
  Crosshair,
  Loader2,
  Minus,
  Moon,
  PersonStanding,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ProgressRing } from '../components/ProgressRing'
import { useApp } from '../state/AppContext'
import { useNowWhen } from '../state/clock'
import { GUIDE_CAPTURE_S, GUIDE_STEPS, SETUP_LEAD_S, SETUP_TOTAL_S, usePosture } from '../state/PostureContext'
import { dateKey, formatMinutes, parseDateKey } from '../lib/time'
import type { PostureDay } from '../../../shared/types'

/** Less than this much coached time in a day is too little to call it good or bad. */
const WEEK_MIN_SECONDS = 60

function goodShare(day: { goodSeconds: number; badSeconds: number } | undefined): number | null {
  if (!day) return null
  const total = day.goodSeconds + day.badSeconds
  return total >= WEEK_MIN_SECONDS ? day.goodSeconds / total : null
}

/** Share of good time across the days that have enough coached time, or null. */
function poolShare(list: ({ goodSeconds: number; badSeconds: number } | undefined)[]): number | null {
  let good = 0
  let total = 0
  for (const day of list) {
    if (!day || day.goodSeconds + day.badSeconds < WEEK_MIN_SECONDS) continue
    good += day.goodSeconds
    total += day.goodSeconds + day.badSeconds
  }
  return total > 0 ? good / total : null
}

/**
 * The last seven days, so the person can see whether the coach is actually
 * changing how they sit, not just how today went. Today is live; earlier days
 * come from the history the main process files at midnight.
 */
function PostureWeek({
  days,
  today
}: {
  days: PostureDay[]
  today: { goodSeconds: number; badSeconds: number }
}) {
  const byKey = new Map(days.map((day) => [day.dayKey, day]))
  const now = new Date()
  const keyFor = (offset: number): string => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset)
    return dateKey(date)
  }
  const todayKeyValue = keyFor(0)
  const dayAt = (offset: number) => (offset === 0 ? today : byKey.get(keyFor(offset)))
  const week = Array.from({ length: 7 }, (_, index) => 6 - index).map((offset) => ({
    key: keyFor(offset),
    share: goodShare(dayAt(offset))
  }))
  const thisWeek = poolShare(Array.from({ length: 7 }, (_, offset) => dayAt(offset)))
  const lastWeek = poolShare(Array.from({ length: 7 }, (_, index) => byKey.get(keyFor(index + 7))))
  if (week.every((day) => day.share === null)) return null
  const change = thisWeek !== null && lastWeek !== null ? Math.round((thisWeek - lastWeek) * 100) : null

  return (
    <div className="posture-week">
      <div className="posture-week-head">
        <span>Last 7 days</span>
        <span>
          {thisWeek !== null ? `${Math.round(thisWeek * 100)}% good` : ''}
          {change !== null && change !== 0 && (
            <em className={change > 0 ? 'is-up' : 'is-down'}>
              {change > 0 ? `up ${change}` : `down ${Math.abs(change)}`} on last week
            </em>
          )}
        </span>
      </div>
      <div className="posture-week-bars">
        {week.map((day) => {
          const label = parseDateKey(day.key).toLocaleDateString(undefined, { weekday: 'narrow' })
          const name = parseDateKey(day.key).toLocaleDateString(undefined, { weekday: 'long' })
          return (
            <div
              key={day.key}
              className={`posture-week-day ${day.key === todayKeyValue ? 'is-today' : ''}`}
              title={day.share === null ? `${name}: not enough time coached` : `${name}: ${Math.round(day.share * 100)}% good`}
            >
              <span className="posture-week-column">
                {day.share !== null && (
                  <span className="posture-week-fill" style={{ height: `${Math.max(6, Math.round(day.share * 100))}%` }} />
                )}
              </span>
              <small>{label}</small>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function scoreColor(score: number, threshold: number): string {
  if (score >= threshold) return '#4ade80'
  if (score >= threshold - 12) return '#fbbf24'
  return '#f87171'
}

/** Plain wording for each reason a person in view cannot be scored. */
const NO_POSE_COPY: Record<string, { title: string; pill: string; hint: string }> = {
  absent: {
    title: 'Nobody in frame',
    pill: 'No one in frame',
    hint: 'Roll back so your head and shoulders fit, then hold still.'
  },
  shoulders: {
    title: 'I can see you, but not both shoulders',
    pill: 'Shoulders hidden',
    hint: 'Sit back a little, or tilt the screen so both shoulders are in the picture.'
  },
  turned: {
    title: 'Looking away',
    pill: 'Looking away',
    hint: 'Face the screen and the coach picks your posture back up.'
  },
  'too-close': {
    title: 'Too close to the camera',
    pill: 'Too close',
    hint: 'Sit back a little so your head and shoulders fit.'
  },
  odd: {
    title: 'I cannot read your posture',
    pill: 'Cannot read',
    hint: 'Sit so your head and shoulders are clearly in view.'
  }
}

function postureWord(score: number, threshold: number): string {
  if (score >= threshold) return 'Good'
  if (score >= threshold - 12) return 'Getting bent'
  return 'Bad'
}

/** Side-view stick figure, so each setup step reads without any words. Screen on the right. */
function GuideFigure({ kind }: { kind: 'good' | 'bad' | 'close' }) {
  const pose =
    kind === 'good'
      ? { head: [58, 28], shoulder: [58, 48], hip: [58, 96] }
      : kind === 'bad'
        ? { head: [86, 56], shoulder: [70, 60], hip: [50, 96] }
        : { head: [94, 28], shoulder: [92, 48], hip: [70, 96] }
  const line = (a: number[], b: number[]) => (
    <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
  )
  return (
    <svg
      viewBox="0 0 140 112"
      width="132"
      height="104"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="4"
      strokeLinecap="round"
      style={{ opacity: 0.9 }}
    >
      <line x1="12" y1="106" x2="128" y2="106" strokeWidth="2" opacity="0.4" />
      <line x1="130" y1="26" x2="130" y2="74" strokeWidth="6" opacity="0.55" />
      <circle cx={pose.head[0]} cy={pose.head[1]} r="10" />
      {line(pose.head, pose.shoulder)}
      {line(pose.shoulder, pose.hip)}
      {line(pose.hip, [pose.hip[0] + 26, pose.hip[1]])}
    </svg>
  )
}

export function PosturePage() {
  const { state, expanded } = useApp()
  const compact = state.settings.panelSize === 'compact'
  const posture = usePosture()
  const now = useNowWhen(expanded && posture.snoozeUntil !== null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [demoVideoUrl, setDemoVideoUrl] = useState('')

  useEffect(() => {
    const api = window.notchDemo
    if (!api) return
    let active = true
    let objectUrl = ''
    void api.getPostureVideo().then((bytes) => {
      if (!active || !bytes.byteLength) return
      objectUrl = URL.createObjectURL(new Blob([bytes.slice()], { type: 'video/mp4' }))
      setDemoVideoUrl(objectUrl)
    })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !posture.stream) return
    video.srcObject = posture.stream
    void video.play().catch(() => undefined)
    return () => {
      video.srcObject = null
    }
  }, [posture.stream])

  const drawSkeleton = useCallback(() => {
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
    const activeColor =
      posture.status === 'running' && posture.score !== null
        ? scoreColor(posture.score, posture.threshold)
        : '#7ec8e3'
    context.strokeStyle = activeColor
    context.globalAlpha = 0.82
    context.lineWidth = Math.max(2, width / 320)
    context.shadowColor = activeColor
    context.shadowBlur = 10
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
    context.globalAlpha = 0.96
    context.fillStyle = activeColor
    for (const index of [0, 7, 8, 11, 12, 23, 24]) {
      const p = point(index)
      if (!p) continue
      context.beginPath()
      context.arc(p.x, p.y, Math.max(2.5, width / 190), 0, Math.PI * 2)
      context.fill()
    }
    context.globalAlpha = 1
  }, [posture.landmarks, posture.score, posture.status, posture.threshold])

  useEffect(() => {
    drawSkeleton()
  }, [drawSkeleton])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const observer = new ResizeObserver(() => drawSkeleton())
    observer.observe(video)
    video.addEventListener('loadedmetadata', drawSkeleton)
    return () => {
      observer.disconnect()
      video.removeEventListener('loadedmetadata', drawSkeleton)
    }
  }, [drawSkeleton, posture.stream])

  const total = posture.goodSeconds + posture.badSeconds
  const goodPercent = total > 0 ? Math.round((posture.goodSeconds / total) * 100) : 0
  const score = posture.score ?? 0
  const hasScore = posture.status === 'running' && posture.score !== null
  const color = hasScore ? scoreColor(score, posture.threshold) : 'var(--accent)'
  const word = hasScore ? postureWord(score, posture.threshold) : ''
  const snoozeLeft = posture.snoozeUntil ? Math.max(0, posture.snoozeUntil - now) : 0
  const snoozed = snoozeLeft > 0
  const history = posture.history
  const average = useMemo(
    () =>
      history.length >= 4
        ? Math.round(history.reduce((sum, value) => sum + value, 0) / history.length)
        : null,
    [history]
  )
  const delta = useMemo(() => {
    if (history.length < 8) return null
    const recent = history.slice(-3)
    const earlier = history.slice(-12, -7)
    if (!earlier.length) return null
    const mean = (values: number[]): number =>
      values.reduce((sum, value) => sum + value, 0) / values.length
    return Math.round(mean(recent) - mean(earlier))
  }, [history])

  const title =
    posture.status === 'off'
      ? 'Sit tall without thinking about it.'
      : posture.status === 'loading'
        ? 'Waking up the coach.'
        : posture.status === 'away'
          ? 'Paused while you are away.'
          : posture.status === 'error'
          ? 'The camera needs a moment.'
          : posture.status === 'no-pose'
            ? 'Find your seat in the frame.'
            : hasScore && score >= posture.threshold
              ? 'Good posture.'
              : hasScore && score >= posture.threshold - 12
                ? 'Getting bent.'
                : 'Sit up straight.'

  const panelCopy =
    posture.status === 'off'
      ? 'Turn it on for continuous coaching. Turn it off to release the camera.'
      : posture.status === 'no-pose'
        ? 'Shoulders and ears need to be visible. Sit back a little if you are too close.'
        : posture.status === 'error'
          ? posture.error || 'Camera unavailable.'
          : 'Runs continuously while on. The Windows camera indicator stays lit.'

  const advice =
    posture.metrics?.advice ||
    (posture.status === 'away'
      ? 'Paused — nobody in frame'
      : posture.status === 'no-pose'
        ? 'Move into frame'
        : 'Camera on')
  const checks = [
    { label: 'Head', ok: posture.coverage.ears },
    { label: 'Shoulders', ok: posture.coverage.shoulders },
    { label: 'Waist', ok: posture.coverage.hips }
  ]

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
            {(posture.stream || Boolean(window.notchDemo)) && (
              <div className="posture-camera-feed">
                {window.notchDemo ? (
                  <video
                    src={demoVideoUrl || undefined}
                    autoPlay
                    loop
                    muted
                    playsInline
                    className="posture-video"
                  />
                ) : (
                  <>
                    <video ref={videoRef} muted playsInline className="posture-video" />
                    <canvas ref={canvasRef} className="posture-skeleton" />
                  </>
                )}
              </div>
            )}
            {!posture.stream && !window.notchDemo && (
              <div className="posture-camera-placeholder">
                {posture.status === 'away' ? (
                  <>
                    <Moon size={30} />
                    <strong>Paused while you are away</strong>
                    <span>
                      Nobody was in frame for a while, so the camera is off. It wakes as soon as you
                      use the keyboard or mouse.
                    </span>
                    <button className="soft-button" onClick={posture.wake}>
                      <Camera size={13} /> Resume now
                    </button>
                  </>
                ) : posture.status === 'error' ? (
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
                    <span>Loading the bundled on-device pose model…</span>
                    <Loader2 size={16} className="spin" />
                  </>
                )}
              </div>
            )}
            {posture.guide && (
              <div className="posture-setup-overlay">
                <span className="eyebrow">Step {posture.guide.step + 1} of 3</span>
                <h3>{GUIDE_STEPS[posture.guide.step].title}</h3>
                <p>{GUIDE_STEPS[posture.guide.step].hint}</p>
                <GuideFigure kind={GUIDE_STEPS[posture.guide.step].key} />
                {posture.guide.message && (
                  <p className="posture-setup-message">{posture.guide.message}</p>
                )}
                {posture.guide.phase === 'ready' && (
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                    <button type="button" className="primary-button" onClick={posture.guideReady}>
                      Ready
                    </button>
                    <button type="button" className="soft-button compact" onClick={posture.cancelGuide}>
                      <X size={12} /> Cancel
                    </button>
                  </div>
                )}
                {posture.guide.phase === 'lead' && (
                  <span className="posture-setup-caption">Get set… {posture.guide.left}</span>
                )}
                {posture.guide.phase === 'capture' && (
                  <>
                    <div className="posture-setup-progress">
                      <span
                        style={{
                          width: `${Math.round(100 * (1 - posture.guide.left / GUIDE_CAPTURE_S))}%`
                        }}
                      />
                    </div>
                    <span className="posture-setup-caption">Hold it… {posture.guide.left}</span>
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
                  optional — {window.notchDemo ? 'Hero Notch' : 'Notch'} uses head, shoulders and depth.
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
                  {posture.setupProgress < SETUP_LEAD_S / SETUP_TOTAL_S
                    ? `Ease back from the mouse and sit tall — capturing in ${Math.max(
                        1,
                        Math.ceil(SETUP_LEAD_S - posture.setupProgress * SETUP_TOTAL_S)
                      )}…`
                    : posture.setupProgress < 0.9
                      ? 'Capturing your baseline…'
                      : 'Almost there…'}
                </span>
                <button type="button" className="soft-button compact" onClick={posture.cancelSetupTest}>
                  <X size={12} /> Cancel
                </button>
              </div>
            )}
            <div className="posture-camera-top">
              <span className={`posture-live ${hasScore ? 'is-on' : ''}`}>
                <i /> {hasScore
                  ? 'Tracking'
                  : posture.status === 'away'
                    ? 'Paused'
                    : posture.status === 'no-pose'
                      ? 'Searching'
                      : 'Starting'}
              </span>
              <span className="posture-privacy-pill">
                <ShieldCheck size={10} /> On-device
              </span>
            </div>

            {posture.stream &&
              posture.status === 'no-pose' &&
              !posture.setupRunning &&
              !posture.guide && (
                <div className="posture-stage-hint">
                  <PersonStanding size={20} />
                  <strong>{(NO_POSE_COPY[posture.reason ?? 'absent'] ?? NO_POSE_COPY.absent).title}</strong>
                  <span>{(NO_POSE_COPY[posture.reason ?? 'absent'] ?? NO_POSE_COPY.absent).hint}</span>
                </div>
              )}

            {hasScore && (
              <div
                className={`posture-camera-score ${compact ? 'is-hero' : ''}`}
                style={{ '--score-color': color } as CSSProperties}
              >
                <strong>{score}</strong>
                <span>
                  <em style={{ color }}>{word}</em>
                  <span className="posture-camera-advice">
                    {posture.metrics?.advice || 'Posture score'}
                  </span>
                </span>
              </div>
            )}

            {!compact && (
              <div className="posture-stage-checks">
                {checks.map((check) => (
                  <span key={check.label} className={check.ok ? 'is-ok' : ''}>
                    <i /> {check.label}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className={`posture-invite ${compact ? 'is-compact' : ''}`}>
            {compact && (
              <div className="posture-compact-score" style={{ color }}>
                <strong>{hasScore ? score : '—'}</strong>
                <span>score</span>
              </div>
            )}
            <div className="posture-orbit" aria-hidden="true">
              <span className="posture-orbit-ring one" />
              <span className="posture-orbit-ring two" />
              <PersonStanding size={52} />
              <span className="posture-orbit-dot" />
            </div>
            <span className="eyebrow">Posture coach · local camera</span>
            <h1>{title}</h1>
            <p>
              Use your webcam as a quiet posture coach. {window.notchDemo ? 'Hero Notch' : 'Notch'} scores your alignment in real time and
              nudges you when your posture starts to go bad. Frames are processed on this computer and never
              stored or uploaded.
            </p>
            <div className="posture-option-row">
              <button className="primary-button" onClick={posture.enable}>
                <Camera size={15} /> Turn on posture coach
              </button>
              {compact && <span className="posture-option-note">Enlarge for the rest of the settings.</span>}
            </div>
            <div className="posture-feature-row">
              <span><Activity size={12} /> Live 0–100 score</span>
              <span><Sparkles size={12} /> Slouch alerts</span>
              <span><ShieldCheck size={12} /> Private &amp; local</span>
            </div>
          </div>
        )}
      </section>

      {compact && posture.enabled && (
        <div className="posture-compact-actions">
          <span>
            {hasScore
              ? `${goodPercent}% good today · ${formatMinutes(Math.round(posture.badSeconds / 60))} with bad posture`
              : advice}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="soft-button compact"
              onClick={posture.calibrate}
              disabled={!hasScore || Boolean(posture.guide) || Boolean(posture.profile)}
              title={
                posture.profile
                  ? 'Not needed after the 3-step setup. Use Redo setup to change it.'
                  : 'Set current upright posture as your baseline'
              }
            >
              <Crosshair size={13} /> Calibrate
            </button>
            <button type="button" className="soft-button compact" onClick={posture.disable}>
              <CameraOff size={13} /> Turn off
            </button>
          </div>
        </div>
      )}

      <aside className="posture-panel">
        <div className="posture-panel-head">
          <span className="eyebrow"><PersonStanding size={12} /> Posture coach</span>
          <div className="posture-panel-title">
            <h2>{title}</h2>
            {posture.enabled && (
              <span className={`posture-state-pill ${hasScore ? 'is-live' : ''}`} style={{ color }}>
                {hasScore
                  ? word
                  : posture.status === 'away'
                    ? 'Paused'
                    : posture.status === 'no-pose'
                      ? (NO_POSE_COPY[posture.reason ?? 'absent'] ?? NO_POSE_COPY.absent).pill
                      : 'Starting'}
              </span>
            )}
          </div>
          {posture.enabled ? (
            // Today's split rides under the title instead of taking its own
            // block: the panel is short and the bar says it in one line.
            <div className="posture-today">
              <div className="posture-day-track" aria-hidden="true">
                {total > 0 && (
                  <>
                    <span className="is-good" style={{ width: `${goodPercent}%` }} />
                    <span className="is-bad" style={{ width: `${100 - goodPercent}%` }} />
                  </>
                )}
              </div>
              <div className="posture-day-legend">
                {total > 0 ? (
                  <>
                    <span><i className="is-good" /> {formatMinutes(Math.round(posture.goodSeconds / 60))} good</span>
                    <span><i className="is-bad" /> {formatMinutes(Math.round(posture.badSeconds / 60))} bad posture</span>
                  </>
                ) : (
                  <span>No time logged yet today</span>
                )}
                <span className="posture-day-baseline">
                  {posture.baseline
                    ? posture.baseline.coverage === 'full'
                      ? 'Full seat'
                      : 'Upper body'
                    : 'No baseline'}
                </span>
              </div>
              <PostureWeek
                days={state.posture.days ?? []}
                today={{ goodSeconds: posture.goodSeconds, badSeconds: posture.badSeconds }}
              />
            </div>
          ) : (
            <p>{panelCopy}</p>
          )}
        </div>

        {posture.enabled && (
          <>
            <div className="posture-hero" style={{ '--score-color': color } as CSSProperties}>
              <ProgressRing
                progress={(hasScore ? score : 0) / 100}
                size={80}
                stroke={6}
                color={color}
                track="rgba(255,255,255,.08)"
              >
                <strong>{hasScore ? score : '—'}</strong>
                <span>score</span>
              </ProgressRing>
              <div className="posture-hero-copy">
                <span className="eyebrow">Coach says</span>
                <strong>
                  {posture.status === 'error'
                    ? 'Camera off'
                    : posture.status === 'away'
                      ? 'Paused — nobody in frame'
                      : posture.status === 'no-pose'
                      ? 'Move into frame'
                      : posture.metrics?.advice || 'Hold this position.'}
                </strong>
                <span className="posture-hero-meta">
                  {delta !== null && delta !== 0 ? (
                    <em className={delta > 0 ? 'is-up' : 'is-down'}>
                      {delta > 0 ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
                      {Math.abs(delta)}
                    </em>
                  ) : (
                    <em className="is-flat"><Minus size={9} /> steady</em>
                  )}
                  <span>
                    {average !== null ? `avg ${average} · ` : ''}
                    {goodPercent > 0 ? `${goodPercent}% good today` : 'baseline starts today'}
                  </span>
                </span>
              </div>
            </div>

            <div className="posture-controls">
              <div className="posture-toggle-row">
                <span>
                  <strong>Notification alerts</strong>
                  <small>A soft chime after about half a minute of bad posture.</small>
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
              <div className="posture-snooze-row">
                <span>
                  <BellOff size={11} />
                  <small>
                    {snoozed
                      ? `Alerts paused · ${Math.ceil(snoozeLeft / 60_000)}m left`
                      : 'Nudge-free while you read or call.'}
                  </small>
                </span>
                {snoozed ? (
                  <button className="soft-button compact" onClick={posture.clearSnooze}>
                    Resume
                  </button>
                ) : (
                  <button className="soft-button compact" onClick={() => posture.snooze(30)}>
                    Snooze 30m
                  </button>
                )}
              </div>
              {posture.baseline &&
                (!posture.baseline.version || posture.baseline.version < 2) && (
                  <div className="posture-upgrade">
                    <Sparkles size={13} />
                    <div>
                      <strong>Redo setup for better results</strong>
                      <span>
                        This baseline predates forward-lean and depth tracking, so it can
                        read a slouch as perfect.
                      </span>
                    </div>
                    <button
                      className="soft-button compact"
                      onClick={posture.startGuide}
                      disabled={posture.setupRunning || Boolean(posture.guide)}
                    >
                      Retake
                    </button>
                  </div>
                )}
              {posture.setupMessage && (
                <p className={`posture-setup-message ${posture.baseline ? 'is-good' : ''}`}>
                  {posture.setupMessage}
                </p>
              )}
              {!posture.baseline && !posture.setupMessage && !posture.setupRunning && (
                <p className="posture-setup-message">
                  Do the 3-step setup first so the score fits the way you sit.
                </p>
              )}
            </div>

            <div className="posture-actions">
              <button
                className="soft-button posture-action-primary"
                onClick={posture.startGuide}
                disabled={posture.setupRunning || Boolean(posture.guide)}
                title="Three short steps: sit well, sit your usual bad way, and come close to the screen"
              >
                <ScanLine size={13} />
                {posture.guide ? 'Setting up…' : posture.profile ? 'Redo setup' : 'Set up in 3 steps'}
              </button>
              <button
                className="soft-button"
                onClick={posture.calibrate}
                disabled={!hasScore || posture.setupRunning || Boolean(posture.guide) || Boolean(posture.profile)}
                title={
                  posture.profile
                    ? 'Not needed after the 3-step setup. Use Redo setup to change it.'
                    : 'Instantly set your current upright posture as the baseline'
                }
              >
                <Crosshair size={13} /> Quick calibrate
              </button>
              <button className="soft-button danger-text" onClick={posture.disable}>
                <CameraOff size={13} /> Turn off
              </button>
            </div>
          </>
        )}

        {!posture.enabled && (
          <div className="posture-side-note">
            {window.notchDemo && (
              <div className="posture-demo-threshold-card">
                <div className="posture-demo-ring">
                  <ProgressRing
                    progress={posture.threshold / 100}
                    size={72}
                    stroke={4.5}
                    color="#fafafa"
                  >
                    <strong>{posture.threshold}</strong>
                    <small>/100</small>
                  </ProgressRing>
                </div>
                <div className="posture-demo-ring-copy">
                  <strong>In-RAM alignment ring</strong>
                  <span>
                    Threshold {posture.threshold} · Camera off by default · 0 bytes stored
                  </span>
                </div>
              </div>
            )}
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
            <strong>What the score reads</strong>
            <p>
              Neck length, head-forward distance, how centred your head sits over your shoulders,
              shoulder level, screen distance and torso lean, each measured against your own
              baseline.
            </p>
          </div>
        )}
      </aside>
    </div>
  )
}
