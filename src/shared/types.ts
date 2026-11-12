export type Accent = 'coral' | 'mint' | 'violet' | 'ice' | 'gold'

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
  accent: Accent
  vaultPath: string | null
  hoverDelay: number
  notchPosition: NotchPosition
  notchStyle: NotchStyle
  launchAtLogin: boolean
  notifications: boolean
  spotifyClientId: string
  spotifyRedirectPort: number
  userName: string
  pinOnOpen: boolean
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
  done: boolean
  createdAt: number
  completedAt?: number
  remindAt?: number | null
  notifiedAt?: number | null
  priority: TaskPriority
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

export interface PostureState {
  enabled: boolean
  notifications: boolean
  threshold: number
  baseline: PostureBaseline | null
  dayKey: string
  goodSeconds: number
  badSeconds: number
  lastAlertAt: number | null
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
  focusLog: FocusSession[]
}

export interface AppStatePatch {
  settings?: Partial<Settings>
  timer?: Partial<TimerState>
  tasks?: Task[]
  notes?: Partial<NotesState>
  posture?: Partial<PostureState>
  focusLog?: FocusSession[]
}

export type SessionProvider = 'codex' | 'opencode' | 'antigravity' | 'claude' | 'cursor' | 'windsurf' | 'zed'

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
}

export interface AppPresence {
  provider: SessionProvider
  label: string
  running: boolean
  processCount: number
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
  ok: boolean
  error?: string
  code?: string
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
}

export interface SpotifyQueueItem {
  id: string
  uri: string
  name: string
  artists: string
  image: string | null
  duration: number
}

export interface NotchToggleEvent {
  expanded: boolean
}

export interface BackdropEvent {
  image: string | null
}

export interface ReminderEvent {
  taskId: string
  title: string
  date: string
  time?: string
}

export type SpotifyAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'play-track'; uri: string; queue?: string[]; deviceId?: string }
  | { type: 'seek'; position: number }
  | { type: 'volume'; volume: number }
  | { type: 'shuffle'; state: boolean }
  | { type: 'repeat'; state: 'off' | 'track' | 'context' }
  | { type: 'transfer'; deviceId: string }

export interface NotchApi {
  getState: () => Promise<AppState>
  getVersion: () => Promise<string>
  setState: (patch: AppStatePatch) => Promise<AppState>
  setExpanded: (expanded: boolean) => Promise<boolean>
  getExpanded: () => Promise<boolean>
  getBackdrop: () => Promise<string | null>
  quit: () => void
  notify: (title: string, body: string) => void
  openExternal: (url: string) => void
  copyText: (text: string) => void
  postureTrace: (sample: unknown) => void
  onExpanded: (callback: (event: NotchToggleEvent) => void) => () => void
  onBackdrop: (callback: (event: BackdropEvent) => void) => () => void
  onStateUpdated: (callback: (state: AppState) => void) => () => void
  onReminder: (callback: (event: ReminderEvent) => void) => () => void
  onVaultChanged: (callback: (path: string | null) => void) => () => void
  onNavigate: (callback: (page: string) => void) => () => void
  onBlur: (callback: () => void) => () => void
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
    action: (action: SpotifyAction) => Promise<SpotifyPlayback>
  }
  sessions: {
    scan: () => Promise<SessionsSnapshot>
    openProject: (directory: string) => Promise<void>
    send: (sessionId: string, message: string) => Promise<{ ok: boolean; error?: string; code?: string }>
    focusCodex: () => Promise<boolean>
    onSendResult: (callback: (result: SessionSendResult) => void) => () => void
  }
}
