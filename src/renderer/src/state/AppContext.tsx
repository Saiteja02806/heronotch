import { subscribeClock, useNow } from './clock'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type {
  AppState,
  AppStatePatch,
  SessionsSnapshot,
  Settings,
  Task,
  TimerMode,
  WaterState
} from '../../../shared/types'
import { formatDateShort, formatTime, timeToTimestamp, todayKey, uid } from '../lib/time'
import { clampWaterGoal, waterToday } from '../lib/water'
import { playPostureRing as playChime } from '../lib/alertSound'

export type Page = 'home' | 'notes' | 'music' | 'planner' | 'sessions' | 'posture' | 'water' | 'settings'
export type SettingsSection = 'appearance' | 'notch' | 'sections' | 'obsidian' | 'spotify' | 'about'

export interface ToastItem {
  id: string
  title: string
  message?: string
  tone: 'default' | 'success' | 'error'
}

interface AppContextValue {
  state: AppState
  update: (patch: AppStatePatch) => void
  updateSettings: (patch: Partial<Settings>) => void
  showToast: (title: string, message?: string, tone?: ToastItem['tone']) => void
  toasts: ToastItem[]
  dismissToast: (id: string) => void
  expanded: boolean
  backdrop: string | null
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
    notes?: string
    priority?: Task['priority']
    remindAt?: number | null
  }) => void
  toggleTask: (id: string) => void
  deleteTask: (id: string) => void
  patchTask: (id: string, patch: Partial<Task>) => void
  addGlass: () => void
  undoGlass: () => void
  setWaterGoal: (glasses: number) => void
  vaultRevision: number
  sessions: SessionsSnapshot | null
  sessionsLoading: boolean
  refreshSessions: () => Promise<void>
  glowTick: number
  repliedSessionId: string | null
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

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null)
  const [expanded, setExpandedState] = useState(false)
  const [backdrop, setBackdrop] = useState<string | null>(null)
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight })
  const viewportHold = useRef(0)
  const [pinned, setPinnedState] = useState(false)
  const [page, setPage] = useState<Page>('home')
  const [pendingNote, setPendingNote] = useState<string | null>(null)
  const [plannerDate, setPlannerDate] = useState<string>(todayKey())
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance')
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [glowTick, setGlowTick] = useState(0)
  const [repliedSessionId, setRepliedSessionId] = useState<string | null>(null)
  const notificationsOn = useRef(true)
  notificationsOn.current = !state || state.settings.notifications !== false
  const [vaultRevision, setVaultRevision] = useState(0)
  const [sessions, setSessions] = useState<SessionsSnapshot | null>(null)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const writeSeq = useRef(0)
  const timerGuard = useRef<number | null>(null)

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
      if (!event.expanded) {
        setBackdrop(null)
      } else {
        void window.notch.getBackdrop().then((image) => {
          if (alive && image) setBackdrop(image)
        })
      }
    })
    void window.notch.getExpanded().then((value) => {
      if (alive && !receivedExpandedEvent) setExpandedState(value)
    })
    void window.notch.getBackdrop().then((image) => {
      if (alive) setBackdrop(image)
    })
    const offBackdrop = window.notch.onBackdrop((event) => setBackdrop(event.image))
    const offState = window.notch.onStateUpdated((next) => setState(next))
    const offReminder = window.notch.onReminder((event) => {
      if (!notificationsOn.current) return
      const day = event.date === todayKey() ? 'Today' : formatDateShort(event.date)
      const at = timeToTimestamp(event.date, event.time)
      const id = uid()
      setGlowTick((value) => value + 1)
      setToasts((current) => [
        ...current,
        {
          id,
          title: `Reminder · ${event.title}`,
          message: at ? `${day} at ${formatTime(at)}` : day,
          tone: 'default'
        }
      ])
      // Reminders arrive while you are in another app, so the notice lingers
      // longer than a normal toast before folding away.
      setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id))
      }, 12000)
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
      setPage(target as Page)
      setExpandedState(true)
    })

    return () => {
      alive = false
      offExpanded()
      offBackdrop()
      offState()
      offReminder()
      offVault()
      offNavigate()
      window.removeEventListener('resize', onResize)
    }
  }, [])

  useEffect(() => {
    return subscribeClock(() => {
      if (!state) return
      const day = todayKey()
      const stale =
        state.timer.dayKey !== day ||
        state.posture.dayKey !== day ||
        state.water.dayKey !== day
      if (!stale) return
      const seq = writeSeq.current
      void window.notch.getState().then((remote) => {
        if (writeSeq.current !== seq) return
        setState(remote)
      })
    })
  }, [state])

  const refreshSessions = useCallback(async () => {
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

  useEffect(() => {
    void refreshSessions()
    const interval = setInterval(() => void refreshSessions(), 15_000)
    return () => clearInterval(interval)
  }, [refreshSessions])

  const update = useCallback((patch: AppStatePatch) => {
    setState((prev) => (prev ? mergeLocal(prev, patch) : prev))
    const seq = ++writeSeq.current
    void window.notch
      .setState(patch)
      .then((remote) => {
        if (writeSeq.current === seq) setState(remote)
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

  const showToast = useCallback(
    (title: string, message?: string, tone: ToastItem['tone'] = 'default') => {
      const id = uid()
      setGlowTick((value) => value + 1)
      setToasts((current) => [...current.slice(-2), { id, title, message, tone }])
      setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id))
      }, 4200)
    },
    []
  )

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  useEffect(() => {
    return window.notch.sessions.onReply((event) => {
      showToast(`${event.label} replied: ${event.title}`)
      setRepliedSessionId(event.sessionId)
      window.setTimeout(() => {
        setRepliedSessionId((current) => (current === event.sessionId ? null : current))
      }, 22000)
    })
  }, [showToast])

  useEffect(() => {
    return window.notch.sessions.onSendResult((result) => {
      if (result.status === 'delivered') {
        showToast(`Delivered to ${result.label}`, 'The message is in that session.', 'success')
        return
      }
      if (result.status === 'unconfirmed') {
        showToast(
          `${result.label} did not confirm delivery`,
          result.error || 'The command finished, but the message was not found in that session.',
          'default'
        )
        return
      }
      showToast(
        `${result.label} did not deliver`,
        result.error || 'The agent command failed.',
        'error'
      )
    })
  }, [showToast])

  const setExpanded = useCallback((value: boolean) => {
    if (!value) {
      // The shell plays the shrink, then tells the main process to drop the
      // click shape back to the tab. Clearing expanded here would hide the
      // panel before it can move.
      window.dispatchEvent(new Event('notch-request-close'))
      return
    }
    performance.mark('notch-open-request')
    void window.notch.setExpanded(true)
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
    if (!state?.timer.running || !state.timer.endsAt) return
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
        window.notch.notify(
          label,
          completed ? `${minutes} minutes of focus logged.` : 'Ready for another round?',
          true
        )
        showToast(label, completed ? `${minutes} focused minutes logged.` : 'Time to stretch.', 'success')
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
  }, [state, update, showToast])

  const addTask = useCallback<AppContextValue['addTask']>(
    (input) => {
      if (!state) return
      const task: Task = {
        id: uid(),
        title: input.title.trim(),
        date: input.date,
        time: input.time || undefined,
        notes: input.notes?.trim() || undefined,
        priority: input.priority || 'normal',
        remindAt: input.remindAt ?? null,
        notifiedAt: null,
        done: false,
        createdAt: Date.now()
      }
      if (!task.title) return
      update({ tasks: [...state.tasks, task] })
    },
    [state, update]
  )

  const toggleTask = useCallback(
    (id: string) => {
      if (!state) return
      update({
        tasks: state.tasks.map((task) =>
          task.id === id
            ? { ...task, done: !task.done, completedAt: !task.done ? Date.now() : undefined }
            : task
        )
      })
    },
    [state, update]
  )

  const deleteTask = useCallback(
    (id: string) => {
      if (!state) return
      update({ tasks: state.tasks.filter((task) => task.id !== id) })
    },
    [state, update]
  )

  const patchTask = useCallback(
    (id: string, patch: Partial<Task>) => {
      if (!state) return
      update({
        tasks: state.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task))
      })
    },
    [state, update]
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
    commitWater((current) => ({ ...current, pours: [...current.pours, Date.now()] }))
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

  if (!state) {
    return <div className="boot" aria-hidden="true" />
  }

  const value: AppContextValue = {
    state,
    update,
    updateSettings,
    showToast,
    toasts,
    dismissToast,
    expanded,
    backdrop,
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
    vaultRevision,
    sessions,
    sessionsLoading,
    refreshSessions,
    glowTick,
    repliedSessionId
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp must be used inside AppProvider')
  return value
}

/** Remaining seconds for the focus timer. Only this hook re-renders each second. */
export function useTimerClock(): { remaining: number; progress: number } {
  const { state } = useApp()
  const now = useNow()
  const timer = state.timer
  const remaining =
    timer.running && timer.endsAt
      ? Math.max(0, Math.ceil((timer.endsAt - now) / 1000))
      : timer.remaining
  const total = timer.durations[timer.mode] * 60
  const progress = total <= 0 ? 0 : Math.max(0, Math.min(1, 1 - remaining / total))
  return { remaining, progress }
}
