import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { SessionProvider } from '../shared/types'

/**
 * Anti Gravity's language server writes a hub_<port>.json record for every run.
 * The records outlive the process, and their ports sit in the Windows ephemeral
 * range, so an old record can point at a socket that now belongs to something
 * else. Sending a message means finding the *live* daemon: process identity
 * first, then the port, then its own health endpoint.
 */
export interface AntiGravityTarget {
  address: string
  csrfToken: string
  version: string
  pid: number
}

export interface AntiGravityProbe {
  /** Directory holding the daemon records. */
  base?: string
  /** Pids of the running language server processes. */
  livePids?: () => Promise<Set<number>>
  portOpen?: (port: number) => Promise<boolean>
  /** Any HTTP answer from the language server's health endpoint. */
  health?: (port: number) => Promise<boolean>
}

/** One process listing for every record, instead of a lookup per file. */
export function languageServerPids(): Promise<Set<number>> {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Process -Name language_server -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id'
      ],
      { windowsHide: true, timeout: 4000 },
      (error, stdout) => {
        if (error) return resolve(new Set())
        const pids = String(stdout)
          .split(/\s+/)
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0)
        resolve(new Set(pids))
      }
    )
  })
}

export function isPortOpen(port: number): Promise<boolean> {
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

/** A TCP connect is not proof: this asks the daemon's own endpoint. */
export async function languageServerAnswers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1200)
    })
    await response.body?.cancel().catch(() => undefined)
    return true
  } catch {
    return false
  }
}

interface HubRecord {
  pid: number
  httpPort: number
  csrfToken?: string
  lsVersion?: string
}

export async function findAntiGravityTarget(
  probe: AntiGravityProbe = {}
): Promise<AntiGravityTarget | null> {
  const base = probe.base ?? path.join(os.homedir(), '.gemini', 'antigravity', 'daemon')
  const livePids = probe.livePids ?? languageServerPids
  const portOpen = probe.portOpen ?? isPortOpen
  const health = probe.health ?? languageServerAnswers

  let names: string[] = []
  try {
    names = (await fs.readdir(base)).filter((name) => /^hub_\d+\.json$/.test(name))
  } catch {
    // Anti Gravity has not run yet.
    return null
  }

  const records = await Promise.all(
    names.map(async (name): Promise<{ data: HubRecord; mtime: number } | null> => {
      const full = path.join(base, name)
      const stat = await fs.stat(full).catch(() => null)
      if (!stat) return null
      try {
        const parsed = JSON.parse(await fs.readFile(full, 'utf8')) as {
          pid?: unknown
          httpPort?: unknown
          csrfToken?: unknown
          lsVersion?: unknown
        }
        const port = parsed.httpPort
        const pid = parsed.pid
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null
        if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return null
        return {
          data: {
            pid,
            httpPort: port,
            csrfToken: typeof parsed.csrfToken === 'string' ? parsed.csrfToken : '',
            lsVersion: typeof parsed.lsVersion === 'string' ? parsed.lsVersion : ''
          },
          mtime: stat.mtimeMs
        }
      } catch {
        // A half-written record; ignore it.
        return null
      }
    })
  )

  const ordered = records
    .filter((value): value is { data: HubRecord; mtime: number } => Boolean(value))
    .sort((a, b) => b.mtime - a.mtime)

  if (ordered.length === 0) return null
  const running = await livePids()
  for (const { data } of ordered) {
    if (!running.has(data.pid)) continue
    if (!(await portOpen(data.httpPort))) continue
    if (!(await health(data.httpPort))) continue
    return {
      address: `127.0.0.1:${data.httpPort}`,
      csrfToken: data.csrfToken || '',
      version: data.lsVersion || '',
      pid: data.pid
    }
  }
  return null
}

export function antiGravityEnv(target: AntiGravityTarget): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ANTIGRAVITY_LS_ADDRESS: target.address }
  // The CLI signs its gRPC calls with this token; a live server rejects calls
  // that arrive without it.
  if (target.csrfToken) env.ANTIGRAVITY_CSRF_TOKEN = target.csrfToken
  if (target.version) env.ANTIGRAVITY_LS_VERSION = target.version
  return env
}

const PROVIDER_NAMES: Record<SessionProvider, string> = {
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Anti Gravity',
  claude: 'Claude Code',
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
  other: 'that tool'
}

export function cleanProcessError(output: string): string {
  return output
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-320)
}

/** The agent CLI prints { "response": {}, "error": "..." } and can still exit 0. */
export function jsonFailure(output: string): string | null {
  // The command can print several objects; the last one is its result.
  const close = output.lastIndexOf('}')
  for (let start = output.lastIndexOf('{'); start >= 0; start = output.lastIndexOf('{', start - 1)) {
    for (const slice of close > start ? [output.slice(start), output.slice(start, close + 1)] : [output.slice(start)]) {
      try {
        const parsed = JSON.parse(slice) as { error?: unknown }
        if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim()
        return null
      } catch {
        // Keep trying: the command may append its own trailing text.
      }
    }
  }
  return null
}

export function transportFailure(output: string): boolean {
  return /Error while dialing|connection refused|actively refused|code = Unavailable|transport: connection error/i.test(
    output
  )
}

/** Every provider names a missing conversation differently, and the send has to
 * say the same thing whether the pre-flight check caught it or the CLI did. */
export function sessionGone(output: string): boolean {
  // "thread/resume failed: ... already has an active writer" means the thread is
  // open in Codex Desktop, not that it was deleted.
  if (/active writer/i.test(output)) return false
  return /no rollout found|thread\/resume failed|No conversation found with session ID|conversation not found|session not found|NotFound|not found.*conversation/i.test(
    output
  )
}

export function describeAgentFailure(
  provider: SessionProvider,
  output: string,
  code: number | null
): string {
  const raw = jsonFailure(output) || cleanProcessError(output)
  if (provider === 'antigravity') {
    if (transportFailure(output)) {
      return 'Anti Gravity\u2019s local agent service refused the connection. Open Anti Gravity, wait for it to finish starting, then send again.'
    }
    if (/Unauthenticated|PermissionDenied|permission_denied|csrf token/i.test(raw)) {
      return 'Anti Gravity rejected the request signature. Reopen Anti Gravity so its token is fresh, then send again.'
    }
    const stripped = raw
      .replace(/^rpc error:\s*code = \w+\s*desc =\s*/i, '')
      .replace(/^"|"$/g, '')
      .trim()
    return stripped || 'Anti Gravity did not accept the message.'
  }
  if (/active writer/i.test(raw)) {
    return `That ${PROVIDER_NAMES[provider]} thread is open in the app, which allows only one writer. Notch could not deliver into it. Send it from the app, or close the thread and try again.`
  }
  if (sessionGone(raw)) {
    return `That conversation is no longer in ${PROVIDER_NAMES[provider]}. It was probably deleted or archived, so refresh the session list and open it again.`
  }
  return raw || `Agent command exited with code ${code ?? 'unknown'}.`
}
