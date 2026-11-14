import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CodingSession, SessionProvider, SessionReplyEvent } from '../shared/types'

/**
 * After a message is handed to a local agent, watch that session until a new
 * assistant turn exists and the agent is idle again.
 *
 * OpenCode: an assistant message part newer than the baseline, and
 * session_v2.time_idle caught up with time_busy. This is a real turn.
 * Codex: a new assistant / agent_message line in the thread rollout, and the
 * newest thread_turns row no longer in progress (or the CLI has exited when
 * that table cannot be read). This is a real turn.
 * Anti Gravity: the conversation summary's step count advanced and the row
 * returned to IDLE. The local store does not keep readable assistant text, so
 * this one is inferred. If those columns are missing, nothing is guessed.
 *
 * A watch gives up after 12 minutes.
 */

const WATCH_MS = 12 * 60 * 1000
const POLL_MS = 2000
const MAX_WATCHES = 6

const WATCHABLE = new Set<SessionProvider>(['opencode', 'codex', 'antigravity'])

const LABELS: Partial<Record<SessionProvider, string>> = {
  opencode: 'OpenCode',
  codex: 'Codex',
  antigravity: 'Anti Gravity'
}

export interface ReplyRoots {
  opencodeDb: string
  codexSessions: string
  codexStateDir: string
  antigravityDb: string
}

export interface ReplyCursor {
  token: string
  /** true while the agent is still producing, false when it has gone idle, null when the store cannot say. */
  busy: boolean | null
  evidence: 'assistant' | 'summary' | 'none'
}

export type ReadResult = { ok: true; cursor: ReplyCursor } | { ok: false }

export const sessionReplyEvents = new EventEmitter()

export function defaultReplyRoots(): ReplyRoots {
  const home = os.homedir()
  return {
    opencodeDb: path.join(home, '.local', 'share', 'opencode', 'opencode.db'),
    codexSessions: path.join(home, '.codex', 'sessions'),
    codexStateDir: path.join(home, '.codex'),
    antigravityDb: path.join(home, '.gemini', 'antigravity', 'conversation_summaries.db')
  }
}

export function replyIsReady(baseline: string, cursor: ReplyCursor, cliRunning: boolean): boolean {
  if (!cursor.token || cursor.token === baseline || cursor.evidence === 'none') return false
  if (cursor.busy === true) return false
  if (cursor.busy === false) return true
  return !cliRunning
}

interface Watch {
  session: CodingSession
  baseline: string
  startedAt: number
  cliRunning: boolean
  fired: boolean
  polling: boolean
  timer: NodeJS.Timeout
  timeout: NodeJS.Timeout
}

const watches = new Map<string, Watch>()
const prepared = new Map<string, Promise<ReadResult>>()
const pendingExit = new Map<string, number | null>()
const sawExit = new Set<string>()
const armTokens = new Map<string, number>()
let armSerial = 0

function watchable(session: CodingSession): boolean {
  return WATCHABLE.has(session.provider) && session.rawId !== 'demo'
}

export function prepareReplyWatch(session: CodingSession): void {
  if (!watchable(session)) return
  // A new send starts clean. The previous process has already exited; a late
  // duplicate exit event must not cancel this watch.
  sawExit.delete(session.id)
  pendingExit.delete(session.id)
  prepared.set(session.id, readBaseline(session))
}

export function discardReplyWatch(sessionId: string): void {
  prepared.delete(sessionId)
  pendingExit.delete(sessionId)
  sawExit.delete(sessionId)
  armTokens.delete(sessionId)
  stopReplyWatch(sessionId)
}

export function armReplyWatch(session: CodingSession): void {
  if (!watchable(session)) return
  const token = ++armSerial
  armTokens.set(session.id, token)
  const pending = prepared.get(session.id) ?? readBaseline(session)
  prepared.delete(session.id)
  void pending.then((result) => {
    if (armTokens.get(session.id) !== token) return
    if (!result.ok) return
    stopReplyWatch(session.id)
    const exitCode = pendingExit.has(session.id) ? pendingExit.get(session.id) : undefined
    pendingExit.delete(session.id)
    if (exitCode !== undefined && exitCode !== 0) {
      sawExit.add(session.id)
      return
    }
    const watch = startWatch(session, result.cursor.token, exitCode === undefined)
    if (exitCode === 0) {
      watch.cliRunning = false
      void poll(watch)
    }
  })
}

export function noteReplyCliExited(sessionId: string, code: number | null): void {
  const watch = watches.get(sessionId)
  if (!watch) {
    // Ignore the exit that follows an error event, or any exit after this
    // send has already been settled. Remembering it would cancel the next send.
    if (!sawExit.has(sessionId)) pendingExit.set(sessionId, code)
    return
  }
  sawExit.add(sessionId)
  pendingExit.delete(sessionId)
  if (code !== 0) {
    stopReplyWatch(sessionId)
    return
  }
  watch.cliRunning = false
  void poll(watch)
}

function startWatch(session: CodingSession, baseline: string, cliRunning: boolean): Watch {
  while (watches.size >= MAX_WATCHES) {
    const oldest = [...watches.values()].sort((a, b) => a.startedAt - b.startedAt)[0]
    if (!oldest) break
    stopReplyWatch(oldest.session.id)
  }
  const watch = {
    session,
    baseline,
    startedAt: Date.now(),
    cliRunning,
    fired: false,
    polling: false
  } as Watch
  watch.timer = setInterval(() => void poll(watch), POLL_MS)
  watch.timeout = setTimeout(() => {
    if (watches.get(session.id) === watch) stopReplyWatch(session.id)
  }, WATCH_MS)
  sawExit.add(session.id)
  pendingExit.delete(session.id)
  watches.set(session.id, watch)
  return watch
}

function stopReplyWatch(sessionId: string): void {
  const watch = watches.get(sessionId)
  if (!watch) return
  clearInterval(watch.timer)
  clearTimeout(watch.timeout)
  watches.delete(sessionId)
}

async function poll(watch: Watch): Promise<void> {
  if (watch.fired || watch.polling || watches.get(watch.session.id) !== watch) return
  if (Date.now() - watch.startedAt > WATCH_MS) {
    stopReplyWatch(watch.session.id)
    return
  }
  watch.polling = true
  try {
    const result = await readReplyCursor(watch.session)
    if (watch.fired || watches.get(watch.session.id) !== watch) return
    if (!result.ok) return
    if (!replyIsReady(watch.baseline, result.cursor, watch.cliRunning)) return
    watch.fired = true
    const event: SessionReplyEvent = {
      sessionId: watch.session.id,
      provider: watch.session.provider,
      label: LABELS[watch.session.provider] || 'Session',
      title: watch.session.title,
      evidence: result.cursor.evidence === 'summary' ? 'summary' : 'assistant'
    }
    stopReplyWatch(watch.session.id)
    sessionReplyEvents.emit('reply', event)
  } finally {
    watch.polling = false
  }
}

async function readBaseline(session: CodingSession): Promise<ReadResult> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await readReplyCursor(session)
    if (result.ok) return result
    await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)))
  }
  return { ok: false }
}

export async function readReplyCursor(
  session: Pick<CodingSession, 'provider' | 'rawId'>,
  roots: ReplyRoots = defaultReplyRoots()
): Promise<ReadResult> {
  if (session.provider === 'opencode') return readOpenCodeReply(roots.opencodeDb, session.rawId)
  if (session.provider === 'codex') return readCodexReply(roots.codexSessions, roots.codexStateDir, session.rawId)
  if (session.provider === 'antigravity') return readAntiGravityReply(roots.antigravityDb, session.rawId)
  return { ok: false }
}

const emptyCursor = (): ReplyCursor => ({ token: '', busy: null, evidence: 'none' })

export async function readOpenCodeReply(dbPath: string, rawId: string): Promise<ReadResult> {
  if (!(await isFile(dbPath))) return { ok: true, cursor: emptyCursor() }
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return { ok: false }
  }
  try {
    let token = ''
    const rows = db
      .prepare(
        `select message.data as data, part.time_created as created
         from part
         join message on message.id = part.message_id
         where part.session_id = ?
         order by part.time_created desc
         limit 80`
      )
      .all(rawId) as { data: string; created: number | null }[]
    for (const row of rows) {
      if (messageRole(row.data) !== 'assistant') continue
      token = `oc:${Number(row.created) || 0}:${String(row.data || '').length}`
      break
    }
    let busy: boolean | null = null
    try {
      const session = db
        .prepare('select time_busy as busy, time_idle as idle from session_v2 where id = ?')
        .get(rawId) as { busy: number | null; idle: number | null } | undefined
      if (session) {
        const idleAt = Number(session.idle || 0)
        const busyAt = Number(session.busy || 0)
        if (idleAt > 0 && idleAt >= busyAt) busy = false
        else if (busyAt > idleAt) busy = true
      }
    } catch {
      busy = null
    }
    return {
      ok: true,
      cursor: { token, busy, evidence: token ? 'assistant' : 'none' }
    }
  } catch {
    return { ok: false }
  } finally {
    try {
      db.close()
    } catch {
      // Already closed.
    }
  }
}

export async function readCodexReply(
  sessionsDir: string,
  stateDir: string,
  rawId: string
): Promise<ReadResult> {
  try {
    const token = await codexAssistantToken(sessionsDir, rawId)
    const busy = await codexBusy(stateDir, rawId)
    return {
      ok: true,
      cursor: { token, busy, evidence: token ? 'assistant' : 'none' }
    }
  } catch {
    return { ok: false }
  }
}

export async function readAntiGravityReply(dbPath: string, rawId: string): Promise<ReadResult> {
  if (!(await isFile(dbPath))) return { ok: true, cursor: emptyCursor() }
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return { ok: false }
  }
  try {
    const columns = db.prepare('pragma table_info(conversation_summaries)').all() as { name: string }[]
    const names = new Set(columns.map((column) => column.name))
    if (!names.has('conversation_id') || !names.has('step_count') || !names.has('status')) {
      return { ok: true, cursor: emptyCursor() }
    }
    const idleColumn = names.has('not_fully_idle') ? 'not_fully_idle' : '0'
    const row = db
      .prepare(
        `select step_count as step, status as status, ${idleColumn} as idle_flag
         from conversation_summaries
         where conversation_id = ?`
      )
      .get(rawId) as { step: number | null; status: string | null; idle_flag: number | null } | undefined
    if (!row) return { ok: true, cursor: emptyCursor() }
    const status = String(row.status || '')
    const notIdle = Number(row.idle_flag || 0) !== 0
    let busy: boolean | null = null
    if (/idle/i.test(status) && !notIdle) busy = false
    else if (notIdle || /run|busy|work|stream|progress/i.test(status)) busy = true
    return {
      ok: true,
      cursor: {
        token: `ag:${Number(row.step) || 0}`,
        busy,
        evidence: 'summary'
      }
    }
  } catch {
    return { ok: false }
  } finally {
    try {
      db.close()
    } catch {
      // Already closed.
    }
  }
}

function messageRole(data: string): string {
  try {
    return String((JSON.parse(data) as { role?: string }).role || '')
  } catch {
    return ''
  }
}

const rolloutFiles = new Map<string, string[]>()

async function codexAssistantToken(sessionsDir: string, rawId: string): Promise<string> {
  const files = await codexRollouts(sessionsDir, rawId)
  const parts: string[] = []
  for (const file of files) {
    const offset = await lastAssistantOffset(file)
    if (offset >= 0) parts.push(`${path.basename(file)}:${offset}`)
  }
  parts.sort()
  return parts.length > 0 ? `codex:${parts.join('|')}` : ''
}

async function codexRollouts(sessionsDir: string, rawId: string): Promise<string[]> {
  const cached = rolloutFiles.get(`${sessionsDir}:${rawId}`)
  if (cached && cached.length > 0) {
    const alive: string[] = []
    for (const file of cached) {
      if (await isFile(file)) alive.push(file)
    }
    if (alive.length > 0) return alive
  }
  let entries: string[] = []
  try {
    entries = (await fs.readdir(sessionsDir, { recursive: true })).map((entry) => String(entry))
  } catch {
    entries = []
  }
  const files = entries
    .filter((entry) => entry.endsWith('.jsonl') && entry.includes(rawId))
    .map((entry) => path.join(sessionsDir, entry))
  rolloutFiles.set(`${sessionsDir}:${rawId}`, files)
  return files
}

async function lastAssistantOffset(file: string): Promise<number> {
  const stat = await fs.stat(file)
  const length = Math.min(stat.size, 2_000_000)
  const start = stat.size - length
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const text = buffer.toString('utf8')
    const skip = start > 0 ? text.indexOf('\n') + 1 : 0
    const body = skip > 0 ? text.slice(skip) : text
    let cursor = start + (skip > 0 ? skip : 0)
    let last = -1
    for (const line of body.split(/\r?\n/)) {
      if (isAssistantLine(line)) last = cursor + line.length
      cursor += line.length + 1
    }
    return last
  } finally {
    await handle.close()
  }
}

function isAssistantLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return false
  try {
    const parsed = JSON.parse(trimmed) as { role?: string; type?: string; payload?: { type?: string } }
    if (parsed.role === 'assistant') return true
    if (parsed.type === 'agent_message' || parsed.type === 'assistant') return true
    const kind = parsed.payload?.type
    return kind === 'agent_message' || kind === 'assistant_message'
  } catch {
    return /"role"\s*:\s*"assistant"/.test(trimmed) || /"type"\s*:\s*"agent_message"/.test(trimmed)
  }
}

async function codexBusy(stateDir: string, rawId: string): Promise<boolean | null> {
  let names: string[] = []
  try {
    names = await fs.readdir(stateDir)
  } catch {
    return null
  }
  const databases = names
    .filter((name) => /\.sqlite$/i.test(name) && /thread|state/i.test(name))
    .map((name) => path.join(stateDir, name))
  let saw: boolean | null = null
  for (const file of databases) {
    const status = await threadStatus(file, rawId)
    if (status === null) continue
    const busy = busyFromStatus(status)
    if (busy === true) return true
    if (busy === false) saw = false
  }
  return saw
}

async function threadStatus(file: string, rawId: string): Promise<string | null> {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(file, { readOnly: true })
  } catch {
    return null
  }
  try {
    const tables = db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]
    if (!tables.some((table) => table.name === 'thread_turns')) return null
    const columns = db.prepare('pragma table_info(thread_turns)').all() as { name: string }[]
    const names = new Set(columns.map((column) => column.name))
    if (!names.has('thread_id') || !names.has('status')) return null
    const row = db
      .prepare('select status as status from thread_turns where thread_id = ? order by rowid desc limit 1')
      .get(rawId) as { status: string | null } | undefined
    return row ? String(row.status || '') : null
  } catch {
    return null
  } finally {
    try {
      db.close()
    } catch {
      // Already closed.
    }
  }
}

function busyFromStatus(status: string): boolean | null {
  const value = status.trim().toLowerCase()
  if (!value) return null
  if (/(progress|running|streaming|pending|working)/.test(value)) return true
  if (/(complete|idle|done|finished|success|failed|error|cancel)/.test(value)) return false
  return null
}

async function isFile(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then((stat) => stat.isFile())
    .catch(() => false)
}
