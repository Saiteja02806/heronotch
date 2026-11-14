import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionProvider } from '../shared/types'

/**
 * After a provider command exits 0, look for the exact user text in that
 * session's own store. A finished command is not treated as delivery.
 */
export type DeliveryCheck = 'confirmed' | 'missing' | 'unavailable'

export interface DeliveryReport {
  check: DeliveryCheck
  reason?: string
}

export async function confirmDeliveredMessage(
  provider: SessionProvider,
  rawId: string,
  message: string
): Promise<DeliveryReport> {
  const text = message.trim()
  if (!rawId || !text) {
    return { check: 'unavailable', reason: 'Notch did not have a session id to check.' }
  }
  if (provider === 'opencode') return confirmOpenCode(rawId, text)
  if (provider === 'codex') return confirmCodex(rawId, text)
  if (provider === 'antigravity') return confirmAntiGravity(rawId, text)
  return {
    check: 'unavailable',
    reason: 'Notch cannot read a session store for this provider.'
  }
}

function openCodeDatabase(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
}

async function confirmOpenCode(rawId: string, text: string): Promise<DeliveryReport> {
  const dbPath = openCodeDatabase()
  if (!(await exists(dbPath))) {
    return { check: 'unavailable', reason: 'OpenCode’s session database was not found.' }
  }
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db
      .prepare(
        `select part.data as part_data, message.data as message_data
         from part
         join message on message.id = part.message_id
         where part.session_id = ?
         order by part.time_created desc
         limit 400`
      )
      .all(rawId) as { part_data: string; message_data: string }[]
    const found = rows.some((row) => openCodeUserText(row.message_data, row.part_data, text))
    if (found) return { check: 'confirmed' }
    return {
      check: 'missing',
      reason: 'The OpenCode command finished, but that message is not a user turn in this session.'
    }
  } catch {
    if (db) {
      try {
        db.close()
      } catch {
        // Already closed.
      }
      db = null
    }
    return confirmInSqlite(dbPath, rawId, text, ['part', 'message', 'session_message'], true)
  } finally {
    try {
      db?.close()
    } catch {
      // Already closed.
    }
  }
}

function openCodeUserText(messageData: string, partData: string, text: string): boolean {
  let role = ''
  try {
    role = String((JSON.parse(messageData) as { role?: string }).role || '')
  } catch {
    role = ''
  }
  if (role !== 'user') return false
  try {
    const part = JSON.parse(partData) as { type?: string; text?: string }
    if (part.type && part.type !== 'text') return false
    return typeof part.text === 'string' && part.text.includes(text)
  } catch {
    return typeof partData === 'string' && partData.includes(text)
  }
}

async function confirmCodex(rawId: string, text: string): Promise<DeliveryReport> {
  const files = await codexRollouts(rawId)
  if (files.length > 0) {
    for (const file of files) {
      if (await rolloutHasUserText(file, text)) return { check: 'confirmed' }
    }
    return {
      check: 'missing',
      reason: 'The Codex command finished, but that message is not in this thread’s transcript.'
    }
  }

  const stateFile = await newestMatch(path.join(os.homedir(), '.codex'), /^state_(\d+)\.sqlite$/)
  if (!stateFile) {
    return { check: 'unavailable', reason: 'No Codex transcript was found for this thread.' }
  }
  return confirmInSqlite(stateFile, rawId, text, ['messages', 'message', 'thread_messages'], true)
}

async function confirmAntiGravity(rawId: string, text: string): Promise<DeliveryReport> {
  const root = path.join(os.homedir(), '.gemini', 'antigravity')
  const summary = path.join(root, 'conversation_summaries.db')
  const files = [summary]
  try {
    const entries = await fs.readdir(root, { recursive: true })
    for (const entry of entries) {
      const rel = String(entry)
      if (!rel.endsWith('.sqlite') && !rel.endsWith('.db')) continue
      const full = path.join(root, rel)
      if (!files.includes(full)) files.push(full)
      if (files.length > 12) break
    }
  } catch {
    // The Anti Gravity directory may not exist.
  }

  let sawStore = false
  for (const file of files) {
    if (!(await exists(file))) continue
    sawStore = true
    const report = await confirmInSqlite(
      file,
      rawId,
      text,
      ['messages', 'message', 'conversation_messages', 'steps', 'conversation_summaries'],
      true,
      true
    )
    if (report.check === 'confirmed') return report
  }
  if (!sawStore) {
    return { check: 'unavailable', reason: 'Anti Gravity’s conversation store was not found.' }
  }
  return {
    check: 'unavailable',
    reason:
      'The Anti Gravity command finished, but Notch could not find that message in the local conversation store.'
  }
}

async function confirmInSqlite(
  dbPath: string,
  rawId: string,
  text: string,
  preferredTables: string[],
  onlyPreferred: boolean,
  requireUserRole = false
): Promise<DeliveryReport> {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return { check: 'unavailable', reason: 'The session database could not be opened.' }
  }

  try {
    const tables = db
      .prepare("select name from sqlite_master where type = 'table'")
      .all() as { name: string }[]
    const names = new Set(tables.map((table) => table.name))
    const ordered = onlyPreferred
      ? preferredTables.filter((name) => names.has(name))
      : [
          ...preferredTables.filter((name) => names.has(name)),
          ...[...names].filter((name) => !preferredTables.includes(name) && !name.startsWith('sqlite_'))
        ]
    let searched = false
    for (const table of ordered) {
      const columns = db.prepare(`pragma table_info(${quoteIdent(table)})`).all() as { name: string }[]
      const columnNames = columns.map((column) => column.name)
      const idColumn = columnNames.find((name) =>
        ['session_id', 'sessionid', 'thread_id', 'conversation_id', 'id'].includes(name.toLowerCase())
      )
      const textColumns = columnNames.filter(
        (name) =>
          /data|text|content|message|body|part/i.test(name) && !/preview|title|summary|count/i.test(name)
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
      if (rows.some((row) => rowHasUserText(row, text, requireUserRole))) return { check: 'confirmed' }
    }
    if (!searched) {
      return { check: 'unavailable', reason: 'The session database has no readable message table.' }
    }
    return {
      check: 'missing',
      reason: 'The command finished, but that message is not in this session.'
    }
  } catch {
    return { check: 'unavailable', reason: 'The session database could not be read.' }
  } finally {
    try {
      db.close()
    } catch {
      // Already closed.
    }
  }
}

function rowHasUserText(row: Record<string, unknown>, text: string, requireUserRole: boolean): boolean {
  for (const value of Object.values(row)) {
    if (typeof value !== 'string' || !value.includes(text)) continue
    if (requireUserRole) {
      if (valueHasUserRole(value, text)) return true
      continue
    }
    if (value.trim() === text) return true
    try {
      const parsed = JSON.parse(value) as { type?: string; role?: string; text?: string }
      if (typeof parsed.text === 'string' && parsed.text.includes(text)) {
        if (parsed.type && parsed.type !== 'text') continue
        if (parsed.role && parsed.role !== 'user') continue
        return true
      }
    } catch {
      // Plain text column.
    }
    if (/"role"\s*:\s*"user"/.test(value) && value.includes(text)) return true
    if (!value.startsWith('{') && !value.startsWith('[')) return true
  }
  return false
}

/** Anti Gravity stores plain columns that mention the text without it being the user's turn. */
function valueHasUserRole(value: string, text: string, depth = 0): boolean {
  if (depth > 8 || !value.includes(text)) return false
  const trimmed = value.trim()
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 2_000_000) {
    try {
      return jsonHasUserRole(JSON.parse(trimmed) as unknown, text, depth + 1)
    } catch {
      // Not JSON. A user role still has to be visible in the text.
    }
  }
  return /"role"\s*:\s*"user"/i.test(value)
}

function jsonHasUserRole(value: unknown, text: string, depth: number): boolean {
  if (depth > 8 || value == null) return false
  if (typeof value === 'string') return valueHasUserRole(value, text, depth)
  if (Array.isArray(value)) return value.some((item) => jsonHasUserRole(item, text, depth + 1))
  if (typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const role = String(record.role || record.author || record.sender || '').toLowerCase()
  const isUser = role === 'user' || role === 'human'
  if (isUser) {
    for (const key of ['text', 'content', 'message', 'body', 'part']) {
      const item = record[key]
      if (typeof item === 'string' && item.includes(text)) return true
      if (item && typeof item === 'object' && JSON.stringify(item).includes(text)) return true
    }
  }
  return Object.values(record).some((item) => jsonHasUserRole(item, text, depth + 1))
}

/** The thread id is the rollout filename suffix, not a substring of a longer id. */
export function codexRolloutMatches(fileName: string, rawId: string): boolean {
  if (!rawId || !fileName.endsWith('.jsonl')) return false
  const base = fileName.split(/[\\/]/).pop() || fileName
  const stem = base.slice(0, -'.jsonl'.length)
  return stem === rawId || stem.endsWith(`-${rawId}`) || stem.endsWith(`_${rawId}`)
}

async function codexRollouts(rawId: string): Promise<string[]> {
  const root = path.join(os.homedir(), '.codex', 'sessions')
  try {
    const entries = await fs.readdir(root, { recursive: true })
    return entries
      .map((entry) => String(entry))
      .filter((entry) => codexRolloutMatches(entry, rawId))
      .map((entry) => path.join(root, entry))
  } catch {
    return []
  }
}

async function rolloutHasUserText(file: string, text: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file)
    const handle = await fs.open(file, 'r')
    try {
      const length = Math.min(stat.size, 2_000_000)
      const start = stat.size > length ? stat.size - length : 0
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      const raw = buffer.toString('utf8')
      return raw.split(/\r?\n/).some((line) => line.includes(text) && /"role"\s*:\s*"user"/.test(line))
    } finally {
      await handle.close()
    }
  } catch {
    return false
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

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Unexpected column')
  return `"${name}"`
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then((stat) => stat.isFile()).catch(() => false)
}
