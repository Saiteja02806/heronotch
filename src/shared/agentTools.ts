import type {
  AgentQuestion,
  AgentSnapshot,
  AgentTool,
  AppPresence,
  PendingApproval,
  QuestionTool,
  SessionProvider,
  SessionsSnapshot
} from './types'

export interface AgentToolMeta {
  id: AgentTool
  label: string
  shortLabel: string
  provider: SessionProvider
  configHint: string
}

export const AGENT_TOOL_META: AgentToolMeta[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    shortLabel: 'Claude',
    provider: 'claude',
    configHint: '~/.claude/settings.json'
  },
  {
    id: 'codex',
    label: 'Codex',
    shortLabel: 'Codex',
    provider: 'codex',
    configHint: '~/.codex/config.toml'
  },
  {
    id: 'antigravity',
    label: 'Anti Gravity',
    shortLabel: 'Anti Gravity',
    provider: 'antigravity',
    configHint: '~/.gemini/config/hooks.json'
  },
  {
    id: 'cursor',
    label: 'Cursor',
    shortLabel: 'Cursor',
    provider: 'cursor',
    configHint: '~/.cursor/hooks.json'
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    shortLabel: 'Gemini',
    provider: 'gemini',
    configHint: '~/.gemini/settings.json'
  },
  {
    id: 'cline',
    label: 'Cline',
    shortLabel: 'Cline',
    provider: 'cline',
    configHint: '~/Documents/Cline/Rules/Hooks'
  },
  {
    id: 'copilot',
    label: 'Copilot',
    shortLabel: 'Copilot',
    provider: 'copilot',
    configHint: '.github/hooks/notch.json'
  }
]

const META_BY_ID = Object.fromEntries(AGENT_TOOL_META.map((item) => [item.id, item])) as Partial<
  Record<AgentTool, AgentToolMeta>
>

export function agentToolLabel(tool: QuestionTool): string {
  if (tool === 'opencode') return 'OpenCode'
  if (tool === 'deepai') return 'DeepAI Code'
  if (tool === 'grok') return 'Grok Bot'
  return META_BY_ID[tool]?.label || tool
}

export function agentToolShortLabel(tool: QuestionTool): string {
  if (tool === 'opencode') return 'OpenCode'
  if (tool === 'deepai') return 'DeepAI'
  if (tool === 'grok') return 'Grok'
  return META_BY_ID[tool]?.shortLabel || tool
}

export function agentToolProvider(tool: AgentTool): SessionProvider {
  if (tool === 'deepai') return 'deepai'
  if (tool === 'grok') return 'grok'
  return META_BY_ID[tool]?.provider || tool
}

export function agentToolHint(tool: AgentTool): string {
  if (tool === 'deepai') return '~/.deepai-code/userdata/statev2.sqlite'
  if (tool === 'grok') return '%APPDATA%/Grok Bot/sand-client-persistence'
  return META_BY_ID[tool]?.configHint || 'hooks config'
}

/** Providers whose session stores directly report active vs idle turns. */
export const SCANNED_ACTIVE_PROVIDERS = new Set<SessionProvider>([
  'antigravity',
  'claude',
  'codex',
  'cursor',
  'deepai',
  'grok',
  'opencode'
])

/** Desktop-only coding apps whose process count reflects whether any instance is open. */
export const DESKTOP_PROCESS_PROVIDERS = new Set<SessionProvider>([
  'antigravity',
  'cursor',
  'deepai',
  'grok',
  'windsurf'
])

/** Grace window allowing a hook status before a subsequent session scan overrides it. */
export const HOOK_SCAN_GRACE_MS = 15_000

/** Max lifetime for hook-only `working` statuses that lack direct session scanning. */
export const UNSCANNED_WORKING_TTL_MS = 2 * 60_000

export interface ActiveAgentsInput {
  sessions: SessionsSnapshot | null | undefined
  agentSnapshot?: AgentSnapshot | null
  questions?: AgentQuestion[]
  openCodePending?: PendingApproval[]
  now?: number
}

/** Counts currently active non-subagent coding chats plus live un-scanned hook tools. */
export function countActiveAgents({
  sessions,
  agentSnapshot,
  questions = [],
  openCodePending = [],
  now = Date.now()
}: ActiveAgentsInput): number {
  const allSessions = sessions?.sessions || []
  const activeSessions = allSessions.filter((session) => session.active && !session.subagent)
  const activeProviders = new Set<SessionProvider>(activeSessions.map((session) => session.provider))
  const extraTools = new Set<SessionProvider>()

  for (const item of agentSnapshot?.pending || []) {
    const provider = agentToolProvider(item.tool)
    if (!activeProviders.has(provider)) extraTools.add(provider)
  }
  for (const q of questions) {
    const provider = q.tool === 'opencode' ? 'opencode' : agentToolProvider(q.tool)
    if (!activeProviders.has(provider)) extraTools.add(provider)
  }
  if (openCodePending.length > 0 && !activeProviders.has('opencode')) {
    extraTools.add('opencode')
  }

  const latestIdleByProvider = new Map<SessionProvider, number>()
  for (const session of allSessions) {
    if (session.active || session.subagent) continue
    const prev = latestIdleByProvider.get(session.provider) || 0
    if (session.updatedAt > prev) latestIdleByProvider.set(session.provider, session.updatedAt)
  }

  const apps = sessions?.apps || []
  const hasProcessInfo = apps.some((app) => app.processCount > 0)
  const appByProvider = new Map<SessionProvider, AppPresence>(apps.map((app) => [app.provider, app]))

  for (const status of agentSnapshot?.statuses || []) {
    if (status.state !== 'working') continue
    const provider = agentToolProvider(status.tool)
    if (activeProviders.has(provider) || extraTools.has(provider)) continue

    if (hasProcessInfo && DESKTOP_PROCESS_PROVIDERS.has(provider)) {
      const app = appByProvider.get(provider)
      if (!app || app.processCount === 0) continue
    }

    if (now - status.at > UNSCANNED_WORKING_TTL_MS) continue

    if (SCANNED_ACTIVE_PROVIDERS.has(provider)) {
      const newerIdle = (latestIdleByProvider.get(provider) || 0) > status.at
      const scannedPastGrace =
        Boolean(sessions) && !sessions?.error && (sessions?.scannedAt || 0) - status.at > HOOK_SCAN_GRACE_MS
      if (newerIdle || scannedPastGrace) continue
    }

    extraTools.add(provider)
  }

  return activeSessions.length + extraTools.size
}

