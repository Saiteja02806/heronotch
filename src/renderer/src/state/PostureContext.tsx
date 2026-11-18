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
import type { NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision'
import type { PostureBaseline, PostureProfile, PostureProfilePose } from '../../../shared/types'
import { useApp } from './AppContext'
import { playPostureRing } from '../lib/alertSound'
import { sectionVisible } from '../lib/sections'
import { todayKey } from '../lib/time'

const WASM_PATH = './mediapipe/wasm'
const MODEL_PATH = './mediapipe/pose_landmarker_lite.task'

const DEFAULT_BASELINE: PostureBaseline = {
  neck: 0.62,
  tilt: 0.025,
  headOffset: 0.04,
  lean: 0.05,
  headTilt: 0.02
  // No forwardHead on purpose. The depth ratio runs 0.4 to 0.7 on real webcams,
  // so any guessed default reads as a permanent lean-in. Without it the scorer
  // falls back to its conservative absolute limit until a baseline exists.
}

/**
 * Alert pacing. A glance at a phone or a stretch is not a slouch, and a nudge
 * every half minute trains people to switch the coach off. Slouch has to hold
 * for a while before the first nudge, and nudges are spaced out after that.
 */
const ALERT_AFTER_SLOUCH_MS = 25_000
const ALERT_COOLDOWN_MS = 4 * 60_000

/** Camera recovery: back-off between restarts. It keeps trying at the cap. */
const RESTART_BASE_MS = 1500
const RESTART_MAX_MS = 30_000
/** A frozen feed (sleep/resume, another app grabbing the camera) shows as no new frames. */
const STALL_RESTART_STEPS = 55
const MUTED_RESTART_MS = 8000

/**
 * Head rotation. Turning to a second monitor moves the ears relative to the
 * shoulders and looks like a slouch, but it is not one. Yaw is the nose's
 * offset from the ear midpoint in head widths: near 0.1 facing the screen, 0.6
 * and up when turned well away. Above the limit the frame is not scored, and
 * scoring waits a few frames after the head comes back, because the filtered
 * landmarks lag the real pose by a fraction of a second.
 */
const YAW_LIMIT = 0.45
const SETTLE_FRAMES = 3

/**
 * Setup timing. Clicking "retake" means leaning toward the screen to reach the
 * mouse, and real baselines saved that way sat at 0.46 to 0.53 shoulder scale
 * against a working 0.33 to 0.37, so leaning in later looked normal. The first
 * seconds are only a get-ready countdown; sampling starts once you have settled.
 */
export const SETUP_TOTAL_S = 10
export const SETUP_LEAD_S = 4
/**
 * Away pause. After this long with nobody in frame the camera is released. Each
 * time the coach wakes and still finds nobody (a mouse nudge, a camera that
 * cannot see the chair), the next wait is doubled from two minutes, up to the
 * cap, so it settles instead of blinking the camera light on and off.
 */
const AWAY_FIRST_MS = 5 * 60_000
const AWAY_RETRY_MS = 2 * 60_000
const AWAY_CAP_MS = 30 * 60_000
/** Keyboard or mouse input this recently counts as someone being back. */
const WAKE_IDLE_S = 3
const WAKE_POLL_MS = 2000
/** A gap this long between frames means the machine slept, not that you left. */
const SLEEP_GAP_MS = 30_000

/** One scale reading a second, kept this many seconds; and the least needed to judge a baseline. */
const SCALE_HISTORY_MAX = 300
const SCALE_HISTORY_MIN = 45

/** Quick calibrate samples this much recent history instead of one frame. */
const CALIBRATE_WINDOW_MS = 2500
/** Quick calibrate waits this long first, for the same reaching-for-the-mouse reason. */
const CALIBRATE_LEAD_S = 3

/**
 * 'away' is the coach paused by Notch, not by the user: nobody has been in frame
 * for a while, so the camera is released. The saved "on" choice is untouched and
 * the coach wakes by itself when there is keyboard or mouse activity.
 */
export type PostureStatus = 'off' | 'loading' | 'running' | 'no-pose' | 'error' | 'away'

export type PosturePartKey =
  | 'neck'
  | 'forward'
  | 'offset'
  | 'tilt'
  | 'scale'
  | 'headTilt'
  | 'lean'

/** One weighted signal in the current score, so the UI can explain the number. */
export interface PosturePart {
  key: PosturePartKey
  /** How far past the baseline this signal is, 0 (fine) to 1 (as bad as it gets). */
  severity: number
  /** How much of the score drop this signal accounts for, 0 to 1. */
  impact: number
}

/** Which way a lopsided measurement points, in the person's own left/right. */
export interface PostureSides {
  /** +1 when the person's left shoulder rides higher than the right. */
  tilt: -1 | 0 | 1
  /** +1 when the head sits off-centre toward the person's left. */
  offset: -1 | 0 | 1
  /** +1 when the torso leans to the person's left. */
  lean: -1 | 0 | 1
}

export interface PostureMetrics {
  neck: number
  tilt: number
  headOffset: number
  headTilt: number
  forwardHead: number
  scale: number
  lean: number
  /** Head rotation away from the screen, 0 when facing it. */
  yaw: number
  advice: string
  parts: PosturePart[]
  sides: PostureSides
}

type PostureSample = Omit<PostureMetrics, 'advice' | 'parts'>

export interface PostureCoverage {
  shoulders: boolean
  ears: boolean
  hips: boolean
}

export interface PostureGuideView {
  /** 0 to 2: which of the three questions is on screen. */
  step: number
  phase: 'ready' | 'lead' | 'capture'
  /** Whole seconds left in the current countdown or hold. */
  left: number
  message: string | null
}

interface PostureContextValue {
  enabled: boolean
  status: PostureStatus
  score: number | null
  metrics: PostureMetrics | null
  landmarks: NormalizedLandmark[] | null
  stream: MediaStream | null
  error: string | null
  threshold: number
  notifications: boolean
  baseline: PostureBaseline | null
  coverage: PostureCoverage
  setupRunning: boolean
  setupProgress: number
  setupMessage: string | null
  goodSeconds: number
  badSeconds: number
  snoozeUntil: number | null
  /** Smoothed score once a second, oldest first. Cleared when tracking restarts. */
  history: number[]
  /** Slouch stretches caught since the coach started this session. */
  slouchEpisodes: number
  enable: () => void
  disable: () => void
  calibrate: () => void
  startSetupTest: () => void
  guide: PostureGuideView | null
  profile: PostureProfile | null
  startGuide: () => void
  guideReady: () => void
  cancelGuide: () => void
  cancelSetupTest: () => void
  snooze: (minutes: number) => void
  clearSnooze: () => void
  /** When status is 'no-pose': why (nobody there, or somebody who cannot be read). */
  reason: PostureReason | null
  /** Wake the coach from 'away' right now instead of waiting for activity. */
  wake: () => void
  setThreshold: (value: number) => void
  setNotifications: (value: boolean) => void
}

const PostureContext = createContext<PostureContextValue | null>(null)

function visibility(landmark: NormalizedLandmark): number {
  return typeof landmark.visibility === 'number' ? landmark.visibility : 1
}

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * fraction))
  )
  return sorted[index]
}

function median(values: number[]): number {
  return percentile(values, 0.5)
}

function medianSample(samples: PostureSample[]): PostureSample {
  const newest = samples[samples.length - 1]
  return {
    neck: median(samples.map((sample) => sample.neck)),
    tilt: median(samples.map((sample) => sample.tilt)),
    headOffset: median(samples.map((sample) => sample.headOffset)),
    headTilt: median(samples.map((sample) => sample.headTilt)),
    forwardHead: median(samples.map((sample) => sample.forwardHead)),
    scale: median(samples.map((sample) => sample.scale)),
    lean: median(samples.map((sample) => sample.lean)),
    yaw: median(samples.map((sample) => sample.yaw)),
    // Magnitudes are median-filtered; the side is taken from the newest frame
    // because averaging a -1/0/+1 sign would cancel it out.
    sides: newest.sides
  }
}

function baselineFromSamples(
  samples: PostureSample[],
  coverage: 'upper' | 'full'
): PostureBaseline {
  // The median of the held frames, not an extreme percentile, so the baseline
  // is a pose that can be sustained rather than a rigid stretch.
  const mid = (pick: (sample: PostureSample) => number): number =>
    percentile(samples.map(pick), 0.5)
  return {
    neck: mid((sample) => sample.neck),
    tilt: mid((sample) => sample.tilt),
    headOffset: mid((sample) => sample.headOffset),
    headTilt: mid((sample) => sample.headTilt),
    forwardHead: mid((sample) => sample.forwardHead),
    scale: mid((sample) => sample.scale),
    lean: mid((sample) => sample.lean),
    coverage,
    version: 2
  }
}

/** Interquartile range of one signal, used to tell a held pose from a moving one. */
function spread(samples: PostureSample[], pick: (sample: PostureSample) => number): number {
  const values = samples.map(pick)
  return percentile(values, 0.75) - percentile(values, 0.25)
}

/**
 * Is a freshly saved baseline sitting somewhere other than where this person
 * actually works? Shoulder scale is the proxy for distance from the camera.
 * Setups taken while reaching for the mouse came out 30 to 45 percent closer
 * than the seat the person held all day, which made leaning in look normal.
 * History is one scale reading per second from before the capture started, so
 * the reach itself is not in it. Too little history means no verdict.
 */
function scaleDrift(history: number[], baselineScale: number | undefined): 'closer' | 'farther' | null {
  if (!baselineScale || history.length < SCALE_HISTORY_MIN) return null
  const ratio = baselineScale / Math.max(0.05, median(history))
  if (ratio > 1.15) return 'closer'
  if (ratio < 0.8) return 'farther'
  return null
}

const DRIFT_MESSAGE = {
  closer:
    'Saved, but you were sitting much closer to the screen than you usually do, so leaning in will look normal. Sit back the way you normally work and retake.',
  farther:
    'Saved, but you were sitting much farther back than usual, so your normal seat may read as leaning in. Retake from your normal working seat.'
} as const

/* ---------------------------------------------------- 3-step personal profile */

/** The three setup questions, in plain words. Shown on the page, one at a time. */
export const GUIDE_STEPS = [
  {
    key: 'good',
    title: 'Sit up straight',
    hint: 'Sit the way you want to sit all day: back straight, shoulders relaxed, head up.'
  },
  {
    key: 'bad',
    title: 'Sit your usual bad way',
    hint: 'Sit the way you usually sit when you stop paying attention: back bent, shoulders and head dropping forward.'
  },
  {
    key: 'close',
    title: 'Come close to the screen',
    hint: 'Move closer to the screen, the way you do when you focus hard. Keep both shoulders in the picture.'
  }
] as const

export const GUIDE_LEAD_S = 3
export const GUIDE_CAPTURE_S = 6
const GUIDE_MIN_SAMPLES = 6
/** A pose must differ from sitting straight by at least this many of your own wobbles. */
const GUIDE_MIN_SEPARATION = 2

const PROFILE_KEYS = ['neck', 'forwardHead', 'headOffset', 'tilt', 'headTilt', 'scale'] as const
/** The least natural wobble assumed per signal, so a very still person does not make noise look huge. */
const SPREAD_FLOOR: PostureProfilePose = {
  neck: 0.02,
  forwardHead: 0.04,
  headOffset: 0.015,
  tilt: 0.01,
  headTilt: 0.01,
  scale: 0.035
}

function poseOf(samples: PostureSample[]): PostureProfilePose {
  const out = {} as PostureProfilePose
  for (const key of PROFILE_KEYS) out[key] = median(samples.map((sample) => sample[key]))
  return out
}

function spreadOfPose(samples: PostureSample[]): PostureProfilePose {
  const out = {} as PostureProfilePose
  for (const key of PROFILE_KEYS) {
    const values = samples.map((sample) => sample[key])
    const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, values.length))
    out[key] = Math.max(sd, SPREAD_FLOOR[key])
  }
  return out
}

/**
 * How far along the line from `good` to `target` this reading is: 0 at good,
 * 1 at target. Signals that barely move between the two poses count for little,
 * and every signal is measured in units of the person's own spread.
 */
function progressAlong(
  x: Record<(typeof PROFILE_KEYS)[number], number>,
  good: PostureProfilePose,
  target: PostureProfilePose,
  spread: PostureProfilePose
): number {
  let num = 0
  let den = 0
  for (const key of PROFILE_KEYS) {
    // The floor is applied again here so profiles saved before it was raised use it too.
    const wobble = Math.max(spread[key], SPREAD_FLOOR[key])
    const axis = (target[key] - good[key]) / wobble
    const here = (x[key] - good[key]) / wobble
    num += axis * here
    den += axis * axis
  }
  return den > 0 ? num / den : 0
}

/** How different a pose is from sitting straight, in units of the person's own wobble. */
function profileSeparation(
  good: PostureProfilePose,
  other: PostureProfilePose,
  spread: PostureProfilePose
): number {
  let total = 0
  for (const key of PROFILE_KEYS) {
    total += ((other[key] - good[key]) / Math.max(spread[key], SPREAD_FLOOR[key])) ** 2
  }
  return Math.sqrt(total / PROFILE_KEYS.length)
}

function buildProfile(
  good: PostureSample[],
  bad: PostureSample[],
  close: PostureSample[]
): PostureProfile {
  return {
    version: 1,
    good: poseOf(good),
    bad: poseOf(bad),
    close: poseOf(close),
    spread: spreadOfPose(good),
    capturedAt: Date.now()
  }
}

/** Where the alert line sits: this far along the way to the person's own bad pose. */
const PROFILE_FREE = 0.1
const PROFILE_FULL = 1

function scoreWithProfile(
  metrics: PostureSample,
  profile: PostureProfile
): { score: number; advice: string; parts: PosturePart[] } {
  const toBad = progressAlong(metrics, profile.good, profile.bad, profile.spread)
  const toClose = progressAlong(metrics, profile.good, profile.close, profile.spread)
  const along = Math.max(toBad, toClose)
  const unit = Math.min(1, Math.max(0, (along - PROFILE_FREE) / (PROFILE_FULL - PROFILE_FREE)))
  const score = Math.max(8, Math.min(100, Math.round(100 - 65 * unit)))
  let advice = 'Good posture. Nice.'
  if (along > 0.3) {
    advice =
      toBad >= toClose
        ? 'Sit up straight. Your back and head are dropping forward.'
        : 'Sit back a little. You are close to the screen.'
  }
  return { score, advice, parts: [] }
}

/** Why a person who is in view cannot be scored right now. */
export type PostureReason = 'absent' | 'shoulders' | 'turned' | 'too-close' | 'odd'

function whyImplausible(m: PostureSample): PostureReason {
  if (m.yaw >= YAW_LIMIT) return 'turned'
  if (m.scale >= 1.3) return 'too-close'
  return 'odd'
}

/** How long nobody can be in frame before pausing; `streak` is wakes with nobody found. */
function awayAfterMs(streak: number, overrideMs = 0): number {
  if (overrideMs > 0) return overrideMs
  if (streak <= 0) return AWAY_FIRST_MS
  return Math.min(AWAY_CAP_MS, AWAY_RETRY_MS * 2 ** (streak - 1))
}

function isPlausible(metrics: PostureSample): boolean {
  return (
    metrics.neck > 0.3 &&
    metrics.neck < 2.2 &&
    metrics.tilt >= 0 &&
    metrics.tilt < 0.28 &&
    metrics.headOffset >= 0 &&
    metrics.headOffset < 0.35 &&
    metrics.headTilt >= 0 &&
    metrics.headTilt < 0.28 &&
    metrics.yaw < YAW_LIMIT &&
    // Shoulder width as a fraction of the frame. A normal laptop view is
    // often just under 0.2 when the person sits back, and over 0.6 when they
    // lean in. Those poses still need a score; only tiny or full-frame
    // detections are treated as noise.
    metrics.scale > 0.12 &&
    metrics.scale < 1.3 &&
    Math.abs(metrics.forwardHead) < 1.8
  )
}

function scorePosture(
  metrics: PostureSample,
  baseline: PostureBaseline
): { score: number; advice: string; parts: PosturePart[] } {
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))
  const baseNeck = Math.max(baseline.neck, 0.35)
  const neckShortfall = Math.max(0, (baseline.neck - metrics.neck) / baseNeck)
  const tiltExcess = Math.max(0, metrics.tilt - Math.max(baseline.tilt, 0.035))
  const headTiltExcess = Math.max(
    0,
    metrics.headTilt - Math.max(baseline.headTilt ?? baseline.tilt * 0.5, 0.025)
  )
  const offsetExcess = Math.max(
    0,
    metrics.headOffset - Math.max(baseline.headOffset, 0.045)
  )
  // Older baselines have no depth reference. Use a conservative absolute
  // threshold until setup is retaken; a personalised depth baseline is far
  // more accurate.
  const forwardLimit = baseline.forwardHead !== undefined ? baseline.forwardHead + 0.025 : 0.9
  const forwardExcess = Math.max(0, metrics.forwardHead - forwardLimit)
  const scaleLimit = baseline.scale !== undefined ? Math.max(0.05, baseline.scale * 1.04) : null
  const scaleExcess =
    scaleLimit && baseline.scale !== undefined
      ? Math.max(0, (metrics.scale - scaleLimit) / Math.max(0.05, baseline.scale * 0.18))
      : 0
  const leanExcess = Math.max(0, metrics.lean - Math.max(baseline.lean, 0.07))

  // Linear response on tight spans. The square-root variant amplified noise
  // and made the score bounce while the user held one posture; linear keeps
  // the drop readable without losing sensitivity.
  const forwardNorm = clamp01(Math.max(0, forwardExcess - 0.015) / 0.16)
  const neckNorm = clamp01(Math.max(0, neckShortfall - 0.02) / 0.18)
  const tiltNorm = clamp01(Math.max(0, tiltExcess - 0.015) / 0.1)
  const headTiltNorm = clamp01(Math.max(0, headTiltExcess - 0.02) / 0.06)
  const offsetNorm = clamp01(Math.max(0, offsetExcess - 0.025) / 0.1)
  const scaleNorm = clamp01(scaleExcess)
  const leanNorm = clamp01(Math.max(0, leanExcess - 0.03) / 0.16)

  const leanWeight = baseline.coverage === 'full' ? 0.12 : 0.04
  const contributions = [
    { key: 'neck', value: neckNorm * 0.3 },
    { key: 'forward', value: forwardNorm * 0.22 },
    { key: 'offset', value: offsetNorm * 0.18 },
    { key: 'tilt', value: tiltNorm * 0.14 },
    { key: 'scale', value: scaleNorm * 0.1 },
    { key: 'headTilt', value: headTiltNorm * 0.06 },
    { key: 'lean', value: leanNorm * leanWeight }
  ] as const
  const slouch = contributions.reduce((total, item) => total + item.value, 0)
  const score = Math.max(8, Math.min(100, Math.round(100 - slouch * 150)))
  // Keep the weighted breakdown for the page: it turns "68" into "your head is
  // 3 cm forward and your left shoulder is high", which is what changes the pose.
  const normalization: Record<PosturePartKey, number> = {
    neck: 0.3,
    forward: 0.22,
    offset: 0.18,
    tilt: 0.14,
    scale: 0.1,
    headTilt: 0.06,
    lean: leanWeight
  }
  const parts: PosturePart[] = contributions
    .map((item) => ({
      key: item.key as PosturePartKey,
      severity: Math.max(
        0,
        Math.min(1, item.value / normalization[item.key as PosturePartKey])
      ),
      impact: slouch > 0 ? item.value / slouch : 0
    }))
    .sort((a, b) => b.impact - a.impact)
  const top = contributions.reduce((best, item) => (item.value > best.value ? item : best))

  // Naming the side turns “level your shoulders” into something the body can
  // act on without thinking about which shoulder is high.
  const side: PostureSides = metrics.sides || { tilt: 0, offset: 0, lean: 0 }
  const sideName = (value: -1 | 0 | 1): string => (value < 0 ? 'right' : 'left')
  const adviceByKey: Record<string, string> = {
    neck: 'Lengthen your neck — lift your chin slightly.',
    // An offset names where the head *is*, so the correction is the other way.
    offset:
      side.offset === 0
        ? 'Bring your head back over the middle of your shoulders.'
        : `Bring your head back over your shoulders, toward your ${sideName(side.offset < 0 ? 1 : -1)}.`,
    tilt:
      side.tilt === 0
        ? 'Level your shoulders and let them drop.'
        : `Drop your ${sideName(side.tilt)} shoulder and level them out.`,
    headTilt: 'Keep your head upright instead of tilting it.',
    forward: 'Bring your head back over your shoulders — you are leaning in.',
    scale: 'You are drifting toward the screen. Sit back into your chair.',
    lean:
      side.lean === 0
        ? 'Sit back over your hips.'
        : `Sit back over your hips — you are leaning ${sideName(side.lean)}.`
  }
  let advice = 'Good posture. Nice.'
  if (top.value > 0.05) advice = adviceByKey[top.key] || advice
  else if (score < 55) advice = 'Reset: feet flat, ribs stacked, screen at eye level.'

  return { score, advice, parts }
}

function computeMetrics(
  landmarks: NormalizedLandmark[],
  video: HTMLVideoElement
): PostureSample | null {
  const leftShoulder = landmarks[11]
  const rightShoulder = landmarks[12]
  const leftEar = landmarks[7]
  const rightEar = landmarks[8]
  const nose = landmarks[0]
  if (!leftShoulder || !rightShoulder) return null
  if (visibility(leftShoulder) < 0.42 || visibility(rightShoulder) < 0.42) return null

  const width = video.videoWidth || 640
  const height = video.videoHeight || 480
  const px = (landmark: NormalizedLandmark): { x: number; y: number } => ({
    x: landmark.x * width,
    y: landmark.y * height
  })

  const ls = px(leftShoulder)
  const rs = px(rightShoulder)
  const shoulderWidth = Math.max(1, Math.hypot(ls.x - rs.x, ls.y - rs.y))
  const shoulderMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 }
  const shoulderZ = (leftShoulder.z + rightShoulder.z) / 2

  let headMid: { x: number; y: number }
  let headZ: number
  let headTilt = 0
  let yaw = 0
  const hasLeftEar = Boolean(leftEar && visibility(leftEar) > 0.35)
  const hasRightEar = Boolean(rightEar && visibility(rightEar) > 0.35)
  if (hasLeftEar && hasRightEar && leftEar && rightEar) {
    const le = px(leftEar)
    const re = px(rightEar)
    headMid = midpoint(le, re)
    headZ = (leftEar.z + rightEar.z) / 2
    headTilt = Math.abs(le.y - re.y) / shoulderWidth
    // Against the width of the head, not the shoulders: sitting back makes the
    // shoulders look narrow, which used to turn an ordinary head angle into a
    // "turned away" frame and the page then claimed nobody was there.
    if (nose && visibility(nose) > 0.35) {
      yaw = Math.abs(px(nose).x - headMid.x) / Math.max(1, Math.abs(le.x - re.x))
    }
  } else if ((hasLeftEar || hasRightEar) && nose) {
    // One ear occluded (headset, hair, slight turn): blend the visible ear's
    // vertical level with the nose's horizontal center so neck height doesn't
    // suddenly drop to nose level and cause a false slouch spike.
    const ear = (hasLeftEar ? leftEar : rightEar)!
    const ep = px(ear)
    const np = px(nose)
    headMid = { x: np.x * 0.65 + ep.x * 0.35, y: ep.y * 0.75 + np.y * 0.25 }
    headZ = ear.z * 0.65 + nose.z * 0.35
  } else if (nose) {
    headMid = px(nose)
    headZ = nose.z
  } else {
    return null
  }

  const neck = (shoulderMid.y - headMid.y) / shoulderWidth
  const tilt = Math.abs(ls.y - rs.y) / shoulderWidth
  const headOffset = Math.abs(headMid.x - shoulderMid.x) / shoulderWidth
  // Positive when the head sits closer to the camera than the shoulders.
  // This is the main signal for leaning into the screen when the camera is
  // head-on, where 2D x/y landmarks barely move.
  const forwardHead = ((shoulderZ - headZ) * width) / shoulderWidth
  const scale = shoulderWidth / width

  let lean = 0
  let sideSign = 0
  const leftHip = landmarks[23]
  const rightHip = landmarks[24]
  const hipVisible = Boolean(
    leftHip && rightHip && visibility(leftHip) > 0.42 && visibility(rightHip) > 0.42
  )
  if (hipVisible && leftHip && rightHip) {
    const lh = px(leftHip)
    const rh = px(rightHip)
    const hipMid = midpoint(lh, rh)
    const hipZ = (leftHip.z + rightHip.z) / 2
    const rise = Math.max(1, hipMid.y - shoulderMid.y)
    const forwardLean = Math.atan2((hipZ - shoulderZ) * width, rise)
    const sideLean = Math.atan2(shoulderMid.x - hipMid.x, rise)
    lean = Math.hypot(forwardLean, sideLean)
    sideSign = sideLean
  }

  // Landmark 11 is the person's own left shoulder. On an unmirrored camera
  // frame that usually sits at a larger x, but front-facing webcams differ, so
  // derive "the person's left" from the shoulder line itself instead of
  // hard-coding a screen direction.
  const leftDirection = Math.sign(ls.x - rs.x) || 1
  const sides: PostureSides = {
    tilt: tilt < 0.01 ? 0 : ls.y < rs.y ? 1 : -1,
    offset: headOffset < 0.02 ? 0 : (headMid.x - shoulderMid.x) * leftDirection > 0 ? 1 : -1,
    lean: Math.abs(sideSign) < 0.02 ? 0 : sideSign * leftDirection > 0 ? 1 : -1
  }

  return { neck, tilt, headOffset, headTilt, forwardHead, scale, lean, yaw, sides }
}

/* ---------------------------------------------------------------- smoothing */

/**
 * One Euro filter (Casiez et al., CHI 2012) on the landmarks themselves.
 *
 * The frame-to-frame jitter of a still person is what makes thresholds flicker;
 * a fixed low-pass would remove it at the cost of lag when you actually move.
 * This filter raises its cutoff with velocity, so a held pose is quiet and a
 * real slouch still shows up immediately. It is dt-aware, which matters now
 * that the inference loop changes tick rate with the posture tier.
 */
class OneEuroFilter {
  private value: number | null = null
  private derivative = 0
  private readonly minCutoff: number
  private readonly beta: number
  private readonly derivativeCutoff: number

  constructor(minCutoff = 1, beta = 0.6, derivativeCutoff = 1) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.derivativeCutoff = derivativeCutoff
  }

  filter(next: number, dtS: number): number {
    if (this.value === null) {
      this.value = next
      return next
    }
    const alpha = (cutoffHz: number): number => {
      const r = 2 * Math.PI * cutoffHz * dtS
      return r / (r + 1)
    }
    const rawDerivative = (next - this.value) / dtS
    this.derivative += (rawDerivative - this.derivative) * alpha(this.derivativeCutoff)
    const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative)
    this.value += (next - this.value) * alpha(cutoff)
    return this.value
  }

  reset(): void {
    this.value = null
    this.derivative = 0
  }
}

/** Landmark indices the score actually reads, plus visibility smoothing. */
const SMOOTHED_LANDMARKS = [0, 7, 8, 11, 12, 23, 24] as const
const STALE_GAP_S = 1.5
const Z_MIN_CUTOFF = 0.4
const Z_BETA = 0.4
const VISIBILITY_TAU_S = 0.3

class LandmarkSmoother {
  private x = new Map<number, OneEuroFilter>()
  private y = new Map<number, OneEuroFilter>()
  // Depth is the noisiest output of the model and moves in coarse steps, so it
  // gets a much lower cutoff than the image-plane coordinates.
  private z = new Map<number, OneEuroFilter>()
  private visibility = new Map<number, number>()
  private lastAt: number | null = null

  smooth(landmarks: NormalizedLandmark[], now: number): NormalizedLandmark[] {
    let dtS = this.lastAt === null ? 0 : (now - this.lastAt) / 1000
    this.lastAt = now
    if (dtS <= 0) dtS = 1e-3
    if (dtS > STALE_GAP_S) this.reset()

    const next = [...landmarks]
    for (const index of SMOOTHED_LANDMARKS) {
      const landmark = landmarks[index]
      if (!landmark) continue
      let fx = this.x.get(index)
      let fy = this.y.get(index)
      let fz = this.z.get(index)
      if (!fx || !fy || !fz) {
        fx = new OneEuroFilter()
        fy = new OneEuroFilter()
        fz = new OneEuroFilter(Z_MIN_CUTOFF, Z_BETA)
        this.x.set(index, fx)
        this.y.set(index, fy)
        this.z.set(index, fz)
      }
      const smoothedVisibility =
        this.visibility.get(index) === undefined
          ? visibility(landmark)
          : (this.visibility.get(index) as number) +
            (visibility(landmark) - (this.visibility.get(index) as number)) *
              (1 - Math.exp(-dtS / VISIBILITY_TAU_S))
      this.visibility.set(index, smoothedVisibility)
      next[index] = {
        ...landmark,
        x: fx.filter(landmark.x, dtS),
        y: fy.filter(landmark.y, dtS),
        z: fz.filter(landmark.z, dtS),
        visibility: smoothedVisibility
      }
    }
    return next
  }

  reset(): void {
    this.x.forEach((filter) => filter.reset())
    this.y.forEach((filter) => filter.reset())
    this.z.forEach((filter) => filter.reset())
    this.visibility.clear()
    this.lastAt = null
  }
}

export function PostureProvider({ children }: { children: ReactNode }) {
  const { state, update, showToast, expanded, page } = useApp()
  const uiRef = useRef({ expanded, page })
  uiRef.current = { expanded, page }
  const traceEnabledRef = useRef(false)
  useEffect(() => {
    let alive = true
    void window.notch
      .postureAwayOverrideMs()
      .then((ms) => {
        if (alive) awayOverrideRef.current = ms
      })
      .catch(() => undefined)
    void window.notch
      .postureTraceEnabled()
      .then((on) => {
        if (alive) traceEnabledRef.current = on
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  const posture = state.posture
  const profile = posture.profile ?? null
  const postureRef = useRef(posture)
  postureRef.current = posture

  const [status, setStatus] = useState<PostureStatus>(posture.enabled ? 'loading' : 'off')
  const [score, setScore] = useState<number | null>(null)
  const [metrics, setMetrics] = useState<PostureMetrics | null>(null)
  const [landmarks, setLandmarks] = useState<NormalizedLandmark[] | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [coverage, setCoverage] = useState<PostureCoverage>({
    shoulders: false,
    ears: false,
    hips: false
  })
  const [setupRunning, setSetupRunning] = useState(false)
  const [setupProgress, setSetupProgress] = useState(0)
  const [setupMessage, setSetupMessage] = useState<string | null>(null)
  const [goodDisplay, setGoodDisplay] = useState(posture.goodSeconds)
  const [badDisplay, setBadDisplay] = useState(posture.badSeconds)
  const [snoozeUntil, setSnoozeUntil] = useState<number | null>(null)
  const snoozeUntilRef = useRef<number | null>(null)
  snoozeUntilRef.current = snoozeUntil
  const [history, setHistory] = useState<number[]>([])
  const [slouchEpisodes, setSlouchEpisodes] = useState(0)

  const videoRef = useRef<HTMLVideoElement>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const metricsRef = useRef<PostureMetrics | null>(null)
  const smoothedRef = useRef<number | null>(null)
  const badSinceRef = useRef<number | null>(null)
  const isSlouchingRef = useRef(false)
  const lastAlertRef = useRef<number>(posture.lastAlertAt || 0)
  const goodRef = useRef(posture.goodSeconds)
  const badRef = useRef(posture.badSeconds)
  const lastTickRef = useRef(0)
  const dayKeyRef = useRef(posture.dayKey)
  const lastPersistRef = useRef(0)
  const lastUiRef = useRef(0)
  const lastFrameUiRef = useRef(0)
  const smootherRef = useRef(new LandmarkSmoother())
  const lastScoreAtRef = useRef(0)
  const noPoseSinceRef = useRef<number | null>(null)
  const lastIntervalRef = useRef(180)
  const lastTrendRef = useRef(0)
  const historyRef = useRef<number[]>([])
  const episodesRef = useRef(0)
  const lastTraceRef = useRef(0)
  const coverageRef = useRef<PostureCoverage>({ shoulders: false, ears: false, hips: false })
  const landmarksShownRef = useRef(false)
  const commitCoverage = useCallback((next: PostureCoverage) => {
    const prev = coverageRef.current
    if (prev.shoulders === next.shoulders && prev.ears === next.ears && prev.hips === next.hips) {
      return
    }
    coverageRef.current = next
    setCoverage(next)
  }, [])
  // Camera recovery. Bumping the tick re-runs the capture effect, which tears
  // the stream down and opens a fresh one.
  const [restartTick, setRestartTick] = useState(0)
  const [awayPaused, setAwayPaused] = useState(false)
  const [guide, setGuide] = useState<PostureGuideView | null>(null)
  const [reason, setReason] = useState<PostureReason | null>(null)
  const guideRef = useRef<{
    step: number
    phase: 'ready' | 'lead' | 'capture'
    t0: number
    samples: PostureSample[][]
    message: string | null
  } | null>(null)
  const lastPresenceRef = useRef(0)
  const lastStepAtRef = useRef(0)
  const awayStreakRef = useRef(0)
  const awayOverrideRef = useRef(0)
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restartAttemptsRef = useRef(0)
  const mutedSinceRef = useRef<number | null>(null)
  const cancelRestart = useCallback(() => {
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
    restartTimerRef.current = null
  }, [])
  const scheduleRestart = useCallback(
    (reason: string) => {
      if (restartTimerRef.current) return
      const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** restartAttemptsRef.current)
      restartAttemptsRef.current = Math.min(restartAttemptsRef.current + 1, 10)
      if (traceEnabledRef.current) {
        window.notch.postureTrace({ t: Date.now(), status: 'restart', reason, delay })
      }
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null
        setRestartTick((tick) => tick + 1)
      }, delay)
    },
    []
  )
  // Recent scored frames, so Quick calibrate can use a couple of seconds of
  // pose instead of whatever a single frame happened to catch.
  const recentSamplesRef = useRef<{ t: number; sample: PostureSample }[]>([])
  const sampleHistoryRef = useRef<PostureSample[]>([])
  const invalidFramesRef = useRef(0)
  const settleFramesRef = useRef(0)
  const scaleHistoryRef = useRef<number[]>([])
  const staleFramesRef = useRef(0)
  const setupRef = useRef<{
    start: number
    samples: PostureSample[]
    coverage: PostureCoverage
    frames: number
    hipFrames: number
  } | null>(null)
  // Hiding Posture stops the camera. The coach preference, baseline and day
  // totals stay, so turning the section back on resumes exactly where it left off.
  const postureVisible = sectionVisible(state, 'posture')
  const enabled = posture.enabled && postureVisible
  // The camera runs only while the coach is on and not paused for absence.
  const active = enabled && !awayPaused

  const persistStats = useCallback(() => {
    const today = todayKey()
    update({
      posture: {
        goodSeconds: Math.round(goodRef.current),
        badSeconds: Math.round(badRef.current),
        dayKey: today,
        lastAlertAt: lastAlertRef.current || null
      }
    })
  }, [update])

  useEffect(() => {
    if (posture.dayKey !== todayKey()) {
      goodRef.current = 0
      badRef.current = 0
      setGoodDisplay(0)
      setBadDisplay(0)
    } else {
      goodRef.current = posture.goodSeconds
      badRef.current = posture.badSeconds
      setGoodDisplay(posture.goodSeconds)
      setBadDisplay(posture.badSeconds)
    }
  }, [posture.dayKey, posture.goodSeconds, posture.badSeconds])

  useEffect(() => {
    if (!active) {
      cancelRestart()
      restartAttemptsRef.current = 0
      scaleHistoryRef.current = []
      setStatus(enabled ? 'away' : 'off')
      setScore(null)
      setMetrics(null)
      setLandmarks(null)
      setCoverage({ shoulders: false, ears: false, hips: false })
      // A fresh start must not inherit the slouch state, the trend or the
      // episode count from the run that just ended.
      isSlouchingRef.current = false
      badSinceRef.current = null
      historyRef.current = []
      setHistory([])
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const video = videoRef.current

    async function start(): Promise<void> {
      if (window.notchDemo) {
        const demoStart = performance.now()
        const applyDemoFrame = (): void => {
          if (cancelled) return
          const phaseSec = ((performance.now() - demoStart) / 1000) % 3.625
          const isSlouch = phaseSec >= 1.0 && phaseSec < 2.35
          const liveScore = isSlouch ? 56 : phaseSec >= 2.35 ? 90 : 91
          setStatus('running')
          setError(null)
          setScore(liveScore)
          commitCoverage({ shoulders: true, ears: true, hips: false })
          setMetrics({
            neck: isSlouch ? 0.44 : 0.62,
            tilt: isSlouch ? 0.08 : 0.02,
            headOffset: isSlouch ? 0.14 : 0.03,
            headTilt: isSlouch ? 0.07 : 0.015,
            forwardHead: isSlouch ? 0.22 : 0.06,
            scale: 0.34,
            lean: isSlouch ? 0.12 : 0.03,
            yaw: 0,
            advice: isSlouch ? 'Head drifting — sit centered' : 'Stacked & aligned',
            parts: [],
            sides: { tilt: 0, offset: isSlouch ? 1 : 0, lean: 0 }
          })
          setHistory((prev) => [...prev.slice(-19), liveScore])
        }
        const tickDemo = (): void => {
          if (cancelled) return
          applyDemoFrame()
          timer = setTimeout(tickDemo, 220)
        }
        tickDemo()
        return
      }
      setStatus('loading')
      setError(null)
      setScore(null)
      smoothedRef.current = null
      smootherRef.current.reset()
      noPoseSinceRef.current = null
      lastScoreAtRef.current = 0
      badSinceRef.current = null
      // Starting the camera is a new coaching session: a slouch left over from
      // the previous run would otherwise count as bad time from the first frame.
      isSlouchingRef.current = false
      historyRef.current = []
      setHistory([])
      episodesRef.current = 0
      setSlouchEpisodes(0)
      sampleHistoryRef.current = []
      recentSamplesRef.current = []
      invalidFramesRef.current = 0
      settleFramesRef.current = 0
      staleFramesRef.current = 0
      try {
        // The lite landmark model works on a 256px input, so a bigger camera
        // frame only costs decode and colour-conversion time. 480x360 is
        // plenty for the upper-body geometry this reads.
        const media = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 480 },
            height: { ideal: 360 },
            facingMode: 'user'
          },
          audio: false
        })
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = media
        setStream(media)
        // The track ends when the camera is unplugged, taken by another app or
        // dropped across sleep. stop() on our own cleanup does not fire this,
        // so it only ever means the feed was lost underneath us.
        mutedSinceRef.current = null
        for (const track of media.getVideoTracks()) {
          track.addEventListener('ended', () => {
            if (!cancelled) scheduleRestart('track-ended')
          })
          track.addEventListener('mute', () => {
            mutedSinceRef.current = performance.now()
          })
          track.addEventListener('unmute', () => {
            mutedSinceRef.current = null
          })
        }
        const preview = videoRef.current
        if (preview) {
          preview.srcObject = media
          await preview.play().catch(() => undefined)
        }

        let landmarker: PoseLandmarker
        try {
          const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision')
          if (cancelled) return
          const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
          const landmarkerOptions = (delegate: 'GPU' | 'CPU') => ({
            baseOptions: { modelAssetPath: MODEL_PATH, delegate },
            runningMode: 'VIDEO' as const,
            numPoses: 1,
            minPoseDetectionConfidence: 0.45,
            minPosePresenceConfidence: 0.45,
            minTrackingConfidence: 0.45
          })
          // A missing GPU can leave the GPU delegate pending forever, which
          // keeps the camera on and the score blank. Fall back to CPU.
          const gpuCreate = PoseLandmarker.createFromOptions(vision, landmarkerOptions('GPU'))
          const gpuLandmarker = await Promise.race([
            gpuCreate,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500))
          ])
          if (cancelled) {
            if (gpuLandmarker) gpuLandmarker.close()
            else gpuCreate.then((created) => created.close()).catch(() => undefined)
            return
          }
          if (gpuLandmarker) {
            landmarker = gpuLandmarker
          } else {
            gpuCreate.then((created) => created.close()).catch(() => undefined)
            landmarker = await PoseLandmarker.createFromOptions(vision, landmarkerOptions('CPU'))
          }
        } catch {
          throw new Error(
            'Could not initialize the local posture model. Restart Notch or check camera permissions.'
          )
        }
        if (cancelled) {
          landmarker.close()
          return
        }
        const traceStatus = (status: string): void => {
          if (!traceEnabledRef.current) return
          const now = performance.now()
          if (now - lastTraceRef.current < 1500) return
          lastTraceRef.current = now
          window.notch.postureTrace({
            t: Date.now(),
            status,
            baselineVersion: postureRef.current.baseline?.version ?? 0
          })
        }

        landmarkerRef.current = landmarker
        setStatus('no-pose')
        lastTickRef.current = performance.now()
        lastPresenceRef.current = performance.now()
        lastStepAtRef.current = performance.now()
        traceStatus('model-ready')

        const finishSetupIfReady = (now: number): void => {
          const setup = setupRef.current
          if (!setup || setup.start === 0) return
          const elapsed = (now - setup.start) / 1000
          setSetupProgress(Math.min(1, elapsed / SETUP_TOTAL_S))
          if (elapsed < SETUP_TOTAL_S) return
          setupRef.current = null
          setSetupRunning(false)
          if (setup.samples.length < 6 || !setup.coverage.shoulders) {
            setSetupMessage(
              'Setup needs a clearer view. Move back until your shoulders are visible, then try again.'
            )
            // With no baseline the coach cannot score, so try again once a pose
            // is back in frame instead of waiting for the user to find a button.
            if (!postureRef.current.baseline) autoSetupRef.current = false
            return
          }
          const coverageMode: 'upper' | 'full' =
            setup.hipFrames / Math.max(1, setup.frames) > 0.6 ? 'full' : 'upper'
          // If the seat was still moving (leaning back from the mouse, settling in),
          // the second half is the pose that was actually held.
          const half = Math.floor(setup.samples.length / 2)
          const scaleOf = (list: PostureSample[]): number => median(list.map((s) => s.scale))
          const early = scaleOf(setup.samples.slice(0, half))
          const late = scaleOf(setup.samples.slice(half))
          const drifted = Math.abs(late - early) / Math.max(early, 0.05) > 0.06
          const held = drifted && setup.samples.length >= 8 ? setup.samples.slice(half) : setup.samples
          const baseline = baselineFromSamples(held, coverageMode)
          update({ posture: { baseline } })
          const tilted = baseline.tilt > 0.11 || baseline.headOffset > 0.16
          const neckSpread = spread(held, (sample) => sample.neck)
          const offsetSpread = spread(held, (sample) => sample.headOffset)
          const unstable = !tilted && (neckSpread > 0.05 || offsetSpread > 0.05)
          const drift = scaleDrift(scaleHistoryRef.current, baseline.scale)
          if (drift) {
            setSetupMessage(DRIFT_MESSAGE[drift])
            showToast('Posture setup needs a retake', DRIFT_MESSAGE[drift], 'default')
          } else if (tilted) {
            setSetupMessage(
              'Baseline saved, but you looked tilted or off-centre. Sit tall and level, then retake for a sharper score.'
            )
            showToast(
              'Posture setup saved with a warning',
              'Retake once while sitting tall for better slouch detection.',
              'default'
            )
          } else if (unstable) {
            setSetupMessage(
              'Baseline saved, but you moved during the test. Sit tall, hold still, then retake for a sharper score.'
            )
            showToast(
              'Posture setup saved with a warning',
              'Hold still during the 10-second test and retake for the best baseline.',
              'default'
            )
          } else {
            setSetupMessage(
              drifted
                ? 'Setup complete. You were still settling in, so Notch used the steadier second half.'
                : coverageMode === 'full'
                  ? 'Setup complete — full torso. Seated lean is part of your score.'
                  : 'Setup complete — upper body, with depth tracking for forward lean.'
            )
            showToast(
              'Posture setup complete',
              coverageMode === 'full' ? 'Full-torso scoring active.' : 'Upper-body scoring active.',
              'success'
            )
          }
        }

        const step = (): void => {
          if (cancelled) return
          try {
            if (!videoRef.current || !landmarkerRef.current) return
            const element = videoRef.current
            // After the machine slept, performance time may have jumped. That is
            // not an absence: start counting from the wake-up.
            const stepNow = performance.now()
            if (stepNow - lastStepAtRef.current > SLEEP_GAP_MS) lastPresenceRef.current = stepNow
            lastStepAtRef.current = stepNow
            const track = streamRef.current?.getVideoTracks()[0]
            if (track && track.readyState === 'ended') {
              scheduleRestart('track-ended')
            } else if (
              mutedSinceRef.current !== null &&
              performance.now() - mutedSinceRef.current > MUTED_RESTART_MS
            ) {
              // A muted track keeps its last frame on screen, so the pose would
              // look frozen-but-fine. Reopen the camera instead.
              scheduleRestart('track-muted')
            }
            if (element.paused) void element.play().catch(() => undefined)
            if (element.readyState >= 2 && element.videoWidth > 0) {
              if (setupRef.current && setupRef.current.start === 0) {
                setupRef.current.start = performance.now()
              }
              staleFramesRef.current = 0
              try {
                const now = performance.now()
                const result = landmarkerRef.current.detectForVideo(element, now)
                const pose = result.landmarks?.[0] || null
                // A frame went through the model, so the camera is healthy and
                // the next failure gets a fresh back-off.
                restartAttemptsRef.current = 0
                const baseline = postureRef.current.baseline || DEFAULT_BASELINE
                if (!pose) {
                  if (noPoseSinceRef.current === null) noPoseSinceRef.current = now
                  smootherRef.current.reset()
                  if (landmarksShownRef.current) {
                    landmarksShownRef.current = false
                    setLandmarks(null)
                  }
                  setStatus('no-pose')
                  setReason('absent')
                  setScore(null)
                  metricsRef.current = null
                  smoothedRef.current = null
                  sampleHistoryRef.current = []
                  invalidFramesRef.current = 0
                  // Nobody in frame: never start or continue a slouch alert.
                  badSinceRef.current = null
                  commitCoverage({ shoulders: false, ears: false, hips: false })
                  traceStatus('no-pose')
                  finishSetupIfReady(now)
                } else {
                  noPoseSinceRef.current = null
                  // Filter before anything reads the landmarks, including the
                  // skeleton drawn on the stage.
                  const filtered = smootherRef.current.smooth(pose, now)
                  if (uiRef.current.expanded && uiRef.current.page === 'posture') {
                    landmarksShownRef.current = true
                    setLandmarks(filtered)
                  } else if (landmarksShownRef.current) {
                    landmarksShownRef.current = false
                    setLandmarks(null)
                  }
                  const leftShoulder = filtered[11]
                  const rightShoulder = filtered[12]
                  const leftEar = filtered[7]
                  const rightEar = filtered[8]
                  const leftHip = filtered[23]
                  const rightHip = filtered[24]
                  const nextCoverage: PostureCoverage = {
                    shoulders: Boolean(
                      leftShoulder &&
                        rightShoulder &&
                        visibility(leftShoulder) >= 0.42 &&
                        visibility(rightShoulder) >= 0.42
                    ),
                    ears: Boolean(
                      leftEar &&
                        rightEar &&
                        visibility(leftEar) >= 0.35 &&
                        visibility(rightEar) >= 0.35
                    ),
                    hips: Boolean(
                      leftHip &&
                        rightHip &&
                        visibility(leftHip) >= 0.42 &&
                        visibility(rightHip) >= 0.42
                    )
                  }
                  commitCoverage(nextCoverage)
                  const computed = computeMetrics(filtered, element)
                  // A person the model can see is present, even if they are too close,
                  // turned away or cut off by the frame and cannot be scored.
                  lastPresenceRef.current = now
                  if (!computed) {
                    // Shoulders low in the picture for a frame or two (a lean, a
                    // reach) is not a reason to blank the score. Wait for a streak.
                    invalidFramesRef.current += 1
                    if (invalidFramesRef.current >= 4) {
                      setStatus('no-pose')
                      setReason('shoulders')
                      setScore(null)
                      metricsRef.current = null
                      smoothedRef.current = null
                      sampleHistoryRef.current = []
                      badSinceRef.current = null
                      traceStatus('no-metrics')
                    }
                    finishSetupIfReady(now)
                  } else if (!isPlausible(computed)) {
                    invalidFramesRef.current += 1
                    settleFramesRef.current = SETTLE_FRAMES
                    if (invalidFramesRef.current >= 6) {
                      sampleHistoryRef.current = []
                      smoothedRef.current = null
                      metricsRef.current = null
                      badSinceRef.current = null
                      setMetrics(null)
                      setScore(null)
                      setStatus('no-pose')
                      setReason(whyImplausible(computed))
                      traceStatus('implausible-' + whyImplausible(computed))
                    }
                    finishSetupIfReady(now)
                  } else if (settleFramesRef.current > 0) {
                    // The head is back, but the filtered landmarks are still
                    // catching up. Hold the last score rather than reading the
                    // transition as a slouch, and start the median window fresh.
                    settleFramesRef.current -= 1
                    invalidFramesRef.current = 0
                    sampleHistoryRef.current = []
                    lastTickRef.current = now
                    finishSetupIfReady(now)
                  } else {
                    invalidFramesRef.current = 0
                    awayStreakRef.current = 0
                    const history = [...sampleHistoryRef.current, computed].slice(-3)
                    sampleHistoryRef.current = history
                    const stable = medianSample(history)
                    const recent = recentSamplesRef.current
                    recent.push({ t: now, sample: stable })
                    while (recent.length && now - recent[0].t > CALIBRATE_WINDOW_MS) recent.shift()
                    const personal = postureRef.current.profile
                    const verdict = personal
                      ? scoreWithProfile(stable, personal)
                      : scorePosture(stable, baseline)
                    const delta = Math.min(1.4, (now - lastTickRef.current) / 1000)
                    lastTickRef.current = now
                    // Time-constant smoothing (~1.1 s), not a fixed per-frame
                    // weight: the loop ticks at 120/180/900 ms depending on the
                    // tier, and the number must feel the same in all of them.
                    let smoothed = verdict.score
                    if (smoothedRef.current !== null && lastScoreAtRef.current > 0) {
                      const scoreDtS = Math.min(2, Math.max(0.001, (now - lastScoreAtRef.current) / 1000))
                      const alpha = 1 - Math.exp(-scoreDtS / 1.1)
                      smoothed = smoothedRef.current + (verdict.score - smoothedRef.current) * alpha
                    }
                    lastScoreAtRef.current = now
                    smoothedRef.current = smoothed
                    const displayMetrics: PostureMetrics = {
                      ...stable,
                      advice: verdict.advice,
                      parts: verdict.parts
                    }
                    metricsRef.current = displayMetrics
                    // The provider wraps the whole shell, so a state write here
                    // re-renders every page. Score frames arrive about five times
                    // a second; publish a little under three and let CSS ease the
                    // ring between them.
                    if (now - lastFrameUiRef.current > 380) {
                      lastFrameUiRef.current = now
                      setMetrics(displayMetrics)
                      setStatus('running')
                      setReason(null)
                      setScore(Math.round(smoothed))
                    }
                    if (now - lastTrendRef.current >= 1000) {
                      lastTrendRef.current = now
                      const trend = [...historyRef.current, Math.round(smoothed)].slice(-150)
                      historyRef.current = trend
                      setHistory(trend)
                      // Where this person actually sits, for judging a new baseline.
                      // Not during setup: the get-ready reach would pollute it.
                      if (!setupRef.current) {
                        scaleHistoryRef.current = [...scaleHistoryRef.current, stable.scale].slice(
                          -SCALE_HISTORY_MAX
                        )
                      }
                    }

                    if (traceEnabledRef.current && now - lastTraceRef.current >= 500) {
                      lastTraceRef.current = now
                      window.notch.postureTrace({
                        t: Date.now(),
                        score: Math.round(smoothed),
                        frameScore: verdict.score,
                        neck: Number(stable.neck.toFixed(3)),
                        tilt: Number(stable.tilt.toFixed(3)),
                        headOffset: Number(stable.headOffset.toFixed(3)),
                        headTilt: Number(stable.headTilt.toFixed(3)),
                        forwardHead: Number(stable.forwardHead.toFixed(3)),
                        scale: Number(stable.scale.toFixed(3)),
                        lean: Number(stable.lean.toFixed(3)),
                        yaw: Number(stable.yaw.toFixed(3)),
                        baselineVersion: postureRef.current.baseline?.version ?? 0,
                        setup: Boolean(setupRef.current)
                      })
                    }

                    const today = todayKey()
                    if (dayKeyRef.current !== today) {
                      dayKeyRef.current = today
                      goodRef.current = 0
                      badRef.current = 0
                      lastAlertRef.current = 0
                      setGoodDisplay(0)
                      setBadDisplay(0)
                      update({
                        posture: { dayKey: today, goodSeconds: 0, badSeconds: 0, lastAlertAt: null }
                      })
                    }
                    const setup = setupRef.current
                    if (guideRef.current) {
                      // The 3-step setup is running: hold scoring, keep the camera
                      // timing clean, and sample only during the hold.
                      lastTickRef.current = now
                      if (guideRef.current.phase === 'capture') {
                        guideRef.current.samples[guideRef.current.step].push(stable)
                      }
                    } else if (setup) {
                      // Nothing is sampled during the get-ready countdown.
                      if (now - setup.start > SETUP_LEAD_S * 1000) setup.samples.push(stable)
                      setup.frames += 1
                      if (nextCoverage.hips) setup.hipFrames += 1
                      setup.coverage = {
                        shoulders: setup.coverage.shoulders || nextCoverage.shoulders,
                        ears: setup.coverage.ears || nextCoverage.ears,
                        hips: setup.coverage.hips || nextCoverage.hips
                      }
                    } else {
                      const current = postureRef.current
                      // Without a baseline the number is only a rough guess, so it
                      // neither counts time nor raises alerts until setup finishes.
                      const calibrated = Boolean(current.baseline)
                      const enterBad = calibrated && smoothed < current.threshold
                      const exitBad = smoothed >= current.threshold + 4
                      if (isSlouchingRef.current) {
                        if (exitBad) {
                          isSlouchingRef.current = false
                          if (traceEnabledRef.current) {
                            window.notch.postureTrace({ t: Date.now(), event: 'slouch-exit', score: Math.round(smoothed) })
                          }
                        }
                      } else if (enterBad) {
                        isSlouchingRef.current = true
                        if (traceEnabledRef.current) {
                          window.notch.postureTrace({ t: Date.now(), event: 'slouch-enter', score: Math.round(smoothed) })
                        }
                        episodesRef.current += 1
                        setSlouchEpisodes(episodesRef.current)
                      }

                      const snoozed = Boolean(
                        snoozeUntilRef.current && Date.now() < snoozeUntilRef.current
                      )
                      if (snoozeUntilRef.current && !snoozed) setSnoozeUntil(null)

                      if (!calibrated) {
                        badSinceRef.current = null
                      } else if (!isSlouchingRef.current) {
                        goodRef.current += delta
                        badSinceRef.current = null
                      } else {
                        badRef.current += delta
                        if (badSinceRef.current === null) badSinceRef.current = now
                        // Ring only while a real pose is being tracked and not snoozed.
                        if (
                          current.notifications &&
                          !snoozed &&
                          now - badSinceRef.current > ALERT_AFTER_SLOUCH_MS &&
                          Date.now() - lastAlertRef.current > ALERT_COOLDOWN_MS
                        ) {
                          lastAlertRef.current = Date.now()
                          if (traceEnabledRef.current) {
                            window.notch.postureTrace({ t: Date.now(), event: 'alert', score: Math.round(smoothed) })
                          }
                          badSinceRef.current = now
                          playPostureRing()
                          showToast(
                            'Posture check',
                            displayMetrics.advice || 'Sit tall and relax your shoulders.',
                            'default',
                            {
                              category: 'posture',
                              section: 'posture',
                              durationMs: 9000,
                              actions: [
                                {
                                  label: 'Snooze 15m',
                                  variant: 'soft',
                                  onClick: () => {
                                    const until = Date.now() + 15 * 60_000
                                    snoozeUntilRef.current = until
                                    setSnoozeUntil(until)
                                    badSinceRef.current = null
                                  }
                                }
                              ]
                            }
                          )
                          window.notch.notify(
                            'Posture check',
                            displayMetrics.advice || 'Sit tall and relax your shoulders.',
                            true
                          )
                        }
                      }

                      if (now - lastUiRef.current > 900) {
                        lastUiRef.current = now
                        setGoodDisplay(goodRef.current)
                        setBadDisplay(badRef.current)
                      }
                      if (now - lastPersistRef.current > 20_000) {
                        lastPersistRef.current = now
                        persistStats()
                      }
                    }
                    finishSetupIfReady(now)
                  }
                }
              } catch (error) {
                setStatus('no-pose')
                setScore(null)
                setMetrics(null)
                metricsRef.current = null
                smoothedRef.current = null
                sampleHistoryRef.current = []
                badSinceRef.current = null
                window.notch.postureTrace({
                  t: Date.now(),
                  status: 'detect-error',
                  message: error instanceof Error ? error.message : String(error)
                })
                traceStatus('detect-error')
              }
            } else {
              // Count in ~180 ms units so the stall timeouts below keep meaning
              // the same number of seconds at every inference tier.
              staleFramesRef.current += Math.max(1, Math.round(lastIntervalRef.current / 180))
              traceStatus('no-frames')
              if (staleFramesRef.current >= 40 && setupRef.current && setupRef.current.start === 0) {
                setupRef.current = null
                setSetupRunning(false)
                setSetupProgress(0)
                setSetupMessage('Setup timed out waiting for camera frames. Check camera access and try again.')
              }
              if (staleFramesRef.current >= STALL_RESTART_STEPS) scheduleRestart('no-frames')
              if (staleFramesRef.current >= 12) {
                setStatus('no-pose')
                setScore(null)
                setMetrics(null)
                metricsRef.current = null
                smoothedRef.current = null
                sampleHistoryRef.current = []
                badSinceRef.current = null
                isSlouchingRef.current = false
              }
            }
          } finally {
            // Inference tiers: cheap and slow while the chair is empty, sharp
            // and fast while the score is actually dropping.
            const absentTooLong =
              !cancelled &&
              !setupRef.current &&
              !guideRef.current &&
              performance.now() - lastPresenceRef.current >
                awayAfterMs(awayStreakRef.current, awayOverrideRef.current)
            if (absentTooLong) {
              const firstTime = awayStreakRef.current === 0
              awayStreakRef.current += 1
              if (traceEnabledRef.current) {
                window.notch.postureTrace({ t: Date.now(), status: 'away', streak: awayStreakRef.current })
              }
              if (firstTime) {
                showToast(
                  'Posture coach paused',
                  'Nobody has been in frame for a while, so the camera is off. It wakes when you are back.',
                  'default'
                )
              }
              setAwayPaused(true)
            } else if (!cancelled) {
              let intervalMs = 220
              if (noPoseSinceRef.current !== null && performance.now() - noPoseSinceRef.current >= 2000) {
                intervalMs = 1200
              } else if (
                smoothedRef.current !== null &&
                smoothedRef.current < postureRef.current.threshold
              ) {
                intervalMs = 150
              }
              lastIntervalRef.current = intervalMs
              timer = setTimeout(step, intervalMs)
            }
          }
        }
        step()
      } catch (caught) {
        if (cancelled) return
        console.error('Posture coach failed', caught)
        const message =
          caught instanceof Error
            ? caught.message
            : caught
              ? String(caught)
              : 'Camera unavailable.'
        streamRef.current?.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        setStream(null)
        if (video) video.srcObject = null
        if (videoRef.current) videoRef.current.srcObject = null
        if (setupRef.current) {
          setupRef.current = null
          setSetupRunning(false)
          setSetupProgress(0)
          setSetupMessage('Setup stopped because the camera could not start.')
        }
        setError(message)
        setStatus('error')
        // A camera another app is holding, or one that has not woken up yet,
        // comes back by itself. A denied permission does not, so retrying it
        // would only spam the log. Toast once per outage, not once per retry.
        const denied =
          caught instanceof Error &&
          (caught.name === 'NotAllowedError' || caught.name === 'SecurityError')
        if (restartAttemptsRef.current === 0) showToast('Posture coach', message, 'error')
        if (!denied) scheduleRestart('start-failed')
      }
    }

    void start()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      setStream(null)
      landmarkerRef.current?.close()
      landmarkerRef.current = null
      if (video) video.srcObject = null
      if (videoRef.current) videoRef.current.srcObject = null
      if (setupRef.current) {
        setupRef.current = null
        setSetupRunning(false)
        setSetupProgress(0)
        // The first-run capture was cut short by a camera restart. Let it start
        // again once the feed is back instead of leaving the user baseline-less.
        autoSetupRef.current = false
      }
      if (guideRef.current) {
        guideRef.current = null
        setGuide(null)
      }
      persistStats()
    }
  }, [active, enabled, persistStats, showToast, restartTick, scheduleRestart])

  // Stamping today's date on a coach that was last used yesterday would keep
  // yesterday's good and bad seconds under it, so they would count as today's.
  const enablePatch = useCallback(() => {
    const today = todayKey()
    const stale = postureRef.current.dayKey !== today
    return {
      enabled: true,
      dayKey: today,
      ...(stale ? { goodSeconds: 0, badSeconds: 0, lastAlertAt: null } : {})
    }
  }, [])

  // Turning the coach off by hand clears any away pause, so a later turn-on starts clean.
  useEffect(() => {
    if (!enabled) {
      setAwayPaused(false)
      awayStreakRef.current = 0
      guideRef.current = null
      setGuide(null)
    }
  }, [enabled])

  // While paused for absence, only the OS can say whether someone is back.
  useEffect(() => {
    if (!awayPaused || !enabled) return
    let stopped = false
    const timer = setInterval(() => {
      void window.notch
        .systemIdleSeconds()
        .then((idle) => {
          if (!stopped && idle < WAKE_IDLE_S) setAwayPaused(false)
        })
        .catch(() => undefined)
    }, WAKE_POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [awayPaused, enabled])

  const wake = useCallback(() => {
    setAwayPaused(false)
  }, [])

  // The coach was left on, so it starts with the app. Say so once: the camera
  // should never come on without a trace of why.
  const resumedNoticeRef = useRef(false)
  useEffect(() => {
    if (resumedNoticeRef.current) return
    resumedNoticeRef.current = true
    if (enabled && !window.notchDemo) {
      showToast('Posture coach resumed', 'It was on last time, so the camera is on again.', 'default')
    }
  }, [enabled, showToast])

  const enable = useCallback(() => {
    update({ posture: enablePatch() })
  }, [update, enablePatch])

  const disable = useCallback(() => {
    update({ posture: { enabled: false } })
    autoSetupRef.current = false
    setStatus('off')
  }, [update])

  const runCalibration = useCallback(() => {
    if (!metricsRef.current) {
      showToast('Posture coach', 'Sit in view of the camera first, then calibrate.', 'error')
      return
    }
    // One frame can catch a mid-reach or a blink of the head. Use the last couple
    // of seconds, and ask for them to be steady, the same bar the 10 s setup sets.
    const cutoff = performance.now() - CALIBRATE_WINDOW_MS
    const samples = recentSamplesRef.current
      .filter((entry) => entry.t >= cutoff)
      .map((entry) => entry.sample)
    if (samples.length < 6) {
      showToast('Posture coach', 'Hold still in view for a couple of seconds, then calibrate.', 'error')
      return
    }
    if (
      spread(samples, (sample) => sample.neck) > 0.05 ||
      spread(samples, (sample) => sample.headOffset) > 0.05
    ) {
      showToast('Posture coach', 'You were moving. Sit tall, hold still, then calibrate.', 'error')
      return
    }
    // Against an existing baseline, a below-threshold score means the coach
    // already thinks you are slouching right now. Saving that pose would make
    // slouching the new "good". The 10 s setup is the way to reset a bad baseline.
    const current = postureRef.current
    if (
      current.baseline &&
      smoothedRef.current !== null &&
      smoothedRef.current < current.threshold
    ) {
      showToast(
        'Not calibrated',
        'You are slouching by your current baseline. Sit tall and try again, or retake the 10 s setup to start over.',
        'error'
      )
      return
    }
    const next = baselineFromSamples(samples, current.baseline?.coverage ?? 'upper')
    update({ posture: { baseline: next } })
    const drift = scaleDrift(scaleHistoryRef.current, next.scale)
    if (drift) showToast('Calibrated, but check your seat', DRIFT_MESSAGE[drift], 'default')
    else showToast('Posture calibrated', 'This seat position is now your baseline.', 'success')
  }, [update, showToast])

  // The click that starts a calibration is also the lean toward the mouse, so the
  // pose it would catch is the wrong one. Wait a few seconds, then sample.
  const calibratingRef = useRef(false)
  const calibrate = useCallback(() => {
    if (calibratingRef.current) return
    if (!metricsRef.current) {
      showToast('Posture coach', 'Sit in view of the camera first, then calibrate.', 'error')
      return
    }
    calibratingRef.current = true
    showToast(
      'Hold your tallest seat',
      `Calibrating in ${CALIBRATE_LEAD_S} seconds. Sit tall and ease back from the mouse.`,
      'default'
    )
    window.setTimeout(() => {
      calibratingRef.current = false
      runCalibration()
    }, CALIBRATE_LEAD_S * 1000)
  }, [runCalibration, showToast])

  const setThreshold = useCallback(
    (value: number) => {
      update({ posture: { threshold: Math.max(30, Math.min(90, value)) } })
    },
    [update]
  )

  const setNotifications = useCallback(
    (value: boolean) => {
      update({ posture: { notifications: value } })
    },
    [update]
  )

  const startSetupTest = useCallback(() => {
    if (awayPaused) setAwayPaused(false)
    if (!enabled) {
      update({ posture: enablePatch() })
    }
    if (status === 'error') {
      showToast('Posture coach', 'Start the camera successfully before running setup.', 'error')
      return
    }
    setupRef.current = {
      start: 0,
      samples: [],
      coverage: { shoulders: false, ears: false, hips: false },
      frames: 0,
      hipFrames: 0
    }
    sampleHistoryRef.current = []
    smoothedRef.current = null
    badSinceRef.current = null
    // A half-finished slouch must not leak into the baseline capture.
    isSlouchingRef.current = false
    setSetupRunning(true)
    setSetupProgress(0)
    setSetupMessage(null)
  }, [enabled, awayPaused, update, status, showToast, enablePatch])

  /* ---------------------------------------------------------- 3-step setup */
  const publishGuide = useCallback(() => {
    const g = guideRef.current
    if (!g) {
      setGuide(null)
      return
    }
    const total = g.phase === 'lead' ? GUIDE_LEAD_S : g.phase === 'capture' ? GUIDE_CAPTURE_S : 0
    const left =
      g.phase === 'ready' ? 0 : Math.max(0, Math.ceil(total - (performance.now() - g.t0) / 1000))
    setGuide((prev) =>
      prev && prev.step === g.step && prev.phase === g.phase && prev.left === left && prev.message === g.message
        ? prev
        : { step: g.step, phase: g.phase, left, message: g.message }
    )
  }, [])

  const finishGuideStep = useCallback(() => {
    const g = guideRef.current
    if (!g) return
    const samples = g.samples[g.step]
    g.phase = 'ready'
    if (samples.length < GUIDE_MIN_SAMPLES) {
      g.message =
        'We could not see you clearly. Sit so your head and shoulders are in view, then try this step again.'
      g.samples[g.step] = []
      publishGuide()
      return
    }
    if (g.step > 0) {
      const good = g.samples[0]
      const gap = profileSeparation(poseOf(good), poseOf(samples), spreadOfPose(good))
      if (gap < GUIDE_MIN_SEPARATION) {
        g.message =
          g.step === 1
            ? 'That looked almost the same as sitting up straight. Let your back bend and your head drop forward more, then try again.'
            : 'That looked almost the same as sitting up straight. Come a bit closer to the screen, then try again.'
        g.samples[g.step] = []
        publishGuide()
        return
      }
    }
    g.message = null
    if (g.step < 2) {
      g.step += 1
      publishGuide()
      return
    }
    const [goodSamples, badSamples, closeSamples] = g.samples
    const nextProfile = buildProfile(goodSamples, badSamples, closeSamples)
    const nextBaseline = baselineFromSamples(goodSamples, 'upper')
    guideRef.current = null
    setGuide(null)
    // The score now means something new, so start it and the slouch state fresh.
    isSlouchingRef.current = false
    smoothedRef.current = null
    update({ posture: { baseline: nextBaseline, profile: nextProfile } })
    const drift = scaleDrift(scaleHistoryRef.current, nextBaseline.scale)
    if (drift) showToast('Posture setup needs a retake', DRIFT_MESSAGE[drift], 'default')
    else showToast('Posture coach is ready', 'It now knows how you sit well and how you sit badly.', 'success')
  }, [publishGuide, update, showToast])

  const startGuide = useCallback(() => {
    if (awayPaused) setAwayPaused(false)
    if (!enabled) update({ posture: enablePatch() })
    setupRef.current = null
    setSetupRunning(false)
    setSetupProgress(0)
    autoSetupRef.current = true
    guideRef.current = { step: 0, phase: 'ready', t0: 0, samples: [[], [], []], message: null }
    publishGuide()
  }, [awayPaused, enabled, update, enablePatch, publishGuide])

  const guideReady = useCallback(() => {
    const g = guideRef.current
    if (!g || g.phase !== 'ready') return
    if (!metricsRef.current) {
      g.message = 'Sit so your head and shoulders are in view of the camera first.'
      publishGuide()
      return
    }
    g.message = null
    g.phase = 'lead'
    g.t0 = performance.now()
    g.samples[g.step] = []
    publishGuide()
  }, [publishGuide])

  const cancelGuide = useCallback(() => {
    guideRef.current = null
    setGuide(null)
  }, [])

  useEffect(() => {
    if (!guide || guide.phase === 'ready') return
    const id = window.setInterval(() => {
      const g = guideRef.current
      if (!g || g.phase === 'ready') return
      const elapsed = (performance.now() - g.t0) / 1000
      if (g.phase === 'lead' && elapsed >= GUIDE_LEAD_S) {
        g.phase = 'capture'
        g.t0 = performance.now()
        g.samples[g.step] = []
      } else if (g.phase === 'capture' && elapsed >= GUIDE_CAPTURE_S) {
        finishGuideStep()
        return
      }
      publishGuide()
    }, 250)
    return () => window.clearInterval(id)
  }, [guide, publishGuide, finishGuideStep])

  const cancelSetupTest = useCallback(() => {
    setupRef.current = null
    setSetupRunning(false)
    setSetupProgress(0)
    setSetupMessage('Setup cancelled.')
  }, [])

  // Nobody knows what a score means before there is a baseline, and asking a
  // first-time user to hunt for a button is a worse trade than just measuring.
  // Run the capture once, automatically, the first time the camera is ready.
  const autoSetupRef = useRef(false)
  useEffect(() => {
    if (!enabled || autoSetupRef.current || setupRunning) return
    if (postureRef.current.baseline || status !== 'running') return
    autoSetupRef.current = true
    startGuide()
  }, [enabled, setupRunning, status, startGuide])

  const snooze = useCallback(
    (minutes: number) => {
      const until = Date.now() + Math.max(1, minutes) * 60_000
      setSnoozeUntil(until)
      badSinceRef.current = null
      showToast('Posture alerts snoozed', `Muted for ${minutes} minutes.`, 'default')
    },
    [showToast]
  )

  const clearSnooze = useCallback(() => {
    setSnoozeUntil(null)
  }, [])

  const goodSeconds = Math.round(goodDisplay)
  const badSeconds = Math.round(badDisplay)
  const value = useMemo<PostureContextValue>(
    () => ({
      enabled,
      status,
      score,
      metrics,
      landmarks,
      stream,
      error,
      reason,
      threshold: posture.threshold,
      notifications: posture.notifications,
      baseline: posture.baseline,
      coverage,
      setupRunning,
      setupProgress,
      setupMessage,
      goodSeconds,
      badSeconds,
      snoozeUntil,
      history,
      slouchEpisodes,
      enable,
      disable,
      calibrate,
      startSetupTest,
      guide,
      profile,
      startGuide,
      guideReady,
      cancelGuide,
      cancelSetupTest,
      snooze,
      clearSnooze,
      wake,
      setThreshold,
      setNotifications
    }),
    [
      enabled,
      status,
      score,
      metrics,
      landmarks,
      stream,
      error,
      reason,
      posture.threshold,
      posture.notifications,
      posture.baseline,
      coverage,
      setupRunning,
      setupProgress,
      setupMessage,
      goodSeconds,
      badSeconds,
      snoozeUntil,
      history,
      slouchEpisodes,
      enable,
      disable,
      calibrate,
      startSetupTest,
      guide,
      profile,
      startGuide,
      guideReady,
      cancelGuide,
      cancelSetupTest,
      snooze,
      clearSnooze,
      wake,
      setThreshold,
      setNotifications
    ]
  )

  return (
    <PostureContext.Provider value={value}>
      {children}
      <video ref={videoRef} className="posture-source-video" muted playsInline />
    </PostureContext.Provider>
  )
}

export function usePosture(): PostureContextValue {
  const value = useContext(PostureContext)
  if (!value) throw new Error('usePosture must be used inside PostureProvider')
  return value
}
