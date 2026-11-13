import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision'
import type { PostureBaseline } from '../../../shared/types'
import { useApp } from './AppContext'
import { playPostureRing } from '../lib/alertSound'
import { todayKey } from '../lib/time'

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2/wasm'
const MODEL_PATH =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

const DEFAULT_BASELINE: PostureBaseline = {
  neck: 0.62,
  tilt: 0.025,
  headOffset: 0.04,
  lean: 0.05,
  headTilt: 0.02,
  forwardHead: 0.08
}

export type PostureStatus = 'off' | 'loading' | 'running' | 'no-pose' | 'error'

export interface PostureMetrics {
  neck: number
  tilt: number
  headOffset: number
  headTilt: number
  forwardHead: number
  scale: number
  lean: number
  advice: string
}

type PostureSample = Omit<PostureMetrics, 'advice'>

export interface PostureCoverage {
  shoulders: boolean
  ears: boolean
  hips: boolean
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
  enable: () => void
  disable: () => void
  calibrate: () => void
  startSetupTest: () => void
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
  return {
    neck: median(samples.map((sample) => sample.neck)),
    tilt: median(samples.map((sample) => sample.tilt)),
    headOffset: median(samples.map((sample) => sample.headOffset)),
    headTilt: median(samples.map((sample) => sample.headTilt)),
    forwardHead: median(samples.map((sample) => sample.forwardHead)),
    scale: median(samples.map((sample) => sample.scale)),
    lean: median(samples.map((sample) => sample.lean))
  }
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
    metrics.scale > 0.2 &&
    metrics.scale < 0.6 &&
    Math.abs(metrics.forwardHead) < 1.8
  )
}

function scorePosture(
  metrics: PostureSample,
  baseline: PostureBaseline
): { score: number; advice: string } {
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
  const forwardLimit = baseline.forwardHead !== undefined ? baseline.forwardHead + 0.03 : 0.95
  const forwardExcess = Math.max(0, metrics.forwardHead - forwardLimit)
  const scaleLimit = baseline.scale !== undefined ? Math.max(0.05, baseline.scale * 1.04) : null
  const scaleExcess =
    scaleLimit && baseline.scale !== undefined
      ? Math.max(0, (metrics.scale - scaleLimit) / Math.max(0.05, baseline.scale * 0.2))
      : 0
  const leanExcess = Math.max(0, metrics.lean - Math.max(baseline.lean, 0.07))

  // Linear response on tight spans. The square-root variant amplified noise
  // and made the score bounce while the user held one posture; linear keeps
  // the drop readable without losing sensitivity.
  const forwardNorm = clamp01(Math.max(0, forwardExcess - 0.02) / 0.2)
  const neckNorm = clamp01(Math.max(0, neckShortfall - 0.02) / 0.18)
  const tiltNorm = clamp01(Math.max(0, tiltExcess - 0.015) / 0.1)
  const headTiltNorm = clamp01(Math.max(0, headTiltExcess - 0.02) / 0.06)
  const offsetNorm = clamp01(Math.max(0, offsetExcess - 0.025) / 0.1)
  const scaleNorm = clamp01(scaleExcess)
  const leanNorm = clamp01(Math.max(0, leanExcess - 0.03) / 0.18)

  const contributions = [
    { key: 'neck', value: neckNorm * 0.38 },
    { key: 'offset', value: offsetNorm * 0.3 },
    { key: 'tilt', value: tiltNorm * 0.18 },
    { key: 'headTilt', value: headTiltNorm * 0.06 },
    { key: 'forward', value: forwardNorm * 0.06 },
    { key: 'scale', value: scaleNorm * 0.03 },
    { key: 'lean', value: leanNorm * 0.02 }
  ] as const
  const slouch = contributions.reduce((total, item) => total + item.value, 0)
  const score = Math.max(8, Math.min(100, Math.round(100 - slouch * 150)))
  const top = contributions.reduce((best, item) => (item.value > best.value ? item : best))

  const adviceByKey: Record<string, string> = {
    neck: 'Lengthen your neck — lift your chin slightly.',
    offset: 'Bring your head back over the middle of your shoulders.',
    tilt: 'Level your shoulders and let them drop.',
    headTilt: 'Keep your head upright instead of tilting it.',
    forward: 'Bring your head back over your shoulders — you are leaning in.',
    scale: 'You are drifting toward the screen. Sit back into your chair.',
    lean: 'Sit back over your hips.'
  }
  let advice = 'Stacked and relaxed. Nice.'
  if (top.value > 0.05) advice = adviceByKey[top.key] || advice
  else if (score < 55) advice = 'Reset: feet flat, ribs stacked, screen at eye level.'

  return { score, advice }
}

function computeMetrics(
  landmarks: NormalizedLandmark[],
  video: HTMLVideoElement,
  baseline: PostureBaseline
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
  if (leftEar && rightEar && visibility(leftEar) > 0.35 && visibility(rightEar) > 0.35) {
    const le = px(leftEar)
    const re = px(rightEar)
    headMid = midpoint(le, re)
    headZ = (leftEar.z + rightEar.z) / 2
    headTilt = Math.abs(le.y - re.y) / shoulderWidth
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
  const leftHip = landmarks[23]
  const rightHip = landmarks[24]
  const hipVisible = Boolean(
    baseline.coverage === 'full' &&
      leftHip &&
      rightHip &&
      visibility(leftHip) > 0.42 &&
      visibility(rightHip) > 0.42
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
  }

  return { neck, tilt, headOffset, headTilt, forwardHead, scale, lean }
}

export function PostureProvider({ children }: { children: ReactNode }) {
  const { state, update, showToast } = useApp()
  const posture = state.posture
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

  const videoRef = useRef<HTMLVideoElement>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const metricsRef = useRef<PostureMetrics | null>(null)
  const smoothedRef = useRef<number | null>(null)
  const badSinceRef = useRef<number | null>(null)
  const lastAlertRef = useRef<number>(posture.lastAlertAt || 0)
  const goodRef = useRef(posture.goodSeconds)
  const badRef = useRef(posture.badSeconds)
  const lastTickRef = useRef(0)
  const lastPersistRef = useRef(0)
  const lastUiRef = useRef(0)
  const lastTraceRef = useRef(0)
  const sampleHistoryRef = useRef<PostureSample[]>([])
  const invalidFramesRef = useRef(0)
  const staleFramesRef = useRef(0)
  const setupRef = useRef<{
    start: number
    samples: PostureSample[]
    coverage: PostureCoverage
    frames: number
    hipFrames: number
  } | null>(null)
  const enabled = posture.enabled

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
    if (!enabled) {
      setStatus('off')
      setScore(null)
      setMetrics(null)
      setLandmarks(null)
      setCoverage({ shoulders: false, ears: false, hips: false })
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const video = videoRef.current

    async function start(): Promise<void> {
      setStatus('loading')
      setError(null)
      setScore(null)
      smoothedRef.current = null
      badSinceRef.current = null
      sampleHistoryRef.current = []
      invalidFramesRef.current = 0
      staleFramesRef.current = 0
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
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
        if (video) {
          video.srcObject = media
          await video.play().catch(() => undefined)
        }

        let landmarker: PoseLandmarker
        try {
          const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
          try {
            landmarker = await PoseLandmarker.createFromOptions(vision, {
              baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
              runningMode: 'VIDEO',
              numPoses: 1,
              minPoseDetectionConfidence: 0.45,
              minPosePresenceConfidence: 0.45,
              minTrackingConfidence: 0.45
            })
          } catch {
            landmarker = await PoseLandmarker.createFromOptions(vision, {
              baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'CPU' },
              runningMode: 'VIDEO',
              numPoses: 1,
              minPoseDetectionConfidence: 0.45,
              minPosePresenceConfidence: 0.45,
              minTrackingConfidence: 0.45
            })
          }
        } catch {
          throw new Error(
            'Could not load the posture model. Check your internet connection and try again.'
          )
        }
        if (cancelled) {
          landmarker.close()
          return
        }
        const traceStatus = (status: string): void => {
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
        traceStatus('model-ready')

        const finishSetupIfReady = (now: number): void => {
          const setup = setupRef.current
          if (!setup) return
          const elapsed = (now - setup.start) / 1000
          setSetupProgress(Math.min(1, elapsed / 8))
          if (elapsed < 8) return
          setupRef.current = null
          setSetupRunning(false)
          if (setup.samples.length < 6 || !setup.coverage.shoulders) {
            setSetupMessage(
              'Setup needs a clearer view. Move back until your shoulders are visible, then try again.'
            )
            return
          }
          const coverageMode: 'upper' | 'full' =
            setup.hipFrames / Math.max(1, setup.frames) > 0.6 ? 'full' : 'upper'
          const baseline: PostureBaseline = {
            // Calibrate to the best-aligned frames from the test, not the
            // average. Averaging can bake a slouch into the baseline.
            neck: percentile(setup.samples.map((sample) => sample.neck), 0.75),
            tilt: percentile(setup.samples.map((sample) => sample.tilt), 0.25),
            headOffset: percentile(setup.samples.map((sample) => sample.headOffset), 0.25),
            headTilt: percentile(setup.samples.map((sample) => sample.headTilt), 0.25),
            forwardHead: percentile(setup.samples.map((sample) => sample.forwardHead), 0.25),
            scale: percentile(setup.samples.map((sample) => sample.scale), 0.35),
            lean: percentile(setup.samples.map((sample) => sample.lean), 0.25),
            coverage: coverageMode,
            version: 2
          }
          update({ posture: { baseline } })
          const tilted = baseline.tilt > 0.11 || baseline.headOffset > 0.16
          const neckSpread =
            percentile(setup.samples.map((sample) => sample.neck), 0.75) -
            percentile(setup.samples.map((sample) => sample.neck), 0.25)
          const offsetSpread =
            percentile(setup.samples.map((sample) => sample.headOffset), 0.75) -
            percentile(setup.samples.map((sample) => sample.headOffset), 0.25)
          const unstable = !tilted && (neckSpread > 0.05 || offsetSpread > 0.05)
          if (tilted) {
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
              'Hold still during the 8-second test and retake for the best baseline.',
              'default'
            )
          } else {
            setSetupMessage(
              coverageMode === 'full'
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
          if (cancelled || !videoRef.current || !landmarkerRef.current) return
          const element = videoRef.current
          if (element.paused) void element.play().catch(() => undefined)
          if (element.readyState >= 2 && element.videoWidth > 0) {
            staleFramesRef.current = 0
            try {
              const now = performance.now()
              const result = landmarkerRef.current.detectForVideo(element, now)
              const pose = result.landmarks?.[0] || null
              const baseline = postureRef.current.baseline || DEFAULT_BASELINE
              if (!pose) {
                setLandmarks(null)
                setStatus('no-pose')
                setScore(null)
                metricsRef.current = null
                smoothedRef.current = null
                sampleHistoryRef.current = []
                invalidFramesRef.current = 0
                // Nobody in frame: never start or continue a slouch alert.
                badSinceRef.current = null
                setCoverage({ shoulders: false, ears: false, hips: false })
                traceStatus('no-pose')
                finishSetupIfReady(now)
              } else {
                setLandmarks(pose)
                const leftShoulder = pose[11]
                const rightShoulder = pose[12]
                const leftEar = pose[7]
                const rightEar = pose[8]
                const leftHip = pose[23]
                const rightHip = pose[24]
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
                setCoverage(nextCoverage)
                const computed = computeMetrics(pose, element, baseline)
                if (!computed) {
                  setStatus('no-pose')
                  setScore(null)
                  metricsRef.current = null
                  smoothedRef.current = null
                  sampleHistoryRef.current = []
                  invalidFramesRef.current = 0
                  badSinceRef.current = null
                  traceStatus('no-metrics')
                  finishSetupIfReady(now)
                } else if (!isPlausible(computed)) {
                  invalidFramesRef.current += 1
                  if (invalidFramesRef.current >= 6) {
                    sampleHistoryRef.current = []
                    smoothedRef.current = null
                    metricsRef.current = null
                    badSinceRef.current = null
                    setMetrics(null)
                    setScore(null)
                    setStatus('no-pose')
                  }
                  finishSetupIfReady(now)
                } else {
                  invalidFramesRef.current = 0
                  const history = [...sampleHistoryRef.current, computed].slice(-5)
                  sampleHistoryRef.current = history
                  const stable = medianSample(history)
                  const verdict = scorePosture(stable, baseline)
                  const delta = Math.min(1.4, (now - lastTickRef.current) / 1000)
                  lastTickRef.current = now
                  const smoothed =
                    smoothedRef.current === null
                      ? verdict.score
                      : smoothedRef.current * 0.4 + verdict.score * 0.6
                  smoothedRef.current = smoothed
                  const displayMetrics: PostureMetrics = { ...stable, advice: verdict.advice }
                  metricsRef.current = displayMetrics
                  setMetrics(displayMetrics)
                  setStatus('running')
                  setScore(Math.round(smoothed))

                  if (now - lastTraceRef.current >= 500) {
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
                      baselineVersion: postureRef.current.baseline?.version ?? 0,
                      setup: Boolean(setupRef.current)
                    })
                  }

                  const setup = setupRef.current
                  if (setup) {
                    // Ignore the first moment while the overlay appears and
                    // the user settles, so a transition pose is not baked in.
                    if (now - setup.start > 900) setup.samples.push(stable)
                    setup.frames += 1
                    if (nextCoverage.hips) setup.hipFrames += 1
                    setup.coverage = {
                      shoulders: setup.coverage.shoulders || nextCoverage.shoulders,
                      ears: setup.coverage.ears || nextCoverage.ears,
                      hips: setup.coverage.hips || nextCoverage.hips
                    }
                  } else {
                    const current = postureRef.current
                    if (smoothed >= current.threshold) {
                      goodRef.current += delta
                      badSinceRef.current = null
                    } else {
                      badRef.current += delta
                      if (badSinceRef.current === null) badSinceRef.current = now
                      // Ring only while a real pose is being tracked: the
                      // presence checks above clear the alert when the seat is
                      // empty, so an empty chair can never ring.
                      if (
                        current.notifications &&
                        now - badSinceRef.current > 4000 &&
                        Date.now() - lastAlertRef.current > 30_000
                      ) {
                        lastAlertRef.current = Date.now()
                        badSinceRef.current = now
                        playPostureRing()
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
            } catch {
              setStatus('no-pose')
              setScore(null)
              setMetrics(null)
              metricsRef.current = null
              smoothedRef.current = null
              sampleHistoryRef.current = []
              badSinceRef.current = null
              traceStatus('detect-error')
            }
          } else {
            staleFramesRef.current += 1
            traceStatus('no-frames')
            if (staleFramesRef.current >= 6) {
              setStatus('no-pose')
              setScore(null)
              setMetrics(null)
              metricsRef.current = null
              smoothedRef.current = null
              sampleHistoryRef.current = []
              badSinceRef.current = null
            }
          }
          timer = setTimeout(step, 420)
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
        if (setupRef.current) {
          setupRef.current = null
          setSetupRunning(false)
          setSetupProgress(0)
          setSetupMessage('Setup stopped because the camera could not start.')
        }
        setError(message)
        setStatus('error')
        showToast('Posture coach', message, 'error')
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
      if (setupRef.current) {
        setupRef.current = null
        setSetupRunning(false)
        setSetupProgress(0)
      }
      persistStats()
    }
  }, [enabled, persistStats, showToast])

  const enable = useCallback(() => {
    update({ posture: { enabled: true, dayKey: todayKey() } })
  }, [update])

  const disable = useCallback(() => {
    update({ posture: { enabled: false } })
    setStatus('off')
  }, [update])

  const calibrate = useCallback(() => {
    if (!metricsRef.current) {
      showToast('Posture coach', 'Sit in view of the camera first, then calibrate.', 'error')
      return
    }
    const baseline: PostureBaseline = {
      neck: metricsRef.current.neck,
      tilt: metricsRef.current.tilt,
      headOffset: metricsRef.current.headOffset,
      lean: metricsRef.current.lean,
      headTilt: metricsRef.current.headTilt,
      forwardHead: metricsRef.current.forwardHead,
      scale: metricsRef.current.scale,
      coverage: postureRef.current.baseline?.coverage ?? 'upper',
      version: 2
    }
    update({ posture: { baseline } })
    showToast('Posture calibrated', 'This seat position is now your baseline.', 'success')
  }, [update, showToast])

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
    if (!enabled) {
      update({ posture: { enabled: true, dayKey: todayKey() } })
    }
    if (status === 'error') {
      showToast('Posture coach', 'Start the camera successfully before running setup.', 'error')
      return
    }
    setupRef.current = {
      start: performance.now(),
      samples: [],
      coverage: { shoulders: false, ears: false, hips: false },
      frames: 0,
      hipFrames: 0
    }
    sampleHistoryRef.current = []
    smoothedRef.current = null
    badSinceRef.current = null
    setSetupRunning(true)
    setSetupProgress(0)
    setSetupMessage(null)
  }, [enabled, update, status, showToast])

  const value: PostureContextValue = {
    enabled,
    status,
    score,
    metrics,
    landmarks,
    stream,
    error,
    threshold: posture.threshold,
    notifications: posture.notifications,
    baseline: posture.baseline,
    coverage,
    setupRunning,
    setupProgress,
    setupMessage,
    goodSeconds: Math.round(goodDisplay),
    badSeconds: Math.round(badDisplay),
    enable,
    disable,
    calibrate,
    startSetupTest,
    setThreshold,
    setNotifications
  }

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
