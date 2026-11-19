import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { promises as fs, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { normalizeSectionPrefs, sectionsEqual } from '../shared/sections'
import {
  POSTURE_DAYS_MAX,
  WATER_GLASS_ML,
  WATER_GOAL_MAX,
  WATER_GOAL_MIN,
  WATER_REMINDER_MAX,
  type AppState,
  type AppStatePatch,
  type PostureDay,
  type Settings,
  type Task,
  type WaterState
} from '../shared/types'

export const stateEvents = new EventEmitter()

const DEFAULT_SETTINGS: Settings = {
  accent: 'obsidian',
  vaultPath: null,
  hoverDelay: 140,
  openTrigger: 'hover',
  notchPosition: { x: 0.5, y: 0 },
  notchStyle: 'minimal',
  launchAtLogin: true,
  notifications: true,
  timerNotifications: true,
  agentStatus: true,
  agentStatusPort: 7432,
  codingReplySound: true,
  spotifyClientId: '',
  spotifyRedirectPort: 43821,
  userName: '',
  pinOnOpen: false,
  panelSize: 'full',
  focusMode: true,
  mediaSource: 'auto',
  autoHideFullscreen: true,
  browserOnly: false,
  notchDisplay: 'primary',
  pillOnOtherDisplays: true,
  neverOver: [],
  reduceMotion: false,
  autoCheckUpdates: true,
  welcomeSeen: false,
  plannerTimeZone: 'local'
}

function localDayKey(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function createDefaultState(): AppState {
  const today = localDayKey()

  return {
    settings: { ...DEFAULT_SETTINGS },
    timer: {
      mode: 'focus',
      durations: { focus: 25, short: 5, long: 45 },
      endsAt: null,
      remaining: 25 * 60,
      running: false,
      sessionsToday: 0,
      completedToday: 0,
      dayKey: today
    },
    tasks: [],
    notes: {
      lastPath: null,
      favorites: []
    },
    posture: {
      enabled: false,
      notifications: true,
      threshold: 65,
      baseline: null,
      profile: null,
      dayKey: today,
      goodSeconds: 0,
      badSeconds: 0,
      lastAlertAt: null,
      days: []
    },
    water: {
      enabled: false,
      goalGlasses: 8,
      glassMl: WATER_GLASS_ML,
      dayKey: today,
      pours: [],
      reminderMinutes: 0,
      remindAt: null
    },
    focusLog: [],
    spotifyMemory: null
  }
}

let current: AppState = createDefaultState()
let loaded = false
let saveTimeout: NodeJS.Timeout | null = null
let lastGoodJson: string | null = null

function stateFile(): string {
  if (!app.isPackaged && process.env.NOTCH_STATE_PATH) return process.env.NOTCH_STATE_PATH
  return path.join(app.getPath('userData'), 'notch-state.json')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function merge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) continue
    next[key] = merge((base as Record<string, unknown>)[key], value)
  }
  return next as T
}

function normalizeWater(state: AppState, today: string): WaterState {
  const water = state.water
  const goalGlasses = Math.min(
    WATER_GOAL_MAX,
    Math.max(WATER_GOAL_MIN, Math.round(Number(water?.goalGlasses) || 8))
  )
  const glassMl = Math.min(500, Math.max(100, Math.round(Number(water?.glassMl) || WATER_GLASS_ML)))
  const pours = Array.isArray(water?.pours)
    ? water.pours.filter((value) => typeof value === 'number' && Number.isFinite(value))
    : []
  const rawReminder = Math.round(Number(water?.reminderMinutes) || 0)
  const reminderMinutes =
    rawReminder > 0 ? Math.min(WATER_REMINDER_MAX, Math.max(1, rawReminder)) : 0
  const remindAt =
    reminderMinutes > 0
      ? typeof water?.remindAt === 'number' && Number.isFinite(water.remindAt)
        ? water.remindAt
        : Date.now() + reminderMinutes * 60 * 1000
      : null
  return {
    enabled: Boolean(water?.enabled),
    goalGlasses,
    glassMl,
    dayKey: today,
    pours: water?.dayKey === today ? pours : [],
    reminderMinutes,
    remindAt
  }
}

function sameWater(left: WaterState | undefined, right: WaterState): boolean {
  if (!left) return false
  if (
    left.enabled !== right.enabled ||
    left.goalGlasses !== right.goalGlasses ||
    left.glassMl !== right.glassMl ||
    left.dayKey !== right.dayKey ||
    left.pours.length !== right.pours.length ||
    (left.reminderMinutes || 0) !== (right.reminderMinutes || 0) ||
    (left.remindAt ?? null) !== (right.remindAt ?? null)
  ) {
    return false
  }
  return left.pours.every((value, index) => value === right.pours[index])
}

/**
 * File a finished posture day into the history before its totals are reset.
 * Runs on the main side for every way the day can turn (app start, a read after
 * midnight, a renderer write that zeroes the totals), so no day is lost however
 * it ends. A day already filed keeps the larger of the two readings.
 */
function archivePostureDay(prev: AppState, next: AppState): AppState {
  const before = prev.posture
  const after = next.posture
  if (!before || !after || !before.dayKey || before.dayKey >= after.dayKey) return next
  const goodSeconds = Math.max(0, Math.round(Number(before.goodSeconds) || 0))
  const badSeconds = Math.max(0, Math.round(Number(before.badSeconds) || 0))
  if (goodSeconds + badSeconds <= 0) return next
  const days: PostureDay[] = Array.isArray(after.days) ? [...after.days] : []
  const index = days.findIndex((day) => day.dayKey === before.dayKey)
  if (index >= 0) {
    days[index] = {
      dayKey: before.dayKey,
      goodSeconds: Math.max(days[index].goodSeconds, goodSeconds),
      badSeconds: Math.max(days[index].badSeconds, badSeconds)
    }
  } else {
    days.push({ dayKey: before.dayKey, goodSeconds, badSeconds })
  }
  days.sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0))
  return { ...next, posture: { ...after, days: days.slice(-POSTURE_DAYS_MAX) } }
}

function normalizeDay(state: AppState): AppState {
  const today = localDayKey()
  const baseSettings = isPlainObject(state.settings) ? state.settings : { ...DEFAULT_SETTINGS }
  let settings =
    baseSettings.timerNotifications === undefined
      ? { ...baseSettings, timerNotifications: true }
      : baseSettings
  const sections = normalizeSectionPrefs(settings.sections, Boolean(state.water?.enabled))
  if (typeof settings.browserOnly !== 'boolean') settings = { ...settings, browserOnly: false }
  if (typeof settings.agentStatus !== 'boolean') settings = { ...settings, agentStatus: true }
  const port = Number(settings.agentStatusPort)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    settings = { ...settings, agentStatusPort: 7432 }
  }
  if (settings.openCodeApprovalPort !== undefined) {
    const ocPort = Number(settings.openCodeApprovalPort)
    if (!Number.isInteger(ocPort) || ocPort < 0 || ocPort > 65535) {
      settings = { ...settings, openCodeApprovalPort: 0 }
    }
  }
  if (typeof settings.codingReplySound !== 'boolean')
    settings = { ...settings, codingReplySound: true }
  if (typeof settings.autoCheckUpdates !== 'boolean')
    settings = { ...settings, autoCheckUpdates: true }
  if (typeof settings.welcomeSeen !== 'boolean')
    settings = { ...settings, welcomeSeen: false }
  if (typeof settings.plannerTimeZone !== 'string' || !settings.plannerTimeZone.trim())
    settings = { ...settings, plannerTimeZone: 'local' }
  if (!sectionsEqual(settings.sections, sections)) settings = { ...settings, sections }
  const defaults = createDefaultState()
  const tasks = Array.isArray(state.tasks) ? state.tasks : []
  const focusLog = Array.isArray(state.focusLog) ? state.focusLog : []
  const notes = isPlainObject(state.notes)
    ? {
        lastPath: typeof state.notes.lastPath === 'string' ? state.notes.lastPath : null,
        favorites: Array.isArray(state.notes.favorites) ? state.notes.favorites : []
      }
    : defaults.notes
  const timer = isPlainObject(state.timer) ? state.timer : defaults.timer
  const water = normalizeWater(state, today)
  if (
    timer === state.timer &&
    tasks === state.tasks &&
    focusLog === state.focusLog &&
    notes.lastPath === state.notes?.lastPath &&
    notes.favorites === state.notes?.favorites &&
    timer.dayKey === today &&
    state.posture?.dayKey === today &&
    settings === state.settings &&
    sameWater(state.water, water)
  ) {
    return state
  }
  return {
    ...state,
    settings,
    tasks,
    focusLog,
    notes,
    timer: {
      ...timer,
      dayKey: today,
      sessionsToday: timer.dayKey === today ? timer.sessionsToday : 0,
      completedToday: timer.dayKey === today ? timer.completedToday : 0
    },
    posture: isPlainObject(state.posture)
      ? {
          ...state.posture,
          dayKey: today,
          goodSeconds: state.posture.dayKey === today ? state.posture.goodSeconds : 0,
          badSeconds: state.posture.dayKey === today ? state.posture.badSeconds : 0
        }
      : defaults.posture,
    water: sameWater(state.water, water) && state.water ? state.water : water
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
    const raw = merge(createDefaultState(), await readJson(file))
    current = archivePostureDay(raw, normalizeDay(raw))
  } catch {
    try {
      // A malformed primary file should not erase the user's state when a
      // recent backup is available.
      const raw = merge(createDefaultState(), await readJson(`${file}.bak`))
      current = archivePostureDay(raw, normalizeDay(raw))
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
    current = archivePostureDay(current, normalized)
    queueSave()
  }
  return current
}

export function setState(patch: AppStatePatch): AppState {
  current = archivePostureDay(current, normalizeDay(merge(current, patch)))
  queueSave()
  stateEvents.emit('change', getState())
  return current
}

export function replaceState(next: AppState): AppState {
  current = normalizeDay(merge(createDefaultState(), next))
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
  if (!loaded) return
  if (saveTimeout) {
    clearTimeout(saveTimeout)
    saveTimeout = null
  }
  revision += 1
  try {
    const file = stateFile()
    const snapshot = JSON.stringify(current, null, 2)
    mkdirSync(path.dirname(file), { recursive: true })
    if (lastGoodJson) {
      writeFileSync(`${file}.bak`, lastGoodJson, 'utf8')
    }
    const temp = `${file}.${process.pid}.flush.tmp`
    writeFileSync(temp, snapshot, 'utf8')
    try {
      renameSync(temp, file)
    } catch {
      writeFileSync(file, snapshot, 'utf8')
      try {
        unlinkSync(temp)
      } catch {
        // Ignore cleanup failure during shutdown.
      }
    }
    lastGoodJson = snapshot
  } catch {
    // A last-moment disk failure should not stop the app from quitting.
  }
}

export { localDayKey }
