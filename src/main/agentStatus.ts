/**
 * A tiny, local-only bridge between Notch and the hooks that Claude Code,
 * Codex and Cursor can call. It has no cloud component: hooks POST to
 * 127.0.0.1 with a token, and Notch shows what the tool is doing.
 *
 * Permission requests are held open until the user clicks Approve or Deny in
 * the notch, then the hook response carries that decision back to the tool.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type {
  AgentPermission,
  AgentSnapshot,
  AgentState,
  AgentStatus,
  AgentTool
} from '../shared/types'

const TOOLS: AgentTool[] = ['claude', 'codex', 'cursor']
const STATES: AgentState[] = ['working', 'waiting', 'done']
const MAX_BODY = 1024 * 1024
const HOLD_MS = 4 * 60 * 1000
const TITLE_KEYS = [
  'tool_name',
  'command',
  'agent_message',
  'description',
  'subagent_type',
  'task',
  'prompt',
  'hook_event_name',
  'source',
  'status',
  'name',
  'title'
]
const DETAIL_KEYS = [
  'tool_input',
  'command',
  'prompt',
  'task',
  'description',
  'last_assistant_message',
  'last_agent_message',
  'reason',
  'agent_message',
  'cwd'
]

export const agentStatusEvents = new EventEmitter()

let server: Server | null = null
let port = 0
let token = ''
let error: string | null = null

const statuses = new Map<AgentTool, AgentStatus>()
interface Held {
  item: AgentPermission
  res: ServerResponse
  timer: NodeJS.Timeout
}
const held = new Map<string, Held>()

function clean(value: unknown, max: number): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim().slice(0, max)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function summarize(raw: unknown): { title: string; detail: string } {
  if (!raw || typeof raw !== 'object') return { title: '', detail: '' }
  const row = raw as Record<string, unknown>
  let title = ''
  let detail = ''
  for (const key of TITLE_KEYS) {
    const value = row[key]
    if (value !== undefined && value !== null && value !== '') {
      title = typeof value === 'object' ? JSON.stringify(value) : String(value)
      break
    }
  }
  for (const key of DETAIL_KEYS) {
    const value = row[key]
    if (value !== undefined && value !== null && value !== '') {
      detail = typeof value === 'object' ? JSON.stringify(value) : String(value)
      break
    }
  }
  return { title: clean(title, 320), detail: clean(detail, 1200) }
}

function emit(): void {
  agentStatusEvents.emit('change', snapshot())
}

export function snapshot(): AgentSnapshot {
  return {
    statuses: [...statuses.values()].sort((a, b) => b.at - a.at),
    pending: [...held.values()].map((entry) => entry.item).sort((a, b) => a.at - b.at),
    port,
    token,
    running: Boolean(server?.listening),
    error
  }
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers['x-notch-token'] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '')
  const given = typeof header === 'string' ? header : ''
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('Too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req)
  if (!text.trim()) return {}
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

function decisionFor(tool: AgentTool, reply: 'allow' | 'deny', title: string): object {
  if (tool === 'cursor') {
    return {
      continue: true,
      permission: reply,
      user_message: `Decided in Notch: ${title || 'tool use'}`,
      agent_message: `The user ${reply === 'allow' ? 'approved' : 'denied'} this in Notch.`
    }
  }
  if (tool === 'codex') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: reply,
          ...(reply === 'deny' ? { message: 'Denied in Notch.' } : {})
        }
      }
    }
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: reply,
      permissionDecisionReason: `Decided in Notch: ${title || 'tool use'}`
    }
  }
}

function finish(id: string, reply: 'allow' | 'deny' | null): void {
  const entry = held.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  held.delete(id)
  const { item, res } = entry
  if (reply) {
    statuses.set(item.tool, {
      tool: item.tool,
      state: reply === 'allow' ? 'working' : 'done',
      title: reply === 'allow' ? 'Approved in Notch' : 'Denied in Notch',
      detail: item.title,
      at: Date.now()
    })
  }
  if (!res.writableEnded) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(reply ? decisionFor(item.tool, reply, item.title) : {}))
  }
  emit()
}

export function decide(id: string, reply: 'allow' | 'deny'): void {
  if (reply !== 'allow' && reply !== 'deny') throw new Error('Invalid decision.')
  if (!held.has(id)) throw new Error('That request is no longer waiting.')
  finish(id, reply)
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // The bridge is loopback-only and token-guarded, so a browser page on the
  // desktop can safely check its own status without a preflight failure.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }
  if (!authorized(req)) {
    res.writeHead(401).end('Invalid token.')
    return
  }
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const tool = url.searchParams.get('tool') as AgentTool | null
  const kind = url.searchParams.get('kind')
  const knownTool = tool && TOOLS.includes(tool) ? tool : null

  try {
    if (req.method === 'GET' && url.pathname === '/status') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(snapshot()))
      return
    }

    if (req.method === 'POST' && url.pathname === '/decision') {
      const body = await jsonBody(req)
      if (typeof body.id !== 'string' || (body.reply !== 'allow' && body.reply !== 'deny')) {
        res.writeHead(400).end('Invalid decision.')
        return
      }
      try {
        decide(body.id, body.reply)
        res.writeHead(204).end()
      } catch (cause) {
        res.writeHead(409).end(cause instanceof Error ? cause.message : 'Request closed.')
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/hook' && knownTool && kind) {
      const body = await jsonBody(req)
      const summary = summarize(body)
      if (kind === 'permission') {
        const id = randomBytes(9).toString('hex')
        const item: AgentPermission = {
          id,
          tool: knownTool,
          title: summary.title || `${knownTool} wants to run a tool`,
          detail: summary.detail,
          at: Date.now()
        }
        statuses.set(knownTool, {
          tool: knownTool,
          state: 'waiting',
          title: item.title,
          detail: item.detail,
          at: item.at
        })
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        const timer = setTimeout(() => finish(id, null), HOLD_MS)
        timer.unref?.()
        held.set(id, { item, res, timer })
        emit()
        return
      }
      if (STATES.includes(kind as AgentState)) {
        const state = kind as AgentState
        const labels: Record<AgentState, string> = {
          working: 'Working',
          waiting: 'Waiting for you',
          done: 'Done'
        }
        statuses.set(knownTool, {
          tool: knownTool,
          state,
          title: summary.title || labels[state],
          detail: summary.detail,
          at: Date.now()
        })
        emit()
        res.writeHead(204).end()
        return
      }
    }

    res.writeHead(404).end('No such hook.')
  } catch {
    if (!res.writableEnded) res.writeHead(400).end('Invalid hook payload.')
  }
}

export function agentStatusStart(listenPort: number, listenToken: string): void {
  agentStatusStop()
  port = listenPort
  token = listenToken
  error = null
  const next = createServer((req, res) => {
    void handle(req, res)
  })
  next.on('error', (cause: NodeJS.ErrnoException) => {
    error =
      cause.code === 'EADDRINUSE'
        ? `Port ${listenPort} is already in use.`
        : 'The local status bridge could not start.'
    emit()
  })
  server = next
  next.listen(listenPort, '127.0.0.1', () => {
    error = null
    emit()
  })
  emit()
}

export function agentStatusStop(): void {
  for (const id of [...held.keys()]) finish(id, null)
  const old = server
  server = null
  if (old) {
    old.close()
    old.closeAllConnections()
  }
  emit()
}

/** The PowerShell one-liner a hook runs. Encoded so any shell can launch it. */
function hookCommand(kind: 'working' | 'done' | 'permission', url: string, tokenValue: string): string {
  const timeout = kind === 'permission' ? 250 : 10
  const script =
    `$body=[Console]::In.ReadToEnd()` +
    `;$headers=@{'X-Notch-Token'='${tokenValue}'}` +
    `;try{$reply=Invoke-RestMethod -Uri '${url}' -Method Post -Headers $headers -Body $body -ContentType 'application/json' -TimeoutSec ${timeout}` +
    `;if($reply){$reply|ConvertTo-Json -Compress -Depth 8}else{'{}'}}catch{'{}'}`
  return `powershell -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}

export function setupSnippet(tool: AgentTool, listenPort: number, tokenValue: string): string {
  const base = `http://127.0.0.1:${listenPort}/hook?tool=${tool}`
  const working = hookCommand('working', `${base}&kind=working`, tokenValue)
  const done = hookCommand('done', `${base}&kind=done`, tokenValue)
  const permission = hookCommand('permission', `${base}&kind=permission`, tokenValue)

  if (tool === 'claude') {
    // Merge these `hooks` into ~/.claude/settings.json.
    return JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: working, timeout: 10 }] }],
          PreToolUse: [{ hooks: [{ type: 'command', command: permission, timeout: 250 }] }],
          Stop: [{ hooks: [{ type: 'command', command: done, timeout: 10 }] }]
        }
      },
      null,
      2
    )
  }
  if (tool === 'codex') {
    // Paste into ~/.codex/config.toml. Codex asks you to trust new hooks once.
    return [
      '[[hooks.UserPromptSubmit.hooks]]',
      'type = "command"',
      `command = '${working}'`,
      'timeout = 10',
      '',
      '[[hooks.PermissionRequest.hooks]]',
      'type = "command"',
      `command = '${permission}'`,
      'timeout = 250',
      '',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      `command = '${done}'`,
      'timeout = 10'
    ].join('\n')
  }
  // Paste into ~/.cursor/hooks.json.
  return JSON.stringify(
    {
      version: 1,
      hooks: {
        sessionStart: [{ command: working }],
        beforeShellExecution: [{ command: permission, timeout: 250 }],
        stop: [{ command: done }]
      }
    },
    null,
    2
  )
}
