import type { SectionPrefs } from './sections'
import type { HomeLayoutPrefs } from './homeLayout'
import type { CalendarApi } from './calendar'
import type { UpdateState } from './updates'
import type { LicenseState } from './license'

export type { UpdateInstallKind, UpdateState, UpdateStatus } from './updates'
export type { LicenseState, LicenseStatus } from './license'

export type Accent =
  | 'obsidian'
  | 'blue'
  | 'orange'
  | 'red'
  | 'coral'
  | 'mint'
  | 'violet'
  | 'ice'
  | 'gold'
  | 'rose'
  | 'emerald'
  | 'custom'

export type TimerMode = 'focus' | 'short' | 'long'

export interface NotchPosition {
  x: number
  y: number
}

export type NotchStyle =
  | 'full'
  | 'compact'
  | 'minimal'
  | 'pill'
  | 'pill-tiny'
  | 'notch-wide'
  | 'notch-micro'

export interface Settings {
  openCodeApprovalPort?: number
  codingReplySound?: boolean
  /** Local hook bridge for coding-tool status and approvals. */
  agentStatus?: boolean
  agentStatusPort?: number
  accent: Accent
  customAccent?: string
  vaultPath: string | null
  hoverDelay: number
  openTrigger: 'hover' | 'click'
  notchPosition: NotchPosition
  notchStyle: NotchStyle
  launchAtLogin: boolean
  notifications: boolean
  timerNotifications: boolean
  spotifyClientId: string
  spotifyRedirectPort: number
  userName: string
  pinOnOpen: boolean
  panelSize: 'full' | 'compact'
  /** Blur and dim the desktop behind the open notch. On unless turned off. */
  focusMode: boolean
  /**
   * Which Windows media session the notch follows.
   * `auto` uses the session that is playing. Anything else is that app's id.
   */
  mediaSource?: string
  /** Hide the tab while another app covers the display the notch is on. On unless turned off. */
  autoHideFullscreen?: boolean
  /** Show the tab only while a supported Windows browser has a window open. */
  browserOnly?: boolean
  /** Display the notch lives on: `primary`, or the id of a connected display. */
  notchDisplay?: string
  /** On a display other than the primary one, shrink the tab to a small pill. */
  pillOnOtherDisplays?: boolean
  /** Process names the tab must never sit on top of, with or without .exe. */
  neverOver?: string[]
  /** Turn off motion in the notch, in addition to the system setting. */
  reduceMotion?: boolean
  /** Quietly check GitHub Releases for newer versions on startup and periodically. */
  autoCheckUpdates?: boolean
  /**
   * Time zone used in the Plan section (`local`, `calendar`, or an IANA zone).
   */
  plannerTimeZone?: string
  /** Whether the first-run collapsed bar welcome intro has already been shown. */
  welcomeSeen?: boolean
  /**
   * Which header sections are on the notch, and in what order.
   * Absent on older saves; filled in from the water switch on load.
   */
  sections?: SectionPrefs
  /**
   * Where the home cards sit. Absent on older saves; the default order is
   * filled in on load.
   */
  homeLayout?: HomeLayoutPrefs
}

export interface NotchDisplay {
  id: string
  label: string
  width: number
  height: number
  primary: boolean
}

export interface TimerState {
  mode: TimerMode
  durations: Record<TimerMode, number>
  endsAt: number | null
  remaining: number
  running: boolean
  sessionsToday: number
  completedToday: number
  dayKey: string
}

export type TaskPriority = 'low' | 'normal' | 'high'

export interface Task {
  id: string
  title: string
  notes?: string
  date: string
  time?: string
  /** IANA time zone in which `date` and `time` were entered. */
  timeZone?: string
  done: boolean
  createdAt: number
  completedAt?: number
  remindAt?: number | null
  notifiedAt?: number | null
  priority: TaskPriority
  /** Google Calendar event this task is mirrored to, when connected. */
  eventId?: string
  eventEtag?: string
}

export interface NotesState {
  lastPath: string | null
  favorites: string[]
}

export interface PostureBaseline {
  neck: number
  tilt: number
  headOffset: number
  lean: number
  headTilt?: number
  forwardHead?: number
  scale?: number
  coverage?: 'upper' | 'full'
  version?: number
}

/** The six signals the 3-step setup records for one pose. */
export interface PostureProfilePose {
  neck: number
  forwardHead: number
  headOffset: number
  tilt: number
  headTilt: number
  scale: number
}

/**
 * What the person's own good, bad and close-to-screen sitting look like to the
 * camera. The score is how far along the line from `good` toward `bad` (or
 * `close`) they are right now, measured in units of their own spread.
 */
export interface PostureProfile {
  version: 1
  good: PostureProfilePose
  bad: PostureProfilePose
  close: PostureProfilePose
  /** Natural wobble of each signal while sitting the good way. */
  spread: PostureProfilePose
  capturedAt: number
}

export interface PostureState {
  enabled: boolean
  notifications: boolean
  threshold: number
  baseline: PostureBaseline | null
  profile: PostureProfile | null
  dayKey: string
  goodSeconds: number
  badSeconds: number
  lastAlertAt: number | null
  /** Finished days, oldest first, so the page can show whether posture is improving. */
  days?: PostureDay[]
}

/** One finished day of posture coaching. */
export interface PostureDay {
  dayKey: string
  goodSeconds: number
  badSeconds: number
}

/** How many finished days are kept. */
export const POSTURE_DAYS_MAX = 90

export const WATER_GOAL_MIN = 1
export const WATER_GOAL_MAX = 16
export const WATER_GLASS_ML = 250
export const WATER_REMINDER_MIN = 0
export const WATER_REMINDER_MAX = 480

export interface WaterState {
  enabled: boolean
  goalGlasses: number
  glassMl: number
  dayKey: string
  pours: number[]
  /** Reminder interval in minutes (0 = off, e.g. 60 for 1h, 120 for 2h). */
  reminderMinutes?: number
  /** Timestamp (ms) when the next water reminder will ring. */
  remindAt?: number | null
}

export interface FocusSession {
  at: number
  minutes: number
}

export interface AppState {
  settings: Settings
  timer: TimerState
  tasks: Task[]
  notes: NotesState
  posture: PostureState
  water: WaterState
  focusLog: FocusSession[]
  spotifyMemory: SpotifyMemory | null
}

export interface AppStatePatch {
  settings?: Partial<Settings>
  timer?: Partial<TimerState>
  tasks?: Task[]
  notes?: Partial<NotesState>
  posture?: Partial<PostureState>
  water?: Partial<WaterState>
  focusLog?: FocusSession[]
  spotifyMemory?: SpotifyMemory | null
}

export type SessionProvider =
  | 'codex'
  | 'opencode'
  | 'antigravity'
  | 'claude'
  | 'cursor'
  | 'windsurf'
  | 'zed'
  | 'vscode'
  | 'jetbrains'
  | 'deepai'
  | 'trae'
  | 'qoder'
  | 'kiro'
  | 'gemini'
  | 'copilot'
  | 'aider'
  | 'cline'
  | 'grok'
  | 'other'

/** AI coding tools that can report status, approvals and questions via Notch's local hook bridge or native store poller. */
export type AgentTool = 'antigravity' | 'claude' | 'codex' | 'cursor' | 'gemini' | 'cline' | 'copilot' | 'deepai' | 'grok'
/** Tools that can show interactive multiple-choice questions in Notch (hook/native tools plus OpenCode). */
export type QuestionTool = AgentTool | 'opencode'
export type AgentState = 'working' | 'waiting' | 'done'

export interface AgentStatus {
  tool: AgentTool
  state: AgentState
  title: string
  detail: string
  at: number
}

export interface AgentPermission {
  id: string
  tool: AgentTool
  title: string
  detail: string
  at: number
}

/** One selectable answer a session is offering, e.g. an AskUserQuestion option. */
export interface AgentQuestionOption {
  label: string
  description: string
}

/** One question step inside a single- or multi-step question prompt. */
export interface AgentQuestionStep {
  id?: string
  title: string
  detail?: string
  options: AgentQuestionOption[]
  multiSelect: boolean
  /** Whether the user may type a custom free-text ("Other") answer. Defaults to true. */
  allowCustom?: boolean
}

/** One step's answer: chosen preset option indices and/or custom typed text. */
export interface AgentQuestionStepAnswer {
  choices: number[]
  customText?: string
}

/** Question response payload: legacy index array(s) or structured step answers supporting custom text. */
export type AgentQuestionResponse = number[] | number[][] | AgentQuestionStepAnswer[]

/** A session asking the user to pick from options instead of approve or deny. */
export interface AgentQuestion {
  id: string
  tool: QuestionTool
  title: string
  detail: string
  options: AgentQuestionOption[]
  multiSelect: boolean
  steps?: AgentQuestionStep[]
  at: number
}

/** How well one coding tool is wired to the notch right now. */
export interface AgentConnection {
  tool: QuestionTool
  label: string
  /** ready: approvals work · idle: installed, open it to connect · attention: Notch needs a fix
   *  limited: shows questions only · missing: not on this PC */
  state: 'ready' | 'idle' | 'attention' | 'limited' | 'missing'
  /** What the user can do or expect, in a short sentence. */
  detail: string
  /** A fix the row can run for the user. */
  action?: 'claude-login'
}

export interface AgentSnapshot {
  statuses: AgentStatus[]
  pending: AgentPermission[]
  questions: AgentQuestion[]
  port: number
  token: string
  running: boolean
  error: string | null
}

export interface CodingSession {
  id: string
  rawId: string
  provider: SessionProvider
  title: string
  project: string | null
  directory: string | null
  model: string | null
  detail: string | null
  updatedAt: number
  active: boolean
  subagent: boolean
  origin: string | null
  /** Messages held back because this session was mid-turn when they were sent. */
  queued?: number
}

export interface AppPresence {
  provider: SessionProvider
  label: string
  running: boolean
  /** working = a session is actively generating; open = the app has a real
   * window; idle = only background processes; closed = nothing at all. */
  state: 'working' | 'open' | 'idle' | 'closed'
  processCount: number
  windowedCount: number
  windowTitle: string | null
  sessions: number
}

export interface SessionsSnapshot {
  sessions: CodingSession[]
  apps: AppPresence[]
  scannedAt: number
  error?: string
}

export interface SessionSendResult {
  sessionId: string
  provider: SessionProvider
  label: string
  /** True only when the message was found afterwards in that session. A queued
   * message is accepted, not delivered. */
  ok: boolean
  status: 'delivered' | 'unconfirmed' | 'failed' | 'queued'
  /** 1-based place in that session's queue, for a queued result. */
  position?: number
  error?: string
  code?: string
}

export interface SessionReplyEvent {
  sessionId: string
  provider: SessionProvider
  label: string
  title: string
  /** assistant: a new assistant turn was read. summary: Anti Gravity only reported the turn finished. */
  evidence: 'assistant' | 'summary'
}

export interface VaultNode {
  name: string
  path: string
  type: 'file' | 'folder'
  ext?: string
  modified?: number
  children?: VaultNode[]
}

export interface NoteSearchResult {
  path: string
  name: string
  snippet: string
}

export interface SpotifyProfile {
  id: string
  name: string
  image: string | null
  product: string
}

export interface SpotifyStatus {
  connected: boolean
  profile: SpotifyProfile | null
  redirectUri: string
  localAvailable: boolean
  localTitle?: string | null
  localArtist?: string | null
  /** Apps currently publishing a Windows media session. */
  mediaSources?: { id: string; label: string }[]
  /** The saved grant is missing a scope this version asks for, usually recently played. */
  needsConsent: boolean
  /** Screenshot-only hint. Absent in normal use. */
  demoPhase?: 'opening' | 'nodevice' | 'premium' | null
}

export interface SpotifyTrack {
  id: string
  name: string
  artists: string
  album: string
  image: string | null
  duration: number
  progress: number
  url: string | null
}

export interface SpotifyDevice {
  id: string
  name: string
  type: string
  active: boolean
  volume: number
}

export interface SpotifyPlayback {
  /** Windows app that supplied the displayed session, including an enriched Spotify session. */
  localSessionId?: string
  controls?: { next?: boolean; previous?: boolean; seek?: boolean }
  connected: boolean
  playing: boolean
  track: SpotifyTrack | null
  device: SpotifyDevice | null
  shuffle: boolean
  repeat: 'off' | 'track' | 'context'
  volume: number
  fetchedAt: number
  source: 'api' | 'local' | 'none'
  queueAvailable: boolean
  contextUri?: string | null
}

export interface SpotifyQueueItem {
  id: string
  uri: string
  name: string
  artists: string
  image: string | null
  duration: number
}

export interface SpotifyRecentItem {
  id: string
  uri: string
  name: string
  artists: string
  image: string | null
  duration: number
  contextUri: string | null
  contextType: 'album' | 'playlist' | 'show' | 'artist' | null
  contextName: string | null
  playedAt: number
}

export interface SpotifyPlaylistItem {
  id: string
  uri: string
  name: string
  image: string | null
  owner: string
}

export interface SpotifyLibrary {
  recent: SpotifyRecentItem[]
  playlists: SpotifyPlaylistItem[]
}

/** Last track Notch saw, so the music card has something to show before Spotify answers. */
export interface SpotifyMemory {
  track: SpotifyTrack
  contextUri: string | null
  updatedAt: number
}

export interface NotchToggleEvent {
  expanded: boolean
  /** Display size the window was just resized to. Present when opening. */
  viewport?: { width: number; height: number }
}

/** Where the collapsed tab sits, in window pixels and on screen. */
export interface NotchMetrics {
  tab: { x: number; y: number; width: number; height: number; radius: number }
  tabScreen: { x: number; y: number; width: number; height: number }
  noticeAbove: boolean
  /** Style actually drawn. Differs from the setting on a secondary display. */
  style?: NotchStyle
  /** Space the taskbar takes at the right and bottom of this display, so corner notices clear it. */
  inset?: { right: number; bottom: number }
}

export interface BackdropEvent {
  image: string | null
}

export interface ReminderEvent {
  taskId: string
  title: string
  date: string
  time?: string
  timeZone?: string
}

export interface MediaControlTarget {
  preference: string
  sessionId: string | null
}

export type SpotifyAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'play-track'; uri: string; queue?: string[]; deviceId?: string; contextUri?: string }
  | { type: 'play-context'; contextUri: string; deviceId?: string }
  | { type: 'seek'; position: number }
  | { type: 'volume'; volume: number }
  | { type: 'shuffle'; state: boolean }
  | { type: 'repeat'; state: 'off' | 'track' | 'context' }
  | { type: 'transfer'; deviceId: string }

export interface PendingApproval { id:string; session:string; operation:string; details:string; fingerprint:string }
export interface OpenCodeQuestion {
  id: string
  sessionID: string
  title: string
  detail: string
  options: AgentQuestionOption[]
  multiSelect: boolean
  steps?: AgentQuestionStep[]
}
export interface NotchApi {
  calendar: CalendarApi
  approvals: {
    list(): Promise<PendingApproval[]>
    decide(fingerprint: string, reply: 'once' | 'reject', port: number): Promise<void>
    questions(): Promise<OpenCodeQuestion[]>
    replyQuestion(id: string, answers: string[][], port: number): Promise<void>
    rejectQuestion(id: string, port: number): Promise<void>
  }
  agent: {
    status(): Promise<AgentSnapshot>
    setup(tool: AgentTool): Promise<string>
    connections(): Promise<AgentConnection[]>
    /** Re-write Notch's hooks, then report each tool again. */
    reconnect(): Promise<AgentConnection[]>
    /** Open Claude Code's own sign-in so Notch can message Claude sessions. */
    claudeLogin(): Promise<{ ok: boolean; error?: string }>
    decide(id: string, reply: 'allow' | 'deny'): Promise<void>
    decideQuestion: (id: string, response: AgentQuestionResponse) => Promise<void>
    /** Let the tool show the question itself; Notch drops its hold. */
    releaseQuestion: (id: string) => Promise<void>
    onUpdate(listener: (snapshot: AgentSnapshot) => void): () => void
  }
  phone: {
    start(
      file: {name:string;bytes:Uint8Array}|null,
      options?: { clipboard?: boolean; text?: string }
    ): Promise<void>
    status():Promise<{qr:string;received:{name:string;text:boolean}|null}|null>
    collect():Promise<void>
    stop():Promise<void>
  }
  getState: () => Promise<AppState>
  getVersion: () => Promise<string>
  setState: (patch: AppStatePatch) => Promise<AppState>
  updater: {
    getState: () => Promise<UpdateState>
    check: (options?: { manual?: boolean }) => Promise<UpdateState>
    download: () => Promise<UpdateState>
    install: () => Promise<boolean>
    openRelease: () => void
    onState: (callback: (state: UpdateState) => void) => () => void
  }
  license: {
    getState: () => Promise<LicenseState>
    activate: (licenseKey: string) => Promise<LicenseState>
    validate: () => Promise<LicenseState>
    deactivate: () => Promise<LicenseState>
    onState: (callback: (state: LicenseState) => void) => () => void
  }
  setExpanded: (expanded: boolean) => Promise<boolean>
  setShape: (
    rect:
      | { x: number; y: number; width: number; height: number }
      | { x: number; y: number; width: number; height: number }[]
      | { focusOff: true; rects: { x: number; y: number; width: number; height: number }[] | null }
      | null
  ) => void
  getExpanded: () => Promise<boolean>
  getBackdrop: () => Promise<string | null>
  quit: () => void
  notify: (title: string, body: string, silent?: boolean) => void
  openExternal: (url: string) => void
  copyText: (text: string) => void
  postureTraceEnabled: () => Promise<boolean>
  /** Seconds since the last keyboard or mouse input anywhere in Windows. */
  systemIdleSeconds: () => Promise<number>
  /** Test-only: shortens the away wait, in ms, when NOTCH_POSTURE_AWAY_MS is set. 0 otherwise. */
  postureAwayOverrideMs: () => Promise<number>
  postureTrace: (sample: unknown) => void
  onExpanded: (callback: (event: NotchToggleEvent) => void) => () => void
  onBackdrop: (callback: (event: BackdropEvent) => void) => () => void
  onStateUpdated: (callback: (state: AppState) => void) => () => void
  onReminder: (callback: (event: ReminderEvent) => void) => () => void
  onVaultChanged: (callback: (path: string | null) => void) => () => void
  onNavigate: (callback: (page: string) => void) => () => void
  getMetrics: () => Promise<NotchMetrics | null>
  onMetrics: (callback: (metrics: NotchMetrics) => void) => () => void
  displays: () => Promise<NotchDisplay[]>
  onRequestClose: (callback: () => void) => () => void
  onPrepareOpen: (callback: () => void) => () => void
  onPresence: (callback: (event: { hidden: boolean }) => void) => () => void
  getPresence: () => Promise<{ hidden: boolean }>
  reportTiming: (mark: string, ms: number) => void
  obsidian: {
    chooseVault: () => Promise<string | null>
    tree: (vaultPath: string) => Promise<VaultNode[]>
    read: (vaultPath: string, relativePath: string) => Promise<string>
    write: (vaultPath: string, relativePath: string, content: string) => Promise<void>
    writeSync: (vaultPath: string, relativePath: string, content: string) => void
    createFile: (vaultPath: string, directory: string, name: string) => Promise<string>
    createFolder: (vaultPath: string, directory: string, name: string) => Promise<string>
    rename: (vaultPath: string, relativePath: string, nextName: string) => Promise<string>
    move: (vaultPath: string, relativePath: string, targetDirectory: string) => Promise<string>
    trash: (vaultPath: string, relativePath: string) => Promise<void>
    reveal: (vaultPath: string, relativePath: string | null) => Promise<void>
    openFile: (vaultPath: string, relativePath: string) => Promise<void>
    search: (vaultPath: string, query: string) => Promise<NoteSearchResult[]>
  }
  spotify: {
    status: () => Promise<SpotifyStatus>
    connect: () => Promise<SpotifyStatus>
    disconnect: () => Promise<SpotifyStatus>
    player: () => Promise<SpotifyPlayback>
    queue: () => Promise<SpotifyQueueItem[]>
    library: () => Promise<SpotifyLibrary>
    action: (action: SpotifyAction, target?: MediaControlTarget) => Promise<SpotifyPlayback>
    launch: (target?: string) => Promise<boolean>
  }
  sessions: {
    scan: () => Promise<SessionsSnapshot>
    openProject: (directory: string) => Promise<void>
    send: (
      sessionId: string,
      message: string
    ) => Promise<{
      ok: boolean
      pending?: boolean
      queued?: boolean
      position?: number
      /** The chat is owned by the Claude app: Notch copied the message and
       * opened that chat there for the user to paste. Nothing was sent. */
      handedOff?: boolean
      note?: string
      error?: string
      code?: string
    }>
    verify: (sessionId: string, message: string) => Promise<{ ok: boolean; error?: string }>
    focusCodex: () => Promise<boolean>
    codexLock: (
      sessionId: string
    ) => Promise<{ locked: boolean; missing: boolean }>
    onSendResult: (callback: (result: SessionSendResult) => void) => () => void
    onReply: (callback: (event: SessionReplyEvent) => void) => () => void
  }
}
