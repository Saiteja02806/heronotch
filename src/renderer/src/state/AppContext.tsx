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
  AppState,
  AppStatePatch,
  SessionsSnapshot,
  Settings,
  Task,
  TimerMode
} from '../../../shared/types'
import { todayKey, uid } from '../lib/time'

export type Page = 'home' | 'notes' | 'music' | 'planner' | 'sessions' | 'posture' | 'settings'
export type SettingsSection = 'appearance' | 'notch' | 'obsidian' | 'spotify' | 'about'

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
  now: number
  timerRemaining: number
  timerProgress: number
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
  vaultRevision: number
  sessions: SessionsSnapshot | null
  sessionsLoading: boolean
  refreshSessions: () => Promise<void>
}

const AppContext = createContext<AppContextValue | null>(null)

function mergeLocal(prev: AppState, patch: AppStatePatch): AppState {
  return {
    ...prev,
    ...patch,
    settings: patch.settings ? { ...prev.settings, ...patch.settings } : prev.settings,
    timer: patch.timer ? { ...prev.timer, ...patch.timer } : prev.timer,
    notes: patch.notes ? { ...prev.notes, ...patch.notes } : prev.notes,
    posture: patch.posture ? { ...prev.posture, ...patch.posture } : prev.posture
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null)
  const [expanded, setExpandedState] = useState(false)
  const [backdrop, setBackdrop] = useState<string | null>(null)
  const [pinned, setPinnedState] = useState(false)
  const [page, setPage] = useState<Page>('home')
  const [pendingNote, setPendingNote] = useState<string | null>(null)
  const [plannerDate, setPlannerDate] = useState<string>(todayKey())
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance')
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [now, setNow] = useState(Date.now())
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
      setToasts((current) => [
        ...current,
        {
          id: uid(),
          title: `Reminder · ${event.title}`,
          message: event.time ? `${event.date} at ${event.time}` : event.date,
          tone: 'default'
        }
      ])
    })
    const offVault = window.notch.onVaultChanged(() => setVaultRevision((value) => value + 1))
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
    }
  }, [])

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 500)
    const onFocus = (): void => setNow(Date.now())
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    if (!state) return
    const day = todayKey()
    if (state.timer.dayKey !== day) {
      void window.notch.getState().then(setState)
    }
  }, [state?.timer.dayKey, state])

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
    return window.notch.sessions.onSendResult((result) => {
      if (result.ok) {
        showToast(
          `${result.label} finished the message`,
          'The agent completed this turn. Open its app to see the full response.',
          'success'
        )
      } else {
        showToast(
          'Agent message failed',
          `${result.label}: ${result.error || 'The agent command exited with an error.'}`,
          'error'
        )
      }
    })
  }, [showToast])

  const setExpanded = useCallback((value: boolean) => {
    if (!value) {
      setExpandedState(false)
      setBackdrop(null)
    }
    void window.notch.setExpanded(value)
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

  const timer = state?.timer
  const timerRemaining = useMemo(() => {
    if (!timer) return 0
    if (timer.running && timer.endsAt) return Math.max(0, Math.ceil((timer.endsAt - now) / 1000))
    return timer.remaining
  }, [timer, now])

  const timerProgress = useMemo(() => {
    if (!timer) return 0
    const total = timer.durations[timer.mode] * 60
    if (total <= 0) return 0
    return Math.max(0, Math.min(1, 1 - timerRemaining / total))
  }, [timer, timerRemaining])

  const startTimer = useCallback(() => {
    if (!state) return
    const current = state.timer
    const remaining = current.running
      ? timerRemaining
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
  }, [state, timerRemaining, update])

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
    if (!state) return
    const current = state.timer
    if (!current.running || !current.endsAt) return
    if (Date.now() < current.endsAt) return
    if (timerGuard.current === current.endsAt) return
    timerGuard.current = current.endsAt

    const minutes = current.durations[current.mode]
    const completed = current.mode === 'focus'
    const label = current.mode === 'focus' ? 'Focus session complete' : 'Break is over'
    window.notch.notify(label, completed ? `${minutes} minutes of focus logged.` : 'Ready for another round?')
    showToast(label, completed ? `${minutes} focused minutes logged.` : 'Time to stretch.', 'success')
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
  }, [now, state, update, showToast])

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
    now,
    timerRemaining,
    timerProgress,
    startTimer,
    pauseTimer,
    resetTimer,
    setTimerMode,
    addTask,
    toggleTask,
    deleteTask,
    patchTask,
    vaultRevision,
    sessions,
    sessionsLoading,
    refreshSessions
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp must be used inside AppProvider')
  return value
}
