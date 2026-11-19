import { DESKTOP_PROCESS_PROVIDERS } from '../shared/agentTools'
import type { CodingSession, SessionProvider } from '../shared/types'

/** Maximum inactivity age before a DB-reported active turn is treated as stale. */
export const ACTIVE_RECENCY_MS = 30 * 60_000

/** Maximum inactivity age for an unclosed Claude transcript turn. */
export const CLAUDE_ACTIVE_WINDOW_MS = 90_000

/** Maximum age for a live Codex rollout file mtime to count as actively writing. */
export const CODEX_ROLLOUT_LIVE_MS = 20_000

export type TurnSignal = 'open' | 'closed' | 'unknown'

const CLAUDE_OPEN_STOP_REASONS = new Set(['tool_use'])

interface CodexRolloutRecord {
  type?: string
  payload?: {
    type?: string
  }
}

interface ClaudeTailRecord {
  type?: string
  subtype?: string
  timestamp?: string
  message?: {
    stop_reason?: string | null
  }
}

/**
 * Parses the tail of a Codex rollout JSONL file and returns whether the last
 * explicit turn lifecycle event leaves a turn open (`'open'`), closed (`'closed'`),
 * or undetermined (`'unknown'`).
 */
export function parseCodexRolloutTail(tail: string): TurnSignal {
  for (const line of tail.split(/\r?\n/).reverse()) {
    if (!line.startsWith('{')) continue
    let entry: CodexRolloutRecord
    try {
      entry = JSON.parse(line) as CodexRolloutRecord
    } catch {
      continue
    }
    if (entry.type === 'event_msg') {
      const kind = entry.payload?.type
      if (kind === 'task_complete' || kind === 'turn_aborted') return 'closed'
      if (kind === 'task_started' || kind === 'user_message') return 'open'
    } else if (entry.type === 'response_item') {
      const kind = entry.payload?.type
      if (kind === 'function_call' || kind === 'custom_tool_call') return 'open'
    }
  }
  return 'unknown'
}

/** Determines whether a Codex session is currently mid-turn. */
export function isCodexSessionActive({
  status,
  updatedAt,
  rolloutSignal,
  rolloutAgeMs,
  now = Date.now()
}: {
  status: string
  updatedAt: number
  rolloutSignal: TurnSignal
  rolloutAgeMs: number | null
  now?: number
}): boolean {
  if (rolloutSignal === 'closed') return false
  if (rolloutAgeMs !== null && rolloutAgeMs < CODEX_ROLLOUT_LIVE_MS) return true
  return updatedAt > 0 && now - updatedAt < ACTIVE_RECENCY_MS && /progress|running/i.test(status)
}

/**
 * Inspects the tail of a Claude Code `.jsonl` transcript from newest line backward
 * to determine the latest timestamp and whether the latest turn is still open.
 */
export function analyzeClaudeTail(tail: string): { updatedAt: number | null; turnSignal: TurnSignal } {
  let updatedAt: number | null = null
  let turnSignal: TurnSignal = 'unknown'

  for (const line of tail.split(/\r?\n/).reverse()) {
    if (!line.startsWith('{')) continue
    let entry: ClaudeTailRecord
    try {
      entry = JSON.parse(line) as ClaudeTailRecord
    } catch {
      continue
    }

    if (updatedAt === null && entry.timestamp) {
      const parsed = Date.parse(String(entry.timestamp))
      if (Number.isFinite(parsed)) updatedAt = parsed
    }

    if (turnSignal === 'unknown') {
      if (entry.type === 'cost-state') {
        turnSignal = 'closed'
      } else if (entry.type === 'system') {
        if (entry.subtype === 'stop_hook_summary' || entry.subtype === 'turn_duration') {
          turnSignal = 'closed'
        }
      } else if (entry.type === 'assistant') {
        const reason = entry.message?.stop_reason
        turnSignal = reason && !CLAUDE_OPEN_STOP_REASONS.has(reason) ? 'closed' : 'open'
      } else if (
        entry.type === 'user' ||
        entry.type === 'api-request' ||
        entry.type === 'api-request-blob' ||
        entry.type === 'progress'
      ) {
        turnSignal = 'open'
      }
    }

    if (updatedAt !== null && turnSignal !== 'unknown') break
  }

  return { updatedAt, turnSignal }
}

/** Determines whether a Claude Code transcript represents a live non-subagent turn. */
export function isClaudeSessionActive({
  subagent,
  turnSignal,
  updatedAt,
  mtime,
  now = Date.now()
}: {
  subagent: boolean
  turnSignal: TurnSignal
  updatedAt: number
  mtime: number
  now?: number
}): boolean {
  if (subagent || turnSignal === 'closed') return false
  const latestTouch = Math.max(updatedAt, mtime)
  return latestTouch > 0 && now - latestTouch < CLAUDE_ACTIVE_WINDOW_MS
}

/** Determines whether an OpenCode SQLite session row is actively running. */
export function isOpenCodeSessionActive({
  timeBusy,
  timeIdle,
  updatedAt,
  now = Date.now()
}: {
  timeBusy: number | null
  timeIdle: number | null
  updatedAt: number
  now?: number
}): boolean {
  return (
    updatedAt > 0 &&
    now - updatedAt < 10 * 60_000 &&
    timeBusy !== null &&
    (timeIdle === null || timeBusy > timeIdle)
  )
}

/** Determines whether an Antigravity conversation summary row is actively running. */
export function isAntigravitySessionActive({
  status,
  updatedAt,
  now = Date.now()
}: {
  status: string | null | undefined
  updatedAt: number
  now?: number
}): boolean {
  return (
    updatedAt > 0 &&
    now - updatedAt < ACTIVE_RECENCY_MS &&
    /running|busy|canceling|progress|working|streaming/i.test(String(status || ''))
  )
}

/** Determines whether a DeepAI Code session row is actively running. */
export function isDeepAiSessionActive({
  status,
  updatedAt,
  now = Date.now()
}: {
  status: string | null | undefined
  updatedAt: number
  now?: number
}): boolean {
  return (
    updatedAt > 0 &&
    now - updatedAt < ACTIVE_RECENCY_MS &&
    /running|thinking|working|streaming|waiting|pending/i.test(String(status || ''))
  )
}

/** Sorts sessions with active main chats first and keeps up to `limit` per provider. */
export function prioritizeAndCapSessions(sessions: CodingSession[], limit = 10): CodingSession[] {
  const byProvider = new Map<string, CodingSession[]>()
  for (const session of sessions) {
    const list = byProvider.get(session.provider)
    if (list) list.push(session)
    else byProvider.set(session.provider, [session])
  }
  return [...byProvider.values()].flatMap((list) =>
    list
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1
        if (a.subagent !== b.subagent) return a.subagent ? 1 : -1
        return b.updatedAt - a.updatedAt
      })
      .slice(0, limit)
  )
}

/** Clears `active` on desktop-only sessions when a non-empty process list confirms the app is closed. */
export function clearClosedDesktopActivity(
  sessions: CodingSession[],
  runningProviders: Set<SessionProvider>,
  hasProcessSample: boolean
): CodingSession[] {
  if (!hasProcessSample) return sessions
  return sessions.map((session) =>
    session.active && DESKTOP_PROCESS_PROVIDERS.has(session.provider) && !runningProviders.has(session.provider)
      ? { ...session, active: false }
      : session
  )
}
