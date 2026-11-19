import { subscribeClock, useNowWhen } from './clock'
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
  AgentQuestion,
  AgentQuestionResponse,
  AgentSnapshot,
  AppState,
  AppStatePatch,
  PendingApproval,
  SessionsSnapshot,
  Settings,
  Task,
  TimerMode,
  UpdateState,
  LicenseState,
  WaterState
} from '../../../shared/types'
import { normalizeQuestionResponse, questionSteps, stepAnswerTexts } from '../../../shared/questionAnswers'
import type { DemoConfig, DemoPlatform } from '@demo/shared/types'
import {
  formatDateKeyInZone,
  formatDateShort,
  formatTime,
  resolveSystemTimeZone,
  timeToTimestamp,
  todayKey,
  uid
} from '../lib/time'
import {
  clampWaterGoal,
  clampWaterReminder,
  formatWaterReminderLong,
  waterToday
} from '../lib/water'
import { playPostureRing as playChime, playWaterRing } from '../lib/alertSound'
import type { NoticeAction, NoticeCategory } from '../lib/notices'

export type Page = 'home' | 'notes' | 'music' | 'planner' | 'sessions' | 'posture' | 'water' | 'phone' | 'settings'
export type SettingsSection = 'appearance' | 'notch' | 'behavior' | 'home' | 'sections' | 'obsidian' | 'spotify' | 'phone' | 'about'

export interface ToastOptions {
  category?: NoticeCategory
  section?: Page
  durationMs?: number
  actions?: NoticeAction[]
  onOpen?: () => void
}

export interface ToastItem {
  id: string
  title: string
  message?: string
  tone: 'default' | 'success' | 'error'
  category?: NoticeCategory
  section?: Page
  durationMs: number
  createdAt: number
  actions?: NoticeAction[]
  onOpen?: () => void
}

interface AppContextValue {
  state: AppState
  update: (patch: AppStatePatch) => void
  updateSettings: (patch: Partial<Settings>) => void
  showToast: (
    title: string,
    message?: string,
    tone?: ToastItem['tone'],
    options?: ToastOptions
  ) => void
  toasts: ToastItem[]
  dismissToast: (id: string) => void
  clearToasts: () => void
  toastsPaused: boolean
  setToastsPaused: (paused: boolean) => void
  expanded: boolean
  presenceHidden: boolean
  viewport: { width: number; height: number }
  setExpanded: (value: boolean) => void
  pinned: boolean
  setPinned: (value: boolean) => void
  page: Page
  setPage: (page: Page) => void
  pendingNote: string | null
  setPendingNote: (path: string | null) => void
  openNote: (path: string) => void
  plannerDate: string
  setPlannerDate: (date: string) => void
  openPlanner: (date?: string) => void
  settingsSection: SettingsSection
  setSettingsSection: (section: SettingsSection) => void
  openSettings: (section?: SettingsSection) => void
  startTimer: () => void
  pauseTimer: () => void
  resetTimer: () => void
  setTimerMode: (mode: TimerMode) => void
  addTask: (input: {
    title: string
    date: string
    time?: string
    timeZone?: string
    notes?: string
    priority?: Task['priority']
    remindAt?: number | null
    eventId?: string
    eventEtag?: string
  }) => void
  toggleTask: (id: string) => void
  deleteTask: (id: string) => void
  patchTask: (id: string, patch: Partial<Task>) => void
  addGlass: () => void
  undoGlass: () => void
  setWaterGoal: (glasses: number) => void
  setWaterReminder: (minutes: number) => void
  vaultRevision: number
  sessions: SessionsSnapshot | null
  sessionsLoading: boolean
  refreshSessions: () => Promise<void>
  glowTick: number
  welcomeActive: boolean
  repliedSessionId: string | null
  agentSnapshot: AgentSnapshot | null
  questions: AgentQuestion[]
  openCodePending: PendingApproval[]
  openCodeError: string
  approvalBusy: boolean
  decideAgent: (id: string, reply: 'allow' | 'deny') => Promise<void>
  decideAgentQuestion: (id: string, response: AgentQuestionResponse) => Promise<void>
  releaseAgentQuestion: (id: string) => Promise<void>
  decideOpenCode: (item: PendingApproval, reply: 'once' | 'reject') => Promise<void>
  refreshOpenCode: () => void
  demoConfig: DemoConfig | null
  demoPlatform: DemoPlatform
  setDemoPlatform: (platform: DemoPlatform) => Promise<void>
  updateState: UpdateState | null
  checkForUpdates: () => Promise<void>
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  openUpdateRelease: () => void
  licenseState: LicenseState | null
  licenseLocked: boolean
  activateLicense: (key: string) => Promise<LicenseState>
  validateLicense: () => Promise<LicenseState>
  deactivateLicense: () => Promise<LicenseState>
}

const AppContext = createContext<AppContextValue | null>(null)

function mergeLocal(prev: AppState, patch: AppStatePatch): AppState {
  return {
    ...prev,
    ...patch,
    settings: patch.settings ? { ...prev.settings, ...patch.settings } : prev.settings,
    timer: patch.timer ? { ...prev.timer, ...patch.timer } : prev.timer,
    notes: patch.notes ? { ...prev.notes, ...patch.notes } : prev.notes,
    posture: patch.posture ? { ...prev.posture, ...patch.posture } : prev.posture,
    water: patch.water ? { ...prev.water, ...patch.water } : prev.water
  }
}

/** Sends Notch handed to the Claude app and could not confirm, by result code. */
const UNCONFIRMED_NOTICES: Record<string, { title: string; fallback: string }> = {
  'claude-open-in-app': {
    title: 'Paste in Claude',
    fallback: 'Notch opened this chat and copied your message. Press Ctrl+V, then Enter.'
  },
  // Notch already pasted and pressed Enter, so asking for another paste would
  // risk sending the message twice.
  'claude-sent-unconfirmed': {
    title: 'Check Claude',
    fallback: 'Notch typed your message into Claude but could not confirm it was sent.'
  }
}

function unconfirmedNotice(result: { code?: string }): { title: string; fallback: string } | undefined {
  if (result.code === 'claude-open-in-app' || result.code === 'claude-sent-unconfirmed') {
    return UNCONFIRMED_NOTICES[result.code]
  }
  return undefined
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const [expanded, setExpandedState] = useState(false)
  // Read from event callbacks that must not re-subscribe when the value flips.
  const expandedRef = useRef(false)
  expandedRef.current = expanded
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight })
  const viewportHold = useRef(0)
  const [pinned, setPinnedState] = useState(false)
  const [page, setPage] = useState<Page>('home')
  const [pendingNote, setPendingNote] = useState<string | null>(null)
  const [plannerDate, setPlannerDate] = useState<string>(todayKey())
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance')
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [toastsPaused, setToastsPausedState] = useState(false)
  const toastsPausedRef = useRef(false)
  const toastTimersRef = useRef(
    new Map<
      string,
      { timer: ReturnType<typeof setTimeout> | null; startedAt: number; remainingMs: number }
    >()
  )
  const [glowTick, setGlowTick] = useState(0)
  const [welcomeActive, setWelcomeActive] = useState(false)
  const welcomeTriggered = useRef(false)
  const [repliedSessionId, setRepliedSessionId] = useState<string | null>(null)
  const [agentSnapshot, setAgentSnapshot] = useState<AgentSnapshot | null>(null)
  const [openCodePending, setOpenCodePending] = useState<PendingApproval[]>([])
  const [openCodeQuestions, setOpenCodeQuestions] = useState<AgentQuestion[]>([])
  const [openCodeError, setOpenCodeError] = useState('')
  const [approvalBusy, setApprovalBusy] = useState(false)
  const approvalBusyRef = useRef(false)
  approvalBusyRef.current = approvalBusy
  const dismissedOpenCodeQuestions = useRef(new Set<string>())
  const [openCodeVersion, setOpenCodeVersion] = useState(0)
  const agentMountedAt = useRef(Date.now())
  const agentSeen = useRef(new Set<string>())
  const openCodeSeen = useRef(new Set<string>())
  const notificationsOn = useRef(true)
  notificationsOn.current = !state || state.settings.notifications !== false
  const [vaultRevision, setVaultRevision] = useState(0)
  const [sessions, setSessions] = useState<SessionsSnapshot | null>(null)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [demoConfig, setDemoConfig] = useState<DemoConfig | null>(null)
  const [demoPlatform, setDemoPlatformState] = useState<DemoPlatform>('macos')
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [licenseState, setLicenseState] = useState<LicenseState | null>(null)
  const licenseReady = Boolean(licenseState && (!licenseState.required || licenseState.status === 'active'))
  const licenseReadyRef = useRef(licenseReady)
  licenseReadyRef.current = licenseReady
  const pageRef = useRef<Page>(page)
  pageRef.current = page
  const settingsSectionRef = useRef<SettingsSection>(settingsSection)
  settingsSectionRef.current = settingsSection
  const writeSeq = useRef(0)
  const timerGuard = useRef<number | null>(null)

  useEffect(() => {
    const api = window.notchDemo
    if (!api) return
    document.title = 'Hero Notch'
    void import('@demo/renderer/demo.css')
    let alive = true
    void api.getConfig().then((cfg) => {
      if (!alive) return
      setDemoConfig(cfg)
      setDemoPlatformState(cfg.platform)
    })
    const offPlatform = api.onPlatform((next) => {
      if (alive) setDemoPlatformState(next)
    })
    return () => {
      alive = false
      offPlatform()
    }
  }, [])

  const setDemoPlatform = useCallback(async (platform: DemoPlatform) => {
    const api = window.notchDemo
    if (!api) return
    const next = await api.setPlatform(platform)
    setDemoPlatformState(next)
  }, [])

  const refreshOpenCode = useCallback(() => {
    setOpenCodeVersion((v) => v + 1)
  }, [])

  useEffect(() => {
    let alive = true
    void window.notch.getState().then((loaded) => {
      if (!alive) return
      setState(loaded)
      setPinnedState(loaded.settings.pinOnOpen)
    })
    let receivedExpandedEvent = false
    const offExpanded = window.notch.onExpanded((event) => {
      receivedExpandedEvent = true
      if (event.viewport) {
        viewportHold.current = Date.now()
        setViewport(event.viewport)
      }
      setExpandedState(event.expanded)
    })
    void window.notch.getExpanded().then((value) => {
      if (alive && !receivedExpandedEvent) setExpandedState(value)
    })
    const offState = window.notch.onStateUpdated((next) => setState(next))
    const offReminder = window.notch.onReminder((event) => {
      if (!notificationsOn.current) return
      const at = timeToTimestamp(event.date, event.time, event.timeZone)
      const localDate = at ? formatDateKeyInZone(at, resolveSystemTimeZone()) : event.date
      const day = localDate === todayKey() ? 'Today' : formatDateShort(localDate)
      const id = uid()
      const durationMs = 12000
      setGlowTick((value) => value + 1)
      const markDone = (): void => {
        const latest = stateRef.current
        if (!latest) return
        const nextTasks = latest.tasks.map((task) =>
          task.id === event.taskId ? { ...task, done: true, completedAt: Date.now() } : task
        )
        setState((prev) => (prev ? mergeLocal(prev, { tasks: nextTasks }) : prev))
        const seq = ++writeSeq.current
        void window.notch
          .setState({ tasks: nextTasks })
          .then((remote) => {
            if (writeSeq.current === seq) setState(remote)
          })
          .catch(() => undefined)
      }
      const snoozeTen = (): void => {
        const latest = stateRef.current
        if (!latest) return
        const nextTasks = latest.tasks.map((task) =>
          task.id === event.taskId
            ? { ...task, remindAt: Date.now() + 10 * 60 * 1000, notifiedAt: null }
            : task
        )
        setState((prev) => (prev ? mergeLocal(prev, { tasks: nextTasks }) : prev))
        const seq = ++writeSeq.current
        void window.notch
          .setState({ tasks: nextTasks })
          .then((remote) => {
            if (writeSeq.current === seq) setState(remote)
          })
          .catch(() => undefined)
      }
      setToasts((current) => [
        ...current.slice(-3),
        {
          id,
          title: `Reminder · ${event.title}`,
          message: at ? `${day} at ${formatTime(at)}` : day,
          tone: 'default',
          category: 'reminder',
          section: 'planner',
          durationMs,
          createdAt: Date.now(),
          actions: [
            { label: 'Done', variant: 'primary', onClick: markDone },
            { label: 'Snooze 10m', variant: 'soft', onClick: snoozeTen }
          ]
        }
      ])
      // Reminders arrive while you are in another app, so the notice lingers
      // longer than a normal toast before folding away.
      const timer = setTimeout(() => {
        toastTimersRef.current.delete(id)
        setToasts((current) => current.filter((toast) => toast.id !== id))
      }, durationMs)
      toastTimersRef.current.set(id, {
        timer,
        startedAt: Date.now(),
        remainingMs: durationMs
      })
    })
    const offVault = window.notch.onVaultChanged(() => setVaultRevision((value) => value + 1))
    const onResize = (): void => {
      // Ignore the collapsed window, and the resize that races the open event.
      if (Date.now() - viewportHold.current < 700) return
      if (window.innerWidth < 640 || window.innerHeight < 400) return
      setViewport({ width: window.innerWidth, height: window.innerHeight })
    }
    window.addEventListener('resize', onResize)

    const offNavigate = window.notch.onNavigate((target) => {
      // "settings:phone" style targets deep-link into a settings tab.
      const value = String(target)
      const [page, section] = value.split(':')
      if (page === 'settings' && section) setSettingsSection(section as SettingsSection)
      setPage(page as Page)
      setExpandedState(true)
    })

    return () => {
      alive = false
      offExpanded()
      offState()
      offReminder()
      offVault()
      offNavigate()
      window.removeEventListener('resize', onResize)
    }
  }, [])

  const dayRolloverInflight = useRef(false)
  const checkDayRollover = useCallback(() => {
    const current = stateRef.current
    if (!current || dayRolloverInflight.current) return
    const day = todayKey()
    const stale =
      current.timer.dayKey !== day ||
      current.posture.dayKey !== day ||
      current.water.dayKey !== day
    if (!stale) return
    dayRolloverInflight.current = true
    const seq = writeSeq.current
    void window.notch
      .getState()
      .then((remote) => {
        if (writeSeq.current !== seq) return
        setState(remote)
      })
      .finally(() => {
        dayRolloverInflight.current = false
      })
  }, [])

  useEffect(() => {
    const interval = window.setInterval(checkDayRollover, 60_000)
    return () => window.clearInterval(interval)
  }, [checkDayRollover])

  useEffect(() => {
    if (expanded) checkDayRollover()
  }, [expanded, checkDayRollover])

  const lastScanAt = useRef(0)
  const refreshSessions = useCallback(async () => {
    if (!licenseReadyRef.current) return
    lastScanAt.current = Date.now()
    setSessionsLoading(true)
    try {
      setSessions(await window.notch.sessions.scan())
    } catch (error) {
      setSessions({
        sessions: [],
        apps: [],
        scannedAt: Date.now(),
        error: error instanceof Error ? error.message : 'Could not scan coding sessions.'
      })
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  /** A scan is expensive; re-opening the panel is not a reason to run another. */
  const scanIfStale = useCallback(
    (maxAgeMs: number) => {
      if (Date.now() - lastScanAt.current < maxAgeMs) return
      void refreshSessions()
    },
    [refreshSessions]
  )

  const [presenceHidden, setPresenceHidden] = useState(false)
  const presenceHiddenRef = useRef(false)
  presenceHiddenRef.current = presenceHidden

  useEffect(() => {
    let useSnapshot = true
    const unsubscribe = window.notch.onPresence((event) => {
      useSnapshot = false
      presenceHiddenRef.current = event.hidden
      setPresenceHidden(event.hidden)
    })
    void window.notch.getPresence().then((event) => {
      if (useSnapshot) {
        presenceHiddenRef.current = event.hidden
        setPresenceHidden(event.hidden)
      }
    })
    return () => {
      useSnapshot = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!presenceHidden) scanIfStale(8_000)
  }, [presenceHidden, scanIfStale])

  // One scan when the app comes up (once license is ready). The cadence below
  // owns everything after that, so expanding the panel does not spawn another.
  useEffect(() => {
    if (!licenseReady) return
    void refreshSessions()
  }, [licenseReady, refreshSessions])

  useEffect(() => {
    if (!licenseReady) return
    let timer = 0
    let alive = true
    // Every scan starts a PowerShell process probe and re-reads each agent's
    // store, so the cadence is the main dial on idle cost. Presence does not
    // change every few seconds; an open panel is the only case that wants to
    // feel live.
    if (expanded) scanIfStale(15_000)
    const schedule = (): void => {
      const wait = presenceHiddenRef.current ? 60_000 : expanded ? 8_000 : 30_000
      timer = window.setTimeout(() => {
        if (!alive) return
        if (!presenceHiddenRef.current) void refreshSessions()
        schedule()
      }, wait)
    }
    schedule()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [licenseReady, expanded, refreshSessions, scanIfStale])

  const update = useCallback((patch: AppStatePatch) => {
    setState((prev) => {
      const next = prev ? mergeLocal(prev, patch) : prev
      stateRef.current = next
      return next
    })
    const seq = ++writeSeq.current
    void window.notch
      .setState(patch)
      .then((remote) => {
        if (writeSeq.current === seq) {
          stateRef.current = remote
          setState(remote)
        }
      })
      .catch(() => {
        // The renderer keeps the optimistic state; the next launch retries from disk.
      })
  }, [])

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      update({ settings: patch })
    },
    [update]
  )

  const scheduleToastExpiry = useCallback((id: string, remainingMs: number) => {
    const existing = toastTimersRef.current.get(id)
    if (existing?.timer) clearTimeout(existing.timer)
    if (toastsPausedRef.current) {
      toastTimersRef.current.set(id, {
        timer: null,
        startedAt: Date.now(),
        remainingMs: Math.max(800, remainingMs)
      })
      return
    }
    const clamped = Math.max(800, remainingMs)
    const timer = setTimeout(() => {
      toastTimersRef.current.delete(id)
      setToasts((current) => current.filter((toast) => toast.id !== id))
    }, clamped)
    toastTimersRef.current.set(id, {
      timer,
      startedAt: Date.now(),
      remainingMs: clamped
    })
  }, [])

  const dismissToast = useCallback((id: string) => {
    const existing = toastTimersRef.current.get(id)
    if (existing?.timer) clearTimeout(existing.timer)
    toastTimersRef.current.delete(id)
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const clearToasts = useCallback(() => {
    for (const entry of toastTimersRef.current.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    toastTimersRef.current.clear()
    setToasts([])
  }, [])

  const setToastsPaused = useCallback(
    (paused: boolean) => {
      if (toastsPausedRef.current === paused) return
      toastsPausedRef.current = paused
      setToastsPausedState(paused)
      const now = Date.now()
      if (paused) {
        for (const entry of toastTimersRef.current.values()) {
          if (entry.timer) clearTimeout(entry.timer)
          const elapsed = Math.max(0, now - entry.startedAt)
          entry.remainingMs = Math.max(900, entry.remainingMs - elapsed)
          entry.timer = null
          entry.startedAt = now
        }
      } else {
        for (const [id, entry] of toastTimersRef.current.entries()) {
          scheduleToastExpiry(id, entry.remainingMs)
        }
      }
    },
    [scheduleToastExpiry]
  )

  const showToast = useCallback(
    (
      title: string,
      message?: string,
      tone: ToastItem['tone'] = 'default',
      options?: ToastOptions
    ) => {
      const id = uid()
      const durationMs = options?.durationMs ?? 5200
      const createdAt = Date.now()
      setGlowTick((value) => value + 1)
      setToasts((current) => {
        const dropped = current.slice(0, Math.max(0, current.length - 3))
        for (const item of dropped) {
          const old = toastTimersRef.current.get(item.id)
          if (old?.timer) clearTimeout(old.timer)
          toastTimersRef.current.delete(item.id)
        }
        return [
          ...current.slice(-3),
          {
            id,
            title,
            message,
            tone,
            category: options?.category,
            section: options?.section,
            durationMs,
            createdAt,
            actions: options?.actions,
            onOpen: options?.onOpen
          }
        ]
      })
      scheduleToastExpiry(id, durationMs)
    },
    [scheduleToastExpiry]
  )

  useEffect(() => {
    const timers = toastTimersRef.current
    return () => {
      for (const entry of timers.values()) {
        if (entry.timer) clearTimeout(entry.timer)
      }
      timers.clear()
    }
  }, [])

  useEffect(() => {
    return window.notch.sessions.onReply((event) => {
      showToast(`${event.label} replied: ${event.title}`, undefined, 'default', {
        category: 'session',
        section: 'sessions',
        durationMs: 7500
      })
      if (stateRef.current?.settings.codingReplySound !== false) playChime()
      setRepliedSessionId(event.sessionId)
      window.setTimeout(() => {
        setRepliedSessionId((current) => (current === event.sessionId ? null : current))
      }, 22000)
    })
  }, [showToast])

  useEffect(() => {
    if (!licenseReady) return
    let alive = true
    void window.notch.agent
      .status()
      .then((value) => {
        if (alive) setAgentSnapshot(value)
      })
      .catch(() => undefined)
    const off = window.notch.agent.onUpdate((value) => {
      if (!alive) return
      setAgentSnapshot(value)
      // A question and a permission are answered in the tab itself, so neither
      // one opens the panel and neither one raises a card. The tab morph plus
      // the edge glow is the whole announcement: a toast under it just repeats
      // what is now sitting in front of you, and it used to push the notch open
      // on the Sessions page for every question a tool asked.
      for (const question of value.questions || []) {
        const qKey = `question:${question.id}`
        if (agentSeen.current.has(qKey)) continue
        agentSeen.current.add(qKey)
        // The question also lands as a waiting status; that key is marked seen
        // so the status loop cannot answer for it.
        agentSeen.current.add(`${question.tool}:waiting:${question.at}`)
        setGlowTick((tick) => tick + 1)
        if (stateRef.current?.settings.codingReplySound !== false) playChime()
      }
      for (const item of value.pending) {
        const pKey = `pending:${item.id}`
        if (agentSeen.current.has(pKey)) continue
        agentSeen.current.add(pKey)
        setGlowTick((tick) => tick + 1)
        if (stateRef.current?.settings.codingReplySound !== false) playChime()
      }
      // "Working / waiting / done" churn is ambient, not news. It stays visible
      // in the panel and on the tab; no card per turn.
      for (const item of value.statuses) {
        if (item.state !== 'waiting' && item.state !== 'done') continue
        const key = `${item.tool}:${item.state}:${item.at}`
        if (agentSeen.current.has(key) || item.at < agentMountedAt.current - 2000) continue
        agentSeen.current.add(key)
      }
    })
    return () => {
      alive = false
      off()
    }
  }, [licenseReady, showToast])

  const openCodePort = state?.settings.openCodeApprovalPort
  const openCodePendingSig = useRef('[]')
  const openCodeQuestionsSig = useRef('[]')
  const openCodeBootstrapped = useRef(false)
  useEffect(() => {
    if (!licenseReady || !openCodePort) {
      openCodeBootstrapped.current = false
      openCodePendingSig.current = '[]'
      openCodeQuestionsSig.current = '[]'
      setOpenCodePending((prev) => (prev.length === 0 ? prev : []))
      setOpenCodeQuestions((prev) => (prev.length === 0 ? prev : []))
      setOpenCodeError((prev) => (prev === '' ? prev : ''))
      return
    }
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh(): Promise<void> {
      if (approvalBusyRef.current) {
        if (active) timer = setTimeout(() => void refresh(), 800)
        return
      }
      try {
        const [result, rawQuestions] = await Promise.all([
          window.notch.approvals.list(),
          window.notch.approvals.questions().catch(() => [])
        ])
        if (!active) return
        const fresh = result.filter((row) => !openCodeSeen.current.has(row.fingerprint))
        const activeIds = new Set(rawQuestions.map((item) => `opencode:${item.id}`))
        for (const dismissed of [...dismissedOpenCodeQuestions.current]) {
          if (!activeIds.has(dismissed)) dismissedOpenCodeQuestions.current.delete(dismissed)
        }
        const mappedQuestions: AgentQuestion[] = rawQuestions
          .map((item) => ({
            id: `opencode:${item.id}`,
            tool: 'opencode' as const,
            title: item.title,
            detail: item.detail,
            options: item.options,
            multiSelect: item.multiSelect,
            steps: item.steps,
            at: Date.now()
          }))
          .filter((item) => !dismissedOpenCodeQuestions.current.has(item.id))
        const freshQuestions = mappedQuestions.filter((item) => !openCodeSeen.current.has(item.id))
        if ((fresh.length > 0 || freshQuestions.length > 0) && openCodeBootstrapped.current) {
          setGlowTick((tick) => tick + 1)
          if (stateRef.current?.settings.codingReplySound !== false) playChime()
        }
        if (fresh.length > 0 && openCodeBootstrapped.current) {
          showToast(
            'OpenCode is waiting for you',
            `${fresh.length} approval request${fresh.length === 1 ? '' : 's'} waiting · Sessions`,
            'default'
          )
        }
        openCodeBootstrapped.current = true
        for (const row of result) openCodeSeen.current.add(row.fingerprint)
        for (const item of mappedQuestions) openCodeSeen.current.add(item.id)
        const nextPendingSig = JSON.stringify(result)
        if (nextPendingSig !== openCodePendingSig.current) {
          openCodePendingSig.current = nextPendingSig
          setOpenCodePending(result)
        }
        const nextQuestionsSig = JSON.stringify(mappedQuestions.map((q) => ({ ...q, at: 0 })))
        if (nextQuestionsSig !== openCodeQuestionsSig.current) {
          openCodeQuestionsSig.current = nextQuestionsSig
          setOpenCodeQuestions(mappedQuestions)
        }
        setOpenCodeError((prev) => (prev === '' ? prev : ''))
      } catch {
        if (active) {
          openCodeSeen.current = new Set()
          openCodePendingSig.current = '[]'
          openCodeQuestionsSig.current = '[]'
          setOpenCodePending((prev) => (prev.length === 0 ? prev : []))
          setOpenCodeQuestions((prev) => (prev.length === 0 ? prev : []))
          setOpenCodeError((prev) =>
            prev === 'Could not read pending requests from OpenCode.'
              ? prev
              : 'Could not read pending requests from OpenCode.'
          )
        }
      }
      if (active) timer = setTimeout(() => void refresh(), 3500)
    }
    void refresh()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [licenseReady, openCodePort, openCodeVersion, showToast])

  const decideAgent = useCallback(
    async (id: string, reply: 'allow' | 'deny') => {
      setApprovalBusy(true)
      try {
        await window.notch.agent.decide(id, reply)
        setAgentSnapshot(await window.notch.agent.status())
      } catch (cause) {
        showToast(
          'Could not send that decision',
          cause instanceof Error ? cause.message : String(cause),
          'error'
        )
      } finally {
        setApprovalBusy(false)
        scanIfStale(1500)
      }
    },
    [scanIfStale, showToast]
  )

  const questions = [...(agentSnapshot?.questions || []), ...openCodeQuestions]

  const decideAgentQuestion = useCallback(
    async (id: string, response: AgentQuestionResponse) => {
      setApprovalBusy(true)
      try {
        if (id.startsWith('opencode:')) {
          const port = stateRef.current?.settings.openCodeApprovalPort
          const target = openCodeQuestions.find((q) => q.id === id)
          if (!port || !target) throw new Error('That OpenCode question is no longer active.')
          const stepList = questionSteps(target)
          const normalized = normalizeQuestionResponse(stepList, response)
          const answers = stepList.map((step, sIdx) => stepAnswerTexts(step, normalized[sIdx] || { choices: [] }))
          if (answers.some((row) => row.length === 0)) throw new Error('Pick an option or type an answer.')
          await window.notch.approvals.replyQuestion(id.slice('opencode:'.length), answers, port)
          setOpenCodeVersion((v) => v + 1)
          return
        }
        await window.notch.agent.decideQuestion(id, response)
        setAgentSnapshot(await window.notch.agent.status())
      } catch (cause) {
        showToast(
          'Could not send that answer',
          cause instanceof Error ? cause.message : String(cause),
          'error'
        )
      } finally {
        setApprovalBusy(false)
        scanIfStale(1500)
      }
    },
    [openCodeQuestions, scanIfStale, showToast]
  )

  const releaseAgentQuestion = useCallback(
    async (id: string) => {
      try {
        if (id.startsWith('opencode:')) {
          // Dismiss locally in Notch without deleting/rejecting the prompt on
          // OpenCode's server, so the user can still answer it in OpenCode.
          dismissedOpenCodeQuestions.current.add(id)
          setOpenCodeQuestions((prev) => prev.filter((item) => item.id !== id))
        } else {
          await window.notch.agent.releaseQuestion(id)
          setAgentSnapshot(await window.notch.agent.status())
        }
        showToast(
          'Answer it in the tool',
          'Notch stepped aside; pick your answer in the session window.',
          'default'
        )
      } catch (cause) {
        showToast(
          'Could not step aside',
          cause instanceof Error ? cause.message : String(cause),
          'error'
        )
      } finally {
        scanIfStale(1500)
      }
    },
    [scanIfStale, showToast]
  )

  const decideOpenCode = useCallback(
    async (item: PendingApproval, reply: 'once' | 'reject') => {
      const port = stateRef.current?.settings.openCodeApprovalPort
      if (!port) return
      setApprovalBusy(true)
      try {
        await window.notch.approvals.decide(item.fingerprint, reply, port)
      } catch (cause) {
        showToast(
          'OpenCode decision failed',
          cause instanceof Error ? cause.message : String(cause),
          'error'
        )
      } finally {
        setApprovalBusy(false)
        setOpenCodeVersion((v) => v + 1)
        scanIfStale(1500)
      }
    },
    [scanIfStale, showToast]
  )

  useEffect(() => {
    return window.notch.sessions.onSendResult((result) => {
      void refreshSessions()
      // A message that went through says "Sent" in the composer, and a queued
      // one shows its queue badge on the row; nothing else needs to interrupt
      // the user.
      if (result.status === 'delivered') return
      if (result.status === 'queued') return
      if (result.status === 'unconfirmed') {
        const notice = unconfirmedNotice(result)
        if (notice) showToast(notice.title, result.error || notice.fallback, 'default')
        return
      }
      showToast(
        `${result.label} did not deliver`,
        result.error || 'The agent command failed.',
        'error'
      )
    })
  }, [refreshSessions, showToast])

  const setExpanded = useCallback((value: boolean) => {
    if (!value) {
      // The shell plays the shrink, then tells the main process to drop the
      // click shape back to the tab. Clearing expanded here would hide the
      // panel before it can move.
      window.dispatchEvent(new Event('notch-request-close'))
      return
    }
    performance.mark('notch-open-request')
    const requested = performance.now()
    // Split a slow open into "main process was busy" (this round trip) and
    // "the page was slow to paint" (open-first-frame in App.tsx).
    void window.notch.setExpanded(true).then(() => {
      window.notch.reportTiming('open-ipc-roundtrip', performance.now() - requested)
    })
  }, [])

  const setPinned = useCallback(
    (value: boolean) => {
      setPinnedState(value)
      updateSettings({ pinOnOpen: value })
      if (value) {
        void window.notch.setExpanded(true)
      }
    },
    [updateSettings]
  )

  const openNote = useCallback((path: string) => {
    setPendingNote(path)
    setPage('notes')
    void window.notch.setExpanded(true)
  }, [])

  const openPlanner = useCallback((date?: string) => {
    if (date) setPlannerDate(date)
    setPage('planner')
    void window.notch.setExpanded(true)
  }, [])

  const openSettings = useCallback((section?: SettingsSection) => {
    if (section) setSettingsSection(section)
    setPage('settings')
    void window.notch.setExpanded(true)
  }, [])

  useEffect(() => {
    let alive = true
    const notifyIfNeeded = (next: UpdateState): void => {
      if (!alive || next.installKind === 'disabled' || !next.availableVersion) return
      if (next.status !== 'available' && next.status !== 'downloaded') return
      if (pageRef.current === 'settings' && settingsSectionRef.current === 'about') return
      const storageKey = 'notch.notifiedUpdateKey'
      const key = `${next.status}:${next.availableVersion}`
      try {
        if (window.localStorage.getItem(storageKey) === key) return
        window.localStorage.setItem(storageKey, key)
      } catch {
        // Ignore storage access errors.
      }
      const isReady = next.status === 'downloaded'
      showToast(
        isReady ? `Notch ${next.availableVersion} ready` : `Notch ${next.availableVersion} available`,
        isReady ? 'Restart from Settings to install.' : 'Open Settings → About to update.',
        isReady ? 'success' : 'default',
        {
          category: 'system',
          section: 'settings',
          durationMs: 9000,
          onOpen: () => openSettings('about'),
          actions: [
            {
              label: isReady ? 'Restart' : 'View update',
              variant: 'primary',
              onClick: () => openSettings('about')
            }
          ]
        }
      )
    }

    void window.notch.updater.getState().then((initial) => {
      if (!alive) return
      setUpdateState(initial)
    })
    const offUpdater = window.notch.updater.onState((next) => {
      if (!alive) return
      setUpdateState(next)
      notifyIfNeeded(next)
    })
    return () => {
      alive = false
      offUpdater()
    }
  }, [openSettings, showToast])

  const checkForUpdates = useCallback(async () => {
    const next = await window.notch.updater.check({ manual: true })
    setUpdateState(next)
  }, [])

  const downloadUpdate = useCallback(async () => {
    const next = await window.notch.updater.download()
    setUpdateState(next)
  }, [])

  const installUpdate = useCallback(async () => {
    const started = await window.notch.updater.install()
    if (!started) {
      showToast('Could not restart to update', 'Download the installer from GitHub Releases if this persists.', 'error')
    }
  }, [showToast])

  const openUpdateRelease = useCallback(() => {
    window.notch.updater.openRelease()
  }, [])

  useEffect(() => {
    let alive = true
    void window.notch.license.getState().then((initial) => {
      if (alive) setLicenseState(initial)
    })
    const off = window.notch.license.onState((next) => {
      if (alive) setLicenseState(next)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const activateLicense = useCallback(async (key: string) => {
    const next = await window.notch.license.activate(key)
    setLicenseState(next)
    return next
  }, [])

  const validateLicense = useCallback(async () => {
    const next = await window.notch.license.validate()
    setLicenseState(next)
    return next
  }, [])

  const deactivateLicense = useCallback(async () => {
    const next = await window.notch.license.deactivate()
    setLicenseState(next)
    return next
  }, [])

  const licenseLocked = Boolean(licenseState?.required && licenseState.status !== 'active')

  const startTimer = useCallback(() => {
    if (!state) return
    const current = state.timer
    const remaining =
      current.running && current.endsAt
        ? Math.max(0, Math.ceil((current.endsAt - Date.now()) / 1000))
        : current.remaining > 0
          ? current.remaining
          : current.durations[current.mode] * 60
    timerGuard.current = null
    update({
      timer: {
        ...current,
        running: true,
        remaining,
        endsAt: Date.now() + remaining * 1000
      }
    })
  }, [state, update])

  const pauseTimer = useCallback(() => {
    if (!state) return
    const current = state.timer
    const remaining = current.running && current.endsAt
      ? Math.max(0, Math.ceil((current.endsAt - Date.now()) / 1000))
      : current.remaining
    update({
      timer: {
        ...current,
        running: false,
        endsAt: null,
        remaining
      }
    })
  }, [state, update])

  const resetTimer = useCallback(() => {
    if (!state) return
    const current = state.timer
    timerGuard.current = null
    update({
      timer: {
        ...current,
        running: false,
        endsAt: null,
        remaining: current.durations[current.mode] * 60
      }
    })
  }, [state, update])

  const setTimerMode = useCallback(
    (mode: TimerMode) => {
      if (!state) return
      const current = state.timer
      timerGuard.current = null
      update({
        timer: {
          ...current,
          mode,
          running: false,
          endsAt: null,
          remaining: current.durations[mode] * 60
        }
      })
    },
    [state, update]
  )

  useEffect(() => {
    if (!licenseReady || !state?.timer.running || !state.timer.endsAt) return
    return subscribeClock(() => {
      const current = state.timer
      if (!current.running || !current.endsAt) return
      if (Date.now() < current.endsAt) return
      if (timerGuard.current === current.endsAt) return
      timerGuard.current = current.endsAt

      const minutes = current.durations[current.mode]
      const completed = current.mode === 'focus'
      const label = current.mode === 'focus' ? 'Focus session complete' : 'Break is over'
      if (state.settings?.timerNotifications !== false) {
        const nextMode: TimerMode = completed ? 'short' : 'focus'
        const nextSeconds = current.durations[nextMode] * 60
        window.notch.notify(
          label,
          completed ? `${minutes} minutes of focus logged.` : 'Ready for another round?',
          true
        )
        showToast(
          label,
          completed ? `${minutes} focused minutes logged.` : 'Time to stretch.',
          'success',
          {
            category: 'timer',
            section: 'home',
            durationMs: 8500,
            actions: [
              {
                label: completed ? 'Start break' : 'Start focus',
                variant: 'primary',
                onClick: () => {
                  const latest = stateRef.current
                  if (!latest) return
                  const durationSecs = latest.timer.durations[nextMode] * 60 || nextSeconds
                  timerGuard.current = null
                  update({
                    timer: {
                      ...latest.timer,
                      mode: nextMode,
                      running: true,
                      remaining: durationSecs,
                      endsAt: Date.now() + durationSecs * 1000
                    }
                  })
                }
              }
            ]
          }
        )
        playChime()
      }
      update({
        timer: {
          ...current,
          running: false,
          endsAt: null,
          remaining: minutes * 60,
          sessionsToday: current.sessionsToday + 1,
          completedToday: current.completedToday + 1
        },
        focusLog: completed
          ? [...state.focusLog, { at: Date.now(), minutes }].slice(-250)
          : state.focusLog
      })
    })
  }, [licenseReady, state, update, showToast])

  const addTask = useCallback<AppContextValue['addTask']>(
    (input) => {
      const currentState = stateRef.current
      if (!currentState) return
      const task: Task = {
        id: uid(),
        title: input.title.trim(),
        date: input.date,
        time: input.time || undefined,
        timeZone: input.time ? input.timeZone : undefined,
        notes: input.notes?.trim() || undefined,
        priority: input.priority || 'normal',
        remindAt: input.remindAt ?? null,
        notifiedAt: null,
        done: false,
        createdAt: Date.now(),
        eventId: input.eventId,
        eventEtag: input.eventEtag
      }
      if (!task.title) return
      update({ tasks: [...currentState.tasks, task] })
    },
    [update]
  )

  const toggleTask = useCallback(
    (id: string) => {
      const currentState = stateRef.current
      if (!currentState) return
      update({
        tasks: currentState.tasks.map((task) =>
          task.id === id
            ? { ...task, done: !task.done, completedAt: !task.done ? Date.now() : undefined }
            : task
        )
      })
    },
    [update]
  )

  const deleteTask = useCallback(
    (id: string) => {
      const currentState = stateRef.current
      if (!currentState) return
      update({ tasks: currentState.tasks.filter((task) => task.id !== id) })
    },
    [update]
  )

  const patchTask = useCallback(
    (id: string, patch: Partial<Task>) => {
      const currentState = stateRef.current
      if (!currentState) return
      update({
        tasks: currentState.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task))
      })
    },
    [update]
  )

  const waterRef = useRef<WaterState | null>(state?.water ?? null)
  if (state?.water) waterRef.current = state.water

  const commitWater = useCallback(
    (recipe: (current: WaterState) => WaterState) => {
      const base = waterRef.current
      if (!base) return
      const next = recipe(waterToday(base))
      waterRef.current = next
      update({ water: next })
    },
    [update]
  )

  const addGlass = useCallback(() => {
    const now = Date.now()
    commitWater((current) => {
      const interval = current.reminderMinutes || 0
      return {
        ...current,
        pours: [...current.pours, now],
        remindAt: interval > 0 ? now + interval * 60 * 1000 : null
      }
    })
  }, [commitWater])

  const undoGlass = useCallback(() => {
    commitWater((current) => ({
      ...current,
      pours: current.pours.length ? current.pours.slice(0, -1) : current.pours
    }))
  }, [commitWater])

  const setWaterGoal = useCallback(
    (glasses: number) => {
      commitWater((current) => ({ ...current, goalGlasses: clampWaterGoal(glasses) }))
    },
    [commitWater]
  )

  const waterReminderGuard = useRef<number | null>(null)

  const setWaterReminder = useCallback(
    (minutes: number) => {
      const clean = clampWaterReminder(minutes)
      waterReminderGuard.current = null
      commitWater((current) => ({
        ...current,
        reminderMinutes: clean,
        remindAt: clean > 0 ? Date.now() + clean * 60 * 1000 : null
      }))
    },
    [commitWater]
  )

  useEffect(() => {
    if (!licenseReady) return
    const interval = state?.water.reminderMinutes || 0
    const remindAt = state?.water.remindAt
    if (interval <= 0 || !remindAt) return
    return subscribeClock(() => {
      const current = waterRef.current
      if (!current) return
      const activeInterval = current.reminderMinutes || 0
      const targetAt = current.remindAt
      if (activeInterval <= 0 || !targetAt) return
      const now = Date.now()
      if (now < targetAt) return
      if (waterReminderGuard.current === targetAt) return
      waterReminderGuard.current = targetAt

      const todayWater = waterToday(current)
      const count = todayWater.pours.length
      const goal = todayWater.goalGlasses
      const label = 'Time to drink water'
      const detail = `${count} of ${goal} ${goal === 1 ? 'glass' : 'glasses'} today · every ${formatWaterReminderLong(activeInterval)}`

      playWaterRing()
      showToast(`Water reminder · ${label}`, detail, 'default', {
        category: 'water',
        section: 'water',
        durationMs: 12000,
        actions: [
          {
            label: 'Add a glass',
            variant: 'primary',
            onClick: () => addGlass()
          }
        ]
      })

      if (notificationsOn.current) {
        window.notch.notify(label, detail, true)
      }

      commitWater((prev) => ({
        ...prev,
        remindAt: Date.now() + activeInterval * 60 * 1000
      }))
    })
  }, [licenseReady, state?.water.reminderMinutes, state?.water.remindAt, commitWater, showToast, addGlass])

  const stateLoaded = Boolean(state)
  const welcomeSeen = state?.settings.welcomeSeen === true
  const hasPendingPrompt = Boolean(
    agentSnapshot?.pending.length || openCodePending.length || questions.length
  )

  useEffect(() => {
    if (!stateLoaded || !licenseReady || welcomeSeen || welcomeTriggered.current) return
    if (demoConfig || window.notchDemo) return
    if (expanded || presenceHidden || hasPendingPrompt) return

    const startTimer = window.setTimeout(() => {
      if (welcomeTriggered.current) return
      welcomeTriggered.current = true
      updateSettings({ welcomeSeen: true })
      // The collapsed bar's welcome animation is the only first-run cue; no toast.
      setWelcomeActive(true)
    }, 900)

    return () => window.clearTimeout(startTimer)
  }, [stateLoaded, licenseReady, welcomeSeen, demoConfig, expanded, presenceHidden, hasPendingPrompt, updateSettings])

  useEffect(() => {
    if (!welcomeActive) return
    const endTimer = window.setTimeout(() => setWelcomeActive(false), 2100)
    return () => window.clearTimeout(endTimer)
  }, [welcomeActive])

  useEffect(() => {
    if (expanded) setWelcomeActive(false)
  }, [expanded])

  const value = useMemo<AppContextValue | null>(() => {
    if (!state) return null
    return {
      state,
      update,
      updateSettings,
      showToast,
      toasts,
      dismissToast,
      clearToasts,
      toastsPaused,
      setToastsPaused,
      expanded,
      presenceHidden,
      viewport,
      setExpanded,
      pinned,
      setPinned,
      page,
      setPage,
      pendingNote,
      setPendingNote,
      openNote,
      plannerDate,
      setPlannerDate,
      openPlanner,
      settingsSection,
      setSettingsSection,
      openSettings,
      startTimer,
      pauseTimer,
      resetTimer,
      setTimerMode,
      addTask,
      toggleTask,
      deleteTask,
      patchTask,
      addGlass,
      undoGlass,
      setWaterGoal,
      setWaterReminder,
      vaultRevision,
      sessions,
      sessionsLoading,
      refreshSessions,
      glowTick,
      welcomeActive,
      repliedSessionId,
      agentSnapshot,
      questions,
      openCodePending,
      openCodeError,
      approvalBusy,
      decideAgent,
      decideAgentQuestion,
      releaseAgentQuestion,
      decideOpenCode,
      refreshOpenCode,
      demoConfig,
      demoPlatform,
      setDemoPlatform,
      updateState,
      checkForUpdates,
      downloadUpdate,
      installUpdate,
      openUpdateRelease,
      licenseState,
      licenseLocked,
      activateLicense,
      validateLicense,
      deactivateLicense
    }
  }, [
    state,
    update,
    updateSettings,
    showToast,
    toasts,
    dismissToast,
    clearToasts,
    toastsPaused,
    setToastsPaused,
    expanded,
    presenceHidden,
    viewport,
    setExpanded,
    pinned,
    setPinned,
    page,
    pendingNote,
    openNote,
    plannerDate,
    openPlanner,
    settingsSection,
    openSettings,
    startTimer,
    pauseTimer,
    resetTimer,
    setTimerMode,
    addTask,
    toggleTask,
    deleteTask,
    patchTask,
    addGlass,
    undoGlass,
    setWaterGoal,
    setWaterReminder,
    vaultRevision,
    sessions,
    sessionsLoading,
    refreshSessions,
    glowTick,
    welcomeActive,
    repliedSessionId,
    agentSnapshot,
    questions,
    openCodePending,
    openCodeError,
    approvalBusy,
    decideAgent,
    decideAgentQuestion,
    releaseAgentQuestion,
    decideOpenCode,
    refreshOpenCode,
    demoConfig,
    demoPlatform,
    setDemoPlatform,
    updateState,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    openUpdateRelease,
    licenseState,
    licenseLocked,
    activateLicense,
    validateLicense,
    deactivateLicense
  ])

  if (!value) {
    return <div className="boot" aria-hidden="true" />
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp must be used inside AppProvider')
  return value
}

/** Remaining seconds for the focus timer. Only ticks while running. */
export function useTimerClock(): { remaining: number; progress: number } {
  const { state } = useApp()
  const timer = state.timer
  const now = useNowWhen(timer.running && Boolean(timer.endsAt))
  const remaining =
    timer.running && timer.endsAt
      ? Math.max(0, Math.ceil((timer.endsAt - now) / 1000))
      : timer.remaining
  const total = timer.durations[timer.mode] * 60
  const progress = total <= 0 ? 0 : Math.max(0, Math.min(1, 1 - remaining / total))
  return { remaining, progress }
}

/** Remaining milliseconds for the water reminder. Ticks only when expanded and scheduled. */
export function useWaterReminderClock(): {
  active: boolean
  intervalMinutes: number
  remainingMs: number
  remindAt: number | null
} {
  const { state, expanded } = useApp()
  const intervalMinutes = state.water.reminderMinutes || 0
  const remindAt = intervalMinutes > 0 && state.water.remindAt ? state.water.remindAt : null
  const now = useNowWhen(expanded && intervalMinutes > 0 && remindAt !== null)
  const remainingMs = remindAt ? Math.max(0, remindAt - now) : 0
  return {
    active: intervalMinutes > 0 && remindAt !== null,
    intervalMinutes,
    remainingMs,
    remindAt
  }
}
