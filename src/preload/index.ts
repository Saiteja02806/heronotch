import { contextBridge, ipcRenderer } from 'electron'
import type { DemoApi, DemoChapter, DemoPlatform } from '@demo/shared/types'
import { plainErrorMessage } from '../shared/errors'
import type {
  AppState,
  NotchApi,
  NotchDisplay,
  NotchMetrics,
  NoteSearchResult,
  ReminderEvent,
  SessionReplyEvent,
  SessionSendResult,
  SessionsSnapshot,
  SpotifyAction,
  SpotifyLibrary,
  SpotifyPlayback,
  SpotifyQueueItem,
  SpotifyStatus,
  UpdateState,
  LicenseState,
  VaultNode
} from '../shared/types'

/**
 * Electron wraps a rejected main-process error, and the main process may also
 * include its own error class name. `plainErrorMessage` keeps only the sentence
 * meant for people, so every screen gets readable text.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (cause) {
    throw new Error(plainErrorMessage(cause))
  }
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: NotchApi = {
  calendar: {
    snapshot: () => invoke('calendar:snapshot'),
    status: () => invoke('calendar:status'),
    connect: () => invoke('calendar:connect'),
    cancelConnect: () => invoke('calendar:cancel-connect'),
    disconnect: () => invoke('calendar:disconnect'),
    calendars: () => invoke('calendar:list'),
    events: (calendarId, date, timeZone) => invoke('calendar:events', calendarId, date, timeZone),
    save: (calendarId, draft, editing) => invoke('calendar:save', calendarId, draft, editing),
    remove: (calendarId, eventId) => invoke('calendar:delete', calendarId, eventId)
  },
  approvals: {
    list: () => invoke('approvals:list'),
    decide: (fingerprint, reply, port) => invoke('approvals:decide', fingerprint, reply, port),
    questions: () => invoke('approvals:questions'),
    replyQuestion: (id, answers, port) => invoke('approvals:questionReply', id, answers, port),
    rejectQuestion: (id, port) => invoke('approvals:questionReject', id, port)
  },
  agent: {
    status: () => invoke('agent:status'),
    setup: (tool) => invoke('agent:setup', tool),
    connections: () => invoke('agent:connections'),
    reconnect: () => invoke('agent:reconnect'),
    claudeLogin: () => invoke('agent:claude-login'),
    decide: (id, reply) => invoke('agent:decide', id, reply),
    decideQuestion: (id, choices) => invoke('agent:questionDecide', id, choices),
    releaseQuestion: (id) => invoke('agent:questionRelease', id),
    onUpdate: (listener) => subscribe('agent:update', listener)
  },
  phone: {
    start: (file, options) => invoke('phone:start', file, options),
    status: () => invoke('phone:status'),
    collect: () => invoke('phone:collect'),
    stop: () => invoke('phone:stop')
  },
  getState: () => invoke('app:get-state') as Promise<AppState>,
  setState: (patch) => invoke('app:set-state', patch) as Promise<AppState>,
  getVersion: () => invoke('app:version') as Promise<string>,
  updater: {
    getState: () => invoke('updater:get-state') as Promise<UpdateState>,
    check: (options) => invoke('updater:check', options) as Promise<UpdateState>,
    download: () => invoke('updater:download') as Promise<UpdateState>,
    install: () => invoke('updater:install') as Promise<boolean>,
    openRelease: () => ipcRenderer.send('updater:open-release'),
    onState: (callback) => subscribe('updater:state', callback)
  },
  license: {
    getState: () => invoke('license:get-state') as Promise<LicenseState>,
    activate: (licenseKey) => invoke('license:activate', licenseKey) as Promise<LicenseState>,
    validate: () => invoke('license:validate') as Promise<LicenseState>,
    deactivate: () => invoke('license:deactivate') as Promise<LicenseState>,
    onState: (callback) => subscribe('license:state', callback)
  },
  setExpanded: (value) => invoke('notch:set-expanded', value) as Promise<boolean>,
  setShape: (rect) => ipcRenderer.send('notch:shape', rect),
  getExpanded: () => invoke('notch:get-expanded') as Promise<boolean>,
  getBackdrop: () => invoke('notch:get-backdrop') as Promise<string | null>,
  quit: () => ipcRenderer.send('app:quit'),
  notify: (title, body, silent) => ipcRenderer.send('app:notify', title, body, silent),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
  copyText: (text) => ipcRenderer.send('app:copy-text', text),
  postureTraceEnabled: () => invoke('posture:trace-enabled'),
  systemIdleSeconds: () => invoke('system:idle-seconds') as Promise<number>,
  postureAwayOverrideMs: () => invoke('posture:away-override') as Promise<number>,
  postureTrace: (sample) => ipcRenderer.send('posture:trace', sample),
  onExpanded: (callback) => subscribe('notch:expanded', callback),
  onBackdrop: (callback) => subscribe('notch:backdrop', callback),
  onStateUpdated: (callback) => subscribe('state:updated', callback),
  onReminder: (callback) => subscribe('reminder:fired', callback),
  onVaultChanged: (callback) => subscribe('vault:changed', callback),
  onNavigate: (callback) => subscribe('navigate', callback),
  getMetrics: () => invoke('notch:get-metrics') as Promise<NotchMetrics | null>,
  displays: () => invoke('notch:displays') as Promise<NotchDisplay[]>,
  onMetrics: (callback) => subscribe<NotchMetrics>('notch:metrics', callback),
  onRequestClose: (callback) => subscribe<void>('notch:request-close', () => callback()),
  onPrepareOpen: (callback) => subscribe<void>('notch:prepare-open', () => callback()),
  onPresence: (callback) => subscribe<{ hidden: boolean }>('notch:presence', callback),
  getPresence: () => invoke('notch:get-presence'),
  reportTiming: (mark, ms) => ipcRenderer.send('notch:timing', mark, ms),
  obsidian: {
    chooseVault: () => invoke('obsidian:choose-vault') as Promise<string | null>,
    tree: (vaultPath) => invoke('obsidian:tree', vaultPath) as Promise<VaultNode[]>,
    read: (vaultPath, relativePath) => invoke('obsidian:read', vaultPath, relativePath) as Promise<string>,
    write: (vaultPath, relativePath, content) =>
      invoke('obsidian:write', vaultPath, relativePath, content) as Promise<void>,
    writeSync: (vaultPath, relativePath, content) => {
      ipcRenderer.sendSync('obsidian:write-sync', vaultPath, relativePath, content)
    },
    createFile: (vaultPath, directory, name) =>
      invoke('obsidian:create-file', vaultPath, directory, name) as Promise<string>,
    createFolder: (vaultPath, directory, name) =>
      invoke('obsidian:create-folder', vaultPath, directory, name) as Promise<string>,
    rename: (vaultPath, relativePath, nextName) =>
      invoke('obsidian:rename', vaultPath, relativePath, nextName) as Promise<string>,
    move: (vaultPath, relativePath, targetDirectory) =>
      invoke('obsidian:move', vaultPath, relativePath, targetDirectory) as Promise<string>,
    trash: (vaultPath, relativePath) => invoke('obsidian:trash', vaultPath, relativePath) as Promise<void>,
    reveal: (vaultPath, relativePath) => invoke('obsidian:reveal', vaultPath, relativePath) as Promise<void>,
    openFile: (vaultPath, relativePath) =>
      invoke('obsidian:open-in-app', vaultPath, relativePath) as Promise<void>,
    search: (vaultPath, query) =>
      invoke('obsidian:search', vaultPath, query) as Promise<NoteSearchResult[]>
  },
  spotify: {
    status: () => invoke('spotify:status') as Promise<SpotifyStatus>,
    connect: () => invoke('spotify:connect') as Promise<SpotifyStatus>,
    disconnect: () => invoke('spotify:disconnect') as Promise<SpotifyStatus>,
    player: () => invoke('spotify:player') as Promise<SpotifyPlayback>,
    queue: () => invoke('spotify:queue') as Promise<SpotifyQueueItem[]>,
    library: () => invoke('spotify:library') as Promise<SpotifyLibrary>,
    action: (action, target) => invoke('spotify:action', action, target) as Promise<SpotifyPlayback>,
    launch: (target?: string) => invoke('spotify:launch', target) as Promise<boolean>
  },
  sessions: {
    scan: () => invoke('sessions:scan') as Promise<SessionsSnapshot>,
    openProject: (directory) => invoke('sessions:open-project', directory) as Promise<void>,
    send: (sessionId, message) =>
      invoke('sessions:send', sessionId, message) as Promise<{
        ok: boolean
        error?: string
        code?: string
      }>,
    verify: (sessionId, message) =>
      invoke('sessions:verify', sessionId, message) as Promise<{
        ok: boolean
        error?: string
      }>,
    focusCodex: () => invoke('sessions:focus-codex') as Promise<boolean>,
    codexLock: (sessionId) =>
      invoke('sessions:codex-lock', sessionId) as Promise<{
        locked: boolean
        missing: boolean
      }>,
    onSendResult: (callback) => subscribe<SessionSendResult>('session:send-result', callback),
    onReply: (callback) => subscribe<SessionReplyEvent>('session:reply', callback)
  }
}

contextBridge.exposeInMainWorld('notch', api)

if (process.env.NOTCH_DEMO === '1' || process.argv.includes('--demo')) {
  const demoApi: DemoApi = {
    getConfig: () => invoke('demo:get-config'),
    getPostureVideo: () => invoke('demo:get-posture-video'),
    setPlatform: (platform: DemoPlatform) => invoke('demo:set-platform', platform),
    onPlatform: (callback) => subscribe('demo:platform', callback),
    fireReminder: (title: string, time?: string) => invoke('demo:fire-reminder', title, time),
    setOpenCodeApproval: (enabled: boolean) => invoke('demo:set-opencode-approval', enabled),
    setQuestionMode: (mode) => invoke('demo:set-question-mode', mode),
    simulatePhoneReceive: (payload) => invoke('demo:phone-receive', payload),
    setCaptions: (visible: boolean) => invoke('demo:set-captions', visible),
    reset: () => invoke('demo:reset'),
    reportDone: (chapters: DemoChapter[]) => ipcRenderer.send('demo:done', chapters)
  }
  contextBridge.exposeInMainWorld('notchDemo', demoApi)
}
