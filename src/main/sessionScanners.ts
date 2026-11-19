import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CodingSession, SessionProvider } from '../shared/types'

/**
 * Editors and agents keep their conversations in their own stores. None of them
 * share a format, so each reader here is separate and defensive: a store that
 * is missing, locked or in an unknown shape contributes nothing instead of
 * breaking the scan.
 *
 * Providers that keep no readable local conversation (JetBrains AI Assistant,
 * the Copilot CLI, Aider) are intentionally absent — they cannot be listed
 * honestly.
 */

const MAX_PER_PROVIDER = 12

function appData(): string {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
}

function baseName(directory: string | null): string | null {
  if (!directory) return null
  const cleaned = directory.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '')
  const parts = cleaned.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || cleaned || null
}

/** Titles come from user text: strip markdown noise and collapse whitespace. */
function cleanTitle(value: unknown, fallback: string): string {
  const raw = String(value ?? '')
  const text = raw
    .replace(/\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[#>*\-\s]+/, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
  if (!text) return fallback
  return text.length > 86 ? `${text.slice(0, 84).trimEnd()}…` : text
}

async function isFile(file: string): Promise<boolean> {
  return fs.stat(file).then((stat) => stat.isFile()).catch(() => false)
}

async function isDir(dir: string): Promise<boolean> {
  return fs.stat(dir).then((stat) => stat.isDirectory()).catch(() => false)
}

async function openDb(file: string): Promise<DatabaseSync | null> {
  try {
    return new DatabaseSync(file, { readOnly: true })
  } catch {
    return null
  }
}

function closeQuietly(db: DatabaseSync | null): void {
  try {
    db?.close()
  } catch {
    // Already closed.
  }
}

function session(input: {
  provider: SessionProvider
  origin: string
  rawId: string
  title: unknown
  fallbackTitle: string
  directory: string | null
  project?: string | null
  model?: string | null
  detail?: string | null
  updatedAt: number
  active?: boolean
  subagent?: boolean
}): CodingSession {
  return {
    id: `${input.provider}-${input.rawId}`,
    rawId: input.rawId,
    provider: input.provider,
    title: cleanTitle(input.title, input.fallbackTitle),
    project: input.project ?? baseName(input.directory),
    directory: input.directory,
    model: input.model ?? null,
    detail: input.detail ?? null,
    updatedAt: input.updatedAt,
    active: input.active === true,
    subagent: input.subagent === true,
    origin: input.origin
  }
}

// ------------------------------------------------------------------ Cursor

/** Cursor keeps the real composers in state.vscdb: cursorDiskKV holds one
 * composerData:<id> record per chat with its name, folder and timestamps.
 * conversation-search.db only indexes cloud chats, so it is a fallback. */
async function scanCursor(): Promise<CodingSession[]> {
  const root = path.join(appData(), 'Cursor')
  const globalDb = path.join(root, 'User', 'globalStorage', 'state.vscdb')
  const found: CodingSession[] = []
  const seen = new Set<string>()

  const db = (await isFile(globalDb)) ? await openDb(globalDb) : null
  if (db) {
    try {
      const headers = new Map<string, { archived: boolean; subagent: boolean; type: string }>()
      const headerRows = db
        .prepare('select composerId, isArchived, isSubagent, subagentTypeName from composerHeaders')
        .all() as { composerId: string; isArchived: number; isSubagent: number; subagentTypeName: string }[]
      for (const row of headerRows) {
        headers.set(String(row.composerId), {
          archived: Number(row.isArchived) === 1,
          subagent: Number(row.isSubagent) === 1,
          type: String(row.subagentTypeName || '')
        })
      }
      const rows = db
        .prepare("select key, value from cursorDiskKV where key glob 'composerData:*'")
        .all() as { key: string; value: string }[]
      for (const row of rows) {
        const parsed = safeJson(row.value) as {
          composerId?: string
          name?: string
          status?: string
          generatingBubbleIds?: unknown[]
          createdAt?: number
          lastUpdatedAt?: number
          workspaceIdentifier?: { uri?: { fsPath?: string; path?: string } }
        } | null
        if (!parsed) continue
        const rawId = String(parsed.composerId || String(row.key).replace(/^composerData:/, ''))
        if (!rawId || seen.has(rawId)) continue
        const header = headers.get(rawId)
        if (header?.archived) continue
        const directory =
          parsed.workspaceIdentifier?.uri?.fsPath || parsed.workspaceIdentifier?.uri?.path || null
        const title = String(parsed.name || '').trim()
        // Drafts and empty sessions carry no name and no folder.
        if (!title && !directory) continue
        const updatedAt = Number(parsed.lastUpdatedAt || parsed.createdAt) || 0
        const active =
          Date.now() - updatedAt < 10 * 60_000 &&
          (/generating|running|streaming|in_progress/i.test(String(parsed.status || '')) ||
            (Array.isArray(parsed.generatingBubbleIds) && parsed.generatingBubbleIds.length > 0))
        seen.add(rawId)
        let decodedDir: string | null = null
        if (directory) {
          try {
            decodedDir = decodeURIComponent(directory)
          } catch {
            decodedDir = directory
          }
        }
        found.push(
          session({
            provider: 'cursor',
            origin: 'Cursor',
            rawId,
            title,
            fallbackTitle: 'Cursor chat',
            directory: decodedDir,
            updatedAt,
            active,
            subagent: header?.subagent === true,
            detail: header?.type || null
          })
        )
      }
    } catch {
      // Unreadable store.
    } finally {
      closeQuietly(db)
    }
  }

  // Cloud conversations are only ever indexed here.
  const searchDb = path.join(root, 'User', 'globalStorage', 'conversation-search.db')
  const cloud = (await isFile(searchDb)) ? await openDb(searchDb) : null
  if (cloud) {
    try {
      const rows = cloud
        .prepare(
          `select id, title, updated_at, source from conversations
           where is_archived = 0 and length(trim(title)) > 0
           order by updated_at desc limit 24`
        )
        .all() as { id: string; title: string; updated_at: number; source: string | null }[]
      for (const row of rows) {
        const rawId = String(row.id)
        if (!rawId || seen.has(rawId)) continue
        seen.add(rawId)
        found.push(
          session({
            provider: 'cursor',
            origin: 'Cursor',
            rawId,
            title: row.title,
            fallbackTitle: 'Cursor chat',
            directory: null,
            detail: row.source === 'cloud-cache' ? 'Cloud' : null,
            updatedAt: Number(row.updated_at) || 0,
            subagent: /^task-call-/.test(rawId)
          })
        )
      }
    } catch {
      // Unreadable store.
    } finally {
      closeQuietly(cloud)
    }
  }

  return found
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1
      if (a.subagent !== b.subagent) return a.subagent ? 1 : -1
      return b.updatedAt - a.updatedAt
    })
    .slice(0, MAX_PER_PROVIDER)
}

function safeJson(value: unknown): unknown {
  try {
    return typeof value === 'string' ? JSON.parse(value) : null
  } catch {
    return null
  }
}

async function workspaceFolder(dir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'workspace.json'), 'utf8')
    const parsed = JSON.parse(raw) as { folder?: string }
    if (!parsed.folder) return null
    return decodeURIComponent(parsed.folder.replace(/^file:\/\/\//, ''))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- Grok Bot

/** Grok Bot stores its persistence as JSON blobs whose file names are the
 * base32 of the storage key, so the sidebar roster is reachable without
 * touching the app: sand.client.slice.account.<user>.roster.last-roster. */
async function scanGrok(): Promise<CodingSession[]> {
  const dir = path.join(appData(), 'Grok Bot', 'sand-client-persistence')
  if (!(await isDir(dir))) return []
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }

  const roster = new Map<string, CodingSession>()
  const transcripts = new Map<string, { title: string; updatedAt: number }>()
  const rosterFiles: string[] = []
  const transcriptFiles: { file: string; id: string }[] = []

  for (const file of files) {
    if (!file.endsWith('.blob')) continue
    const key = decodeBase32(file.slice(0, -'.blob'.length))
    if (!key.startsWith('sand.client.slice.')) continue
    if (key.endsWith('.roster.last-roster')) {
      rosterFiles.push(file)
      continue
    }
    const transcriptId = key.match(/\.transcript\.replicas\.([0-9a-f-]+)$/)?.[1]
    if (transcriptId) transcriptFiles.push({ file, id: transcriptId })
  }

  for (const file of rosterFiles) {
    let parsed: { value?: { rows?: GrokRow[] } } | null = null
    try {
      parsed = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))
    } catch {
      continue
    }
    for (const row of parsed?.value?.rows || []) {
      if (!row?.id || row.isHiddenFromSidebar === true || row.isGroup === true) continue
      const existing = roster.get(row.id)
      const updatedAt = Number(row.lastActivityAt || row.updatedAt || row.createdAt) || 0
      if (existing && existing.updatedAt >= updatedAt) continue
      roster.set(
        row.id,
        session({
          provider: 'grok',
          origin: 'Grok Bot',
          rawId: row.id,
          title: row.title || row.name,
          fallbackTitle: 'Grok Bot chat',
          directory: null,
          // The bot name is already the title; only a real thread title
          // makes the name worth repeating as the project.
          project: row.title ? row.name || null : null,
          detail: preview(row.lastEntry?.text),
          updatedAt,
          active: updatedAt > 0 && Date.now() - updatedAt < 30 * 60_000 && Boolean(row.awaitingUserResponse)
        })
      )
    }
  }

  // Only inspect transcript blobs that are not already covered by a roster row,
  // and stat first so we read at most the newest candidates.
  const pendingTranscripts = transcriptFiles.filter((entry) => !roster.has(entry.id))
  const sized = await Promise.all(
    pendingTranscripts.map(async (entry) => ({
      ...entry,
      mtime: await fs.stat(path.join(dir, entry.file)).then((s) => s.mtimeMs).catch(() => 0)
    }))
  )
  sized.sort((a, b) => b.mtime - a.mtime)

  for (const { file, id: transcriptId } of sized.slice(0, MAX_PER_PROVIDER * 2)) {
    let parsed: { value?: { entries?: GrokEntry[]; persistedAt?: number } } | null = null
    try {
      parsed = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))
    } catch {
      continue
    }
    if (!parsed) continue
    const entries = parsed.value?.entries || []
    const firstUser = entries.find((entry) => entry.role === 'user' && entry.content)
    let latestStamp = 0
    for (const entry of entries) {
      const stamp = Number(entry.timestampMs) || 0
      if (stamp > latestStamp) latestStamp = stamp
    }
    transcripts.set(transcriptId, {
      title: textOf(firstUser?.content) || textOf(firstUser?.message?.content),
      updatedAt: Number(parsed.value?.persistedAt) || latestStamp
    })
  }

  for (const [id, entry] of transcripts) {
    if (roster.has(id) || !entry.updatedAt) continue
    roster.set(
      id,
      session({
        provider: 'grok',
        origin: 'Grok Bot',
        rawId: id,
        title: entry.title,
        fallbackTitle: 'Grok Bot chat',
        directory: null,
        updatedAt: entry.updatedAt
      })
    )
  }

  return [...roster.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PER_PROVIDER)
}

interface GrokRow {
  id?: string
  name?: string
  title?: string
  createdAt?: number
  updatedAt?: number
  lastActivityAt?: number
  isHiddenFromSidebar?: boolean
  isGroup?: boolean
  awaitingUserResponse?: unknown
  lastEntry?: { text?: string }
}

interface GrokEntry {
  role?: string
  content?: unknown
  timestampMs?: number
  message?: { content?: unknown }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  return stringifyContent(value)
}

function preview(value: unknown): string | null {
  const text = String(value ?? '').trim()
  return text ? text.slice(0, 120) : null
}

/** Storage keys are spelled in RFC 4648 base32, lowercase. */
function decodeBase32(value: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let acc = 0
  const out: number[] = []
  for (const char of value.toLowerCase()) {
    const index = alphabet.indexOf(char)
    if (index < 0) continue
    acc = (acc << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out).toString('utf8')
}

// ---------------------------------------------------------------- Windsurf

/** Cascade writes one encrypted blob per conversation, so only existence, time
 * and the conversation id are readable. */
async function scanWindsurf(): Promise<CodingSession[]> {
  const dir = path.join(os.homedir(), '.codeium', 'windsurf', 'cascade')
  if (!(await isDir(dir))) return []
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const files: { file: string; mtime: number }[] = []
  for (const name of names) {
    if (!name.endsWith('.pb')) continue
    const full = path.join(dir, name)
    const stat = await fs.stat(full).catch(() => null)
    if (stat?.isFile()) files.push({ file: name, mtime: stat.mtimeMs })
  }
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 4)
    .map(({ file, mtime }) =>
      session({
        provider: 'windsurf',
        origin: 'Windsurf',
        rawId: file.replace(/\.pb$/, ''),
        title: '',
        fallbackTitle: 'Windsurf chat',
        directory: null,
        detail: 'stored encrypted',
        updatedAt: mtime
      })
    )
}

// ------------------------------------------------------- VS Code and forks

interface ChatRoot {
  provider: SessionProvider
  origin: string
  dir: string
}

const CHAT_ROOTS: ChatRoot[] = [
  { provider: 'vscode', origin: 'VS Code', dir: 'Code' },
  { provider: 'trae', origin: 'Trae', dir: 'Trae' },
  { provider: 'qoder', origin: 'Qoder', dir: 'Qoder' },
  { provider: 'kiro', origin: 'Kiro', dir: 'Kiro' }
]

interface VsCodeChatFile {
  sessionId?: string
  customTitle?: string
  lastMessageDate?: number
  creationDate?: number
  requests?: { message?: { text?: string } }[]
}

/** VS Code writes one JSON file per chat under workspaceStorage/<id>/chatSessions. */
async function scanVsCodeFamily(): Promise<CodingSession[]> {
  const sessions: CodingSession[] = []
  for (const root of CHAT_ROOTS) {
    const base = path.join(appData(), root.dir, 'User', 'workspaceStorage')
    if (!(await isDir(base))) continue
    let dirs: string[]
    try {
      dirs = await fs.readdir(base)
    } catch {
      continue
    }
    // A chat session file is a whole conversation log, and a busy editor keeps
    // thousands of them. Stat first and parse only the newest handful: reading
    // every log on every scan was the heaviest thing this scan did.
    const candidates: { file: string; mtime: number; folder: string | null }[] = []
    for (const dir of dirs) {
      const store = path.join(base, dir, 'chatSessions')
      if (!(await isDir(store))) continue
      let files: string[]
      try {
        files = await fs.readdir(store)
      } catch {
        continue
      }
      let folder: string | null = null
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const full = path.join(store, file)
        const stat = await fs.stat(full).catch(() => null)
        if (!stat?.isFile()) continue
        if (folder === null) folder = await workspaceFolder(path.join(base, dir))
        candidates.push({ file: full, mtime: stat.mtimeMs, folder })
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    const found: CodingSession[] = []
    for (const candidate of candidates.slice(0, MAX_PER_PROVIDER)) {
      const rawText = await readTextCapped(candidate.file).catch(() => '')
      if (!rawText) continue
      let parsed: VsCodeChatFile | null = null
      try {
        parsed = JSON.parse(rawText) as VsCodeChatFile
      } catch {
        // Files exceeding the readTextCapped byte limit truncate mid-JSON; recover
        // header fields from the prefix rather than silently dropping the session.
        const customTitle = rawText.match(/"customTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]
        const sessionId = rawText.match(/"sessionId"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]
        const firstText = rawText.match(/"message"\s*:\s*\{[^{}]*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]
        const lastDate = rawText.match(/"lastMessageDate"\s*:\s*(\d+)/)?.[1]
        const createdDate = rawText.match(/"creationDate"\s*:\s*(\d+)/)?.[1]
        if (customTitle || sessionId || firstText) {
          const unescape = (v?: string): string | undefined => {
            if (!v) return undefined
            try {
              return JSON.parse(`"${v}"`) as string
            } catch {
              return v
            }
          }
          parsed = {
            sessionId: unescape(sessionId),
            customTitle: unescape(customTitle),
            lastMessageDate: lastDate ? Number(lastDate) : undefined,
            creationDate: createdDate ? Number(createdDate) : undefined,
            requests: firstText ? [{ message: { text: unescape(firstText) } }] : undefined
          }
        }
      }
      if (!parsed) continue
      const first = parsed.requests?.find((request) => request?.message?.text)?.message?.text
      found.push(
        session({
          provider: root.provider,
          origin: root.origin,
          rawId: parsed.sessionId || path.basename(candidate.file).replace(/\.json$/, ''),
          title: parsed.customTitle || first,
          fallbackTitle: `${root.origin} chat`,
          directory: candidate.folder,
          updatedAt: Number(parsed.lastMessageDate || parsed.creationDate) || candidate.mtime
        })
      )
    }
    // The file pick is by mtime, but the row order is by the chat's own time.
    sessions.push(...found.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PER_PROVIDER))
  }
  return sessions
}

// ------------------------------------------------------------- Gemini CLI

/** Gemini CLI stores one JSON file per chat in ~/.gemini/tmp/<project>/chats. */
async function scanGemini(): Promise<CodingSession[]> {
  const root = path.join(os.homedir(), '.gemini', 'tmp')
  if (!(await isDir(root))) return []
  let projects: string[]
  try {
    projects = await fs.readdir(root)
  } catch {
    return []
  }
  const found: CodingSession[] = []
  const candidates: { file: string; mtime: number; directory: string | null }[] = []
  for (const project of projects) {
    const chats = path.join(root, project, 'chats')
    if (!(await isDir(chats))) continue
    // Gemini CLI writes the real project path next to the chat folder.
    const directory =
      (await fs.readFile(path.join(root, project, '.project_root'), 'utf8').catch(() => ''))
        .trim() || null
    let files: string[]
    try {
      files = await fs.readdir(chats)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const full = path.join(chats, file)
      const stat = await fs.stat(full).catch(() => null)
      if (!stat?.isFile()) continue
      candidates.push({ file: full, mtime: stat.mtimeMs, directory })
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  for (const candidate of candidates.slice(0, MAX_PER_PROVIDER)) {
    let text = ''
    try {
      const parsed = JSON.parse(await readTextCapped(candidate.file)) as {
        messages?: { type?: string; role?: string; content?: unknown }[]
      }
      const first = (parsed.messages || []).find((message) => {
        const role = String(message?.type || message?.role || '')
        return /user/i.test(role) && message?.content
      })
      text = stringifyContent(first?.content)
    } catch {
      // Unreadable chat file.
    }
    found.push(
      session({
        provider: 'gemini',
        origin: 'Gemini CLI',
        rawId: path.basename(candidate.file).replace(/\.json$/, ''),
        title: text,
        fallbackTitle: 'Gemini CLI chat',
        directory: candidate.directory,
        updatedAt: candidate.mtime
      })
    )
  }
  return found
}

/** Session stores hold whole transcripts; a title never needs more than the head. */
const MAX_TITLE_READ = 2 * 1024 * 1024

async function readTextCapped(file: string): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat()
    const length = Math.min(stat.size, MAX_TITLE_READ)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === 'string' ? part : String((part as { text?: string })?.text || '')))
      .join(' ')
  }
  const text = (value as { text?: string } | null)?.text
  return typeof text === 'string' ? text : ''
}

// ------------------------------------------------------------------- Zed

/** Zed keeps its agent threads in a small SQLite database, one row per thread
 * with a summary and an RFC 3339 timestamp. */
async function scanZed(): Promise<CodingSession[]> {
  const candidates = Array.from(
    new Set(
      [
        path.join(process.env.LOCALAPPDATA || '', 'Zed', 'threads', 'threads.db'),
        path.join(os.homedir(), 'AppData', 'Local', 'Zed', 'threads', 'threads.db'),
        path.join(os.homedir(), '.local', 'share', 'zed', 'threads', 'threads.db')
      ].filter(Boolean)
    )
  )
  for (const dbPath of candidates) {
    if (!dbPath || !(await isFile(dbPath))) continue
    const db = await openDb(dbPath)
    if (!db) continue
    try {
      const columns = (db.prepare('pragma table_info(threads)').all() as { name: string }[]).map(
        (column) => column.name
      )
      if (!columns.includes('id')) continue
      const summary = columns.includes('summary') ? 'summary' : columns.includes('title') ? 'title' : 'NULL'
      const updated = columns.includes('updated_at') ? 'updated_at' : 'timestamp'
      const parent = columns.includes('parent_id') ? 'parent_id' : 'NULL'
      const rows = db
        .prepare(
          `select id, ${summary} as summary, ${updated} as updated, ${parent} as parent
           from threads order by updated desc limit ${MAX_PER_PROVIDER * 2}`
        )
        .all() as { id: string; summary: string | null; updated: string | number | null; parent: string | null }[]
      return rows.slice(0, MAX_PER_PROVIDER).map((row) =>
        session({
          provider: 'zed',
          origin: 'Zed',
          rawId: String(row.id),
          title: row.summary,
          fallbackTitle: 'Zed thread',
          directory: null,
          updatedAt: Number.isFinite(Number(row.updated))
            ? Number(row.updated)
            : Date.parse(String(row.updated || '')) || 0,
          subagent: Boolean(row.parent)
        })
      )
    } catch {
      // Different schema, nothing to report.
    } finally {
      closeQuietly(db)
    }
  }
  return []
}

// ----------------------------------------------------------------- Cline

/** The Cline extension writes one folder per task with its metadata. */
async function scanCline(): Promise<CodingSession[]> {
  const homes = [
    path.join(appData(), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'),
    path.join(appData(), 'Cursor', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')
  ]
  const sessions: CodingSession[] = []
  for (const root of homes) {
    if (!(await isDir(root))) continue
    let dirs: string[]
    try {
      dirs = await fs.readdir(root)
    } catch {
      continue
    }
    // One folder per task, each holding a full conversation log. Stat every
    // folder, then read the history of the newest handful only.
    const candidates: { full: string; mtime: number }[] = []
    for (const dir of dirs) {
      const full = path.join(root, dir)
      const stat = await fs.stat(full).catch(() => null)
      if (!stat?.isDirectory()) continue
      candidates.push({ full, mtime: stat.mtimeMs })
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    for (const candidate of candidates.slice(0, MAX_PER_PROVIDER)) {
      const full = candidate.full
      let text = ''
      try {
        const api = JSON.parse(await readTextCapped(path.join(full, 'api_conversation_history.json')))
        const first = Array.isArray(api)
          ? api.find((entry: { role?: string; content?: unknown }) => /user/i.test(String(entry?.role)))
          : null
        text = stringifyContent(first?.content)
      } catch {
        // Metadata is optional; the task still exists.
      }
      sessions.push(
        session({
          provider: 'cline',
          origin: 'Cline',
          rawId: path.basename(full),
          title: text,
          fallbackTitle: 'Cline task',
          directory: null,
          updatedAt: candidate.mtime
        })
      )
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PER_PROVIDER)
}

// ------------------------------------------------------------------ public

export async function scanEditorSessions(): Promise<CodingSession[]> {
  const groups = await Promise.all([
    scanCursor().catch(() => []),
    scanWindsurf().catch(() => []),
    scanVsCodeFamily().catch(() => []),
    scanGemini().catch(() => []),
    scanGrok().catch(() => []),
    scanZed().catch(() => []),
    scanCline().catch(() => [])
  ])
  return groups.flat().filter((entry) => entry.updatedAt > 0)
}
