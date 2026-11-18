import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { clipboard, shell } from 'electron'
import { scanEditorSessions } from './sessionScanners'
import { MAX_QUEUED_PER_SESSION, SendQueue } from './sendQueue'
import type {
  AppPresence,
  CodingSession,
  SessionProvider,
  SessionSendResult,
  SessionsSnapshot
} from '../shared/types'
import {
  AGENT_ERROR_PREFIX,
  captureDeliveryMark,
  confirmDeliveredMessage,
  sessionPresence,
  type DeliveryMark
} from './sessionDelivery'
import { sendCodexDesktopMessage } from './agentStatus'
import {
  antiGravityEnv,
  describeAgentFailure,
  sessionGone,
  findAntiGravityTarget,
  jsonFailure,
  transportFailure
} from './antiGravityAgent'
import {
  armReplyWatch,
  discardReplyWatch,
  noteReplyCliExited,
  prepareReplyWatch,
  stopAllReplyWatches
} from './sessionWatch'
import {
  ACTIVE_RECENCY_MS,
  analyzeClaudeTail,
  clearClosedDesktopActivity,
  isAntigravitySessionActive,
  isClaudeSessionActive,
  isCodexSessionActive,
  isDeepAiSessionActive,
  isOpenCodeSessionActive,
  parseCodexRolloutTail,
  prioritizeAndCapSessions,
  type TurnSignal
} from './sessionActivity'

const PROVIDER_LABELS: Record<SessionProvider, string> = {
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Anti Gravity',
  claude: 'Claude',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  zed: 'Zed',
  vscode: 'VS Code',
  jetbrains: 'JetBrains',
  deepai: 'DeepAI Code',
  trae: 'Trae',
  qoder: 'Qoder',
  kiro: 'Kiro',
  gemini: 'Gemini',
  copilot: 'Copilot',
  aider: 'Aider',
  cline: 'Cline',
  grok: 'Grok Bot',
  other: 'Other tools'
}

const CORE_PROVIDERS: SessionProvider[] = ['deepai', 'codex', 'opencode', 'antigravity', 'claude', 'grok']

let lastDirectories = new Set<string>()
let lastSessions = new Map<string, CodingSession>()
const runningSends = new Map<string, ChildProcess>()
/** Messages held back while their session is mid-turn. */
const outbox = new SendQueue()
const outboxMissCounts = new Map<string, number>()
let codexTurnCache: { file: string; mtimeMs: number; size: number; idsKey: string; statuses: Map<string, string> } | null = null
const draining = new Set<string>()
export const sessionSendEvents = new EventEmitter()
export { sessionReplyEvents } from './sessionWatch'

interface ProcessInfo {
  Id: number
  Name: string
  Title: string | null
  Path: string | null
}

function normalizeTimestamp(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'string') {
    const parsed = Date.parse(value.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'))
    return Number.isFinite(parsed) ? parsed : 0
  }
  return value > 10_000_000_000 ? value : value * 1000
}

function cleanTitle(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback
  let text = raw
    .replace(/^#+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*`>]/g, '')
    // `_` only counts as markdown emphasis at the edge of a word; inside a name
    // like cloud_agent it is part of the name.
    .replace(/(^|\s)_+(?=\S)|(?<=\S)_+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return fallback
  if (text.length > 96) text = `${text.slice(0, 93).trimEnd()}…`
  return text
}

/** Claude Code stores prompts with wrapper tags the user never typed
 * (<pasted_content>, <system-reminder>, <command-name>, <ide_opened_file>).
 * Drop the machinery blocks and unwrap the rest, so a title reads like text. */
function stripAgentMarkup(text: string): string {
  return text
    .replace(
      /<(system-reminder|ide_[a-z_]+|local-command-[a-z]+|command-(?:name|message|args))\b[^>]*>[\s\S]*?<\/\1>/gi,
      ' '
    )
    .replace(/<\/?[a-z][a-z0-9_-]*(?:\s[^<>]*)?>/gi, ' ')
}

function baseName(directory: string | null): string | null {
  if (!directory) return null
  const cleaned = directory.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '')
  const parts = cleaned.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || cleaned || null
}

function providerForProcess(name: string): SessionProvider | null {
  const normalizedName = (name || '').toLowerCase()
  if (normalizedName.startsWith('codex') || normalizedName === 'chatgpt.exe') return 'codex'
  if (normalizedName.includes('opencode')) return 'opencode'
  if (normalizedName.includes('antigravity')) return 'antigravity'
  if (normalizedName === 'claude.exe' || normalizedName === 'claude') return 'claude'
  if (normalizedName === 'cursor.exe') return 'cursor'
  if (normalizedName.includes('windsurf')) return 'windsurf'
  if (normalizedName === 'zed.exe') return 'zed'
  if (normalizedName.startsWith('code')) return 'vscode'
  if (
    /^(idea64|idea|pycharm64|pycharm|webstorm64|webstorm|goland64|goland|phpstorm64|phpstorm|clion64|clion|rider64|rider|datagrip64|datagrip|jetbrainsclient)/.test(normalizedName) ||
    normalizedName.includes('jetbrains')
  ) {
    return 'jetbrains'
  }
  if (normalizedName.includes('deepai')) return 'deepai'
  if (normalizedName.includes('trae')) return 'trae'
  if (normalizedName.includes('qoder')) return 'qoder'
  if (normalizedName.includes('kiro')) return 'kiro'
  if (normalizedName.startsWith('gemini')) return 'gemini'
  if (normalizedName === 'copilot.exe') return 'copilot'
  if (normalizedName.includes('aider')) return 'aider'
  if (normalizedName.includes('cline')) return 'cline'
  if (normalizedName.includes('grok')) return 'grok'
  return null
}

/** Generic hosts (Electron apps, JVM launchers) hide behind ordinary exe
 * names; their window titles are the only tell. Match known coding-tool
 * keywords so every popular AI IDE surfaces as its own card. */
function providerForTitle(title: string): SessionProvider | null {
  const normalized = (title || '').toLowerCase()
  if (!normalized || /^n\/a$/.test(normalized)) return null
  if (normalized.includes('chatgpt')) return 'codex'
  if (normalized === 'claude' || normalized.startsWith('claude ')) return 'claude'
  if (normalized.includes('opencode')) return 'opencode'
  if (normalized.includes('cursor')) return 'cursor'
  if (normalized.includes('windsurf')) return 'windsurf'
  if (/\bzed\b/.test(normalized)) return 'zed'
  if (normalized.includes('visual studio code')) return 'vscode'
  if (
    normalized.includes('intellij') ||
    normalized.includes('pycharm') ||
    normalized.includes('webstorm') ||
    normalized.includes('goland') ||
    normalized.includes('phpstorm') ||
    normalized.includes('clion') ||
    normalized.includes('rider') ||
    normalized.includes('datagrip') ||
    normalized.includes('jetbrains')
  ) {
    return 'jetbrains'
  }
  if (normalized.includes('deepai')) return 'deepai'
  if (normalized.includes('grok')) return 'grok'
  if (normalized.includes('trae')) return 'trae'
  if (normalized.includes('qoder')) return 'qoder'
  if (normalized.includes('kiro')) return 'kiro'
  if (normalized.includes('gemini')) return 'gemini'
  if (normalized.includes('copilot')) return 'copilot'
  if (normalized.includes('aider')) return 'aider'
  if (normalized.includes('cline')) return 'cline'
  return null
}

/**
 * Each probe starts a PowerShell, enumerates every process and parses the
 * output, which costs roughly 0.3s of CPU and a few dozen MB of transient
 * memory. Presence changes on the scale of minutes, so a scan that arrives
 * inside the cache window reuses the last probe instead of paying that again.
 */
const PROCESS_CACHE_MS = 20_000
let processCache: { at: number; list: ProcessInfo[] } | null = null
let processInFlight: Promise<ProcessInfo[]> | null = null

function scanProcesses(): Promise<ProcessInfo[]> {
  if (processCache && Date.now() - processCache.at < PROCESS_CACHE_MS) {
    return Promise.resolve(processCache.list)
  }
  if (processInFlight) return processInFlight
  processInFlight = probeProcesses()
    .then((list) => {
      // A probe that failed must not be cached: an empty window list would
      // report every tool as closed for the whole window.
      if (list) processCache = { at: Date.now(), list }
      return list ?? []
    })
    .finally(() => {
      processInFlight = null
    })
  return processInFlight
}

function probeProcesses(): Promise<ProcessInfo[] | null> {
  return new Promise((resolve) => {
    // `tasklist /V` can take a minute or more on some machines; Get-Process
    // returns in well under a second and exposes the main window title, which
    // is what tells an actually-open tool apart from its leftover daemons.
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-Process | ForEach-Object { \"{0}`t{1}`t{2}\" -f $_.Id, $_.ProcessName, $_.MainWindowTitle }"
      ],
      { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null)
          return
        }
        const processes: ProcessInfo[] = []
        for (const row of stdout.split(/\r?\n/)) {
          const parts = row.split('\t')
          if (parts.length < 3) continue
          const pid = Number(parts[0])
          if (!Number.isFinite(pid)) continue
          const name = `${parts[1].trim()}.exe`
          const title = parts.slice(2).join(' ').trim()
          const provider = providerForProcess(name) ?? providerForTitle(title)
          if (!provider) continue
          const hasWindow = Boolean(title) && !HIDDEN_WINDOW_TITLE.test(title)
          processes.push({ Id: pid, Name: name, Title: hasWindow ? title : null, Path: null })
        }
        resolve(processes)
      }
    )
  })
}

/** Tasklist /V also reports invisible helper windows (COM pumps, .NET
 * broadcast sinks). They must not make an idle daemon look open. */
const HIDDEN_WINDOW_TITLE =
  /^(n\/a|olemainthreadwndname|olechannelwnd|uxdservice|gdi\+ window|\.net-broadcasteventwindow|dwm notification window|progman|default ime|msctfime ui|task host window|windows input experience|broadcastlistenerwindow|crossdeviceresumewindow)/i

async function latestFile(directory: string, pattern: RegExp): Promise<string | null> {
  try {
    const files = await fs.readdir(directory)
    const matches = files
      .map((file) => {
        const match = file.match(pattern)
        return match ? { file, version: Number(match[1] || 0) } : null
      })
      .filter((item): item is { file: string; version: number } => Boolean(item))
      .sort((a, b) => b.version - a.version)
    return matches[0] ? path.join(directory, matches[0].file) : null
  } catch {
    return null
  }
}

let codexNamesCache: { file: string; mtimeMs: number; size: number; names: Map<string, string> } | null = null

async function readCodexSessionNames(): Promise<Map<string, string>> {
  const file = path.join(os.homedir(), '.codex', 'session_index.jsonl')
  try {
    const stat = await fs.stat(file)
    if (
      codexNamesCache &&
      codexNamesCache.file === file &&
      codexNamesCache.mtimeMs === stat.mtimeMs &&
      codexNamesCache.size === stat.size
    ) {
      return codexNamesCache.names
    }
    const names = new Map<string, string>()
    const raw = await fs.readFile(file, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as { id: string; thread_name?: string }
        if (entry.id && entry.thread_name) names.set(entry.id, entry.thread_name)
      } catch {
        // Ignore malformed index lines.
      }
    }
    codexNamesCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, names }
    return names
  } catch {
    // Older Codex installs may not have the index.
    return new Map<string, string>()
  }
}

async function readCodexTurnStatuses(threadIds: string[]): Promise<Map<string, string>> {
  const statuses = new Map<string, string>()
  if (threadIds.length === 0) return statuses
  const historyFile = await latestFile(path.join(os.homedir(), '.codex'), /^thread_history_(\d+)\.sqlite$/)
  if (!historyFile) return statuses
  const idsKey = threadIds.join(',')
  const stat = await fs.stat(historyFile).catch(() => null)
  if (
    stat &&
    codexTurnCache &&
    codexTurnCache.file === historyFile &&
    codexTurnCache.mtimeMs === stat.mtimeMs &&
    codexTurnCache.size === stat.size &&
    codexTurnCache.idsKey === idsKey
  ) {
    return codexTurnCache.statuses
  }
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(historyFile, { readOnly: true })
    let stmt
    try {
      // `idx_thread_turns_page(thread_id, rollout_ordinal)` turns a 3+ GB table scan into O(log N) seeks.
      stmt = db.prepare('select status from thread_turns where thread_id = ? order by rollout_ordinal desc limit 1')
    } catch {
      stmt = db.prepare('select status from thread_turns where thread_id = ? order by rowid desc limit 1')
    }
    for (const threadId of threadIds) {
      const row = stmt.get(threadId) as { status?: string } | undefined
      if (row?.status) statuses.set(threadId, row.status)
    }
    if (stat) {
      codexTurnCache = { file: historyFile, mtimeMs: stat.mtimeMs, size: stat.size, idsKey, statuses }
    }
  } catch {
    // Missing or locked history database.
  } finally {
    try {
      db?.close()
    } catch {
      // Already closed.
    }
  }
  return statuses
}

async function readCodexRolloutState(
  rolloutPath: string
): Promise<{ signal: TurnSignal; ageMs: number | null }> {
  const cleaned = String(rolloutPath).replace(/^\\\\\?\\/, '')
  const stat = await fs.stat(cleaned).catch(() => null)
  if (!stat) return { signal: 'unknown', ageMs: null }
  const ageMs = Date.now() - stat.mtimeMs
  if (ageMs > ACTIVE_RECENCY_MS) return { signal: 'unknown', ageMs }
  const handle = await fs.open(cleaned, 'r').catch(() => null)
  if (!handle) return { signal: 'unknown', ageMs }
  try {
    const start = Math.max(0, stat.size - 32768)
    const tail = await readSlice(handle, start, stat.size)
    return { signal: parseCodexRolloutTail(tail), ageMs }
  } catch {
    return { signal: 'unknown', ageMs }
  } finally {
    await handle.close().catch(() => {})
  }
}

async function scanCodex(names: Map<string, string>): Promise<CodingSession[]> {
  const stateFile = await latestFile(path.join(os.homedir(), '.codex'), /^state_(\d+)\.sqlite$/)
  if (!stateFile) return []

  let db: DatabaseSync | null = null
  let rows: {
    id: string
    title: string
    cwd: string
    updated_at: number
    source: string
    model_provider: string
    tokens_used: number
    rollout_path?: string | null
  }[] = []
  try {
    db = new DatabaseSync(stateFile, { readOnly: true })
    rows = db
      .prepare(
        `select id, title, cwd, updated_at, source, model_provider, tokens_used, rollout_path
         from threads
         order by updated_at desc
         limit 30`
      )
      .all() as typeof rows
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      // Already closed.
    }
  }

  const statuses = await readCodexTurnStatuses(rows.map((row) => row.id))
  const now = Date.now()
  // The turn table lags or stays `inProgress` on crashed/just-finished turns;
  // check the rollout tail to confirm whether the latest turn is open or closed.
  const rolloutStates = new Map<string, { signal: TurnSignal; ageMs: number | null }>()
  await Promise.all(
    rows
      .filter((row, index) => row.rollout_path && (index < 10 || /progress|running/i.test(statuses.get(row.id) || '')))
      .map(async (row) => {
        if (!row.rollout_path) return
        rolloutStates.set(row.id, await readCodexRolloutState(row.rollout_path))
      })
  )
  return rows.map((row) => {
    const source = String(row.source || '')
    const subagent = /subagent|guardian|other/i.test(source)
    const origin = source.includes('vscode') ? 'VS Code' : subagent ? 'Subagent' : null
    const title = cleanTitle(
      names.get(row.id) || row.title,
      baseName(row.cwd) || 'Codex session'
    )
    const status = statuses.get(row.id) || ''
    const updatedAt = normalizeTimestamp(row.updated_at)
    const rollout = rolloutStates.get(row.id)
    const active = isCodexSessionActive({
      status,
      updatedAt,
      rolloutSignal: rollout?.signal || 'unknown',
      rolloutAgeMs: rollout?.ageMs ?? null,
      now
    })
    const tokens = row.tokens_used || 0
    return {
      id: `codex-${row.id}`,
      rawId: row.id,
      provider: 'codex' as const,
      title,
      project: baseName(row.cwd),
      directory: row.cwd ? row.cwd.replace(/^\\\\\?\\/, '') : null,
      model: row.model_provider || null,
      detail: tokens > 0 ? `${tokens.toLocaleString()} tokens` : status || null,
      updatedAt,
      active,
      subagent,
      origin
    }
  })
}

async function scanOpenCode(): Promise<CodingSession[]> {
  const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
  let db: DatabaseSync | null = null
  try {
    await fs.access(dbPath)
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db
      .prepare(
        `select s.id, s.title, s.directory, s.time_created, s.time_updated, s.time_busy, s.time_idle,
                s.time_archived, s.cost, s.tokens_input, s.tokens_output, s.model, s.agent, s.parent_id,
                p.worktree, p.name as project_name
         from session_v2 s
         left join project p on s.project_id = p.id
         where s.time_archived is null
         order by s.time_updated desc
         limit 24`
      )
      .all() as {
      id: string
      title: string
      directory: string
      time_updated: number
      time_busy: number | null
      time_idle: number | null
      cost: number
      tokens_input: number
      tokens_output: number
      model: string
      agent: string
      parent_id: string | null
      worktree: string | null
      project_name: string | null
    }[]

    return rows.map((row) => {
      const directory = row.worktree || row.directory || null
      const updatedAt = normalizeTimestamp(row.time_updated)
      const active = isOpenCodeSessionActive({
        timeBusy: row.time_busy,
        timeIdle: row.time_idle,
        updatedAt
      })
      let model: string | null = null
      try {
        const parsed = JSON.parse(row.model || '{}') as { id?: string; providerID?: string }
        model = parsed.id ? parsed.id.split('/').pop() || parsed.id : parsed.providerID || null
      } catch {
        model = null
      }
      const tokens = (row.tokens_input || 0) + (row.tokens_output || 0)
      return {
        id: `opencode-${row.id}`,
        rawId: row.id,
        provider: 'opencode' as const,
        title: cleanTitle(row.title, baseName(directory) || 'OpenCode session'),
        project: row.project_name || baseName(directory),
        directory,
        model,
        detail: [row.agent, tokens > 0 ? `${tokens.toLocaleString()} tokens` : null]
          .filter(Boolean)
          .join(' · ') || null,
        updatedAt,
        active,
        subagent: Boolean(row.parent_id),
        origin: 'OpenCode'
      }
    })
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      // Already closed.
    }
  }
}

function antigravityDirectory(value: string): string | null {
  try {
    const uris = JSON.parse(value || '[]') as string[]
    if (!uris[0]) return null
    return fileURLToPath(uris[0])
  } catch {
    return null
  }
}

async function scanAntigravity(): Promise<CodingSession[]> {
  const dbPath = path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db')
  let db: DatabaseSync | null = null
  try {
    await fs.access(dbPath)
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db
      .prepare(
        `select conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
                status, agent_name, nesting_depth, not_fully_idle, killed
         from conversation_summaries
         where killed = 0
         order by (coalesce(nesting_depth, 0) = 0 and upper(coalesce(status, '')) in ('CASCADE_RUN_STATUS_RUNNING', 'CASCADE_RUN_STATUS_BUSY', 'CASCADE_RUN_STATUS_CANCELING')) desc,
                  last_modified_time desc
         limit 30`
      )
      .all() as {
      conversation_id: string
      title: string
      preview: string
      step_count: number
      last_modified_time: string
      workspace_uris: string
      status: string
      agent_name: string
      nesting_depth: number
      not_fully_idle: number
    }[]

    return rows.map((row) => {
      const directory = antigravityDirectory(row.workspace_uris)
      const updatedAt = normalizeTimestamp(row.last_modified_time)
      const active = isAntigravitySessionActive({ status: row.status, updatedAt })
      return {
        id: `antigravity-${row.conversation_id}`,
        rawId: row.conversation_id,
        provider: 'antigravity' as const,
        title: cleanTitle(row.title || row.preview, baseName(directory) || 'Anti Gravity session'),
        project: baseName(directory),
        directory,
        model: null,
        detail: `${row.step_count || 0} steps`,
        updatedAt,
        active,
        subagent: Boolean(row.nesting_depth),
        origin: row.agent_name || 'Anti Gravity'
      }
    })
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      // Already closed.
    }
  }
}

/**
 * Claude Code keeps one JSONL transcript per session under
 * ~/.claude/projects/<munged-project-path>/<session-id>.jsonl. Each line is a
 * JSON record (user / assistant / system) with sessionId, cwd and a timestamp.
 */
/** DeepAI Code keeps its threads in statev2.sqlite. The v1 `projection_threads`
 * table still exists but is empty on current builds, so the v2 projection is
 * read first and the legacy shape is only a fallback. */
async function scanDeepAi(): Promise<CodingSession[]> {
  const base = process.env.T3CODE_HOME || path.join(os.homedir(), '.deepai-code')
  const dbPath = path.join(base, 'userdata', 'statev2.sqlite')
  if (!(await fs.stat(dbPath).then((stat) => stat.isFile()).catch(() => false))) return []
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    let rows: {
      thread_id: string
      title: string | null
      updated_at: string | null
      created_at: string | null
      workspace_root: string | null
      project_title: string | null
      session_status: string | null
      model: string | null
    }[]
    try {
      rows = db
        .prepare(
          `select t.thread_id, t.title, t.updated_at, t.created_at,
                  p.workspace_root, p.title as project_title,
                  (select s.status from orchestration_v2_projection_provider_sessions s
                     where s.thread_id = t.thread_id order by s.updated_at desc limit 1) as session_status,
                  (select s.model from orchestration_v2_projection_provider_sessions s
                     where s.thread_id = t.thread_id order by s.updated_at desc limit 1) as model
           from orchestration_v2_projection_threads t
           left join projection_projects p on p.project_id = t.project_id
           where t.deleted_at is null and t.archived_at is null
           order by t.updated_at desc
           limit 24`
        )
        .all() as typeof rows
    } catch {
      rows = db
        .prepare(
          `select t.thread_id, t.title, t.updated_at, t.created_at,
                  p.workspace_root, p.title as project_title,
                  null as session_status, null as model
           from projection_threads t
           left join projection_projects p on p.project_id = t.project_id
           where t.deleted_at is null and t.archived_at is null
           order by t.updated_at desc
           limit 24`
        )
        .all() as typeof rows
    }

    return rows.map((row) => {
      const directory = row.workspace_root ? row.workspace_root.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '') : null
      const updatedAt = Date.parse(String(row.updated_at || row.created_at || '')) || 0
      const status = String(row.session_status || '')
      const model = String(row.model || '').split('/').filter(Boolean).pop() || null
      return {
        id: `deepai-${row.thread_id}`,
        rawId: row.thread_id,
        provider: 'deepai' as const,
        title: cleanTitle(row.title, baseName(directory) || 'DeepAI Code thread'),
        project: row.project_title || baseName(directory),
        directory,
        model,
        detail: status ? status.replace(/^\w/, (c) => c.toUpperCase()) : null,
        updatedAt,
        active: isDeepAiSessionActive({ status, updatedAt }),
        subagent: /delegated-task|subagent/i.test(row.thread_id),
        origin: 'DeepAI Code'
      }
    })
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      // Already closed.
    }
  }
}

async function scanClaude(): Promise<CodingSession[]> {
  const root = path.join(os.homedir(), '.claude', 'projects')
  try {
    const projects = await fs.readdir(root, { withFileTypes: true })
    const candidates: { file: string; mtime: number }[] = []
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const dir = path.join(root, project.name)
      const files = await fs.readdir(dir).catch(() => [] as string[])
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const full = path.join(dir, file)
        const stat = await fs.stat(full).catch(() => null)
        if (stat && stat.size > 0) candidates.push({ file: full, mtime: stat.mtimeMs })
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    const picked: CodingSession[] = []
    for (const candidate of candidates.slice(0, 16)) {
      const session = await claudeSessionFromFile(candidate.file, candidate.mtime)
      if (session) picked.push(session)
    }
    return picked
  } catch {
    // Claude Code has not run yet.
    return []
  }
}

async function claudeSessionFromFile(file: string, mtime: number): Promise<CodingSession | null> {
  try {
    const handle = await fs.open(file, 'r')
    try {
      const stat = await handle.stat()
      const head = await readSlice(handle, 0, Math.min(stat.size, 65536))
      const tail = await readSlice(handle, Math.max(0, stat.size - 32768), stat.size)

      let sessionId = ''
      let cwd = ''
      let title = ''
      let customTitle = ''
      let model: string | null = null
      let subagent = false
      let updatedAt = mtime

      for (const line of head.split(/\r?\n/)) {
        if (!line.startsWith('{')) continue
        let entry: ClaudeRecord
        try {
          entry = JSON.parse(line) as ClaudeRecord
        } catch {
          continue
        }
        if (!sessionId && entry.sessionId) sessionId = String(entry.sessionId)
        if (!cwd && entry.cwd) cwd = String(entry.cwd)
        if (entry.isSidechain) subagent = true
        if (!model && entry.message?.model) model = String(entry.message.model)
        if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
          customTitle = entry.customTitle
        }
        if (!title && entry.type === 'user') {
          const text = stripAgentMarkup(claudeContentText(entry.message?.content)).trim()
          if (text) title = text
        }
      }
      // The name shown in the Claude app is a `custom-title` record. Claude keeps
      // rewriting it as the chat goes on, so the newest one is near the end.
      for (const line of tail.split(/\r?\n/)) {
        if (!line.startsWith('{') || !line.includes('"custom-title"')) continue
        try {
          const entry = JSON.parse(line) as ClaudeRecord
          if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
            customTitle = entry.customTitle
          }
        } catch {
          // A slice can start mid-line.
        }
      }
      const tailSummary = analyzeClaudeTail(tail)
      if (tailSummary.updatedAt !== null) updatedAt = tailSummary.updatedAt

      if (!sessionId) sessionId = path.basename(file, '.jsonl')
      // Only treat unclosed recent turns as live; completed (`end_turn`, `cost-state`, `stop_hook_summary`) are at rest.
      const active = isClaudeSessionActive({
        subagent,
        turnSignal: tailSummary.turnSignal,
        updatedAt,
        mtime
      })
      return {
        id: `claude-${sessionId}`,
        rawId: sessionId,
        provider: 'claude' as const,
        title: cleanTitle(customTitle || title, baseName(cwd) || 'Claude Code session'),
        project: baseName(cwd),
        directory: cwd || null,
        model: model ? model.replace(/^claude-/, '') : null,
        detail: model ? null : null,
        updatedAt,
        active,
        subagent,
        origin: 'Claude Code'
      }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

interface ClaudeRecord {
  type?: string
  sessionId?: string
  cwd?: string
  isSidechain?: boolean
  timestamp?: string
  customTitle?: string
  message?: {
    role?: string
    model?: string
    content?: unknown
  }
}

/** Claude content is either a plain string or a block array; keep the first readable text. */
function claudeContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        const text = (block as { text: string }).text.trim()
        // Skip tool output and system reminders; keep real user words.
        if (text && !/^<system-reminder>|^Caveat:/i.test(text)) return text
      }
    }
  }
  return ''
}

async function readSlice(handle: fs.FileHandle, start: number, end: number): Promise<string> {
  const length = Math.max(0, end - start)
  if (length === 0) return ''
  const buffer = Buffer.alloc(length)
  await handle.read(buffer, 0, length, start)
  return buffer.toString('utf8')
}

/** Probe PATH with `where.exe` so npm, Scoop, Winget, and Cargo CLI installs work alongside desktop apps. */
async function findCommandOnPath(names: string[]): Promise<string | null> {
  if (process.platform !== 'win32') return null
  for (const name of names) {
    const hit = await new Promise<string | null>((resolve) => {
      execFile('where.exe', [name], { windowsHide: true, timeout: 4000 }, (error, stdout) => {
        if (error || !stdout.trim()) return resolve(null)
        const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        const exe = lines.find((line) => /\.exe$/i.test(line))
        const shim = lines.find((line) => /\.(cmd|bat)$/i.test(line))
        resolve(exe || shim || null)
      })
    })
    if (hit) return hit
  }
  return null
}

async function findClaudeCli(): Promise<string | null> {
  const home = os.homedir()
  const candidates = [
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude.cmd'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd')
  ]
  for (const candidate of candidates) {
    if (await fs.stat(candidate).then((stat) => stat.isFile()).catch(() => false)) return candidate
  }
  return findCommandOnPath(['claude'])
}

function processProvider(process: ProcessInfo): SessionProvider | null {
  return providerForProcess(process.Name) ?? providerForTitle(process.Title || '')
}

function buildPresence(processes: ProcessInfo[], sessions: CodingSession[]): AppPresence[] {
  const providers = new Set<SessionProvider>(CORE_PROVIDERS)
  for (const session of sessions) providers.add(session.provider)
  for (const process of processes) {
    const provider = processProvider(process)
    if (provider) providers.add(provider)
  }

  const coreIndex = (provider: SessionProvider): number => {
    if (provider === 'other') return 999
    const index = CORE_PROVIDERS.indexOf(provider)
    return index === -1 ? CORE_PROVIDERS.length : index
  }

  return Array.from(providers)
    .map((provider) => {
      const matching = processes.filter((process) => processProvider(process) === provider)
      const providerSessions = sessions.filter((session) => session.provider === provider)
      const activeSession = providerSessions.some((session) => session.active)
      // CLI agents keep daemons alive long after the user stops using them, so
      // bare process counts must never claim "running". A real window or an
      // actively-generating session does.
      const windowed = matching.filter((process) => process.Title)
      const state: AppPresence['state'] = activeSession
        ? 'working'
        : windowed.length > 0
          ? 'open'
          : matching.length > 0
            ? 'idle'
            : 'closed'
      const windowTitle =
        providerSessions.find((session) => session.active)?.title ||
        windowed[0]?.Title ||
        providerSessions[0]?.title ||
        null
      return {
        provider,
        label: PROVIDER_LABELS[provider],
        running: state === 'working' || state === 'open',
        state,
        processCount: matching.length,
        windowedCount: windowed.length,
        windowTitle,
        sessions: providerSessions.length
      }
    })
    .sort((a, b) => {
      const order = coreIndex(a.provider) - coreIndex(b.provider)
      return order !== 0 ? order : a.label.localeCompare(b.label)
    })
}

let inFlightScan: Promise<SessionsSnapshot> | null = null

export function scanSessions(): Promise<SessionsSnapshot> {
  if (inFlightScan) return inFlightScan
  inFlightScan = performScan().finally(() => {
    inFlightScan = null
  })
  return inFlightScan
}

function demoSnapshot(): SessionsSnapshot {
  const now = Date.now()
  const session = (
    provider: CodingSession['provider'],
    title: string,
    project: string,
    active = false
  ): CodingSession => ({
    id: `${provider}-demo`,
    rawId: 'demo',
    provider,
    title,
    project,
    directory: null,
    model: provider === 'codex' ? 'gpt-5.1' : provider === 'opencode' ? 'claude' : null,
    detail: active ? 'working' : '12k tokens',
    updatedAt: now - (active ? 60_000 : 3_600_000),
    active,
    subagent: false,
    origin: null
  })
  const sessions = [
    session('opencode', 'A Walk Through the Void', 'notch', true),
    session('codex', 'Identify safe-to-delete files', 'notch'),
    session('antigravity', 'Posture notes', 'notch'),
    session('claude', 'Review the notch window', 'notch'),
    session('cursor', 'Spatial open animation', 'notch'),
    session('windsurf', 'Placement map', 'notch'),
    session('zed', 'Compact notes layout', 'notch')
  ]
  const apps: AppPresence[] = (['codex', 'opencode', 'antigravity', 'claude', 'cursor', 'windsurf', 'zed'] as const).map(
    (provider) => ({
      provider,
      label: PROVIDER_LABELS[provider],
      running: provider === 'opencode' || provider === 'codex',
      state: (provider === 'opencode' || provider === 'codex' ? 'open' : 'closed') as AppPresence['state'],
      processCount: provider === 'opencode' ? 2 : provider === 'codex' ? 1 : 0,
      windowedCount: provider === 'opencode' || provider === 'codex' ? 1 : 0,
      windowTitle: sessions.find((item) => item.provider === provider)?.title || null,
      sessions: 1
    })
  )
  lastSessions = new Map(sessions.map((item) => [item.id, item]))
  lastDirectories = new Set()
  return { sessions, apps, scannedAt: now }
}

async function performScan(): Promise<SessionsSnapshot> {
  if (process.env.NOTCH_DEMO_SESSIONS === '1') return demoSnapshot()
  try {
    const [processes, names] = await Promise.all([
      scanProcesses(),
      readCodexSessionNames()
    ])
    const [deepai, codex, opencode, antigravity, claude, editors] = await Promise.all([
      scanDeepAi(),
      scanCodex(names),
      scanOpenCode(),
      scanAntigravity(),
      scanClaude(),
      scanEditorSessions()
    ])

    const runningProviders = new Set(
      processes
        .map(processProvider)
        .filter((provider): provider is SessionProvider => provider !== null)
    )

    // Keep each provider's newest sessions without letting a busy tool crowd others out,
    // prioritizing live main chats and clearing phantom activity for closed desktop apps.
    const sessions = prioritizeAndCapSessions(
      clearClosedDesktopActivity(
        [...deepai, ...codex, ...opencode, ...antigravity, ...claude, ...editors].filter(
          (session) => session.updatedAt > 0
        ),
        runningProviders,
        processes.length > 0
      )
    )
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1
        if (a.subagent !== b.subagent) return a.subagent ? 1 : -1
        return b.updatedAt - a.updatedAt
      })

    lastDirectories = new Set(
      sessions.map((session) => session.directory).filter((value): value is string => Boolean(value))
    )
    lastSessions = new Map(sessions.map((session) => [session.id, session]))

    // Carry the queue into the snapshot, then hand out anything that may now go.
    const held = outbox.counts()
    for (const session of sessions) {
      const count = held.get(session.id)
      if (count) session.queued = count
    }
    drainOutbox()

    return {
      sessions,
      apps: buildPresence(processes, sessions),
      scannedAt: Date.now()
    }
  } catch (error) {
    return {
      sessions: [],
      apps: buildPresence([], []),
      scannedAt: Date.now(),
      error: error instanceof Error ? error.message : 'Could not scan coding sessions.'
    }
  }
}

export async function openSessionProject(directory: string): Promise<void> {
  if (!lastDirectories.has(directory)) {
    throw new Error('That project is no longer part of the latest session scan.')
  }
  const stats = await fs.stat(directory).catch(() => null)
  if (!stats?.isDirectory()) throw new Error('That project folder is no longer available.')
  const error = await shell.openPath(directory)
  if (error) throw new Error(error)
}

async function findOpenCodeCli(): Promise<string | null> {
  const base = path.join(process.env.APPDATA || '', 'ai.opencode.desktop', 'cli')
  try {
    const entries = await fs.readdir(base, { withFileTypes: true })
    const versions = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
    for (const version of versions) {
      const candidate = path.join(base, version, 'opencode-cli.exe')
      if (await fs.stat(candidate).then((stat) => stat.isFile()).catch(() => false)) {
        return candidate
      }
    }
  } catch {
    // OpenCode desktop CLI is not installed; check PATH below.
  }
  return findCommandOnPath(['opencode-cli', 'opencode'])
}

let claudeSignedInAt = 0

type ClaudeAuthState = 'signed-in' | 'signed-out' | 'unknown'

/** Ask the Claude Code command line whether it is signed in. An older CLI without
 * `auth status`, or any unclear answer, is `unknown` and never blocks a send. */
async function claudeAuthState(cli: string): Promise<ClaudeAuthState> {
  if (Date.now() - claudeSignedInAt < 60_000) return 'signed-in'
  let command = cli
  let args = ['auth', 'status']
  const unwrapped = await resolveNodeCmdEntry(command)
  if (unwrapped) {
    command = unwrapped.node
    args = [unwrapped.script, ...args]
  }
  const stdout = await new Promise<string>((resolve) => {
    try {
      execFile(
        command,
        args,
        { windowsHide: true, timeout: 8000, maxBuffer: 200_000 },
        (_error, out) => resolve(typeof out === 'string' ? out : '')
      )
    } catch {
      resolve('')
    }
  })
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end <= start) return 'unknown'
  try {
    const status = JSON.parse(stdout.slice(start, end + 1)) as { loggedIn?: unknown }
    if (status.loggedIn === true) {
      claudeSignedInAt = Date.now()
      return 'signed-in'
    }
    if (status.loggedIn === false) return 'signed-out'
  } catch {
    // Unreadable answer: do not block.
  }
  return 'unknown'
}

/** Notch sends to Claude through the Claude Code command line, which keeps its own
 * sign-in. A CLI that is not signed in still writes the user's message into the
 * transcript and then answers "Not logged in", so ask first and refuse to send.
 * Returns a message to show, or null when sending can go ahead. */
async function claudeSignInProblem(cli: string): Promise<string | null> {
  if ((await claudeAuthState(cli)) !== 'signed-out') return null
  return 'Claude Code is not signed in on this PC, so Notch did not send anything. Notch sends through the Claude Code command line, which has its own sign-in. Press “Sign in to Claude Code”, finish signing in in your browser, then send again.'
}

const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const claudeOpenProbes = new Map<string, { at: number; open: boolean }>()

/** The Claude app keeps one Claude Code process per open chat, started with
 * `--input-format stream-json --resume=<session id>`. A chat that is open there
 * owns its conversation in memory, so a second `claude --resume` from Notch would
 * write into the same file behind its back: the app never sees the message and
 * never answers it. Any doubt (not Windows, probe failed) says "not open". */
async function claudeOpenInApp(rawId: string): Promise<boolean> {
  if (process.platform !== 'win32' || !CLAUDE_SESSION_ID.test(rawId)) return false
  const cached = claudeOpenProbes.get(rawId)
  if (cached && Date.now() - cached.at < 4000) return cached.open
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$hit = Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Where-Object { $_.CommandLine -like '*--input-format stream-json*' -and $_.CommandLine -like '*" + rawId + "*' }",
    "if ($hit) { 'open' } else { 'free' }"
  ].join('; ')
  const open = await new Promise<boolean>((resolve) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 6000 },
        (_error, stdout) => resolve(String(stdout || '').trim() === 'open')
      )
    } catch {
      resolve(false)
    }
  })
  claudeOpenProbes.set(rawId, { at: Date.now(), open })
  return open
}

const CLAUDE_OPEN_IN_APP_MESSAGE =
  'This chat is open in the Claude app, so Notch did not send anything. Notch would have to start a second Claude beside it, and the app would never see or answer the message. Send it from the Claude app, or close the chat there first.'

const claudeAppIds = new Map<string, string>()

/** The Claude app keeps one record per chat, named after its own `local_…` id,
 * that carries the Claude Code session id it resumes (`cliSessionId`). Find the
 * app's id for a Claude Code session, so its own deep link opens that exact chat. */
async function claudeAppSessionId(cliId: string): Promise<string | null> {
  const known = claudeAppIds.get(cliId)
  if (known) return known
  const roots: string[] = []
  const local = process.env.LOCALAPPDATA
  if (local) {
    // Store (MSIX) install: %LOCALAPPDATA%\Claude-Data\claude_<package hash>
    const dataDir = path.join(local, 'Claude-Data')
    const entries = await fs.readdir(dataDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) roots.push(path.join(dataDir, entry.name, 'claude-code-sessions'))
    }
  }
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'Claude', 'claude-code-sessions'))
  if (process.platform === 'darwin') {
    roots.push(path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'))
  }

  // Layout: <root>/<account>/<org>/local_<id>.json
  for (const root of roots) {
    const accounts = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    for (const account of accounts) {
      if (!account.isDirectory()) continue
      const accountDir = path.join(root, account.name)
      const orgs = await fs.readdir(accountDir, { withFileTypes: true }).catch(() => [])
      for (const org of orgs) {
        if (!org.isDirectory()) continue
        const orgDir = path.join(accountDir, org.name)
        const files = await fs.readdir(orgDir).catch(() => [] as string[])
        for (const file of files) {
          if (!/^local_[A-Za-z0-9-]{1,64}\.json$/.test(file)) continue
          const text = await fs.readFile(path.join(orgDir, file), 'utf8').catch(() => '')
          if (!text.includes(cliId)) continue
          try {
            const record = JSON.parse(text) as { sessionId?: unknown; cliSessionId?: unknown }
            if (record.cliSessionId === cliId && typeof record.sessionId === 'string') {
              claudeAppIds.set(cliId, record.sessionId)
              return record.sessionId
            }
          } catch {
            // A record mid-write; try the next one.
          }
        }
      }
    }
  }
  return null
}

/** Nothing outside the Claude app can type into a chat it owns, so hand the
 * message over: put it on the clipboard and open that exact chat in the app. */
async function handOffToClaudeApp(session: CodingSession, message: string): Promise<string> {
  clipboard.writeText(message)
  const appId = await claudeAppSessionId(session.rawId).catch(() => null)
  if (appId) {
    try {
      await shell.openExternal(`claude://claude.ai/epitaxy/${encodeURIComponent(appId)}`)
      return 'This chat is open in the Claude app, so Notch opened it there and copied your message. Press Ctrl+V, then Enter.'
    } catch {
      // Fall through: the message is still on the clipboard.
    }
  }
  return 'This chat is open in the Claude app. Notch copied your message: switch to the chat in Claude, press Ctrl+V, then Enter.'
}

/** For the Connected tools panel: is Claude messaging ready on this PC? */
export async function claudeSignInStatus(): Promise<ClaudeAuthState | 'no-cli'> {
  const cli = await findClaudeCli()
  if (!cli) return 'no-cli'
  return claudeAuthState(cli)
}

/** Open the official `claude auth login` in a console window the user can see, so
 * they can finish the browser sign-in and paste a code if one is asked for. Notch
 * never handles the credentials. */
export async function startClaudeSignIn(): Promise<{ ok: boolean; error?: string }> {
  const cli = await findClaudeCli()
  if (!cli) return { ok: false, error: 'Claude Code was not found on this PC. Install it first.' }
  if (process.platform !== 'win32') return { ok: false, error: 'Run `claude auth login` in a terminal.' }
  try {
    const child = spawn(
      'cmd.exe',
      [`/d /s /c "start "Claude sign-in" cmd /k ""${cli}" auth login""`],
      { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }
    )
    child.unref()
    claudeSignedInAt = 0
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not open the sign-in window.' }
  }
}

async function findCodexCli(): Promise<string | null> {
  const base = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin')
  const candidates: { full: string; mtime: number }[] = []

  const consider = async (full: string): Promise<void> => {
    const stat = await fs.stat(full).catch(() => null)
    if (stat?.isFile()) candidates.push({ full, mtime: stat.mtimeMs })
  }

  await consider(path.join(base, 'codex.exe'))
  try {
    const entries = await fs.readdir(base, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      await consider(path.join(base, entry.name, 'codex.exe'))
    }
  } catch {
    // Codex desktop CLI is not installed; check PATH below.
  }

  // The desktop app keeps its current CLI in a versioned folder. Prefer the
  // newest binary, because the legacy top-level one can reject newer config.
  candidates.sort((a, b) => b.mtime - a.mtime)
  if (candidates[0]?.full) return candidates[0].full
  return findCommandOnPath(['codex'])
}

/** A lock file that exists proves nothing: Codex never deletes it, so a thread
 * closed weeks ago still has one. Probe whether a writer actually holds it by
 * taking the same byte-range lock ourselves and letting go at once. */
const lockProbes = new Map<string, { at: number; held: boolean }>()
const lockInFlight = new Map<string, Promise<boolean>>()

function probeLock(lockPath: string): Promise<boolean> {
  const cached = lockProbes.get(lockPath)
  if (cached && Date.now() - cached.at < 4000) return Promise.resolve(cached.held)
  const existing = lockInFlight.get(lockPath)
  if (existing) return existing

  const probe = (): Promise<boolean> =>
    new Promise((resolve) => {
      const escaped = lockPath.replace(/'/g, "''")
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `try { $f = [IO.File]::Open('${escaped}', 'Open', 'ReadWrite', 'ReadWrite') }`,
        "catch { Write-Output 'unknown'; exit 0 }",
        "try { $f.Lock(0, 1); Write-Output 'free' }",
        "catch { Write-Output 'held' }",
        'finally { $f.Dispose() }',
        'exit 0'
      ].join('; ')
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 5000 },
        // A released lock still makes PowerShell exit 1, so the answer is the
        // printed word, never the exit code.
        (_error, stdout) => {
          const answer = String(stdout || '').trim()
          resolve(answer === 'held')
        }
      )
    })

  const pending = probe()
    .then((held) => {
      lockProbes.set(lockPath, { at: Date.now(), held })
      if (lockProbes.size > 64) {
        const oldest = [...lockProbes.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest) lockProbes.delete(oldest[0])
      }
      return held
    })
    .finally(() => {
      lockInFlight.delete(lockPath)
    })
  lockInFlight.set(lockPath, pending)
  return pending
}

async function codexThreadIsOpen(rawId: string): Promise<boolean> {
  const lock = path.join(os.homedir(), '.codex', 'thread-writer-locks', `${rawId}.lock`)
  const hasLock = await fs.stat(lock).then((stat) => stat.isFile()).catch(() => false)
  if (!hasLock) return false
  return probeLock(lock)
}

export async function codexThreadLock(
  sessionId: string
): Promise<{ locked: boolean; missing: boolean }> {
  const session = lastSessions.get(sessionId)
  if (!session || session.provider !== 'codex') return { locked: false, missing: true }
  return { locked: await codexThreadIsOpen(session.rawId), missing: false }
}

/** A store check must never hold a send hostage: a busy SQLite file or a huge
 * transcript would otherwise leave the composer spinning. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ])
}

function markQueue(sessionId: string, count: number): void {
  const session = lastSessions.get(sessionId)
  if (session) session.queued = count
}

function emitQueuedFailure(sessionId: string, message: string, code: string): void {
  const session = lastSessions.get(sessionId)
  sessionSendEvents.emit('result', {
    sessionId,
    provider: session?.provider ?? 'other',
    label: session ? PROVIDER_LABELS[session.provider] : 'Coding tool',
    ok: false,
    status: 'failed',
    error: message,
    code
  } satisfies SessionSendResult)
}

let queueTimer: NodeJS.Timeout | null = null
let queueTimerAt = 0

/** The renderer asks for a scan every 15 s, but only while the panel is open.
 * While anything is queued, keep a slow scan running in the background so a
 * held message is not stranded until the user reopens Notch. */
function scheduleQueueTick(delay = 10_000): void {
  if (outbox.counts().size === 0) return
  const targetAt = Date.now() + delay
  if (queueTimer) {
    if (targetAt >= queueTimerAt) return
    clearTimeout(queueTimer)
  }
  queueTimerAt = targetAt
  queueTimer = setTimeout(() => {
    queueTimer = null
    queueTimerAt = 0
    void scanSessions()
      .catch(() => undefined)
      .finally(() => {
        if (outbox.counts().size > 0) scheduleQueueTick()
      })
  }, delay)
  queueTimer.unref?.()
}

/** Terminate the spawned CLI and any child processes it opened (npm shims, node workers). */
function killProcessTree(target: ChildProcess): void {
  try {
    if (process.platform === 'win32' && target.pid) {
      const killer = spawn('taskkill', ['/pid', String(target.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.unref?.()
    }
    target.kill()
  } catch {
    // Already exited.
  }
}

/** Unwrap npm `.cmd`/`.bat` shims directly to `node.exe <entry>` so `cmd.exe` never mangles newlines, quotes, `%VAR%`, or 8k args. */
async function resolveNodeCmdEntry(cmdPath: string): Promise<{ node: string; script: string } | null> {
  if (!/\.(cmd|bat)$/i.test(cmdPath)) return null
  try {
    const content = await fs.readFile(cmdPath, 'utf8')
    const dir = path.dirname(cmdPath)
    const match = content.match(/"?(?:%dp0%|%~dp0)[\\/]([^"\r\n]+\.(?:js|mjs|cjs))"?/i)
    if (!match?.[1]) return null
    const script = path.resolve(dir, match[1])
    if (!(await fs.stat(script).then((stat) => stat.isFile()).catch(() => false))) return null
    const localNode = path.join(dir, 'node.exe')
    const node = (await fs.stat(localNode).then((stat) => stat.isFile()).catch(() => false))
      ? localNode
      : await findCommandOnPath(['node'])
    if (!node) return null
    return { node, script }
  } catch {
    return null
  }
}

function quoteCmdArg(value: string): string {
  const escaped = value.replace(/%/g, '%%').replace(/\r?\n/g, ' ').replace(/"/g, '\\"')
  return `"${escaped}"`
}

/** After each scan: hand the next held message to every session that has gone
 * quiet. One at a time, oldest first, so a burst never overtakes itself. */
function drainOutbox(): void {
  for (const sessionId of outbox.sessions()) {
    const session = lastSessions.get(sessionId)
    if (!session) {
      const misses = (outboxMissCounts.get(sessionId) ?? 0) + 1
      if (misses < 2) {
        outboxMissCounts.set(sessionId, misses)
        continue
      }
      outboxMissCounts.delete(sessionId)
      const dropped = outbox.drop(sessionId)
      if (dropped.length) {
        emitQueuedFailure(
          sessionId,
          'That conversation is no longer in the session list, so the queued message was not sent.',
          'session-gone'
        )
      }
      continue
    }
    outboxMissCounts.delete(sessionId)
    if (session.active || runningSends.has(sessionId) || draining.has(sessionId)) continue
    const next = outbox.peek(sessionId)
    if (!next) continue
    draining.add(sessionId)
    void (async () => {
      if (session.provider === 'codex' && (await codexThreadIsOpen(session.rawId))) {
        scheduleQueueTick(4_000)
        return
      }
      const taken = outbox.take(sessionId)
      if (!taken) return
      markQueue(sessionId, outbox.size(sessionId))
      await deliverSessionMessage(session, taken.message, { emitEarlyFailure: true })
    })()
      .catch(() => undefined)
      .finally(() => {
        draining.delete(sessionId)
        if (outbox.size(sessionId) > 0) scheduleQueueTick(300)
      })
  }
}

export async function sendSessionMessage(
  sessionId: string,
  rawMessage: string
): Promise<{
  ok: boolean
  pending?: boolean
  queued?: boolean
  position?: number
  handedOff?: boolean
  note?: string
  error?: string
  code?: string
}> {
  const session = lastSessions.get(sessionId)
  if (!session) return { ok: false, error: 'That session is no longer in the latest scan.' }
  if (session.rawId === 'demo') {
    return { ok: false, error: 'This is a preview session, so nothing was sent.' }
  }

  const message = rawMessage.trim()
  if (!message) return { ok: false, error: 'Write a message first.' }
  if (message.length > 12_000) return { ok: false, error: 'Keep messages under 12,000 characters.' }
  // DeepAI Code owns its threads and exposes no CLI or local API another app can
  // deliver through (verified against the desktop app). Refuse before the queue
  // branch, so a live thread never holds a message Notch could never deliver.
  if (session.provider === 'deepai') {
    return {
      ok: false,
      code: 'deepai-external',
      error:
        'DeepAI Code does not yet expose a local channel another app can deliver a message through, so Notch did not send anything. Message the thread from the DeepAI Code app.'
    }
  }
  if (runningSends.has(sessionId) || desktopSends.has(sessionId)) {
    return { ok: false, error: 'A message is already being sent to this session.' }
  }
  if (session.provider === 'claude' && (await claudeOpenInApp(session.rawId))) {
    // A second `claude --resume` would write behind the app's back and never be
    // answered, so hand the message to the app instead of sending it.
    const note = await handOffToClaudeApp(session, message)
    return { ok: true, handedOff: true, note, code: 'claude-open-in-app' }
  }
  // The scan can be minutes old and providers delete conversations, so a send
  // must not target a row the store no longer has.
  const presence = await within(sessionPresence(session.provider, session.rawId), 600, 'unknown')
  if (presence === 'gone') {
    return {
      ok: false,
      error: `That conversation is no longer in ${PROVIDER_LABELS[session.provider]}. Refresh the session list and open it again.`,
      code: 'session-gone'
    }
  }

  // Never type into an agent that is mid-turn: hold the message and deliver it
  // when that turn ends. The queue is strict FIFO per session.
  if (session.active) {
    const position = outbox.push(sessionId, message)
    if (!position) {
      return {
        ok: false,
        error: `This session already has ${MAX_QUEUED_PER_SESSION} messages waiting. Let it finish first.`,
        code: 'queue-full'
      }
    }
    sessionSendEvents.emit('result', {
      sessionId,
      provider: session.provider,
      label: PROVIDER_LABELS[session.provider],
      ok: true,
      status: 'queued',
      position
    } satisfies SessionSendResult)
    scheduleQueueTick()
    return { ok: true, queued: true, position }
  }

  markQueue(sessionId, outbox.size(sessionId))
  return deliverSessionMessage(session, message)
}

const desktopSends = new Set<string>()

function emitSendResult(session: CodingSession, status: SessionSendResult['status'], error?: string, code?: string): void {
  sessionSendEvents.emit('result', {
    sessionId: session.id,
    provider: session.provider,
    label: PROVIDER_LABELS[session.provider],
    ok: status === 'delivered',
    status,
    error,
    code
  } satisfies SessionSendResult)
}

/** A message can land and the agent still fail to answer it: Claude "Not logged
 * in", Codex "usage limit". The transcript records that a moment after the
 * message, so look for it for a while after "delivered" and say so. */
function watchAgentError(session: CodingSession, message: string, mark: DeliveryMark | undefined): void {
  if (session.provider !== 'codex' && session.provider !== 'claude') return
  void (async () => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const report = await confirmDeliveredMessage(session.provider, session.rawId, message, {
        mark,
        retryMs: 0
      }).catch(() => null)
      if (report?.check === 'missing' && report.reason?.startsWith(AGENT_ERROR_PREFIX)) {
        emitSendResult(session, 'failed', report.reason, 'agent-error')
        return
      }
    }
  })()
}

/** Follows a message typed into an open Codex Desktop thread until it is in the
 * transcript, then reports the result like any other send. */
function trackDesktopDelivery(session: CodingSession, message: string, mark: DeliveryMark | undefined): void {
  desktopSends.add(session.id)
  prepareReplyWatch(session, message)
  armReplyWatch(session, message)
  void (async () => {
    let status: SessionSendResult['status'] = 'unconfirmed'
    let error: string | undefined = 'Notch could not confirm this message landed in the thread.'
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const report = await confirmDeliveredMessage('codex', session.rawId, message, { mark, retryMs: 0 }).catch(
        () => null
      )
      if (report?.check === 'confirmed') {
        status = 'delivered'
        error = undefined
        break
      }
      if (report?.check === 'missing' && report.reason?.startsWith(AGENT_ERROR_PREFIX)) {
        status = 'failed'
        error = report.reason
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    desktopSends.delete(session.id)
    emitSendResult(session, status, error)
    if (status === 'delivered') watchAgentError(session, message, mark)
  })()
}

/** Delivers one message into a session that is already known to exist and to be
 * quiet. Queueing and validation live in `sendSessionMessage`. */
async function deliverSessionMessage(
  session: CodingSession,
  message: string,
  options?: { emitEarlyFailure?: boolean }
): Promise<{ ok: boolean; pending?: boolean; error?: string; code?: string }> {
  const sessionId = session.id
  const failEarly = (error: string, code?: string) => {
    if (options?.emitEarlyFailure) {
      emitQueuedFailure(sessionId, error, code || 'send-failed')
    }
    return { ok: false, error, ...(code ? { code } : {}) }
  }
  let command: string
  let args: string[]
  let stdinText: string | null = null
  let env: NodeJS.ProcessEnv = process.env
  let resolveAddress: (() => Promise<NodeJS.ProcessEnv | null>) | null = null

  if (session.provider === 'opencode') {
    const cli = await findOpenCodeCli()
    if (!cli) return failEarly('OpenCode CLI was not found. Open the OpenCode desktop app or add `opencode` to PATH.')
    command = cli
    args = ['run', '--session', session.rawId, '--', message]
  } else if (session.provider === 'codex') {
    // A thread open in Codex Desktop has one writer, so a background CLI is
    // refused. Type into it through the app itself; `no-owner` means no window
    // holds the thread and the command line is safe to use.
    const desktopMark = await within(captureDeliveryMark('codex', session.rawId), 600, undefined)
    const desktop = await sendCodexDesktopMessage(session.rawId, message)
    if (desktop.reason === 'sent') {
      trackDesktopDelivery(session, message, desktopMark)
      return { ok: true, pending: true }
    }
    if (desktop.reason === 'error' || (await codexThreadIsOpen(session.rawId))) {
      return failEarly(
        `That Codex thread is open in Codex Desktop and Notch could not type into it${
          desktop.error ? ` (${desktop.error})` : ''
        }. Send it from the app, or close the thread and use “Send when the thread closes”.`,
        'codex-open'
      )
    }
    const cli = await findCodexCli()
    if (!cli) {
      return failEarly('Codex CLI was not found. Open the Codex desktop app or add `codex` to PATH.')
    }
    command = cli
    // Always pipe via `-` so newlines, leading dashes, and long prompts never depend on shell arg handling.
    args = ['exec', 'resume', '--skip-git-repo-check', session.rawId, '-']
    stdinText = `${message}\n`
  } else if (session.provider === 'claude') {
    // Claude Code has no writer lock like Codex's, but a headless resume while
    // a turn is still streaming would interleave two writers in one
    // transcript. Wait for the turn to end instead.
    if (await claudeOpenInApp(session.rawId)) {
      return failEarly(CLAUDE_OPEN_IN_APP_MESSAGE, 'claude-open-in-app')
    }
    if (session.active) {
      return failEarly(
        'Claude is still working in this session. Wait for the current turn to finish, then press Send again.',
        'claude-active'
      )
    }
    const cli = await findClaudeCli()
    if (!cli) {
      return failEarly('Claude Code CLI was not found. Install Claude Code, then try again.')
    }
    const signInProblem = await claudeSignInProblem(cli)
    if (signInProblem) return failEarly(signInProblem, 'claude-signin')
    // Claude organises transcripts per project, so the resume has to run in
    // the session's own directory to find this conversation.
    command = cli
    // "--" ends option parsing, so a message that begins with a dash is still
    // the prompt instead of an unknown option.
    args = ['--resume', session.rawId, '--print', '--', message]
  } else if (session.provider === 'antigravity') {
    const target = await findAntiGravityTarget()
    if (!target) {
      return failEarly(
        'Anti Gravity’s local agent service is not answering. Open Anti Gravity, or restart it, so Notch can deliver messages.'
      )
    }
    const executable = path.join(
      process.env.LOCALAPPDATA || '',
      'Programs',
      'antigravity',
      'resources',
      'bin',
      'language_server.exe'
    )
    if (!(await fs.stat(executable).then((stat) => stat.isFile()).catch(() => false))) {
      return failEarly('Anti Gravity local agent CLI was not found.')
    }
    command = executable
    args = ['agentapi', 'send-message', session.rawId, message]
    env = antiGravityEnv(target)
    // The daemon can restart between this scan and the dial, which leaves the
    // recorded port dead. Re-resolve once and retry instead of failing the send.
    resolveAddress = async () => {
      const next = await findAntiGravityTarget()
      return next ? antiGravityEnv(next) : null
    }
  } else {
    return failEarly(`${PROVIDER_LABELS[session.provider]} messaging is not supported yet.`)
  }

  // Unwrap `.cmd`/`.bat` npm wrappers directly onto Node before spawning so cmd.exe metacharacters never bite.
  const unwrapped = await resolveNodeCmdEntry(command)
  if (unwrapped) {
    command = unwrapped.node
    args = [unwrapped.script, ...args]
  }

  // Where the store stands now, so an older copy of the same text cannot be
  // mistaken for this send.
  const mark: DeliveryMark | undefined = await within(
    captureDeliveryMark(session.provider, session.rawId),
    600,
    undefined
  )

  const maxAttempts = resolveAddress ? 2 : 1
  const CLI_TIMEOUT_MS = 10 * 60_000
  let child: ChildProcess | null = null
  let childTimeout: NodeJS.Timeout | null = null
  let attempt = 0
  let output = ''
  let settled = false

  const clearChildTimeout = (): void => {
    if (childTimeout) {
      clearTimeout(childTimeout)
      childTimeout = null
    }
  }

  const finish = (
    status: SessionSendResult['status'],
    error?: string,
    code?: string
  ): void => {
    if (settled) return
    settled = true
    stopProbe()
    clearChildTimeout()
    runningSends.delete(sessionId)
    if (outbox.size(sessionId) > 0) scheduleQueueTick(200)
    if (status === 'delivered') watchAgentError(session, message, mark)
    const result: SessionSendResult = {
      sessionId,
      provider: session.provider,
      label: PROVIDER_LABELS[session.provider],
      ok: status === 'delivered',
      status,
      error,
      code
    }
    sessionSendEvents.emit('result', result)
  }

  const collect = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-3000)
  }

  const launch = (): void => {
    attempt += 1
    clearChildTimeout()
    // Custom non-Node `.cmd`/`.bat` shims still go through cmd.exe with verbatim quoting.
    const needsShell = /\.(cmd|bat)$/i.test(command)
    const stdio: ('ignore' | 'pipe')[] = [stdinText ? 'pipe' : 'ignore', 'pipe', 'pipe']
    const spawned = needsShell
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${[command, ...args].map(quoteCmdArg).join(' ')}"`], {
          cwd: session.directory || os.homedir(),
          env,
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio
        })
      : spawn(command, args, {
          cwd: session.directory || os.homedir(),
          env,
          windowsHide: true,
          stdio
        })
    if (stdinText) spawned.stdin?.end(stdinText)
    child = spawned
    runningSends.set(sessionId, spawned)
    childTimeout = setTimeout(() => {
      if (child === spawned && !spawned.killed) {
        killProcessTree(spawned)
        finish('failed', 'The agent command timed out.')
      }
    }, CLI_TIMEOUT_MS)
    childTimeout.unref?.()
    spawned.stdout?.on('data', collect)
    spawned.stderr?.on('data', collect)
    spawned.on('error', (error) => {
      clearChildTimeout()
      noteReplyCliExited(sessionId, 1)
      finish('failed', error.message)
    })
    spawned.on('exit', (code) => {
      clearChildTimeout()
      noteReplyCliExited(sessionId, code)
      void settle(code)
    })
  }

  const verifyDelivery = async (
    retryMs?: number
  ): Promise<{
    check: 'confirmed' | 'missing' | 'unavailable'
    reason?: string
  }> => {
    try {
      return await confirmDeliveredMessage(session.provider, session.rawId, message, {
        mark,
        ...(retryMs === undefined ? {} : { retryMs })
      })
    } catch (error) {
      return {
        check: 'unavailable',
        reason:
          error instanceof Error
            ? error.message
            : 'Notch could not read this session’s store.'
      }
    }
  }

  // A CLI can stream a whole turn before it exits (OpenCode does), so waiting
  // for the process would leave the composer "sending" long after the message
  // arrived. Watch the store while the command runs and report as soon as the
  // message is there.
  let probeTimer: NodeJS.Timeout | null = null
  let probeStartedAt = 0
  let probing = false
  const stopProbe = (): void => {
    if (probeTimer) clearInterval(probeTimer)
    probeTimer = null
  }
  const startProbe = (): void => {
    if (probeTimer || settled) return
    probeStartedAt = Date.now()
    probeTimer = setInterval(() => {
      if (settled || Date.now() - probeStartedAt > 45_000) {
        stopProbe()
        return
      }
      if (probing) return
      probing = true
      void verifyDelivery(0)
        .then((report) => {
          if (report.check === 'confirmed') {
            finish('delivered')
            stopProbe()
          }
        })
        .finally(() => {
          probing = false
        })
    }, 1200)
    probeTimer.unref?.()
  }

  const settle = async (code: number | null): Promise<void> => {
    // The agent CLI prints its failure as JSON, and some builds still exit 0.
    const reported = jsonFailure(output)
    const commandFailed = code !== 0 || Boolean(reported)
    const failedAtTransport = reported ? transportFailure(reported) : transportFailure(output)

    // The session store decides delivery, not the exit code: a CLI can report an
    // error after the message was already accepted (a stream that broke, a turn
    // the user cancelled, a daemon that answered late), and an exit code of zero
    // proves nothing on its own. A refused dial is the one case where nothing
    // can have arrived, so it is not worth polling for.
    const delivery = await verifyDelivery(commandFailed && failedAtTransport ? 0 : undefined)
    if (delivery.check === 'confirmed') {
      finish('delivered')
      return
    }
    if (settled) return

    if (!commandFailed) {
      finish(
        'unconfirmed',
        delivery.reason || 'Notch could not confirm this message landed in the session.'
      )
      return
    }

    if (resolveAddress && attempt < maxAttempts && failedAtTransport) {
      const nextEnv = await resolveAddress()
      if (settled) return
      if (nextEnv) {
        env = nextEnv
        output = ''
        try {
          launch()
          armReplyWatch(session, message)
        } catch (error) {
          finish('failed', error instanceof Error ? error.message : 'Could not start the agent command.')
        }
        return
      }
    }
    const configHint =
      session.provider === 'codex' && /config\.toml/i.test(output)
        ? ' Fix the flagged setting in %USERPROFILE%\\.codex\\config.toml and try again.'
        : ''
    const gone = sessionGone(output) || sessionGone(reported || '')
    finish(
      'failed',
      `${describeAgentFailure(session.provider, reported ? `${reported} ${output}` : output, code)}${configHint}`,
      gone ? 'session-gone' : undefined
    )
  }

  prepareReplyWatch(session, message)
  try {
    launch()
  } catch (error) {
    discardReplyWatch(session.id)
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not start the agent command.'
    }
  }
  armReplyWatch(session, message)
  startProbe()

  return { ok: true, pending: true }
}

/** Re-read the session store for a message that was already sent. Provider
 * commands exit before their store is flushed, so a second look can turn an
 * unconfirmed send into a delivered one without sending anything again. */
export async function verifySessionMessage(
  sessionId: string,
  rawMessage: string
): Promise<{ ok: boolean; error?: string }> {
  const session = lastSessions.get(sessionId)
  if (!session) return { ok: false, error: 'That session is no longer in the latest scan.' }
  const message = rawMessage.trim()
  if (!message) return { ok: false, error: 'Write a message first.' }
  const report = await confirmDeliveredMessage(session.provider, session.rawId, message)
  const delivered = report.check === 'confirmed'
  sessionSendEvents.emit('result', {
    sessionId,
    provider: session.provider,
    label: PROVIDER_LABELS[session.provider],
    ok: delivered,
    status: delivered ? 'delivered' : 'unconfirmed',
    error: report.reason
  })
  return delivered ? { ok: true } : { ok: false, error: report.reason }
}

export function stopSessionActivity(): void {
  stopAllReplyWatches()
  for (const child of runningSends.values()) {
    killProcessTree(child)
  }
  runningSends.clear()
}
