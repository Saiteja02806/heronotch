import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  screen,
  session,
  shell,
  Tray
} from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { AppState, AppStatePatch, NotchStyle } from '../shared/types'
import * as backdrop from './backdrop'
import * as localMedia from './localMedia'
import * as obsidian from './obsidian'
import * as sessions from './sessions'
import * as spotify from './spotify'
import { flushState, getState, initState, setState, stateEvents, updateTask } from './state'

if (process.env.NOTCH_CAPTURE) {
  app.disableHardwareAcceleration()
}

const COLLAPSED_SIZES: Record<NotchStyle, { width: number; height: number }> = {
  full: { width: 420, height: 52 },
  compact: { width: 340, height: 46 },
  minimal: { width: 220, height: 40 },
  pill: { width: 340, height: 46 },
  'pill-tiny': { width: 140, height: 36 },
  'notch-wide': { width: 260, height: 42 },
  'notch-micro': { width: 130, height: 32 }
}
const EXPANDED_WIDTH = 1160
const EXPANDED_HEIGHT = 632

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let expanded = false
let expandToken = 0
let expanding: Promise<boolean> | null = null
let lastWatchedVault: string | null = null
let reminderTimers = new Map<string, NodeJS.Timeout>()
let reminderReschedule: NodeJS.Timeout | null = null
let spotifyActionQueue: Promise<unknown> = Promise.resolve()
let quitting = false
let windowShown = false
let revealTimer: NodeJS.Timeout | null = null
let rendererRecoveries = 0
let failureDialogOpen = false

function logLine(message: string): void {
  try {
    appendFileSync(
      path.join(app.getPath('userData'), 'notch.log'),
      `[${new Date().toISOString()}] ${message}\n`,
      'utf8'
    )
  } catch {
    // Logging must never be the reason the app fails.
  }
}

process.on('uncaughtException', (error) => {
  logLine(`uncaughtException ${error?.stack || String(error)}`)
})

process.on('unhandledRejection', (reason) => {
  logLine(`unhandledRejection ${reason instanceof Error ? reason.stack : String(reason)}`)
})

function notifyRaw(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return
    new Notification({ title, body, silent: false }).show()
  } catch {
    // Ignore notification failures.
  }
}

function screenWorkArea(): Electron.Rectangle {
  return screen.getPrimaryDisplay().workArea
}

function boundsFor(isExpanded: boolean): Electron.Rectangle {
  const state = getState()
  const display = screen.getPrimaryDisplay()
  if (isExpanded) {
    return {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height
    }
  }
  const workArea = display.workArea
  const size = COLLAPSED_SIZES[state.settings.notchStyle] || COLLAPSED_SIZES.minimal
  const width = Math.min(size.width, workArea.width)
  const height = Math.min(size.height, workArea.height)
  const saved = state.settings.notchPosition || { x: 0.5, y: 0 }
  const anchorX = Math.min(1, Math.max(0, Number(saved.x) || 0))
  const anchorY = Math.min(1, Math.max(0, Number(saved.y) || 0))
  return {
    x: Math.round(workArea.x + anchorX * Math.max(0, workArea.width - width)),
    y: Math.round(workArea.y + anchorY * Math.max(0, workArea.height - height)),
    width,
    height
  }
}

function applyBounds(): void {
  if (!mainWindow) return
  mainWindow.setBounds(boundsFor(expanded), false)
}

async function setExpanded(next: boolean, notify = true): Promise<boolean> {
  if (!mainWindow) return false

  if (next) {
    if (expanded) return true
    if (expanding) return expanding
    const token = ++expandToken
    const cached = backdrop.getCachedBackdrop()
    // Open now. The blurred snapshot is only decoration, and waiting for it
    // meant a failed or slow capture left the notch stuck shut.
    expanded = true
    backdrop.suspendBackdropCapture()
    applyBounds()
    mainWindow.setAlwaysOnTop(true, 'screen-saver')
    if (notify) {
      if (cached) mainWindow.webContents.send('notch:backdrop', { image: cached })
      mainWindow.webContents.send('notch:expanded', { expanded: true })
    }
    mainWindow.showInactive()
    syncEscapeShortcut()
    expanding = null

    if (notify && !cached) {
      const target = mainWindow
      void backdrop
        .captureDesktopBackdrop(true)
        .then((image) => {
          if (!image || token !== expandToken || !expanded) return
          if (!target.isDestroyed()) target.webContents.send('notch:backdrop', { image })
        })
        .catch(() => undefined)
    }
    return true
  }

  expandToken += 1
  expanding = null
  expanded = false
  syncEscapeShortcut()
  backdrop.resumeBackdropCapture()
  applyBounds()
  if (notify && mainWindow) {
    mainWindow.webContents.send('notch:expanded', { expanded: false })
  }
  setTimeout(() => {
    if (!expanded) backdrop.refreshBackdrop()
  }, 550)
  setTimeout(() => nudgePointerHover(), 160)
  return false
}

// After the window shrinks back to the tab, Chromium keeps the last pointer
// position clamped to the old (full screen) viewport. If the pointer is parked
// on the tab it never sends a fresh move, so the tab shows no hover state and
// the OS keeps the arrow cursor even though the pointer is right there. Feed
// one mouse move in from the real cursor position so hover and the hand cursor
// are correct without the user having to wiggle the mouse.
function nudgePointerHover(): void {
  if (!mainWindow || mainWindow.isDestroyed() || expanded || !mainWindow.isVisible()) return
  const cursor = screen.getCursorScreenPoint()
  const bounds = mainWindow.getBounds()
  if (
    cursor.x < bounds.x ||
    cursor.y < bounds.y ||
    cursor.x >= bounds.x + bounds.width ||
    cursor.y >= bounds.y + bounds.height
  ) {
    return
  }
  mainWindow.webContents.sendInputEvent({
    type: 'mouseMove',
    x: Math.round(cursor.x - bounds.x),
    y: Math.round(cursor.y - bounds.y)
  })
}

function revealWindow(reason: string): void {
  if (!mainWindow || windowShown) return
  windowShown = true
  if (revealTimer) {
    clearTimeout(revealTimer)
    revealTimer = null
  }
  mainWindow.showInactive()
  logLine(
    `window shown (${reason}) bounds=${JSON.stringify(mainWindow.getBounds())} visible=${mainWindow.isVisible()}`
  )
}

function smartAppControlState(): 'on' | 'evaluation' | 'off' | 'unknown' {
  if (process.platform !== 'win32') return 'unknown'
  try {
    const output = execFileSync(
      'reg.exe',
      [
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy',
        '/v',
        'VerifiedAndReputablePolicyState'
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 }
    )
    const match = output.match(/VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i)
    if (!match) return 'unknown'
    const value = Number.parseInt(match[1], 16)
    if (value === 0) return 'off'
    if (value === 1) return 'on'
    if (value === 2) return 'evaluation'
    return 'unknown'
  } catch {
    // Older Windows builds do not have the key at all.
    return 'unknown'
  }
}

function syncEscapeShortcut(): void {
  // Esc must close the notch even when the window never got focus, which is the
  // normal case: the notch opens on hover via showInactive(), so keyboard focus
  // stays in whatever app the user was in. Grab Esc globally only while the
  // notch is expanded and unfocused; a focused window handles Esc itself, which
  // keeps "Esc leaves a text field" working inside the notch.
  if (!mainWindow || mainWindow.isDestroyed()) return
  const want = expanded && !mainWindow.isFocused()
  const registered = globalShortcut.isRegistered('Escape')
  try {
    if (want && !registered) {
      globalShortcut.register('Escape', () => {
        logLine('global escape: collapsing notch')
        void setExpanded(false)
      })
    } else if (!want && registered) {
      globalShortcut.unregister('Escape')
    }
  } catch {
    // If another app owns Esc, the collapse arrow still works.
  }
}

function showRendererFailure(details: Electron.RenderProcessGoneDetails): void {
  if (failureDialogOpen) return
  failureDialogOpen = true
  const logPath = path.join(app.getPath('userData'), 'notch.log')
  const sac = smartAppControlState()
  const sacBlocked = sac === 'on' || sac === 'evaluation'
  logLine(`renderer failure dialog sac=${sac}`)
  const detail = sacBlocked
    ? [
        `The notch window could not draw because Windows blocked an unsigned part of Notch (${details.reason}, exit code ${details.exitCode}).`,
        '',
        'This PC has Smart App Control turned on. It blocks unsigned apps and their components (DLLs included), and Windows offers no per-app exception.',
        '',
        'Notch is not code-signed yet, so it cannot run on this PC until one of these is true:',
        '  • Smart App Control is turned off: Windows Security > App & browser control > Smart App Control > Off. Windows cannot turn it back on without resetting the PC.',
        '  • Notch is used on a PC where Smart App Control is off.',
        '  • A code-signed build of Notch is installed.',
        '',
        `Log: ${logPath}`
      ].join('\n')
    : [
        `The notch window could not draw because its renderer process stopped (${details.reason}, exit code ${details.exitCode}).`,
        '',
        'On Windows 11 this is usually caused by Smart App Control or an Application Control policy blocking unsigned Electron components. Signing the app, or testing on a PC without that policy, resolves it.',
        '',
        `A log was written to: ${logPath}`
      ].join('\n')

  notifyRaw(
    'Notch could not open',
    sacBlocked
      ? 'Smart App Control is blocking this unsigned build. Open Notch for details.'
      : 'Its window cannot be displayed. Open the tray icon or check the log for details.'
  )

  // The app normally never steals focus. For a fatal startup failure it must,
  // otherwise the dialog opens behind whatever the user is working in.
  try {
    app.focus({ steal: true })
  } catch {
    // Older Electron versions may not support steal.
  }
  mainWindow?.setAlwaysOnTop(true, 'screen-saver')
  mainWindow?.show()
  mainWindow?.setSkipTaskbar(false)
  mainWindow?.focus()

  const buttons = sacBlocked
    ? ['Retry', 'Open Windows Security', 'Quit']
    : ['Retry', 'Quit']
  const quitIndex = buttons.length - 1

  void dialog
    .showMessageBox({
      type: 'error',
      title: 'Notch could not open',
      message: sacBlocked
        ? 'Smart App Control is blocking Notch.'
        : 'Notch is running, but its window cannot be displayed.',
      detail,
      buttons,
      defaultId: 0,
      cancelId: quitIndex,
      noLink: true
    })
    .then(({ response }) => {
      failureDialogOpen = false
      mainWindow?.setSkipTaskbar(true)
      if (response === 0 && mainWindow && !mainWindow.isDestroyed()) {
        rendererRecoveries = 0
        windowShown = false
        mainWindow.webContents.reload()
        return
      }
      if (sacBlocked && response === 1) {
        // Keep the app alive in the tray so the user can retry after changing
        // the Windows setting.
        logLine('opening Smart App Control settings')
        void shell.openExternal('windowsdefender://smartappcontrol').catch(() => {
          void shell.openExternal('windowsdefender://')
        })
        return
      }
      quitting = true
      app.quit()
    })
    .catch(() => {
      failureDialogOpen = false
    })
}

function createWindow(): void {
  const initial = boundsFor(false)
  windowShown = false
  rendererRecoveries = 0
  if (revealTimer) {
    clearTimeout(revealTimer)
    revealTimer = null
  }
  const iconPath = path.join(__dirname, '../../resources/icon.png')
  mainWindow = new BrowserWindow({
    ...initial,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    title: 'Notch',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      backgroundThrottling: false
    }
  })

  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })

  mainWindow.once('ready-to-show', () => revealWindow('ready-to-show'))
  mainWindow.webContents.on('did-finish-load', () => revealWindow('did-finish-load'))

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    logLine(`did-fail-load code=${code} ${description} url=${url}`)
  })

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    logLine(`preload-error ${preloadPath} ${error.stack || error.message}`)
  })

  mainWindow.webContents.on('unresponsive', () => {
    logLine('renderer unresponsive')
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logLine(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
    if (details.reason === 'clean-exit' || quitting) return
    rendererRecoveries += 1
    if (rendererRecoveries === 1) {
      windowShown = false
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        logLine('retrying renderer after crash')
        mainWindow.webContents.reload()
      }, 700)
      return
    }
    showRendererFailure(details)
  })

  // Some GPUs and remote sessions never emit ready-to-show. Reveal the notch
  // anyway so the app cannot end up running with no visible window.
  revealTimer = setTimeout(() => revealWindow('timeout'), 1800)

  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    void setExpanded(false)
    mainWindow?.showInactive()
  })

  mainWindow.on('closed', () => {
    if (revealTimer) {
      clearTimeout(revealTimer)
      revealTimer = null
    }
    mainWindow = null
  })
  mainWindow.on('blur', () => {
    syncEscapeShortcut()
    if (expanded && !getState().settings.pinOnOpen) {
      mainWindow?.webContents.send('notch:blur')
    }
  })

  mainWindow.on('focus', () => {
    syncEscapeShortcut()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  const capturePath = process.env.NOTCH_CAPTURE
  if (capturePath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const page = process.env.NOTCH_CAPTURE_PAGE
        if (page) mainWindow?.webContents.send('navigate', page)
        if (process.env.NOTCH_CAPTURE_EXPANDED !== '0') await setExpanded(true)
        setTimeout(async () => {
          try {
            if (!mainWindow) return
            if (process.env.NOTCH_CAPTURE_JS) {
              const jsResult = await mainWindow.webContents.executeJavaScript(process.env.NOTCH_CAPTURE_JS)
              if (jsResult !== undefined) console.log('CAPTURE_JS:', JSON.stringify(jsResult))
              await new Promise((resolve) => setTimeout(resolve, 650))
            }
            const image = await mainWindow.webContents.capturePage()
            await fs.writeFile(capturePath, image.toPNG())
          } catch (error) {
            console.error('Capture failed', error)
          } finally {
            app.quit()
          }
        }, 1400)
      }, 500)
    })
  }
}

function createTray(): void {
  try {
    const trayIconPath = path.join(__dirname, '../../resources/tray.png')
    const icon = nativeImage.createFromPath(trayIconPath)
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
    const menu = Menu.buildFromTemplate([
      {
        label: 'Open Notch',
        click: () => {
          if (!mainWindow) createWindow()
          revealWindow('tray-menu')
          void setExpanded(true)
        }
      },
      { label: 'Collapse Notch', click: () => void setExpanded(false) },
      {
        label: 'Open log file',
        click: () => {
          void shell.openPath(path.join(app.getPath('userData'), 'notch.log'))
        }
      },
      { type: 'separator' },
      {
        label: 'Quit Notch',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
    tray.setToolTip('Notch')
    tray.setContextMenu(menu)
    tray.on('click', () => {
      if (!mainWindow) createWindow()
      revealWindow('tray')
      void setExpanded(!expanded)
    })
  } catch {
    tray = null
  }
}

function showNotification(title: string, body: string): void {
  if (!getState().settings.notifications) return
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body, silent: false })
  notification.on('click', () => {
    void setExpanded(true).then(() => mainWindow?.focus())
  })
  notification.show()
}

function clearReminderTimers(): void {
  for (const timer of reminderTimers.values()) clearTimeout(timer)
  reminderTimers.clear()
}

function fireReminder(taskId: string): void {
  const state = getState()
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task || task.done || task.notifiedAt) return
  updateTask(taskId, { notifiedAt: Date.now() })
  showNotification('Reminder', task.time ? `${task.title} · ${task.time}` : task.title)
  mainWindow?.webContents.send('reminder:fired', {
    taskId: task.id,
    title: task.title,
    date: task.date,
    time: task.time
  })
}

function scheduleReminders(): void {
  clearReminderTimers()
  const now = Date.now()
  const MAX_DELAY = 2_147_000_000
  const tasks = getState().tasks

  for (const task of tasks) {
    if (task.done || task.notifiedAt || !task.remindAt) continue
    const delay = task.remindAt - now
    if (delay < -12 * 60 * 60 * 1000) continue
    if (delay > MAX_DELAY) {
      // setTimeout cannot hold more than ~24.8 days. Re-arm rather than
      // firing the reminder early.
      const timer = setTimeout(() => {
        reminderTimers.delete(task.id)
        scheduleReminders()
      }, MAX_DELAY)
      reminderTimers.set(task.id, timer)
      continue
    }
    const effectiveDelay = Math.max(900, delay)
    const timer = setTimeout(() => {
      reminderTimers.delete(task.id)
      fireReminder(task.id)
    }, effectiveDelay)
    reminderTimers.set(task.id, timer)
  }
}

function scheduleRemindersSoon(): void {
  if (reminderReschedule) clearTimeout(reminderReschedule)
  reminderReschedule = setTimeout(() => {
    reminderReschedule = null
    scheduleReminders()
  }, 350)
}

function refreshVaultWatcher(force = false): void {
  const vaultPath = getState().settings.vaultPath
  if (!force && vaultPath === lastWatchedVault) return
  lastWatchedVault = vaultPath
  obsidian.watchVault(vaultPath, () => {
    mainWindow?.webContents.send('vault:changed', getState().settings.vaultPath)
  })
}

function requireVault(requested?: string): string {
  const vaultPath = getState().settings.vaultPath
  if (!vaultPath) throw new Error('Choose a notes folder first.')
  if (requested && path.resolve(requested) !== path.resolve(vaultPath)) {
    throw new Error('The notes folder changed. Reload the notes view.')
  }
  return vaultPath
}

function registerIpc(): void {
  ipcMain.handle('app:get-state', () => getState())
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('app:set-state', (_event, patch: AppStatePatch) => {
    const before = getState()
    const next = setState(patch)

    if (
      patch.settings?.spotifyClientId !== undefined ||
      patch.settings?.spotifyRedirectPort !== undefined
    ) {
      const clientId = next.settings.spotifyClientId.trim()
      if (clientId) void spotify.saveCredentials(clientId, next.settings.spotifyRedirectPort)
    }

    if (
      app.isPackaged &&
      patch.settings?.launchAtLogin !== undefined &&
      patch.settings.launchAtLogin !== before.settings.launchAtLogin
    ) {
      app.setLoginItemSettings({
        openAtLogin: patch.settings.launchAtLogin,
        path: process.execPath
      })
    }

    if (patch.settings?.notchPosition !== undefined || patch.settings?.notchStyle !== undefined) {
      applyBounds()
    }
    if (patch.tasks) scheduleRemindersSoon()
    refreshVaultWatcher()
    return next
  })

  ipcMain.handle('notch:set-expanded', (_event, value: boolean) => setExpanded(Boolean(value)))
  ipcMain.handle('notch:get-expanded', () => expanded)
  ipcMain.handle('notch:get-backdrop', () => backdrop.getCachedBackdrop())
  ipcMain.handle('notch:reposition', () => {
    applyBounds()
    return true
  })

  ipcMain.on('app:quit', () => {
    quitting = true
    app.quit()
  })

  ipcMain.on('app:notify', (_event, title: string, body: string) => {
    showNotification(title, body)
  })

  ipcMain.on('app:open-external', (_event, url: string) => {
    if (/^(https?:|obsidian:)/i.test(url)) void shell.openExternal(url)
  })

  ipcMain.on('app:copy-text', (_event, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.on('posture:trace', (_event, sample: unknown) => {
    const target = process.env.NOTCH_POSTURE_TRACE
    if (!target) return
    try {
      appendFileSync(target, `${JSON.stringify(sample)}\n`)
    } catch {
      // Diagnostics must never disturb posture tracking.
    }
  })

  ipcMain.handle('obsidian:choose-vault', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a notes folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder'
    })
    if (result.canceled || !result.filePaths[0]) return null
    const chosen = result.filePaths[0]
    setState({ settings: { vaultPath: chosen } })
    refreshVaultWatcher(true)
    return chosen
  })

  ipcMain.handle('obsidian:tree', async (_event, vaultPath: string) => {
    return obsidian.listVault(requireVault(vaultPath))
  })

  ipcMain.handle('obsidian:read', async (_event, vaultPath: string, relativePath: string) => {
    return obsidian.readNote(requireVault(vaultPath), relativePath)
  })

  ipcMain.handle('obsidian:write', async (_event, vaultPath: string, relativePath: string, content: string) => {
    await obsidian.writeNote(requireVault(vaultPath), relativePath, content)
  })

  ipcMain.on('obsidian:write-sync', (event, vaultPath: string, relativePath: string, content: string) => {
    try {
      obsidian.writeNoteSync(requireVault(vaultPath), relativePath, content)
      event.returnValue = true
    } catch (error) {
      event.returnValue = error instanceof Error ? error.message : 'Could not save the note.'
    }
  })

  ipcMain.handle('obsidian:create-file', async (_event, vaultPath: string, directory: string, name: string) => {
    return obsidian.createFile(requireVault(vaultPath), directory, name)
  })

  ipcMain.handle('obsidian:create-folder', async (_event, vaultPath: string, directory: string, name: string) => {
    return obsidian.createFolder(requireVault(vaultPath), directory, name)
  })

  ipcMain.handle('obsidian:rename', async (_event, vaultPath: string, relativePath: string, nextName: string) => {
    return obsidian.renameEntry(requireVault(vaultPath), relativePath, nextName)
  })

  ipcMain.handle(
    'obsidian:move',
    async (_event, vaultPath: string, relativePath: string, targetDirectory: string) => {
      return obsidian.moveEntry(requireVault(vaultPath), relativePath, targetDirectory)
    }
  )

  ipcMain.handle('obsidian:trash', async (_event, vaultPath: string, relativePath: string) => {
    await obsidian.trashEntry(requireVault(vaultPath), relativePath)
  })

  ipcMain.handle('obsidian:reveal', async (_event, vaultPath: string, relativePath: string | null) => {
    await obsidian.revealEntry(requireVault(vaultPath), relativePath)
  })

  ipcMain.handle('obsidian:open-in-app', async (_event, vaultPath: string, relativePath: string) => {
    await obsidian.openFile(requireVault(vaultPath), relativePath)
  })

  ipcMain.handle('obsidian:search', async (_event, vaultPath: string, query: string) => {
    return obsidian.searchNotes(requireVault(vaultPath), query)
  })

  ipcMain.handle('spotify:status', async () => {
    const status = await spotify.getStatus(getState().settings.spotifyRedirectPort)
    const local = localMedia.getLocalStatus()
    return {
      ...status,
      localAvailable: local.available,
      localTitle: local.title,
      localArtist: local.artist
    }
  })

  ipcMain.handle('spotify:connect', async () => {
    const settings = getState().settings
    const status = await spotify.connect(settings.spotifyClientId, settings.spotifyRedirectPort)
    const local = localMedia.getLocalStatus()
    return { ...status, localAvailable: local.available, localTitle: local.title, localArtist: local.artist }
  })

  ipcMain.handle('spotify:disconnect', async () => {
    const status = await spotify.disconnect(getState().settings.spotifyRedirectPort)
    const local = localMedia.getLocalStatus()
    return { ...status, localAvailable: local.available, localTitle: local.title, localArtist: local.artist }
  })

  ipcMain.handle('spotify:player', async () => {
    const settings = getState().settings
    const status = await spotify.getStatus(settings.spotifyRedirectPort)
    if (status.connected) {
      try {
        const playback = await spotify.getPlayback(settings.spotifyClientId)
        if (playback.track || !localMedia.isLocalAvailable()) return playback
      } catch {
        // Fall through to the local Windows media session.
      }
    }
    return localMedia.getLocalPlayback()
  })

  ipcMain.handle('spotify:queue', async () => {
    const settings = getState().settings
    const status = await spotify.getStatus(settings.spotifyRedirectPort)
    if (!status.connected) return []
    return spotify.getQueue(settings.spotifyClientId)
  })

  ipcMain.handle('spotify:action', (_event, action) => {
    const run = spotifyActionQueue.then(async () => {
      const settings = getState().settings
      const status = await spotify.getStatus(settings.spotifyRedirectPort)
      if (status.connected) {
        try {
          return await spotify.performAction(settings.spotifyClientId, action)
        } catch (error) {
          if (!localMedia.isLocalAvailable()) throw error
        }
      }
      return localMedia.performLocalAction(action)
    })
    spotifyActionQueue = run.catch(() => undefined)
    return run
  })

  ipcMain.handle('sessions:scan', () => sessions.scanSessions())
  ipcMain.handle('sessions:open-project', (_event, directory: string) => {
    return sessions.openSessionProject(directory)
  })
  ipcMain.handle('sessions:send', (_event, sessionId: string, message: string) => {
    return sessions.sendSessionMessage(sessionId, message)
  })
  ipcMain.handle('sessions:focus-codex', () => {
    return new Promise<boolean>((resolve) => {
      const command =
        "$p = Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($p -and (New-Object -ComObject WScript.Shell).AppActivate($p.Id)) { 'ok' } else { 'no' }"
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true, timeout: 5000 },
        (error, stdout) => resolve(!error && stdout.trim() === 'ok')
      )
    })
  })
}

function registerGlobalShortcuts(): void {
  try {
    globalShortcut.register('CommandOrControl+Shift+Space', () => {
      void setExpanded(!expanded).then((value) => {
        if (value) mainWindow?.focus()
      })
    })
  } catch {
    // Another app may already own the shortcut; the notch is still hoverable.
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('child-process-gone', (_event, details) => {
    logLine(
      `child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`
    )
  })

  app.on('second-instance', () => {
    if (!mainWindow) createWindow()
    logLine('second instance: revealing existing window')
    void setExpanded(true).then(() => mainWindow?.focus())
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.notch.dashboard')
    logLine(
      `start v${app.getVersion()} packaged=${app.isPackaged} exe=${process.execPath} userData=${app.getPath('userData')}`
    )
    logLine(`smart app control=${smartAppControlState()}`)
    const primaryDisplay = screen.getPrimaryDisplay()
    logLine(
      `display bounds=${JSON.stringify(primaryDisplay.bounds)} workArea=${JSON.stringify(primaryDisplay.workArea)} scale=${primaryDisplay.scaleFactor}`
    )
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission === 'media')
    })
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => {
      return permission === 'media'
    })
    await initState()

    // The state file and the Spotify token file are separate. If the state was
    // reset, recover the saved Client ID so the user does not have to paste it
    // again and the refresh token can keep working.
    const storedCredentials = await spotify.loadCredentials()
    const loadedSettings = getState().settings
    if (storedCredentials?.clientId && !loadedSettings.spotifyClientId.trim()) {
      setState({
        settings: {
          spotifyClientId: storedCredentials.clientId,
          ...(storedCredentials.redirectPort
            ? { spotifyRedirectPort: storedCredentials.redirectPort }
            : {})
        }
      })
    } else if (loadedSettings.spotifyClientId.trim()) {
      await spotify.saveCredentials(
        loadedSettings.spotifyClientId,
        loadedSettings.spotifyRedirectPort
      )
    }

    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: getState().settings.launchAtLogin,
        path: process.execPath
      })
    }
    registerIpc()
    localMedia.startLocalMediaMonitor()
    createWindow()
    createTray()
    logLine(`window created bounds=${JSON.stringify(mainWindow?.getBounds())} tray=${Boolean(tray)}`)
    sessions.sessionSendEvents.on('result', (result) => {
      mainWindow?.webContents.send('session:send-result', result)
    })
    backdrop.scheduleBackdropRefresh()
    setInterval(() => {
      if (!expanded) backdrop.refreshBackdrop()
    }, 30_000)
    refreshVaultWatcher(true)
    scheduleReminders()
    registerGlobalShortcuts()

    stateEvents.on('change', (next: AppState) => {
      mainWindow?.webContents.send('state:updated', next)
      scheduleRemindersSoon()
      refreshVaultWatcher()
    })

    screen.on('display-metrics-changed', applyBounds)
    screen.on('display-added', applyBounds)
    screen.on('display-removed', applyBounds)
    powerMonitor.on('resume', () => {
      scheduleReminders()
      applyBounds()
    })

    app.on('activate', () => {
      if (!mainWindow) createWindow()
      void setExpanded(true)
    })
  })

  app.on('before-quit', () => {
    quitting = true
    if (revealTimer) {
      clearTimeout(revealTimer)
      revealTimer = null
    }
    logLine('quitting')
    flushState()
    localMedia.stopLocalMediaMonitor()
    obsidian.closeVaultWatcher()
    clearReminderTimers()
    globalShortcut.unregisterAll()
  })

  app.on('window-all-closed', () => {
    if (quitting) app.quit()
  })
}
