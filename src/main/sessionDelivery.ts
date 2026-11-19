import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionProvider } from '../shared/types'

/**
 * After a provider command exits 0, look for the exact user text in that
 * session's own store. A finished command is not treated as delivery.
 *
 * Every provider stores the text differently (jsonl transcripts, a JSON column
 * in SQLite, protobuf step blobs), so matching decodes where it can and only
 * falls back to escaped-text search on data it cannot parse.
 */
export type DeliveryCheck = 'confirmed' | 'missing' | 'unavailable'

/** Starts the reason when a message landed but the agent then failed to answer it. */
export const AGENT_ERROR_PREFIX = 'The message reached the agent, but'

export interface DeliveryReport {
  check: DeliveryCheck
  reason?: string
}

/** Where a transcript stood before the send, so an older copy of the same text
 * can never confirm a new send. */
export interface DeliveryFileMark {
  path: string
  size: number
}

export interface DeliveryMark {
  /** Highest OpenCode message sequence number already in the session. */
  openCodeSeq?: number
  /** Transcript files and their size before the send. */
  files?: DeliveryFileMark[]
  /** Anti Gravity: index of the last user input step before the send. */
  stepIndex?: number
  /** When the send started, used when a store renumbers or rewrites itself. */
  startedAt?: number
}

export interface DeliveryOptions {
  /** Test seam: read a fixture home instead of the real one. */
  home?: string
  mark?: DeliveryMark
  /** How long to keep re-reading a store that updates asynchronously. */
  retryMs?: number
}

const DEFAULT_RETRY_MS = 2500

/** Providers rewrite line endings and indentation; compare on words. */
export function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A JSON column stores quotes and newlines escaped, so the plain text will not
 * appear in the raw string. */
function escapedForms(text: string): string[] {
  const json = JSON.stringify(text).slice(1, -1)
  return json && json !== text ? [json] : []
}

export function containsText(haystack: string, text: string): boolean {
  const needle = normalizeWhitespace(text)
  if (!needle) return false
  if (normalizeWhitespace(haystack).includes(needle)) return true
  return escapedForms(text).some((form) => haystack.includes(form))
}

/** Walk parsed JSON and compare the decoded strings, so escaping never matters. */
export function jsonContainsText(value: unknown, text: string, depth = 0): boolean {
  if (depth > 12 || value == null) return false
  if (typeof value === 'string') return containsText(value, text)
  if (Array.isArray(value)) return value.some((item) => jsonContainsText(item, text, depth + 1))
  if (typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).some((item) =>
    jsonContainsText(item, text, depth + 1)
  )
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function home(options?: DeliveryOptions): string {
  return options?.home || os.homedir()
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then((stat) => stat.isFile()).catch(() => false)
}

async function fileSize(file: string): Promise<number | null> {
  return fs.stat(file).then((stat) => stat.size).catch(() => null)
}

/** Read from `from` to the end, capped so a huge transcript stays cheap. */
async function readFrom(file: string, from: number, cap = 4_000_000): Promise<string> {
  const stat = await fs.stat(file)
  // A mark larger than the file means the transcript was rewritten or
  // compacted, so the offset is meaningless and the whole file is read.
  const offset = from > stat.size ? 0 : from
  const start = Math.max(0, Math.min(offset, stat.size), stat.size - cap)
  const length = stat.size - start
  if (length <= 0) return ''
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value)).toString('utf8')
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

interface JsonlMatch {
  found: boolean
  parsedAny: boolean
}

async function jsonlHasUserText(
  file: string,
  text: string,
  from: number,
  isUserTurn: (line: Record<string, unknown>) => boolean
): Promise<JsonlMatch> {
  const raw = await readFrom(file, from)
  if (!raw) return { found: false, parsedAny: false }
  let parsedAny = false
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // The slice can start mid-line, and providers can flush partial rows.
      continue
    }
    parsedAny = true
    if (!parsed || typeof parsed !== 'object') continue
    if (!isUserTurn(parsed as Record<string, unknown>)) continue
    if (jsonContainsText(parsed, text)) return { found: true, parsedAny }
  }
  return { found: false, parsedAny }
}

function codexUserTurn(line: Record<string, unknown>): boolean {
  const payload = (line.payload || line) as Record<string, unknown>
  const role = String(payload.role || line.role || '')
  return role === 'user' || line.type === 'user_message'
}

function claudeUserTurn(line: Record<string, unknown>): boolean {
  if (line.type !== 'user') return false
  const message = line.message as { content?: unknown } | undefined
  const content = message?.content
  if (Array.isArray(content)) {
    const parts = content as { type?: string }[]
    if (parts.length > 0 && parts.every((part) => part?.type === 'tool_result')) return false
  }
  return true
}

const transcriptPathCache = new Map<string, string[]>()

function rememberTranscriptPaths(cacheKey: string, files: string[]): void {
  if (files.length === 0) return
  if (transcriptPathCache.size >= 64) {
    const oldest = transcriptPathCache.keys().next().value
    if (oldest !== undefined) transcriptPathCache.delete(oldest)
  }
  transcriptPathCache.set(cacheKey, files)
}

async function cachedTranscriptPaths(cacheKey: string): Promise<string[] | null> {
  const cached = transcriptPathCache.get(cacheKey)
  if (!cached || cached.length === 0) return null
  const alive: string[] = []
  for (const file of cached) {
    if (await exists(file)) alive.push(file)
  }
  if (alive.length > 0) return alive
  transcriptPathCache.delete(cacheKey)
  return null
}

/** Claude Code writes ~/.claude/projects/<project>/<session-id>.jsonl. */
async function claudeTranscripts(rawId: string, base: string): Promise<string[]> {
  const root = path.join(base, '.claude', 'projects')
  const cacheKey = `claude:${root}:${rawId}`
  const hit = await cachedTranscriptPaths(cacheKey)
  if (hit) return hit
  try {
    const entries = await fs.readdir(root, { recursive: true })
    const files = entries
      .map((entry) => String(entry))
      .filter((entry) => entry.endsWith(`${rawId}.jsonl`))
      .map((entry) => path.join(root, entry))
    rememberTranscriptPaths(cacheKey, files)
    return files
  } catch {
    return []
  }
}

/** The thread id is the rollout filename suffix, not a substring of a longer id. */
export function codexRolloutMatches(fileName: string, rawId: string): boolean {
  if (!rawId || !fileName.endsWith('.jsonl')) return false
  const base = fileName.split(/[\\/]/).pop() || fileName
  const stem = base.slice(0, -'.jsonl'.length)
  return stem === rawId || stem.endsWith(`-${rawId}`) || stem.endsWith(`_${rawId}`)
}

async function codexRollouts(rawId: string, base: string): Promise<string[]> {
  const root = path.join(base, '.codex', 'sessions')
  const cacheKey = `codex:${root}:${rawId}`
  const hit = await cachedTranscriptPaths(cacheKey)
  if (hit) return hit
  try {
    const entries = await fs.readdir(root, { recursive: true })
    const files = entries
      .map((entry) => String(entry))
      .filter((entry) => codexRolloutMatches(entry, rawId))
      .map((entry) => path.join(root, entry))
    rememberTranscriptPaths(cacheKey, files)
    return files
  } catch {
    return []
  }
}

async function newestMatch(directory: string, pattern: RegExp): Promise<string | null> {
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

function tableNames(db: DatabaseSync): Set<string> {
  const tables = db.prepare("select name from sqlite_master where type = 'table'").all() as {
    name: string
  }[]
  return new Set(tables.map((table) => table.name))
}

function closeQuietly(db: DatabaseSync | null): void {
  try {
    db?.close()
  } catch {
    // Already closed.
  }
}

function markedSize(options: DeliveryOptions | undefined, file: string): number {
  const mark = options?.mark?.files?.find((entry) => entry.path === file)
  return mark ? mark.size : 0
}

async function openStore(file: string): Promise<DatabaseSync | null> {
  try {
    return new DatabaseSync(file, { readOnly: true })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- OpenCode

function openCodeDatabase(base: string): string {
  return path.join(base, '.local', 'share', 'opencode', 'opencode.db')
}

async function confirmOpenCode(
  rawId: string,
  text: string,
  options?: DeliveryOptions
): Promise<DeliveryReport> {
  const dbPath = openCodeDatabase(home(options))
  if (!(await exists(dbPath))) {
    return { check: 'unavailable', reason: 'OpenCode’s session database was not found.' }
  }
  const db = await openStore(dbPath)
  if (!db) return { check: 'unavailable', reason: 'OpenCode’s session database could not be opened.' }
  try {
    const tables = tableNames(db)
    const since = options?.mark?.openCodeSeq
    let searched = false

    // OpenCode 2.x: one row per message, role in the column, body in JSON.
    if (tables.has('session_message')) {
      searched = true
      let rows: { type: string; seq: number; time_created?: number; data: unknown }[]
      try {
        rows = db
          .prepare(
            `select type, seq, time_created, data from session_message
             where session_id = ? order by seq desc limit 200`
          )
          .all(rawId) as typeof rows
      } catch {
        // Very early 2.x builds had no time_created column.
        rows = db
          .prepare(
            `select type, seq, data from session_message
             where session_id = ? order by seq desc limit 200`
          )
          .all(rawId) as typeof rows
      }
      const partRows = tables.has('session_part')
        ? (db
            .prepare(
              `select m.seq as seq, p.data as data
               from session_part p join session_message m on m.id = p.message_id
               where p.session_id = ? and m.type = 'user'
               order by m.seq desc limit 200`
            )
            .all(rawId) as { seq: number; data: unknown }[])
        : []
      const startedAt = options?.mark?.startedAt
      for (const row of rows) {
        if (String(row.type || '') !== 'user') continue
        const newerSeq = since == null || Number(row.seq) > since
        const newerRow = startedAt != null && Number(row.time_created) >= startedAt - 2000
        if (!newerSeq && !newerRow) continue
        if (jsonContainsText(parseJson(row.data) ?? row.data, text)) return { check: 'confirmed' }
        if (containsText(toText(row.data), text)) return { check: 'confirmed' }
      }
      for (const row of partRows) {
        if (since != null && Number(row.seq) <= since) continue
        if (jsonContainsText(parseJson(row.data) ?? row.data, text)) return { check: 'confirmed' }
        if (containsText(toText(row.data), text)) return { check: 'confirmed' }
      }
    }

    // OpenCode 1.x: parts joined to messages.
    if (tables.has('part') && tables.has('message')) {
      searched = true
      const rows = db
        .prepare(
          `select part.data as part_data, message.data as message_data
           from part join message on message.id = part.message_id
           where part.session_id = ? order by part.time_created desc limit 400`
        )
        .all(rawId) as { part_data: unknown; message_data: unknown }[]
      for (const row of rows) {
        let role = ''
        try {
          role = String((JSON.parse(toText(row.message_data)) as { role?: string }).role || '')
        } catch {
          role = ''
        }
        if (role !== 'user') continue
        if (jsonContainsText(parseJson(row.part_data) ?? row.part_data, text)) {
          return { check: 'confirmed' }
        }
        if (containsText(toText(row.part_data), text)) return { check: 'confirmed' }
      }
    }

    if (!searched) {
      const fallback = await confirmInSqlite(dbPath, rawId, text, ['session_message', 'part'], false)
      return fallback
    }
    return {
      check: 'missing',
      reason: 'The OpenCode command finished, but that message is not a user turn in this session.'
    }
  } catch {
    return { check: 'unavailable', reason: 'OpenCode’s session database could not be read.' }
  } finally {
    closeQuietly(db)
  }
}

// ------------------------------------------------------------------- Codex

/** Codex ends a turn it could not run (usage limit, auth, network) with a
 * `task_complete` record carrying an `error` and no agent message. If the newest
 * turn after the user's message ended that way, return the error text. */
async function codexAgentErrorAfter(file: string, from: number, text: string): Promise<string | null> {
  const raw = await readFrom(file, from)
  let seenUser = false
  let error: string | null = null
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const record = parsed as Record<string, unknown>
    if (!seenUser) {
      if (codexUserTurn(record) && jsonContainsText(record, text)) seenUser = true
      continue
    }
    const payload = (record.payload && typeof record.payload === 'object' ? record.payload : {}) as Record<
      string,
      unknown
    >
    if (payload.type === 'task_started') error = null
    if (payload.type === 'task_complete') {
      const failure = payload.error
      const message =
        typeof failure === 'string'
          ? failure
          : failure && typeof failure === 'object'
            ? String((failure as { message?: unknown }).message ?? '')
            : ''
      error = message.trim() ? message.trim().slice(0, 240) : null
    }
  }
  return error
}

async function confirmCodex(
  rawId: string,
  text: string,
  options?: DeliveryOptions
): Promise<DeliveryReport> {
  const base = home(options)
  const files = await codexRollouts(rawId, base)
  if (files.length > 0) {
    let parsedAny = false
    for (const file of files) {
      const result = await jsonlHasUserText(file, text, markedSize(options, file), codexUserTurn)
      parsedAny = parsedAny || result.parsedAny
      if (result.found) {
        const agentError = await codexAgentErrorAfter(file, markedSize(options, file), text).catch(() => null)
        if (agentError) {
          return {
            check: 'missing',
            reason: `${AGENT_ERROR_PREFIX} Codex could not answer it: ${agentError}`
          }
        }
        return { check: 'confirmed' }
      }
    }
    if (!parsedAny) {
      for (const file of files) {
        const raw = await readFrom(file, markedSize(options, file))
        if (containsText(raw, text)) return { check: 'confirmed' }
      }
    }
    return {
      check: 'missing',
      reason: 'The Codex command finished, but that message is not in this thread’s transcript.'
    }
  }

  const stateFile = await newestMatch(path.join(base, '.codex'), /^state_(\d+)\.sqlite$/)
  if (!stateFile) {
    return { check: 'unavailable', reason: 'No Codex transcript was found for this thread.' }
  }
  return confirmInSqlite(stateFile, rawId, text, ['messages', 'message', 'thread_messages'], true)
}

// ------------------------------------------------------------------ Claude

/** Text of an assistant turn in a Claude Code transcript line. */
function claudeAssistantText(record: Record<string, unknown>): string {
  const content = (record.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : ''))
    .join(' ')
    .trim()
}

/** Claude Code writes an API failure (not signed in, out of credit, rate limited)
 * into the transcript as an assistant line flagged `isApiErrorMessage`. If the
 * newest assistant turn after the user's message is one of those, the message
 * arrived but nothing answered it; return the error text. */
async function claudeApiErrorAfter(file: string, from: number, text: string): Promise<string | null> {
  const raw = await readFrom(file, from)
  let seenUser = false
  let lastAssistantError: string | null = null
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const record = parsed as Record<string, unknown>
    if (!seenUser) {
      if (claudeUserTurn(record) && jsonContainsText(record, text)) seenUser = true
      continue
    }
    if (record.type === 'assistant') {
      lastAssistantError = record.isApiErrorMessage === true ? claudeAssistantText(record) || 'API error' : null
    }
  }
  return lastAssistantError
}

async function confirmClaude(
  rawId: string,
  text: string,
  options?: DeliveryOptions
): Promise<DeliveryReport> {
  const files = await claudeTranscripts(rawId, home(options))
  if (files.length === 0) {
    return { check: 'unavailable', reason: 'No Claude Code transcript was found for this session.' }
  }
  let parsedAny = false
  for (const file of files) {
    const result = await jsonlHasUserText(file, text, markedSize(options, file), claudeUserTurn)
    parsedAny = parsedAny || result.parsedAny
    if (result.found) {
      const apiError = await claudeApiErrorAfter(file, markedSize(options, file), text).catch(() => null)
      if (apiError) {
        return {
          check: 'missing',
          reason: `${AGENT_ERROR_PREFIX} Claude could not answer it: ${apiError}`
        }
      }
      return { check: 'confirmed' }
    }
  }
  if (!parsedAny) {
    for (const file of files) {
      const raw = await readFrom(file, markedSize(options, file))
      if (containsText(raw, text)) return { check: 'confirmed' }
    }
  }
  return {
    check: 'missing',
    reason: 'The Claude Code command finished, but that message is not in this session’s transcript.'
  }
}

// ------------------------------------------------------------- Anti Gravity

function antiGravityRoot(base: string): string {
  return path.join(base, '.gemini', 'antigravity')
}

/** Each conversation has its own SQLite file; steps hold protobuf payloads whose
 * strings are plain UTF-8, so the message bytes appear verbatim. */
async function confirmAntiGravity(
  rawId: string,
  text: string,
  options?: DeliveryOptions
): Promise<DeliveryReport> {
  const base = home(options)
  const root = antiGravityRoot(base)
  let sawStore = false
  let readSteps = false
  const since = options?.mark?.stepIndex

  const conversation = path.join(root, 'conversations', `${rawId}.db`)
  if (await exists(conversation)) {
    sawStore = true
    const db = await openStore(conversation)
    if (db) {
      try {
        const rows = db
          .prepare('select idx, step_payload from steps order by idx desc limit 120')
          .all() as { idx: number; step_payload: unknown }[]
        readSteps = true
        for (const row of rows) {
          if (since != null && Number(row.idx) <= since) continue
          if (containsText(toText(row.step_payload), text)) return { check: 'confirmed' }
        }
      } catch {
        // A conversation file can be mid-write.
      } finally {
        closeQuietly(db)
      }
    }
  }

  const transcript = path.join(root, 'brain', rawId, '.system_generated', 'logs', 'transcript.jsonl')
  if (await exists(transcript)) {
    sawStore = true
    try {
      const raw = await readFrom(transcript, 0, 512_000)
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        let parsed: Record<string, unknown> | undefined
        try {
          parsed = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (!parsed || typeof parsed !== 'object') continue
        const stepIndex = typeof parsed.step_index === 'number' ? parsed.step_index : null
        if (since != null && stepIndex !== null && stepIndex <= since) continue
        if (parsed.type !== 'USER_INPUT' && parsed.type !== 'SYSTEM_MESSAGE') continue
        if (jsonContainsText(parsed.content, text)) return { check: 'confirmed' }
      }
    } catch {
      // Transcript can be mid-write.
    }
  }

  // When a step mark was captured before sending, only confirm against
  // conversation_summaries if its last_user_input_step_index actually advanced
  // past `since`, and never fall through to un-marked FTS text after already
  // inspecting the conversation steps DB.
  const summaries = path.join(root, 'conversation_summaries.db')
  if (!(since != null && readSteps) && (await exists(summaries))) {
    sawStore = true
    const db = await openStore(summaries)
    if (db) {
      try {
        const tables = tableNames(db)
        let summaryStepAdvanced = since == null
        if (tables.has('conversation_summaries')) {
          const row = db
            .prepare(
              `select last_user_input_step_index as idx, preview, raw_summary from conversation_summaries
               where conversation_id = ? limit 1`
            )
            .get(rawId) as { idx?: number; preview?: unknown; raw_summary?: unknown } | undefined
          if (since != null) {
            summaryStepAdvanced = row?.idx != null && Number(row.idx) > since
          }
          if (
            summaryStepAdvanced &&
            row &&
            (containsText(toText(row.preview), text) || containsText(toText(row.raw_summary), text))
          ) {
            return { check: 'confirmed' }
          }
        }
        if (summaryStepAdvanced && tables.has('conversations_fts')) {
          const rows = db
            .prepare(
              `select user_body from conversations_fts
               where conversation_id = ? and length(user_body) > 0 order by rowid desc limit 20`
            )
            .all(rawId) as { user_body: unknown }[]
          if (rows.some((row) => containsText(toText(row.user_body), text))) {
            return { check: 'confirmed' }
          }
        }
      } catch {
        // Summaries are rewritten while a turn runs.
      } finally {
        closeQuietly(db)
      }
    }
  }

  if (!sawStore) {
    return { check: 'unavailable', reason: 'Anti Gravity’s conversation store was not found.' }
  }
  if (readSteps) {
    return {
      check: 'missing',
      reason: 'The Anti Gravity command finished, but that message is not in this conversation’s steps.'
    }
  }
  return {
    check: 'unavailable',
    reason:
      'The Anti Gravity command finished, but this conversation’s store could not be read, so delivery is unconfirmed.'
  }
}

// ----------------------------------------------------------------- generic

async function confirmInSqlite(
  dbPath: string,
  rawId: string,
  text: string,
  preferredTables: string[],
  onlyPreferred: boolean
): Promise<DeliveryReport> {
  const db = await openStore(dbPath)
  if (!db) return { check: 'unavailable', reason: 'The session database could not be opened.' }
  try {
    const names = tableNames(db)
    const ordered = onlyPreferred
      ? preferredTables.filter((name) => names.has(name))
      : [
          ...preferredTables.filter((name) => names.has(name)),
          ...[...names].filter((name) => !preferredTables.includes(name) && !name.startsWith('sqlite_'))
        ]
    let searched = false
    for (const table of ordered) {
      let columns: { name: string }[]
      try {
        columns = db.prepare(`pragma table_info(${quoteIdent(table)})`).all() as { name: string }[]
      } catch {
        continue
      }
      const columnNames = columns.map((column) => column.name)
      const idColumn = columnNames.find((name) =>
        ['session_id', 'sessionid', 'thread_id', 'conversation_id', 'id'].includes(name.toLowerCase())
      )
      const textColumns = columnNames.filter(
        (name) => /data|text|content|message|body|part/i.test(name) && !/preview|title|summary|count/i.test(name)
      )
      if (!idColumn || textColumns.length === 0) continue
      searched = true
      const projection = textColumns.map(quoteIdent).join(', ')
      let rows: Record<string, unknown>[]
      try {
        rows = db
          .prepare(`select ${projection} from ${quoteIdent(table)} where ${quoteIdent(idColumn)} = ? limit 400`)
          .all(rawId) as Record<string, unknown>[]
      } catch {
        continue
      }
      for (const row of rows) {
        for (const value of Object.values(row)) {
          const raw = toText(value)
          if (!containsText(raw, text)) continue
          if (jsonContainsText(parseJson(raw) ?? raw, text)) return { check: 'confirmed' }
          if (containsText(raw, text) && !raw.trim().startsWith('{')) return { check: 'confirmed' }
        }
      }
    }
    if (!searched) {
      return { check: 'unavailable', reason: 'The session database has no readable message table.' }
    }
    return { check: 'missing', reason: 'The command finished, but that message is not in this session.' }
  } catch {
    return { check: 'unavailable', reason: 'The session database could not be read.' }
  } finally {
    closeQuietly(db)
  }
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Unexpected column')
  return `"${name}"`
}

// --------------------------------------------------------------- public API

export async function captureDeliveryMark(
  provider: SessionProvider,
  rawId: string,
  options?: DeliveryOptions
): Promise<DeliveryMark | undefined> {
  const mark = await readMark(provider, rawId, options)
  return mark ? { ...mark, startedAt: Date.now() } : undefined
}

async function readMark(
  provider: SessionProvider,
  rawId: string,
  options?: DeliveryOptions
): Promise<DeliveryMark | undefined> {
  const base = home(options)
  try {
    if (provider === 'opencode') {
      const db = await openStore(openCodeDatabase(base))
      if (!db) return undefined
      try {
        if (!tableNames(db).has('session_message')) return undefined
        const row = db
          .prepare('select coalesce(max(seq), 0) as seq from session_message where session_id = ?')
          .get(rawId) as { seq?: number } | undefined
        return { openCodeSeq: Number(row?.seq || 0) }
      } finally {
        closeQuietly(db)
      }
    }
    if (provider === 'codex' || provider === 'claude') {
      const files =
        provider === 'codex'
          ? await codexRollouts(rawId, base)
          : await claudeTranscripts(rawId, base)
      const marks: DeliveryFileMark[] = []
      for (const file of files) {
        const size = await fileSize(file)
        marks.push({ path: file, size: size ?? 0 })
      }
      return { files: marks }
    }
    if (provider === 'antigravity') {
      const convDb = await openStore(path.join(antiGravityRoot(base), 'conversations', `${rawId}.db`))
      if (convDb) {
        try {
          const row = convDb.prepare('select max(idx) as idx from steps').get() as { idx?: number | null } | undefined
          if (row?.idx != null) return { stepIndex: Number(row.idx) }
        } catch {
          // Fall back to conversation_summaries below.
        } finally {
          closeQuietly(convDb)
        }
      }
      const db = await openStore(path.join(antiGravityRoot(base), 'conversation_summaries.db'))
      if (!db) return undefined
      try {
        const row = db
          .prepare('select last_user_input_step_index as idx from conversation_summaries where conversation_id = ?')
          .get(rawId) as { idx?: number } | undefined
        if (row?.idx == null || Number(row.idx) < 0) return undefined
        return { stepIndex: Number(row.idx) }
      } finally {
        closeQuietly(db)
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/** A stale session row sends a message into nothing, so check the store first.
 * "unknown" means the store could not be read at all: that must never block a
 * send, only a definite absence does. */
export type SessionPresence = 'exists' | 'gone' | 'unknown'

export async function sessionPresence(
  provider: SessionProvider,
  rawId: string,
  options?: DeliveryOptions
): Promise<SessionPresence> {
  const base = home(options)
  if (provider === 'codex') {
    if ((await codexRollouts(rawId, base)).length > 0) return 'exists'
    const stateFile = await newestMatch(path.join(base, '.codex'), /^state_(\d+)\.sqlite$/)
    if (!stateFile) return 'unknown'
    const db = await openStore(stateFile)
    if (!db) return 'unknown'
    try {
      return db.prepare('select 1 as hit from threads where id = ? limit 1').get(rawId)
        ? 'exists'
        : 'gone'
    } catch {
      return 'unknown'
    } finally {
      closeQuietly(db)
    }
  }
  if (provider === 'opencode') {
    const dbPath = openCodeDatabase(base)
    if (!(await exists(dbPath))) return 'unknown'
    const db = await openStore(dbPath)
    if (!db) return 'unknown'
    try {
      return db.prepare('select 1 as hit from session_v2 where id = ? limit 1').get(rawId)
        ? 'exists'
        : 'gone'
    } catch {
      return 'unknown'
    } finally {
      closeQuietly(db)
    }
  }
  if (provider === 'claude') {
    const root = path.join(base, '.claude', 'projects')
    if (!(await fs.stat(root).then((stat) => stat.isDirectory()).catch(() => false))) {
      return 'unknown'
    }
    return (await claudeTranscripts(rawId, base)).length > 0 ? 'exists' : 'gone'
  }
  if (provider === 'antigravity') {
    if (await exists(path.join(antiGravityRoot(base), 'conversations', `${rawId}.db`))) return 'exists'
    const summaries = path.join(antiGravityRoot(base), 'conversation_summaries.db')
    if (!(await exists(summaries))) return 'unknown'
    const db = await openStore(summaries)
    if (!db) return 'unknown'
    try {
      return db
        .prepare('select 1 as hit from conversation_summaries where conversation_id = ? limit 1')
        .get(rawId)
        ? 'exists'
        : 'gone'
    } catch {
      return 'unknown'
    } finally {
      closeQuietly(db)
    }
  }
  return 'unknown'
}

async function verifyOnce(
  provider: SessionProvider,
  rawId: string,
  text: string,
  options?: DeliveryOptions
): Promise<DeliveryReport> {
  if (provider === 'opencode') return confirmOpenCode(rawId, text, options)
  if (provider === 'codex') return confirmCodex(rawId, text, options)
  if (provider === 'antigravity') return confirmAntiGravity(rawId, text, options)
  if (provider === 'claude') return confirmClaude(rawId, text, options)
  return { check: 'unavailable', reason: 'Notch cannot read a session store for this provider.' }
}

export async function confirmDeliveredMessage(
  provider: SessionProvider,
  rawId: string,
  message: string,
  options?: DeliveryOptions
): Promise<DeliveryReport> {
  const text = message.trim()
  if (!rawId || !text) {
    return { check: 'unavailable', reason: 'Notch did not have a session id to check.' }
  }
  const retryMs = options?.retryMs ?? DEFAULT_RETRY_MS
  const deadline = Date.now() + retryMs
  let report = await verifyOnce(provider, rawId, text, options)
  while (report.check !== 'confirmed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    report = await verifyOnce(provider, rawId, text, options)
  }
  return report
}
