import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AppState, AppStatePatch, Settings, Task } from '../shared/types'

export const stateEvents = new EventEmitter()

const DEFAULT_SETTINGS: Settings = {
  accent: 'coral',
  vaultPath: null,
  hoverDelay: 140,
  notchPosition: { x: 0.5, y: 0 },
  notchStyle: 'minimal',
  launchAtLogin: false,
  notifications: true,
  spotifyClientId: '',
  spotifyRedirectPort: 43821,
  userName: '',
  pinOnOpen: false
}

function localDayKey(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function id(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function createDefaultState(): AppState {
  const today = localDayKey()
  const now = Date.now()
  const starterTasks: Task[] = [
    {
      id: id(),
      title: 'Connect your Obsidian vault',
      date: today,
      done: false,
      createdAt: now,
      priority: 'high'
    },
    {
      id: id(),
      title: 'Add a reminder to your day',
      date: today,
      done: false,
      createdAt: now,
      priority: 'normal'
    }
  ]

  return {
    settings: { ...DEFAULT_SETTINGS },
    timer: {
      mode: 'focus',
      durations: { focus: 25, short: 5, long: 15 },
      endsAt: null,
      remaining: 25 * 60,
      running: false,
      sessionsToday: 0,
      completedToday: 0,
      dayKey: today
    },
    tasks: starterTasks,
    notes: {
      lastPath: null,
      favorites: []
    },
    posture: {
      enabled: false,
      notifications: true,
      threshold: 65,
      baseline: null,
      dayKey: today,
      goodSeconds: 0,
      badSeconds: 0,
      lastAlertAt: null
    },
    focusLog: []
  }
}

let current: AppState = createDefaultState()
let loaded = false
let saveTimeout: NodeJS.Timeout | null = null
let lastGoodJson: string | null = null

function stateFile(): string {
  if (process.env.NOTCH_STATE_PATH) return process.env.NOTCH_STATE_PATH
  return path.join(app.getPath('userData'), 'notch-state.json')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function merge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    next[key] = merge((base as Record<string, unknown>)[key], value)
  }
  return next as T
}

function normalizeDay(state: AppState): AppState {
  const today = localDayKey()
  if (state.timer.dayKey === today && state.posture?.dayKey === today) return state
  return {
    ...state,
    timer: {
      ...state.timer,
      dayKey: today,
      sessionsToday: state.timer.dayKey === today ? state.timer.sessionsToday : 0,
      completedToday: state.timer.dayKey === today ? state.timer.completedToday : 0
    },
    posture: state.posture
      ? {
          ...state.posture,
          dayKey: today,
          goodSeconds: state.posture.dayKey === today ? state.posture.goodSeconds : 0,
          badSeconds: state.posture.dayKey === today ? state.posture.badSeconds : 0
        }
      : state.posture
  }
}

export async function initState(): Promise<AppState> {
  if (loaded) return current
  const file = stateFile()
  const readJson = async (target: string): Promise<Partial<AppState>> => {
    const raw = await fs.readFile(target, 'utf8')
    return JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<AppState>
  }
  try {
    current = normalizeDay(merge(createDefaultState(), await readJson(file)))
  } catch {
    try {
      // A malformed primary file should not erase the user's state when a
      // recent backup is available.
      current = normalizeDay(merge(createDefaultState(), await readJson(`${file}.bak`)))
    } catch {
      current = normalizeDay(createDefaultState())
    }
    // Keep the unreadable file for manual recovery instead of silently
    // overwriting it with defaults.
    await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => undefined)
  }
  lastGoodJson = JSON.stringify(current, null, 2)
  loaded = true
  await persistNow()
  return current
}

export function getState(): AppState {
  const normalized = normalizeDay(current)
  if (normalized !== current) {
    current = normalized
    queueSave()
  }
  return current
}

export function setState(patch: AppStatePatch): AppState {
  current = normalizeDay(merge(current, patch))
  queueSave()
  stateEvents.emit('change', getState())
  return current
}

export function updateTask(taskId: string, patch: Partial<Task>): AppState {
  return setState({
    tasks: current.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task))
  })
}

function queueSave(): void {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => {
    saveTimeout = null
    void persistNow()
  }, 90)
}

let writeChain: Promise<void> = Promise.resolve()
let revision = 0

export function persistNow(): Promise<void> {
  const snapshot = JSON.stringify(current, null, 2)
  const writeRevision = ++revision
  writeChain = writeChain.catch(() => undefined).then(async () => {
    if (writeRevision !== revision) return
    const file = stateFile()
    await fs.mkdir(path.dirname(file), { recursive: true })
    // Rotate the last successfully parsed snapshot rather than copying the
    // current file, which may itself have been corrupted by an external write.
    if (lastGoodJson) {
      await fs.writeFile(`${file}.bak`, lastGoodJson, 'utf8')
    }
    const temp = `${file}.tmp`
    await fs.writeFile(temp, snapshot, 'utf8')
    if (writeRevision !== revision) {
      await fs.unlink(temp).catch(() => undefined)
      return
    }
    await fs.rename(temp, file).catch(async () => {
      await fs.writeFile(file, snapshot, 'utf8')
      await fs.unlink(temp).catch(() => undefined)
    })
    lastGoodJson = snapshot
  })
  return writeChain
}

export function flushState(): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout)
    saveTimeout = null
  }
  revision += 1
  try {
    const file = stateFile()
    mkdirSync(path.dirname(file), { recursive: true })
    if (lastGoodJson) {
      writeFileSync(`${file}.bak`, lastGoodJson, 'utf8')
    }
    writeFileSync(file, JSON.stringify(current, null, 2), 'utf8')
    lastGoodJson = JSON.stringify(current, null, 2)
  } catch {
    // A last-moment disk failure should not stop the app from quitting.
  }
}

export { localDayKey }
