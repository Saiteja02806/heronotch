import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppState,
  NotchApi,
  NoteSearchResult,
  ReminderEvent,
  SessionSendResult,
  SessionsSnapshot,
  SpotifyAction,
  SpotifyPlayback,
  SpotifyQueueItem,
  SpotifyStatus,
  VaultNode
} from '../shared/types'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: NotchApi = {
  getState: () => ipcRenderer.invoke('app:get-state') as Promise<AppState>,
  setState: (patch) => ipcRenderer.invoke('app:set-state', patch) as Promise<AppState>,
  getVersion: () => ipcRenderer.invoke('app:version') as Promise<string>,
  setExpanded: (value) => ipcRenderer.invoke('notch:set-expanded', value) as Promise<boolean>,
  getExpanded: () => ipcRenderer.invoke('notch:get-expanded') as Promise<boolean>,
  getBackdrop: () => ipcRenderer.invoke('notch:get-backdrop') as Promise<string | null>,
  quit: () => ipcRenderer.send('app:quit'),
  notify: (title, body) => ipcRenderer.send('app:notify', title, body),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
  copyText: (text) => ipcRenderer.send('app:copy-text', text),
  postureTrace: (sample) => ipcRenderer.send('posture:trace', sample),
  onExpanded: (callback) => subscribe('notch:expanded', callback),
  onBackdrop: (callback) => subscribe('notch:backdrop', callback),
  onStateUpdated: (callback) => subscribe('state:updated', callback),
  onReminder: (callback) => subscribe('reminder:fired', callback),
  onVaultChanged: (callback) => subscribe('vault:changed', callback),
  onNavigate: (callback) => subscribe('navigate', callback),
  onBlur: (callback) => subscribe('notch:blur', () => callback()),
  obsidian: {
    chooseVault: () => ipcRenderer.invoke('obsidian:choose-vault') as Promise<string | null>,
    tree: (vaultPath) => ipcRenderer.invoke('obsidian:tree', vaultPath) as Promise<VaultNode[]>,
    read: (vaultPath, relativePath) =>
      ipcRenderer.invoke('obsidian:read', vaultPath, relativePath) as Promise<string>,
    write: (vaultPath, relativePath, content) =>
      ipcRenderer.invoke('obsidian:write', vaultPath, relativePath, content) as Promise<void>,
    writeSync: (vaultPath, relativePath, content) => {
      ipcRenderer.sendSync('obsidian:write-sync', vaultPath, relativePath, content)
    },
    createFile: (vaultPath, directory, name) =>
      ipcRenderer.invoke('obsidian:create-file', vaultPath, directory, name) as Promise<string>,
    createFolder: (vaultPath, directory, name) =>
      ipcRenderer.invoke('obsidian:create-folder', vaultPath, directory, name) as Promise<string>,
    rename: (vaultPath, relativePath, nextName) =>
      ipcRenderer.invoke('obsidian:rename', vaultPath, relativePath, nextName) as Promise<string>,
    move: (vaultPath, relativePath, targetDirectory) =>
      ipcRenderer.invoke('obsidian:move', vaultPath, relativePath, targetDirectory) as Promise<string>,
    trash: (vaultPath, relativePath) =>
      ipcRenderer.invoke('obsidian:trash', vaultPath, relativePath) as Promise<void>,
    reveal: (vaultPath, relativePath) =>
      ipcRenderer.invoke('obsidian:reveal', vaultPath, relativePath) as Promise<void>,
    openFile: (vaultPath, relativePath) =>
      ipcRenderer.invoke('obsidian:open-in-app', vaultPath, relativePath) as Promise<void>,
    search: (vaultPath, query) =>
      ipcRenderer.invoke('obsidian:search', vaultPath, query) as Promise<NoteSearchResult[]>
  },
  spotify: {
    status: () => ipcRenderer.invoke('spotify:status') as Promise<SpotifyStatus>,
    connect: () => ipcRenderer.invoke('spotify:connect') as Promise<SpotifyStatus>,
    disconnect: () => ipcRenderer.invoke('spotify:disconnect') as Promise<SpotifyStatus>,
    player: () => ipcRenderer.invoke('spotify:player') as Promise<SpotifyPlayback>,
    queue: () => ipcRenderer.invoke('spotify:queue') as Promise<SpotifyQueueItem[]>,
    action: (action: SpotifyAction) =>
      ipcRenderer.invoke('spotify:action', action) as Promise<SpotifyPlayback>
  },
  sessions: {
    scan: () => ipcRenderer.invoke('sessions:scan') as Promise<SessionsSnapshot>,
    openProject: (directory) =>
      ipcRenderer.invoke('sessions:open-project', directory) as Promise<void>,
    send: (sessionId, message) =>
      ipcRenderer.invoke('sessions:send', sessionId, message) as Promise<{
        ok: boolean
        error?: string
        code?: string
      }>,
    focusCodex: () => ipcRenderer.invoke('sessions:focus-codex') as Promise<boolean>,
    onSendResult: (callback) => subscribe<SessionSendResult>('session:send-result', callback)
  }
}

contextBridge.exposeInMainWorld('notch', api)
