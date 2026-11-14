import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { shell } from 'electron'
import type {
  AppPresence,
  CodingSession,
  SessionProvider,
  SessionSendResult,
  SessionsSnapshot
} from '../shared/types'
import { confirmDeliveredMessage } from './sessionDelivery'
import { armReplyWatch, discardReplyWatch, noteReplyCliExited, prepareReplyWatch } from './sessionWatch'

const PROVIDER_LABELS: Record<SessionProvider, string> = {
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Anti Gravity',
  claude: 'Claude',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  zed: 'Zed'
}

const CORE_PROVIDERS: SessionProvider[] = ['codex', 'opencode', 'antigravity']

let lastDirectories = new Set<string>()
let lastSessions = new Map<string, CodingSession>()
const runningSends = new Map<string, ChildProcess>()
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
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return fallback
  if (text.length > 96) text = `${text.slice(0, 93).trimEnd()}…`
  return text
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
  return null
}

function scanProcesses(): Promise<ProcessInfo[]> {
  return new Promise((resolve) => {
    execFile(
      'tasklist.exe',
      ['/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve([])
          return
        }
        const processes: ProcessInfo[] = []
        const rows = stdout.split(/\r?\n/)
        for (const row of rows) {
          const match = row.match(/^"([^"]+)","([0-9]+)"/)
          if (!match) continue
          const name = match[1]
          if (!providerForProcess(name)) continue
          processes.push({ Id: Number(match[2]), Name: name, Title: null, Path: null })
        }
        resolve(processes)
      }
    )
  })
}

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

async function readCodexSessionNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.codex', 'session_index.jsonl'), 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as { id: string; thread_name?: string }
        if (entry.id && entry.thread_name) names.set(entry.id, entry.thread_name)
      } catch {
        // Ignore malformed index lines.
      }
    }
  } catch {
    // Older Codex installs may not have the index.
  }
  return names
}

async function readCodexTurnStatuses(): Promise<Map<string, string>> {
  const statuses = new Map<string, string>()
  const historyFile = await latestFile(path.join(os.homedir(), '.codex'), /^thread_history_(\d+)\.sqlite$/)
  if (!historyFile) return statuses
  try {
    const db = new DatabaseSync(historyFile, { readOnly: true })
    const rows = db
      .prepare(
        'select thread_id, status from thread_turns order by started_at desc limit 250'
      )
      .all() as { thread_id: string; status: string }[]
    for (const row of rows) {
      if (!statuses.has(row.thread_id)) statuses.set(row.thread_id, row.status)
    }
    db.close()
  } catch {
    // Missing or locked history database.
  }
  return statuses
}

async function scanCodex(names: Map<string, string>, statuses: Map<string, string>): Promise<CodingSession[]> {
  const stateFile = await latestFile(path.join(os.homedir(), '.codex'), /^state_(\d+)\.sqlite$/)
  if (!stateFile) return []

  try {
    const db = new DatabaseSync(stateFile, { readOnly: true })
    const rows = db
      .prepare(
        `select id, title, cwd, updated_at, source, model_provider, tokens_used
         from threads
         order by updated_at desc
         limit 30`
      )
      .all() as {
      id: string
      title: string
      cwd: string
      updated_at: number
      source: string
      model_provider: string
      tokens_used: number
    }[]
    db.close()

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
      const active = /progress|running/i.test(status)
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
  } catch {
    return []
  }
}

async function scanOpenCode(): Promise<CodingSession[]> {
  const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
  try {
    await fs.access(dbPath)
    const db = new DatabaseSync(dbPath, { readOnly: true })
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
    db.close()

    return rows.map((row) => {
      const directory = row.worktree || row.directory || null
      const updatedAt = normalizeTimestamp(row.time_updated)
      const recentlyUpdated = Date.now() - updatedAt < 10 * 60_000
      const active =
        recentlyUpdated &&
        (row.time_idle === null || (row.time_busy !== null && row.time_busy > row.time_idle))
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
  try {
    await fs.access(dbPath)
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db
      .prepare(
        `select conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
                status, agent_name, nesting_depth, not_fully_idle, killed
         from conversation_summaries
         where killed = 0
         order by last_modified_time desc
         limit 20`
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
    db.close()

    return rows.map((row) => {
      const directory = antigravityDirectory(row.workspace_uris)
      const active = !/IDLE/i.test(row.status) || Boolean(row.not_fully_idle)
      return {
        id: `antigravity-${row.conversation_id}`,
        rawId: row.conversation_id,
        provider: 'antigravity' as const,
        title: cleanTitle(row.title || row.preview, baseName(directory) || 'Anti Gravity session'),
        project: baseName(directory),
        directory,
        model: null,
        detail: `${row.step_count || 0} steps`,
        updatedAt: normalizeTimestamp(row.last_modified_time),
        active,
        subagent: Boolean(row.nesting_depth),
        origin: row.agent_name || 'Anti Gravity'
      }
    })
  } catch {
    return []
  }
}

function buildPresence(processes: ProcessInfo[], sessions: CodingSession[]): AppPresence[] {
  const providers = new Set<SessionProvider>(CORE_PROVIDERS)
  for (const session of sessions) providers.add(session.provider)
  for (const process of processes) {
    const provider = providerForProcess(process.Name)
    if (provider) providers.add(provider)
  }

  return Array.from(providers)
    .map((provider) => {
      const matching = processes.filter((process) => providerForProcess(process.Name) === provider)
      const providerSessions = sessions.filter((session) => session.provider === provider)
      const windowTitle =
        providerSessions.find((session) => session.active)?.title ||
        providerSessions[0]?.title ||
        null
      return {
        provider,
        label: PROVIDER_LABELS[provider],
        running: matching.length > 0 || providerSessions.some((session) => session.active),
        processCount: matching.length,
        windowTitle,
        sessions: providerSessions.length
      }
    })
    .sort((a, b) => {
      const order = CORE_PROVIDERS.indexOf(a.provider) - CORE_PROVIDERS.indexOf(b.provider)
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
      processCount: provider === 'opencode' ? 2 : provider === 'codex' ? 1 : 0,
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
    const [processes, names, statuses] = await Promise.all([
      scanProcesses(),
      readCodexSessionNames(),
      readCodexTurnStatuses()
    ])
    const [codex, opencode, antigravity] = await Promise.all([
      scanCodex(names, statuses),
      scanOpenCode(),
      scanAntigravity()
    ])

    const sessions = [...codex, ...opencode, ...antigravity]
      .filter((session) => session.updatedAt > 0)
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1
        if (a.subagent !== b.subagent) return a.subagent ? 1 : -1
        return b.updatedAt - a.updatedAt
      })
      .slice(0, 30)

    lastDirectories = new Set(
      sessions.map((session) => session.directory).filter((value): value is string => Boolean(value))
    )
    lastSessions = new Map(sessions.map((session) => [session.id, session]))

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
    // OpenCode is not installed.
  }
  return null
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
    // Codex is not installed.
  }

  // The desktop app keeps its current CLI in a versioned folder. Prefer the
  // newest binary, because the legacy top-level one can reject newer config.
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.full || null
}

function isProcessRunning(imageName: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 4000 },
      (error, stdout) => {
        resolve(!error && stdout.toLowerCase().includes(imageName.toLowerCase()))
      }
    )
  })
}

async function codexThreadIsOpen(rawId: string): Promise<boolean> {
  const lock = path.join(os.homedir(), '.codex', 'thread-writer-locks', `${rawId}.lock`)
  const hasLock = await fs.stat(lock).then((stat) => stat.isFile()).catch(() => false)
  if (!hasLock) return false
  return isProcessRunning('ChatGPT.exe')
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(900)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function findAntiGravityAddress(): Promise<string | null> {
  const base = path.join(os.homedir(), '.gemini', 'antigravity', 'daemon')
  try {
    const files = (await fs.readdir(base)).filter((name) => /^hub_\d+\.json$/.test(name))
    const candidates = await Promise.all(
      files.map(async (name) => {
        const full = path.join(base, name)
        const stat = await fs.stat(full).catch(() => null)
        return stat ? { full, mtime: stat.mtimeMs } : null
      })
    )
    for (const candidate of candidates
      .filter((value): value is { full: string; mtime: number } => Boolean(value))
      .sort((a, b) => b.mtime - a.mtime)) {
      try {
        const data = JSON.parse(await fs.readFile(candidate.full, 'utf8')) as {
          httpPort?: number
          httpsPort?: number
        }
        if (data.httpPort && (await isPortOpen(data.httpPort))) {
          return `http://127.0.0.1:${data.httpPort}`
        }
      } catch {
        // Try the next daemon record.
      }
    }
  } catch {
    // Anti Gravity has not run yet.
  }
  return null
}

function cleanProcessError(output: string): string {
  return output
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-320)
}

export async function sendSessionMessage(
  sessionId: string,
  rawMessage: string
): Promise<{ ok: boolean; pending?: boolean; error?: string; code?: string }> {
  const session = lastSessions.get(sessionId)
  if (!session) return { ok: false, error: 'That session is no longer in the latest scan.' }
  if (session.rawId === 'demo') {
    return { ok: false, error: 'This is a preview session, so nothing was sent.' }
  }

  const message = rawMessage.trim()
  if (!message) return { ok: false, error: 'Write a message first.' }
  if (message.length > 12_000) return { ok: false, error: 'Keep messages under 12,000 characters.' }
  if (runningSends.has(sessionId)) {
    return { ok: false, error: 'A message is already being sent to this session.' }
  }

  let command: string
  let args: string[]
  let env: NodeJS.ProcessEnv = process.env

  if (session.provider === 'opencode') {
    const cli = await findOpenCodeCli()
    if (!cli) return { ok: false, error: 'OpenCode CLI was not found. Open the OpenCode desktop app first.' }
    command = cli
    args = ['run', '--session', session.rawId, '--', message]
  } else if (session.provider === 'codex') {
    if (await codexThreadIsOpen(session.rawId)) {
      return {
        ok: false,
        code: 'codex-open',
        error:
          'That Codex thread is open in ChatGPT. Codex locks open threads, so a background CLI cannot deliver into it. Copy the message and send it in ChatGPT, or close the thread and retry.'
      }
    }
    const cli = await findCodexCli()
    if (!cli) {
      return { ok: false, error: 'Codex CLI was not found. Open the Codex desktop app first.' }
    }
    command = cli
    args = ['exec', 'resume', '--skip-git-repo-check', session.rawId, message]
  } else if (session.provider === 'antigravity') {
    const address = await findAntiGravityAddress()
    if (!address) {
      return {
        ok: false,
        error: 'Anti Gravity is not running. Open it once so its local agent service is available.'
      }
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
      return { ok: false, error: 'Anti Gravity local agent CLI was not found.' }
    }
    command = executable
    args = ['agentapi', 'send-message', session.rawId, message]
    env = { ...process.env, ANTIGRAVITY_LS_ADDRESS: address }
  } else {
    return { ok: false, error: `${PROVIDER_LABELS[session.provider]} messaging is not supported yet.` }
  }

  let child: ChildProcess
  prepareReplyWatch(session)
  try {
    child = spawn(command, args, {
      cwd: session.directory || os.homedir(),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    discardReplyWatch(session.id)
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not start the agent command.'
    }
  }
  armReplyWatch(session)

  runningSends.set(sessionId, child)
  let output = ''

  const finish = (
    status: SessionSendResult['status'],
    error?: string,
    code?: string
  ): void => {
    if (runningSends.get(sessionId) !== child) return
    runningSends.delete(sessionId)
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

  child.stdout?.on('data', (chunk: Buffer) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-3000)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-3000)
  })
  child.on('error', (error) => {
    noteReplyCliExited(sessionId, 1)
    finish('failed', error.message)
  })
  child.on('exit', (code) => {
    noteReplyCliExited(sessionId, code)
    if (code === 0) {
      void confirmDeliveredMessage(session.provider, session.rawId, message).then((report) => {
        if (report.check === 'confirmed') {
          finish('delivered')
          return
        }
        finish('unconfirmed', report.reason || 'Notch could not confirm this message landed in the session.')
      })
      return
    }
    const detail = cleanProcessError(output) || `Agent command exited with code ${code}.`
    const configHint =
      session.provider === 'codex' && /config\.toml/i.test(output)
        ? ' Fix the flagged setting in %USERPROFILE%\\.codex\\config.toml and try again.'
        : ''
    finish('failed', `${detail}${configHint}`)
  })

  return { ok: true, pending: true }
}
