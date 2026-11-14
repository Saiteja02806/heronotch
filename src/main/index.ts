import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  screen,
  session,
  shell,
  Tray
} from 'electron'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { appendFileSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { AppState, AppStatePatch, NotchMetrics } from '../shared/types'
import { followWithSpotifyApi } from '../shared/mediaFollow'
import { collapsedLayout } from '../shared/notchLayout'
import * as backdrop from './backdrop'
import * as localMedia from './localMedia'
import * as obsidian from './obsidian'
import * as sessions from './sessions'
import * as spotify from './spotify'
import { flushState, getState, initState, setState, stateEvents, updateTask } from './state'

if (process.env.NOTCH_CAPTURE) {
  app.disableHardwareAcceleration()
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let expanded = false
let expandToken = 0
let expanding: Promise<boolean> | null = null
let collapsedShape: Electron.Rectangle | null = null
let expandedShape: Electron.Rectangle[] | null = null
let lastWatchedVault: string | null = null
let reminderTimers = new Map<string, NodeJS.Timeout>()
let reminderReschedule: NodeJS.Timeout | null = null
let spotifyActionQueue: Promise<unknown> = Promise.resolve()
let quitting = false
let windowShown = false
let revealTimer: NodeJS.Timeout | null = null
let topmostTimer: NodeJS.Timeout | null = null
let rendererRecoveries = 0
let failureDialogOpen = false
let currentMetrics: NotchMetrics | null = null
let closeFallback: NodeJS.Timeout | null = null

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

function tabHit(metrics: NotchMetrics): Electron.Rectangle {
  return {
    x: Math.max(0, Math.round(metrics.tab.x - 6)),
    y: Math.max(0, Math.round(metrics.tab.y - 6)),
    width: Math.round(metrics.tab.width + 12),
    height: Math.round(metrics.tab.height + 14)
  }
}

// The window stays the size of the display. Opening only changes the click
// shape and a CSS transform. Resizing a transparent window on Windows
// reallocates the DWM surface and is what made the notch feel late.
function refreshCollapsedLayout(): Electron.Rectangle {
  const display = screen.getPrimaryDisplay()
  const settings = getState().settings
  const layout = collapsedLayout(settings.notchPosition, display.workArea, settings.notchStyle)
  const tab = layout.metrics.tabScreen
  currentMetrics = {
    tab: {
      x: tab.x - display.bounds.x,
      y: tab.y - display.bounds.y,
      width: tab.width,
      height: tab.height,
      radius: layout.metrics.tab.radius
    },
    tabScreen: layout.metrics.tabScreen,
    noticeAbove: layout.metrics.noticeAbove
  }
  const win = mainWindow
  if (win && !win.isDestroyed()) win.webContents.send('notch:metrics', currentMetrics)
  if (!expanded) collapsedShape = tabHit(currentMetrics)
  return {
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height
  }
}

function applyBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const next = refreshCollapsedLayout()
  const current = mainWindow.getBounds()
  if (
    current.x !== next.x ||
    current.y !== next.y ||
    current.width !== next.width ||
    current.height !== next.height
  ) {
    mainWindow.setBounds(next, false)
  }
  applyWindowShape()
}

function clearCloseFallback(): void {
  if (!closeFallback) return
  clearTimeout(closeFallback)
  closeFallback = null
}

// Ask the renderer to shrink the panel back into the tab, then actually resize.
// A fallback covers a renderer that never finishes the animation.
function requestAnimatedClose(): void {
  if (!mainWindow || !expanded) return
  mainWindow.webContents.send('notch:request-close')
  clearCloseFallback()
  closeFallback = setTimeout(() => {
    closeFallback = null
    if (expanded) void setExpanded(false)
  }, 980)
}

async function setExpanded(next: boolean, notify = true): Promise<boolean> {
  if (!mainWindow) return false

  if (next) {
    if (expanded) return true
    if (expanding) return expanding
    const token = ++expandToken
    const started = performance.now()
    const cached = backdrop.getCachedBackdrop()
    // The window is already display-sized. Do not resize, and do not wait
    // for a snapshot or a "hide the tab" frame.
    expanded = true
    expandedShape = null
    backdrop.suspendBackdropCapture()
    applyWindowShape()
    mainWindow.setAlwaysOnTop(true, 'screen-saver')
    const display = screen.getPrimaryDisplay()
    const focusMode = getState().settings.focusMode !== false
    if (notify) {
      if (focusMode && cached) mainWindow.webContents.send('notch:backdrop', { image: cached })
      mainWindow.webContents.send('notch:expanded', {
        expanded: true,
        viewport: { width: display.bounds.width, height: display.bounds.height }
      })
    }
    mainWindow.showInactive()
    mainWindow.setSkipTaskbar(true)
    syncEscapeShortcut()
    expanding = null
    logLine(`open dispatched in ${(performance.now() - started).toFixed(1)}ms`)

    if (notify && focusMode && !cached) {
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

  clearCloseFallback()
  const started = performance.now()
  expandToken += 1
  expanding = null
  expanded = false
  expandedShape = null
  syncEscapeShortcut()
  backdrop.resumeBackdropCapture()
  if (currentMetrics) collapsedShape = tabHit(currentMetrics)
  applyWindowShape()
  if (notify && mainWindow) {
    mainWindow.webContents.send('notch:expanded', { expanded: false })
  }
  logLine(`close dispatched in ${(performance.now() - started).toFixed(1)}ms`)
  setTimeout(() => {
    if (!expanded) backdrop.refreshBackdrop()
  }, 400)
  setTimeout(() => nudgePointerHover(), 40)
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

// `setShape` limits both drawing and mouse input to the given window region.
// The collapsed window is wider/taller than the visible tab (Windows will not
// make it shorter than ~38px), and those invisible margins used to swallow the
// hover of whatever sat underneath — usually a browser tab, which therefore lost
// its hand cursor. Shaping the window to the tab lets the rest of the desktop
// receive the mouse normally while the tab keeps working.
function applyWindowShape(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const bounds = mainWindow.getBounds()
    const full = { x: 0, y: 0, width: bounds.width + 2, height: bounds.height + 2 }
    if (expanded) {
      // Focus mode owns the whole screen so the backdrop can take a click.
      // With focus mode off, the renderer sends only the panel (and any
      // toast) so the rest of the desktop keeps the mouse.
      mainWindow.setShape(expandedShape && expandedShape.length > 0 ? expandedShape : [full])
      return
    }
    if (!collapsedShape) {
      mainWindow.setShape([full])
      return
    }
    mainWindow.setShape([collapsedShape])
  } catch {
    // setShape is experimental; if it is unavailable the window still works,
    // it just keeps its rectangular input area.
  }
}

function revealWindow(reason: string): void {
  if (!mainWindow || windowShown) return
  windowShown = true
  if (revealTimer) {
    clearTimeout(revealTimer)
    revealTimer = null
  }
  mainWindow.showInactive()
  // Windows gives every visible top-level window a taskbar button. The option
  // flag alone does not survive the first show on some Electron versions, so
  // re-assert it after the window becomes visible.
  mainWindow.setSkipTaskbar(true)
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
        requestAnimatedClose()
      })
    } else if (!want && registered) {
      globalShortcut.unregister('Escape')
    }
  } catch {
    // If another app owns Esc, the Collapse button still works.
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
  const initial = refreshCollapsedLayout()
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
    // 'toolbar' maps to WS_EX_TOOLWINDOW on Windows, so the shell never gives
    // this window a taskbar button, Alt-Tab entry or Task View tile. The
    // skipTaskbar flag alone calls ITaskbarList::DeleteTab, which the taskbar
    // silently undoes the next time the window is activated (e.g. clicking
    // into the notch to type).
    ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
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
  // Windows/Electron otherwise clamps the collapsed window to ~40px high,
  // leaving a strip below the tab that swallowed hover from the window
  // underneath. The tab only needs 26.
  mainWindow.setMinimumSize(1, 1)
  applyBounds()

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

  // Windows can drop the notch out of the top of the z-order (a fullscreen app
  // closing, the shell restarting, display changes). A buried tab cannot be
  // clicked, so it would never raise itself again and the notch would simply
  // look gone. Re-assert topmost on a slow timer; this only raises the window,
  // it never steals focus or moves it.
  if (topmostTimer) {
    clearInterval(topmostTimer)
    topmostTimer = null
  }
  topmostTimer = setInterval(() => {
    if (quitting || !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return
    mainWindow.setAlwaysOnTop(true, 'screen-saver')
  }, 4000)

  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    requestAnimatedClose()
    mainWindow?.showInactive()
    mainWindow?.setSkipTaskbar(true)
  })

  mainWindow.on('closed', () => {
    if (revealTimer) {
      clearTimeout(revealTimer)
      revealTimer = null
    }
    if (topmostTimer) {
      clearInterval(topmostTimer)
      topmostTimer = null
    }
    mainWindow = null
  })
  mainWindow.on('blur', () => {
    syncEscapeShortcut()
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
        const frames = (process.env.NOTCH_CAPTURE_FRAMES || '')
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value >= 0)
        const wantClose = process.env.NOTCH_CAPTURE_CLOSE === '1'
        const expandedShot = process.env.NOTCH_CAPTURE_EXPANDED !== '0'
        if (expandedShot) await setExpanded(true)
        const writeShot = async (file: string): Promise<void> => {
          if (!mainWindow || mainWindow.isDestroyed()) return
          const image = await mainWindow.webContents.capturePage()
          await fs.writeFile(file, image.toPNG())
        }
        const stamp = (suffix: string): string => {
          const ext = path.extname(capturePath)
          const base = ext ? capturePath.slice(0, -ext.length) : capturePath
          return `${base}${suffix}${ext || '.png'}`
        }
        const grabSequence = async (suffix: (at: number) => string): Promise<void> => {
          const started = Date.now()
          for (const at of frames) {
            const wait = at - (Date.now() - started)
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
            await writeShot(suffix(at))
          }
        }
        try {
          if (process.env.NOTCH_CAPTURE_JS && mainWindow) {
            const jsResult = await mainWindow.webContents.executeJavaScript(process.env.NOTCH_CAPTURE_JS)
            if (jsResult !== undefined) console.log('CAPTURE_JS:', JSON.stringify(jsResult))
            const jsSettle = Number(process.env.NOTCH_CAPTURE_JS_SETTLE ?? 650)
            if (jsSettle > 0) await new Promise((resolve) => setTimeout(resolve, jsSettle))
          }
          const closeOnly = process.env.NOTCH_CAPTURE_CLOSE_ONLY === '1'
          if (frames.length > 0 && !closeOnly) {
            await grabSequence((at) => stamp(`-${at}`))
          }
          if (wantClose && frames.length > 0) {
            const settle = Number(process.env.NOTCH_CAPTURE_SETTLE || 0)
            if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle))
            requestAnimatedClose()
            await grabSequence((at) => stamp(`-close-${at}`))
          } else if (frames.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1400))
            await writeShot(capturePath)
          }
        } catch (error) {
          console.error('Capture failed', error)
        } finally {
          app.quit()
        }
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
      { label: 'Collapse Notch', click: () => requestAnimatedClose() },
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
      if (expanded) requestAnimatedClose()
      else void setExpanded(true)
    })
  } catch {
    tray = null
  }
}

function showNotification(title: string, body: string, silent = false): void {
  if (!getState().settings.notifications) return
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body, silent })
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
  ipcMain.on('notch:timing', (_event, mark: string, ms: number) => {
    if (typeof mark !== 'string' || !Number.isFinite(ms)) return
    logLine(`timing ${mark} ${ms.toFixed(1)}ms`)
  })
  ipcMain.handle('notch:get-expanded', () => expanded)
  ipcMain.handle('notch:get-metrics', () => currentMetrics)
  ipcMain.handle('notch:get-backdrop', () => backdrop.getCachedBackdrop())
  ipcMain.on(
    'notch:shape',
    (
      _event,
      payload:
        | Electron.Rectangle
        | Electron.Rectangle[]
        | { focusOff: true; rects: Electron.Rectangle[] | null }
        | null
    ) => {
      if (payload && typeof payload === 'object' && 'focusOff' in payload) {
        // Only the open, focus-off panel may clip the full-screen window.
        // A collapsed-tab report that arrives during the open animation must
        // not shrink that window down to the tab.
        if (!expanded) return
        const list = Array.isArray(payload.rects) ? payload.rects : []
        const usable = list.filter((item) => item && item.width > 0 && item.height > 0)
        expandedShape = usable.length > 0 ? usable : null
        applyWindowShape()
        return
      }
      if (expanded) return
      const rect = Array.isArray(payload) ? payload[0] : payload
      if (rect && rect.width > 0 && rect.height > 0) collapsedShape = rect
      applyWindowShape()
    }
  )
  ipcMain.handle('notch:reposition', () => {
    applyBounds()
    return true
  })

  ipcMain.on('app:quit', () => {
    quitting = true
    app.quit()
  })

  ipcMain.on('app:notify', (_event, title: string, body: string, silent?: boolean) => {
    showNotification(title, body, silent === true)
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
      localArtist: local.artist,
      mediaSources: localMedia.listMediaSources()
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
    const sessionId = localMedia.currentMediaId(settings.mediaSource)
    if (followWithSpotifyApi(settings.mediaSource, sessionId, status.connected)) {
      try {
        const playback = await spotify.getPlayback(settings.spotifyClientId)
        if (playback.track || !localMedia.isLocalAvailable(settings.mediaSource)) return playback
      } catch {
        // Fall through to the Windows media session.
      }
    }
    return localMedia.getLocalPlayback(settings.mediaSource)
  })

  ipcMain.handle('spotify:queue', async () => {
    const settings = getState().settings
    const status = await spotify.getStatus(settings.spotifyRedirectPort)
    if (!status.connected) return []
    return spotify.getQueue(settings.spotifyClientId)
  })

  ipcMain.handle('spotify:library', async () => {
    const settings = getState().settings
    const status = await spotify.getStatus(settings.spotifyRedirectPort)
    if (!status.connected) return { recent: [], playlists: [] }
    return spotify.getLibrary(settings.spotifyClientId)
  })

async function openSpotifyApp(target = 'spotify:'): Promise<boolean> {
  const uri =
    target === 'spotify:' || /^spotify:(track|episode|album|playlist):[A-Za-z0-9]+$/.test(target)
      ? target
      : 'spotify:'
  try {
    await shell.openExternal(uri)
    return true
  } catch {
    // Fall back to common install locations. Those only start the app.
  }
  const candidates = [
    'C:\\Users\\' + (process.env.USERNAME || '') + '\\AppData\\Roaming\\Spotify\\Spotify.exe',
    'C:\\Program Files\\Spotify\\Spotify.exe',
    'C:\\Program Files (x86)\\Spotify\\Spotify.exe'
  ]
  const fileSystem = await import('node:fs')
  for (const candidate of candidates) {
    try {
      if (fileSystem.existsSync(candidate)) {
        spawn(candidate, [], { detached: true, stdio: 'ignore' }).unref()
        return true
      }
    } catch {
      // try next
    }
  }
  return false
}

async function recoverSpotifyDevice(clientId: string): Promise<boolean> {
  const opened = await openSpotifyApp('spotify:')
  if (opened && (await spotify.waitForDevice(clientId, 12000))) return true
  try {
    await shell.openExternal('https://open.spotify.com')
  } catch {
    return false
  }
  return spotify.waitForDevice(clientId, 8000)
}

async function startTrackOnDesktop(clientId: string, uri: string) {
  if (!/^spotify:(track|episode):[A-Za-z0-9]+$/.test(uri)) return null
  try {
    await shell.openExternal(uri)
  } catch {
    return null
  }
  const targetId = uri.split(':').pop() || ''
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const playback = await spotify.getPlayback(clientId).catch(() => null)
    if (playback?.track?.id === targetId) {
      return { ...playback, playing: true, fetchedAt: Date.now() }
    }
  }
  return null
}

  ipcMain.handle('spotify:action', (_event, action) => {
    const run = spotifyActionQueue.then(async () => {
      const settings = getState().settings
      const status = await spotify.getStatus(settings.spotifyRedirectPort)
      const sessionId = localMedia.currentMediaId(settings.mediaSource)
      const enhanced = followWithSpotifyApi(settings.mediaSource, sessionId, status.connected)
      const recoverable =
        action?.type === 'play' || action?.type === 'play-track' || action?.type === 'play-context'
      if ((action?.type === 'play-track' || action?.type === 'play-context') && !status.connected) {
        throw new Error('Connect your Spotify account to choose what plays. Opening the Spotify app still works.')
      }
      if (enhanced && recoverable) {
        const memory = getState().spotifyMemory
        try {
          return await spotify.performAction(settings.spotifyClientId, action, memory)
        } catch (error) {
          if (spotify.isPremiumRequired(error)) throw error
          if (!spotify.isNoActiveDevice(error)) {
            if (!localMedia.isLocalAvailable()) throw error
            return localMedia.performLocalAction(action)
          }
          const ready = await recoverSpotifyDevice(settings.spotifyClientId)
          if (ready) return spotify.performAction(settings.spotifyClientId, action, memory)
          if (action.type === 'play-track') {
            const recovered = await startTrackOnDesktop(settings.spotifyClientId, action.uri)
            if (recovered) return recovered
          }
          throw new Error('No Spotify device yet. Open Spotify, then press play again.')
        }
      }
      if (enhanced) {
        try {
          return await spotify.performAction(settings.spotifyClientId, action, getState().spotifyMemory)
        } catch (error) {
          if (spotify.isPremiumRequired(error) || spotify.isNoActiveDevice(error)) throw error
          if (!localMedia.isLocalAvailable()) throw error
        }
      }
      return localMedia.performLocalAction(action)
    })
    spotifyActionQueue = run.catch(() => undefined)
    return run
  })

  ipcMain.handle('spotify:launch', async (_event, target?: string) => {
    return openSpotifyApp(typeof target === 'string' ? target : 'spotify:')
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
      if (expanded) {
        requestAnimatedClose()
        return
      }
      void setExpanded(true).then(() => mainWindow?.focus())
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
    // Native widgets (the select popup, date pickers, scrollbars) follow this,
    // not just the page CSS. Without it the select menu is a white Windows list
    // with near-white option labels.
    nativeTheme.themeSource = 'dark'
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
    sessions.sessionReplyEvents.on('reply', (event) => {
      mainWindow?.webContents.send('session:reply', event)
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
