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
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  agentStatusEvents,
  agentStatusStart,
  agentStatusStop,
  decide as agentDecide,
  decideQuestion as agentDecideQuestion,
  releaseQuestion as agentReleaseQuestion,
  setupSnippet,
  snapshot as agentSnapshot,
  syncInstalledToolHooks,
  toolConnections
} from './agentStatus'
import { approvalClient, detectOpenCodePort } from './openCodeApprovals'
import { startTransfer, phoneHost, qrImage, type Parcel } from './phoneTransfer'
import type { AppState, AppStatePatch, NotchMetrics, MediaControlTarget } from '../shared/types'
import { pauseForegroundWatch, resumeForegroundWatch, setForegroundTarget, startForegroundWatch, stopForegroundWatch } from './foreground'
import { shouldAutoHide, type ForegroundSample } from '../shared/presence'
import { followWithSpotifyApi, isMusicSourceId, normalizeMediaPreference } from '../shared/mediaFollow'
import { collapsedLayout } from '../shared/notchLayout'
import { displayPhysicalSize, effectiveNotchStyle, listDisplays, notchDisplay, setDemoStageSize } from './notchDisplay'
import * as backdrop from './backdrop'
import {
  cleanupDemoSandbox,
  initDemoSandbox,
  isDemoCapture,
  isDemoMode,
  isDemoStage,
  registerDemoIpc,
  syncDemoPlatformFromDisplay
} from '@demo/main'
import * as localMedia from './localMedia'
import * as obsidian from './obsidian'
import * as sessions from './sessions'
import * as spotify from './spotify'
import * as calendar from './calendar'
import { convertTaskSchedule, formatTaskClock, resolveSystemTimeZone } from '../shared/timeZone'
import {
  checkForUpdates,
  disposeUpdater,
  downloadUpdate,
  getUpdateState,
  initUpdater,
  installUpdate,
  openUpdateRelease,
  syncAutoUpdateChecks
} from './updater'
import {
  activateLicenseKey,
  deactivateStoredLicense,
  getLicenseState,
  initLicense,
  isLicenseUnlocked,
  validateStoredLicense
} from './license'
import { flushState, getState, initState, persistNow, replaceState, setState, stateEvents, updateTask } from './state'

const isCaptureMode = !app.isPackaged && Boolean(process.env.NOTCH_CAPTURE)

if (isDemoMode) {
  initDemoSandbox()
  if (isDemoCapture) {
    app.commandLine.appendSwitch('force-device-scale-factor', '1.5')
  }
}

if (isCaptureMode) {
  app.disableHardwareAcceleration()
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let expanded = false
let expandedAt = 0
let expanding: Promise<boolean> | null = null
let collapsedShape: Electron.Rectangle[] | null = null
let expandedShape: Electron.Rectangle[] | null = null
let eventLoopWatch: ReturnType<typeof setInterval> | null = null
let lastWatchedVault: string | null = null
let reminderTimers = new Map<string, NodeJS.Timeout>()
let reminderReschedule: NodeJS.Timeout | null = null
let spotifyActionQueue: Promise<unknown> = Promise.resolve()
let quitting = false
let windowShown = false
let revealTimer: NodeJS.Timeout | null = null
let topmostTimer: NodeJS.Timeout | null = null
let rendererRecoveries = 0
let rendererRecoveryResetTimer: NodeJS.Timeout | null = null
let failureDialogOpen = false
let currentMetrics: NotchMetrics | null = null
let closeFallback: NodeJS.Timeout | null = null
let nativeDialogs = 0
let userHidden = false
let autoHidden = false
let agentToken = ''
let agentPort = 0

function loadAgentToken(): string {
  const file = path.join(app.getPath('userData'), 'agent-token.json')
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown }
    if (typeof saved.token === 'string' && saved.token.length >= 32) return saved.token
  } catch {
    // First run, or the file went away. A fresh token is fine.
  }
  const value = randomBytes(24).toString('hex')
  try {
    writeFileSync(file, JSON.stringify({ token: value }), { mode: 0o600 })
  } catch {
    // The bridge still works for this session even if it cannot be saved.
  }
  return value
}

function syncAgentBridge(): void {
  const settings = getState().settings
  const enabled = isLicenseUnlocked() && settings.agentStatus !== false
  const rawPort = Number(settings.agentStatusPort)
  const validPort = Number.isInteger(rawPort) && rawPort >= 1024 && rawPort <= 65535 ? rawPort : 7432
  const wanted = enabled ? validPort : 0
  if (wanted === agentPort) return
  agentPort = wanted
  if (wanted) agentStatusStart(wanted, agentToken)
  else agentStatusStop()
}
let sessionLocked = false
let presenceApplied: boolean | null = null
let foreground: ForegroundSample | null = null
let fullscreenStreak = 0
let explicitUserOpen = false
let lastShapeKey = ''
let appInitialized = false
let revealPending = false
let logChain: Promise<void> = Promise.resolve()

function armRevealTimer(): void {
  if (revealTimer) clearTimeout(revealTimer)
  revealTimer = setTimeout(() => revealWindow('timeout'), 2600)
}

function syncStoreStartupTask(openAtLogin: boolean): void {
  if (process.platform !== 'win32') return
  const desired = openAtLogin ? '$true' : '$false'
  const ps = [
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    '$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq \'AsTask\' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq \'IAsyncOperation`1\' })[0]',
    'function Await($op, $type) { $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }',
    '[Windows.ApplicationModel.StartupTask,Windows.ApplicationModel,ContentType=WindowsRuntime] | Out-Null',
    "$task = Await ([Windows.ApplicationModel.StartupTask]::GetAsync('NotchStartup')) ([Windows.ApplicationModel.StartupTask])",
    `if ($task) { if (${desired}) { Await ($task.RequestEnableAsync()) ([Windows.ApplicationModel.StartupTaskState]) | Out-Null } else { $task.Disable() } }`
  ].join('; ')
  execFile(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
    { windowsHide: true, timeout: 5000 },
    (error) => {
      if (error) logLine(`store StartupTask sync skipped (${error.message})`)
    }
  )
}

function syncLoginItem(openAtLogin: boolean): void {
  if (isDemoMode || !app.isPackaged) return
  if (process.windowsStore) {
    syncStoreStartupTask(openAtLogin)
    return
  }
  try {
    // Portable builds extract to a temporary directory on every run; register the
    // persistent wrapper path when running portable so login auto-start survives reboot.
    app.setLoginItemSettings({
      openAtLogin,
      path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
    })
  } catch {
    // Ignore login-item registration failures under restricted policies.
  }
}

/**
 * Re-assert window visibility and screen-saver topmost stacking without stealing focus.
 * Recovers from Windows z-order drops (taskbar popups, toasts, overlays) or Win+D hides.
 */
function assertTopmost(): void {
  if (quitting || isDemoStage || !mainWindow || mainWindow.isDestroyed()) return
  if (!windowShown || userHidden || autoHidden || sessionLocked) return
  if (nativeDialogs > 0) return
  if (!mainWindow.isVisible()) {
    mainWindow.showInactive()
    lastShapeKey = ''
    applyWindowShape()
  }
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.setSkipTaskbar(true)
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win = mainWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, ...args)
}

function syncBackgroundThrottling(): void {
  const win = mainWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  const state = getState()
  const needsBackgroundTimers =
    expanded ||
    state.timer.running ||
    ((state.water.reminderMinutes ?? 0) > 0 && state.water.remindAt !== null) ||
    state.posture.enabled
  win.webContents.setBackgroundThrottling(!needsBackgroundTimers)
}

function handleForegroundSample(sample: ForegroundSample): void {
  const wasFullscreen = foreground?.fullscreen === true
  fullscreenStreak = sample.fullscreen ? Math.min(fullscreenStreak + 1, 2) : 0
  // Require two consecutive fullscreen samples (~1.6s) before auto-hiding so
  // single-frame focus transitions and Alt+Tab flickers do not blink the notch.
  foreground = {
    ...sample,
    fullscreen: sample.fullscreen && fullscreenStreak >= 2
  }
  if (explicitUserOpen && !expanded && !shouldAutoHide(foreground, getState().settings, false)) {
    explicitUserOpen = false
  }
  applyPresence()
  if (
    wasFullscreen &&
    !foreground.fullscreen &&
    !userHidden &&
    !autoHidden &&
    !sessionLocked &&
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.isVisible()
  ) {
    mainWindow.setAlwaysOnTop(true, 'screen-saver')
  }
}

function applyPresence(): void {
  if (isDemoStage) {
    autoHidden = false
    userHidden = false
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setIgnoreMouseEvents(false)
      if (windowShown && !mainWindow.isVisible()) mainWindow.show()
    }
    return
  }
  autoHidden = shouldAutoHide(foreground, getState().settings, explicitUserOpen)
  if (userHidden) {
    pauseForegroundWatch()
  } else if (!sessionLocked) {
    resumeForegroundWatch()
  }
  if (!mainWindow || mainWindow.isDestroyed()) return
  const hidden = userHidden || autoHidden
  const visibleNow = mainWindow.isVisible()
  const alreadyMatches =
    presenceApplied === hidden &&
    (hidden ? !visibleNow : !windowShown || visibleNow)
  if (alreadyMatches) return
  const changed = presenceApplied !== hidden
  presenceApplied = hidden
  if (hidden) {
    if (expanded) void setExpanded(false)
    // Calling hide() removes the window from DWM compositing without leaving a
    // transparent full-screen surface or low-level mouse forwarding hook active.
    mainWindow.hide()
    if (mainWindow.isFocused()) mainWindow.blur()
    syncBackgroundThrottling()
    if (changed) logLine(`notch hidden user=${userHidden} auto=${autoHidden}`)
    if (changed && windowShown) sendToRenderer('notch:presence', { hidden: true })
    return
  }
  mainWindow.setIgnoreMouseEvents(false)
  if (windowShown && !visibleNow) mainWindow.showInactive()
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.setSkipTaskbar(true)
  lastShapeKey = ''
  applyWindowShape()
  syncBackgroundThrottling()
  if (changed && windowShown) sendToRenderer('notch:presence', { hidden: false })
  logLine(changed ? 'notch shown' : 'notch visibility restored')
}

function logLine(message: string): void {
  try {
    const file = path.join(app.getPath('userData'), 'notch.log')
    const line = `[${new Date().toISOString()}] ${message}\n`
    logChain = logChain
      .then(() => fs.appendFile(file, line, 'utf8'))
      .catch(() => undefined)
  } catch {
    // Logging must never be the reason the app fails.
  }
}

function logLineSync(message: string): void {
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
  logLineSync(`uncaughtException ${error?.stack || String(error)}`)
})

process.on('unhandledRejection', (reason) => {
  logLineSync(`unhandledRejection ${reason instanceof Error ? reason.stack : String(reason)}`)
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
  const display = notchDisplay()
  const settings = getState().settings
  const style = effectiveNotchStyle(display)
  const layout = collapsedLayout(settings.notchPosition, display.workArea, style)
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
    noticeAbove: layout.metrics.noticeAbove,
    style,
    inset: {
      right: Math.max(
        0,
        display.bounds.x + display.bounds.width - (display.workArea.x + display.workArea.width)
      ),
      bottom: Math.max(
        0,
        display.bounds.y + display.bounds.height - (display.workArea.y + display.workArea.height)
      )
    }
  }
  sendToRenderer('notch:metrics', currentMetrics)
  if (!expanded) collapsedShape = [tabHit(currentMetrics)]
  return {
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height
  }
}

function applyBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (isDemoStage) {
    const [w, h] = mainWindow.getContentSize()
    if (w > 100 && h > 100) setDemoStageSize(w, h)
    refreshCollapsedLayout()
    return
  }
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
  lastShapeKey = ''
  applyWindowShape()
}

function clearCloseFallback(): void {
  if (!closeFallback) return
  clearTimeout(closeFallback)
  closeFallback = null
}

// A native file picker deactivates the notch, which looks exactly like an
// outside click. Keep the panel open while a dialog is up.
async function withNativeDialog<T>(run: () => Promise<T>): Promise<T> {
  nativeDialogs += 1
  // Esc belongs to the dialog while it is up, not to the global notch close.
  const hadEscape = globalShortcut.isRegistered('Escape')
  if (hadEscape) globalShortcut.unregister('Escape')
  try {
    return await run()
  } finally {
    nativeDialogs -= 1
    syncEscapeShortcut()
  }
}

// Ask the renderer to shrink the panel back into the tab, then actually resize.
// A fallback covers a renderer that never finishes the animation.
function requestAnimatedClose(): void {
  if (!mainWindow || !expanded) return
  sendToRenderer('notch:request-close')
  clearCloseFallback()
  closeFallback = setTimeout(() => {
    closeFallback = null
    if (expanded) void setExpanded(false)
  }, 980)
}

async function setExpanded(next: boolean, notify = true): Promise<boolean> {
  if (!mainWindow) return false

  if (next) {
    if (userHidden || autoHidden) return false
    if (expanded) return true
    if (expanding) return expanding
    const started = performance.now()
    // The window is already display-sized. Do not resize, and do not wait
    // for a snapshot or a "hide the tab" frame.
    expanded = true
    expandedShape = null
    expandedAt = Date.now()
    // While the panel covers the screen a capture would only photograph the
    // panel, so background refreshes stop until it closes.
    backdrop.suspendBackdropCapture()
    const focusBackdrop = getState().settings.focusMode !== false ? backdrop.getCachedBackdrop() : null
    applyWindowShape()
    syncBackgroundThrottling()
    if (!isDemoStage) mainWindow.setAlwaysOnTop(true, 'screen-saver')
    const display = notchDisplay()
    if (notify) {
      // The blurred desktop behind focus mode is the last snapshot taken while
      // the notch was collapsed, so opening never waits for a capture.
      if (focusBackdrop) sendToRenderer('notch:backdrop', { image: focusBackdrop })
      sendToRenderer('notch:expanded', {
        expanded: true,
        viewport: { width: display.bounds.width, height: display.bounds.height }
      })
    }
    if (!isDemoStage) {
      mainWindow.showInactive()
      mainWindow.setSkipTaskbar(true)
    } else if (!mainWindow.isVisible()) {
      if (isDemoCapture) mainWindow.showInactive()
      else mainWindow.show()
    }
    syncEscapeShortcut()
    expanding = null
    logLine(`open dispatched in ${(performance.now() - started).toFixed(1)}ms`)
    return true
  }

  clearCloseFallback()
  const started = performance.now()
  expanding = null
  expanded = false
  if (explicitUserOpen) {
    explicitUserOpen = false
    applyPresence()
  }
  expandedShape = null
  syncEscapeShortcut()
  // No refresh right after a close: the user often opens it again within a
  // few seconds, and a capture freezes the main process for a second or two.
  backdrop.resumeBackdropCapture()
  if (currentMetrics) collapsedShape = [tabHit(currentMetrics)]
  applyWindowShape()
  assertTopmost()
  syncBackgroundThrottling()
  if (notify && mainWindow) {
    sendToRenderer('notch:expanded', { expanded: false })
  }
  logLine(`close dispatched in ${(performance.now() - started).toFixed(1)}ms`)
  if (!isDemoStage) setTimeout(() => nudgePointerHover(), 40)
  return false
}

// After the window shrinks back to the tab, Chromium keeps the last pointer
// position clamped to the old (full screen) viewport. If the pointer is parked
// on the tab it never sends a fresh move, so the tab shows no hover state and
// the OS keeps the arrow cursor even though the pointer is right there. Feed
// one mouse move in from the real cursor position so hover and the hand cursor
// are correct without the user having to wiggle the mouse.
function nudgePointerHover(): void {
  if (!mainWindow || mainWindow.isDestroyed() || expanded || userHidden || autoHidden || !mainWindow.isVisible()) return
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
  if (!mainWindow || mainWindow.isDestroyed() || isDemoStage) return
  try {
    const bounds = mainWindow.getBounds()
    const full = { x: 0, y: 0, width: bounds.width + 2, height: bounds.height + 2 }
    const nextRects = expanded
      ? expandedShape && expandedShape.length > 0
        ? expandedShape
        : [full]
      : collapsedShape
        ? collapsedShape
        : [full]
    const key = nextRects.map((r) => `${r.x},${r.y},${r.width},${r.height}`).join(';')
    if (key === lastShapeKey) return
    // Focus mode owns the whole screen so the backdrop can take a click.
    // With focus mode off, the renderer sends only the panel (and any
    // toast) so the rest of the desktop keeps the mouse.
    mainWindow.setShape(nextRects)
    lastShapeKey = key
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
  if (userHidden || autoHidden) return
  if (isDemoStage) {
    if (isDemoCapture) mainWindow.showInactive()
    else mainWindow.show()
    applyBounds()
    logLine(
      `demo window shown (${reason}) bounds=${JSON.stringify(mainWindow.getBounds())} visible=${mainWindow.isVisible()}`
    )
    return
  }
  mainWindow.showInactive()
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  // Windows gives every visible top-level window a taskbar button. The option
  // flag alone does not survive the first show on some Electron versions, so
  // re-assert it after the window becomes visible.
  mainWindow.setSkipTaskbar(true)
  lastShapeKey = ''
  applyWindowShape()
  logLine(
    `window shown (${reason}) bounds=${JSON.stringify(mainWindow.getBounds())} visible=${mainWindow.isVisible()}`
  )
}

async function openFromUserAction(focus = true): Promise<void> {
  userHidden = false
  explicitUserOpen = shouldAutoHide(foreground, getState().settings, false)
  applyPresence()
  if (await setExpanded(true)) {
    if (focus) mainWindow?.focus()
  } else {
    explicitUserOpen = false
    applyPresence()
  }
}

function parseSmartAppControl(output: string): 'on' | 'evaluation' | 'off' | 'unknown' {
  const match = output.match(/VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i)
  if (!match) return 'unknown'
  const value = Number.parseInt(match[1], 16)
  if (value === 0) return 'off'
  if (value === 1) return 'on'
  if (value === 2) return 'evaluation'
  return 'unknown'
}

function readSmartAppControlState(): Promise<'on' | 'evaluation' | 'off' | 'unknown'> {
  if (process.platform !== 'win32') return Promise.resolve('unknown')
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      [
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy',
        '/v',
        'VerifiedAndReputablePolicyState'
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 },
      (error, stdout) => {
        if (error || !stdout) {
          resolve('unknown')
          return
        }
        resolve(parseSmartAppControl(stdout))
      }
    )
  })
}

function syncEscapeShortcut(): void {
  if (isDemoStage) return
  // Esc must close the notch even when the window never got focus, which is the
  // normal case: the notch opens on hover via showInactive(), so keyboard focus
  // stays in whatever app the user was in. Grab Esc globally only while the
  // notch is expanded and unfocused; a focused window handles Esc itself, which
  // keeps "Esc leaves a text field" working inside the notch.
  if (!mainWindow || mainWindow.isDestroyed()) return
  const want =
    expanded && !mainWindow.isFocused() && nativeDialogs === 0 && !getState().settings.pinOnOpen
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

async function showRendererFailure(details: Electron.RenderProcessGoneDetails): Promise<void> {
  if (failureDialogOpen) return
  failureDialogOpen = true
  const logPath = path.join(app.getPath('userData'), 'notch.log')
  const sac = await readSmartAppControlState()
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

  const messageBoxOptions: Electron.MessageBoxOptions = {
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
  }

  void withNativeDialog(() =>
    mainWindow && !mainWindow.isDestroyed()
      ? dialog.showMessageBox(mainWindow, messageBoxOptions)
      : dialog.showMessageBox(messageBoxOptions)
  )
    .then(({ response }) => {
      failureDialogOpen = false
      mainWindow?.setSkipTaskbar(true)
      if (response === 0 && mainWindow && !mainWindow.isDestroyed()) {
        rendererRecoveries = 0
        windowShown = false
        armRevealTimer()
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
  const work = screen.getPrimaryDisplay().workArea
  const stageWidth = isDemoCapture ? 1280 : Math.min(1280, Math.max(960, work.width - 48))
  const stageHeight = isDemoCapture ? 720 : Math.min(720, Math.max(600, work.height - 64))
  if (isDemoStage) setDemoStageSize(stageWidth, stageHeight)
  const initial = refreshCollapsedLayout()
  windowShown = false
  rendererRecoveries = 0
  if (revealTimer) {
    clearTimeout(revealTimer)
    revealTimer = null
  }
  const iconPath = path.join(__dirname, '../../resources/icon.png')
  mainWindow = new BrowserWindow(
    isDemoStage
      ? {
          width: stageWidth,
          height: stageHeight,
          ...(isDemoCapture ? { x: 0, y: 0 } : { center: true }),
          useContentSize: true,
          show: false,
          frame: !isDemoCapture,
          transparent: false,
          backgroundColor: '#050507',
          resizable: !isDemoCapture,
          movable: !isDemoCapture,
          minimizable: !isDemoCapture,
          maximizable: !isDemoCapture,
          fullscreenable: false,
          skipTaskbar: isDemoCapture,
          hasShadow: !isDemoCapture,
          alwaysOnTop: false,
          acceptFirstMouse: true,
          title: 'Hero Notch',
          icon: iconPath,
          webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
            backgroundThrottling: false
          }
        }
      : {
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
          title: isDemoMode ? 'Hero Notch' : 'Notch',
          icon: iconPath,
          webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: !isDemoMode,
            backgroundThrottling: false
          }
        }
  )

  if (!isDemoStage) {
    mainWindow.setAlwaysOnTop(true, 'screen-saver')
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Windows/Electron otherwise clamps the collapsed window to ~40px high,
    // leaving a strip below the tab that swallowed hover from the window
    // underneath. The tab only needs 26.
    mainWindow.setMinimumSize(1, 1)
  } else {
    mainWindow.setMenuBarVisibility(false)
    mainWindow.on('resize', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const [w, h] = mainWindow.getContentSize()
      setDemoStageSize(w, h)
      applyBounds()
      if (expanded) {
        sendToRenderer('notch:expanded', {
          expanded: true,
          viewport: { width: w, height: h }
        })
      }
    })
  }
  lastShapeKey = ''
  presenceApplied = null
  applyPresence()
  applyBounds()
  syncBackgroundThrottling()

  const rendererIndexFile = path.join(__dirname, '../renderer/index.html')
  const allowedRendererHref = pathToFileURL(rendererIndexFile).href.toLowerCase()
  const isAllowedRendererUrl = (candidate: string): boolean => {
    const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : ''
    if (devUrl && candidate.startsWith(devUrl)) return true
    const clean = candidate.split(/[?#]/)[0].toLowerCase()
    return clean === allowedRendererHref
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedRendererUrl(url)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url).catch(() => undefined)
  })

  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (isAllowedRendererUrl(url)) return
    event.preventDefault()
  })

  mainWindow.once('ready-to-show', () => revealWindow('ready-to-show'))
  mainWindow.webContents.on('did-finish-load', () => {
    if (currentMetrics) sendToRenderer('notch:metrics', currentMetrics)
    revealWindow('did-finish-load')
  })

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
      if (rendererRecoveryResetTimer) clearTimeout(rendererRecoveryResetTimer)
      rendererRecoveryResetTimer = setTimeout(() => {
        rendererRecoveryResetTimer = null
        rendererRecoveries = 0
      }, 60_000)
      rendererRecoveryResetTimer.unref?.()
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        logLine('retrying renderer after crash')
        armRevealTimer()
        mainWindow.webContents.reload()
      }, 700)
      return
    }
    void showRendererFailure(details)
  })

  // Some GPUs and remote sessions never emit ready-to-show. Reveal the notch
  // anyway so the app cannot end up running with no visible window.
  armRevealTimer()

  // Windows can drop the notch out of the top of the z-order (a fullscreen app
  // closing, the shell restarting, display changes) or hide tool windows (Win+D).
  // Re-assert topmost on a fast timer; this only raises/restores without focus.
  if (topmostTimer) {
    clearInterval(topmostTimer)
    topmostTimer = null
  }
  topmostTimer = setInterval(() => {
    if (expanded) return
    assertTopmost()
  }, 3_000)
  topmostTimer.unref?.()

  // A stalled main process is felt as a slow open: the click waits in the
  // queue. Log any stall so a slow open can be traced to its cause.
  if (!eventLoopWatch) {
    let last = Date.now()
    eventLoopWatch = setInterval(() => {
      const now = Date.now()
      const late = now - last - 100
      last = now
      if (late > 200) logLine(`main event loop stalled ${late}ms`)
    }, 100)
    eventLoopWatch.unref?.()
  }

  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    requestAnimatedClose()
    if (!isDemoStage) {
      if (!userHidden && !autoHidden) mainWindow?.showInactive()
      mainWindow?.setSkipTaskbar(true)
    }
  })

  mainWindow.on('closed', () => {
    if (revealTimer) {
      clearTimeout(revealTimer)
      revealTimer = null
    }
    if (rendererRecoveryResetTimer) {
      clearTimeout(rendererRecoveryResetTimer)
      rendererRecoveryResetTimer = null
    }
    if (topmostTimer) {
      clearInterval(topmostTimer)
      topmostTimer = null
    }
    mainWindow = null
  })
  mainWindow.on('blur', () => {
    syncEscapeShortcut()
    // Focus mode has its own backdrop click. With focus mode off the window is
    // shaped to the panel, so a click on the desktop never reaches the page.
    // Once the notch has focus (the user typed or clicked a control), losing
    // that focus is the outside click: close instead of staying open.
    if (isDemoStage) return
    if (!expanded || Date.now() - expandedAt < 400) return
    if (getState().settings.pinOnOpen) return
    if (closeFallback) return
    if (nativeDialogs > 0) return
    requestAnimatedClose()
  })

  mainWindow.on('focus', () => {
    syncEscapeShortcut()
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(rendererIndexFile)
  }

  const capturePath = isCaptureMode ? process.env.NOTCH_CAPTURE : undefined
  if (capturePath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const page = process.env.NOTCH_CAPTURE_PAGE
        // The renderer may subscribe to 'navigate' after this first tick, so
        // repeat it — setPage is idempotent.
        if (page) {
          let sent = 0
          const navTimer = setInterval(() => {
            sendToRenderer('navigate', page)
            if (++sent >= 12) clearInterval(navTimer)
          }, 1200)
          sendToRenderer('navigate', page)
        }
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
          void openFromUserAction(false)
        }
      },
      { label: 'Collapse Notch', click: () => requestAnimatedClose() },
      {
        label: 'Check for updates…',
        click: () => {
          if (!mainWindow) createWindow()
          revealWindow('tray-menu')
          void openFromUserAction(false).then(() => {
            sendToRenderer('navigate', 'settings:about')
            void checkForUpdates({ manual: true })
          })
        }
      },
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
      else void openFromUserAction(false)
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
    void openFromUserAction()
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
  const systemTz = resolveSystemTimeZone()
  const converted = task.time
    ? convertTaskSchedule(task.date, task.time, task.timeZone || systemTz, systemTz)
    : null
  const labelTime =
    converted?.time ? formatTaskClock(converted.date, converted.time, systemTz, false) : task.time
  showNotification('Reminder', labelTime ? `${task.title} · ${labelTime}` : task.title)
  sendToRenderer('reminder:fired', {
    taskId: task.id,
    title: task.title,
    date: task.date,
    time: task.time,
    timeZone: task.timeZone
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
    sendToRenderer('vault:changed', getState().settings.vaultPath)
  })
}

function isSafeExternalUrl(raw: unknown, allowObsidian = false): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return true
    if (allowObsidian && parsed.protocol === 'obsidian:') return true
    return false
  } catch {
    return false
  }
}

function requireLicensed(): void {
  if (!isLicenseUnlocked()) {
    throw new Error('Activate your Notch license to use this feature.')
  }
}

const VALID_AGENT_TOOLS = new Set(['claude', 'codex', 'cursor', 'gemini', 'antigravity', 'opencode'])

function sanitizeShapeRects(list: unknown[]): Electron.Rectangle[] {
  const usable: Electron.Rectangle[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const rect = item as Record<string, unknown>
    const x = Number(rect.x)
    const y = Number(rect.y)
    const width = Number(rect.width)
    const height = Number(rect.height)
    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
    ) {
      usable.push({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height)
      })
    }
  }
  return usable
}

function requireVault(requested?: string): string {
  requireLicensed()
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
  ipcMain.handle('updater:get-state', () => getUpdateState())
  ipcMain.handle('updater:check', (_event, options?: { manual?: boolean }) =>
    checkForUpdates({ manual: options?.manual !== false })
  )
  ipcMain.handle('updater:download', () => downloadUpdate())
  ipcMain.handle('updater:install', () => installUpdate())
  ipcMain.on('updater:open-release', () => openUpdateRelease())
  ipcMain.handle('license:get-state', () => getLicenseState())
  ipcMain.handle('license:activate', (_event, key: string) => activateLicenseKey(String(key || '')))
  ipcMain.handle('license:validate', () => validateStoredLicense(true))
  ipcMain.handle('license:deactivate', () => deactivateStoredLicense())

  ipcMain.handle('app:set-state', (_event, patch: AppStatePatch) => {
    requireLicensed()
    const before = getState()
    // Vault path can only be selected via the native folder picker dialog (or cleared to null),
    // preventing renderer code from pivoting filesystem access to an arbitrary directory.
    let safePatch = patch
    if (
      !isDemoMode &&
      patch?.settings &&
      'vaultPath' in patch.settings &&
      patch.settings.vaultPath !== null &&
      patch.settings.vaultPath !== before.settings.vaultPath
    ) {
      const { vaultPath: _ignored, ...restSettings } = patch.settings
      safePatch = { ...patch, settings: restSettings }
    }
    const next = setState(safePatch)
    // Turning the posture coach on or off is the user's standing choice. Write it
    // now instead of waiting for the save timer, so a quick exit cannot lose it.
    if (patch.posture?.enabled !== undefined) void persistNow()

    if (
      !isDemoMode &&
      (patch.settings?.spotifyClientId !== undefined ||
        patch.settings?.spotifyRedirectPort !== undefined)
    ) {
      const clientId = next.settings.spotifyClientId.trim()
      if (clientId) void spotify.saveCredentials(clientId, next.settings.spotifyRedirectPort)
    }

    if (
      patch.settings?.launchAtLogin !== undefined &&
      patch.settings.launchAtLogin !== before.settings.launchAtLogin
    ) {
      syncLoginItem(next.settings.launchAtLogin)
    }

    if (
      patch.settings?.autoCheckUpdates !== undefined &&
      patch.settings.autoCheckUpdates !== before.settings.autoCheckUpdates
    ) {
      syncAutoUpdateChecks(next.settings.autoCheckUpdates !== false)
    }

    const browserModeChanged = before.settings.browserOnly !== next.settings.browserOnly
    if (browserModeChanged) explicitUserOpen = false
    if (
      patch.settings?.notchPosition !== undefined ||
      patch.settings?.notchStyle !== undefined ||
      patch.settings?.notchDisplay !== undefined ||
      patch.settings?.pillOnOtherDisplays !== undefined
    ) {
      applyBounds()
    }
    if (isDemoMode) {
      syncDemoPlatformFromDisplay(patch.settings?.notchDisplay, sendToRenderer)
    } else if (browserModeChanged || patch.settings?.notchDisplay !== undefined) {
      setForegroundTarget(displayPhysicalSize(notchDisplay()), next.settings.browserOnly === true)
    }
    if (patch.tasks) scheduleRemindersSoon()
    // Enabling browser detection starts a fresh watcher. Its first sample
    // decides visibility, so an already-open browser doesn't cause a flash.
    if (
      !isDemoStage &&
      ((browserModeChanged && !next.settings.browserOnly) ||
        patch.settings?.autoHideFullscreen !== undefined ||
        patch.settings?.neverOver !== undefined)
    ) {
      applyPresence()
    }
    refreshVaultWatcher()
    return next
  })

  ipcMain.handle('notch:set-expanded', (_event, value: boolean) => setExpanded(Boolean(value)))
  ipcMain.on('notch:timing', (_event, mark: string, ms: number) => {
    if (typeof mark !== 'string' || !Number.isFinite(ms)) return
    logLine(`timing ${mark} ${ms.toFixed(1)}ms`)
  })
  ipcMain.handle('notch:get-expanded', () => expanded)
  ipcMain.handle('notch:get-presence', () => ({ hidden: userHidden || autoHidden }))
  ipcMain.handle('notch:get-metrics', () => currentMetrics)
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
        if (!expanded) return
        const list = Array.isArray(payload.rects) ? payload.rects : []
        const usable = sanitizeShapeRects(list)
        expandedShape = usable.length > 0 ? usable : null
        applyWindowShape()
        return
      }
      if (expanded) return
      // The tab and a corner notice are far apart, so the collapsed shape is a
      // list of regions. One box around both would block the whole desktop.
      const rects = Array.isArray(payload) ? payload : payload ? [payload] : []
      const usable = sanitizeShapeRects(rects)
      if (usable.length > 0) collapsedShape = usable
      else if (payload === null) collapsedShape = null
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
    if (!isDemoMode && typeof title === 'string' && typeof body === 'string') {
      showNotification(title, body, silent === true)
    }
  })

  ipcMain.on('app:open-external', (_event, url: string) => {
    if (!isDemoMode && isSafeExternalUrl(url, true)) {
      void shell.openExternal(url).catch(() => undefined)
    }
  })

  ipcMain.on('app:copy-text', (_event, text: string) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })

  ipcMain.handle('posture:trace-enabled', () => !app.isPackaged && Boolean(process.env.NOTCH_POSTURE_TRACE))

  // The posture coach releases the camera when nobody is in frame for a while and
  // wakes on any keyboard or mouse activity, which only the OS can report.
  ipcMain.handle('system:idle-seconds', () => powerMonitor.getSystemIdleTime())
  ipcMain.handle('posture:away-override', () =>
    !app.isPackaged ? Number(process.env.NOTCH_POSTURE_AWAY_MS) || 0 : 0
  )

  ipcMain.on('posture:trace', (_event, sample: unknown) => {
    const target = !app.isPackaged ? process.env.NOTCH_POSTURE_TRACE : ''
    if (!target) return
    try {
      void fs.appendFile(target, `${JSON.stringify(sample)}\n`)
    } catch {
      // Diagnostics must never disturb posture tracking.
    }
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

  ipcMain.handle('obsidian:search', async (_event, vaultPath: string, query: string) => {
    return obsidian.searchNotes(requireVault(vaultPath), query)
  })

  if (isDemoMode) {
    registerDemoIpc({
      getMainWindow: () => mainWindow,
      sendToRenderer,
      applyStatePatch: (patch) => setState(patch),
      resetAppState: (next) => {
        replaceState(next)
        expanded = false
        applyBounds()
        sendToRenderer('state:updated', getState())
      },
      onChaptersDone: (chapters) => {
        logLine(`demo:done chapters=${chapters.length}`)
        if (!app.isPackaged && process.env.NOTCH_DEMO_DONE_FILE) {
          void fs.writeFile(process.env.NOTCH_DEMO_DONE_FILE, JSON.stringify(chapters, null, 2), 'utf8').catch(() => {})
        }
      }
    })
    return
  }

  let transfer: Awaited<ReturnType<typeof startTransfer>> | null = null
  let qr = ''
  let starting = false
  const stopActiveTransfer = (): void => {
    transfer?.stop()
    transfer = null
    qr = ''
  }
  stopTransferHook = stopActiveTransfer
  ipcMain.handle('agent:status', () => {
    requireLicensed()
    return agentSnapshot()
  })
  const agentConnections = async (): Promise<import('../shared/types').AgentConnection[]> => {
    const rows = await toolConnections()
    // Claude approvals ride hooks, but messaging from Sessions goes through the
    // Claude Code command line, which keeps its own sign-in.
    const claudeRow = rows.find((row) => row.tool === 'claude')
    if (claudeRow && claudeRow.state !== 'missing') {
      const auth = await sessions.claudeSignInStatus()
      if (auth === 'signed-out') {
        claudeRow.state = 'attention'
        claudeRow.detail =
          'Approvals work, but Notch cannot message Claude sessions until Claude Code is signed in.'
        claudeRow.action = 'claude-login'
      } else if (auth === 'signed-in' && claudeRow.state === 'ready') {
        claudeRow.detail = 'Approvals, questions and messages from Sessions all work.'
      }
    }
    // OpenCode is read through its own server, so its row is built here.
    const port = getState().settings.openCodeApprovalPort || (await detectOpenCodePort().catch(() => null))
    rows.push(
      port
        ? { tool: 'opencode', label: 'OpenCode', state: 'ready', detail: 'Connected. Approvals and questions work.' }
        : { tool: 'opencode', label: 'OpenCode', state: 'idle', detail: 'Open OpenCode to connect.' }
    )
    return rows
  }
  ipcMain.handle('agent:connections', () => {
    requireLicensed()
    return agentConnections()
  })
  ipcMain.handle('agent:claude-login', () => {
    requireLicensed()
    return sessions.startClaudeSignIn()
  })
  ipcMain.handle('agent:reconnect', async () => {
    requireLicensed()
    if (agentPort > 0 && agentToken) await syncInstalledToolHooks(agentPort, agentToken)
    return agentConnections()
  })
  ipcMain.handle('agent:setup', (_event, tool: import('../shared/types').AgentTool) => {
    requireLicensed()
    if (typeof tool !== 'string' || !VALID_AGENT_TOOLS.has(tool)) {
      throw new Error('Unknown agent tool.')
    }
    return setupSnippet(tool, agentPort || getState().settings.agentStatusPort || 7432, agentToken)
  })
  ipcMain.handle('agent:decide', (_event, id: string, reply: 'allow' | 'deny') => {
    requireLicensed()
    return agentDecide(id, reply)
  })
  ipcMain.handle(
    'agent:questionDecide',
    (_event, id: string, response: import('../shared/types').AgentQuestionResponse) => {
      requireLicensed()
      return agentDecideQuestion(id, response)
    }
  )
  ipcMain.handle('agent:questionRelease', (_event, id: string) => {
    requireLicensed()
    return agentReleaseQuestion(id)
  })
  ipcMain.handle('approvals:list', () => {
    requireLicensed()
    return approvalClient(getState().settings.openCodeApprovalPort || 0).list()
  })
  ipcMain.handle('approvals:decide', (_event, key, reply, port) => {
    requireLicensed()
    if (port !== getState().settings.openCodeApprovalPort) throw new Error('OpenCode connection changed.')
    return approvalClient(port).decide(key, reply)
  })
  ipcMain.handle('approvals:questions', () => {
    requireLicensed()
    return approvalClient(getState().settings.openCodeApprovalPort || 0).listQuestions()
  })
  ipcMain.handle('approvals:questionReply', (_event, id: string, answers: string[][], port: number) => {
    requireLicensed()
    if (port !== getState().settings.openCodeApprovalPort) throw new Error('OpenCode connection changed.')
    return approvalClient(port).replyQuestion(id, answers)
  })
  ipcMain.handle('approvals:questionReject', (_event, id: string, port: number) => {
    requireLicensed()
    if (port !== getState().settings.openCodeApprovalPort) throw new Error('OpenCode connection changed.')
    return approvalClient(port).rejectQuestion(id)
  })
  ipcMain.handle('phone:start', async (_event, file: Parcel | null, options?: { clipboard?: boolean; text?: string }) => {
    requireLicensed()
    if (transfer && transfer.expires <= Date.now()) stopActiveTransfer()
    if (starting || (transfer && transfer.expires > Date.now())) throw new Error('A transfer is already open.')
    starting = true
    try {
      const typed = options?.text ?? ''
      let parcel: Parcel | null = file
      if (typed.trim()) parcel = { name: 'note.txt', bytes: Buffer.from(typed, 'utf8'), text: true }
      else if (options?.clipboard) parcel = { name: 'clipboard.txt', bytes: Buffer.from(await clipboard.readText()), text: true }
      transfer = await startTransfer(phoneHost(), parcel)
      qr = qrImage(transfer.url, app.getAppPath())
    } catch (error) {
      stopActiveTransfer()
      throw error
    } finally {
      starting = false
    }
  })
  ipcMain.handle('phone:status', () => {
    requireLicensed()
    if (!transfer) return null
    if (transfer.expires <= Date.now()) {
      stopActiveTransfer()
      return null
    }
    const item = transfer.peek()
    return { qr, received: item ? { name: item.name, text: item.text } : null }
  })
  ipcMain.handle('phone:collect', async () => {
    requireLicensed()
    const current = transfer
    const item = current?.peek()
    if (!item || !current || current.expires <= Date.now()) {
      if (current && current.expires <= Date.now()) stopActiveTransfer()
      throw new Error('Transfer expired.')
    }
    if (item.text) await clipboard.writeText(Buffer.from(item.bytes).toString('utf8'))
    else {
      const saveOptions: Electron.SaveDialogOptions = {
        defaultPath: path.join(app.getPath('downloads'), /^\.+$/.test(item.name) ? 'received' : item.name)
      }
      const choice = await withNativeDialog(() =>
        mainWindow && !mainWindow.isDestroyed()
          ? dialog.showSaveDialog(mainWindow, saveOptions)
          : dialog.showSaveDialog(saveOptions)
      )
      if (choice.canceled || !choice.filePath) return
      await fs.writeFile(choice.filePath, item.bytes)
    }
    current.collected(item)
  })
  ipcMain.handle('phone:stop', () => {
    stopActiveTransfer()
  })
  app.once('before-quit', () => stopActiveTransfer())
  ipcMain.handle('calendar:snapshot', () => {
    requireLicensed()
    return calendar.calendarSnapshot()
  })
  ipcMain.handle('calendar:status', () => {
    requireLicensed()
    return calendar.calendarStatus()
  })
  ipcMain.handle('calendar:connect', () => {
    requireLicensed()
    return calendar.connectCalendar()
  })
  ipcMain.handle('calendar:cancel-connect', () => calendar.cancelCalendarConnect())
  ipcMain.handle('calendar:disconnect', () => {
    requireLicensed()
    return calendar.disconnectCalendar()
  })
  ipcMain.handle('calendar:list', () => {
    requireLicensed()
    return calendar.listCalendars()
  })
  ipcMain.handle('calendar:events', (_event, calendarId, date, timeZone) => {
    requireLicensed()
    return calendar.calendarEvents(calendarId, date, timeZone)
  })
  ipcMain.handle('calendar:save', (_event, calendarId, draft, editing) => {
    requireLicensed()
    return calendar.saveCalendarEvent(calendarId, draft, editing)
  })
  ipcMain.handle('calendar:delete', (_event, calendarId, eventId) => {
    requireLicensed()
    return calendar.deleteCalendarEvent(calendarId, eventId)
  })

  ipcMain.handle('notch:displays', () => listDisplays())
  ipcMain.handle('notch:get-backdrop', () => backdrop.getCachedBackdrop())

  ipcMain.handle('obsidian:choose-vault', async () => {
    requireLicensed()
    if (!mainWindow) return null
    const result = await withNativeDialog(() =>
      dialog.showOpenDialog(mainWindow!, {
        title: 'Choose a notes folder',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Use this folder'
      })
    )
    if (result.canceled || !result.filePaths[0]) return null
    const chosen = result.filePaths[0]
    setState({ settings: { vaultPath: chosen }, notes: { lastPath: null } })
    refreshVaultWatcher(true)
    return chosen
  })

  ipcMain.handle('obsidian:reveal', async (_event, vaultPath: string, relativePath: string | null) => {
    await obsidian.revealEntry(requireVault(vaultPath), relativePath)
  })

  ipcMain.handle('obsidian:open-in-app', async (_event, vaultPath: string, relativePath: string) => {
    await obsidian.openFile(requireVault(vaultPath), relativePath)
  })

  ipcMain.handle('spotify:status', async () => {
    requireLicensed()
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
    requireLicensed()
    const settings = getState().settings
    const status = await spotify.connect(settings.spotifyClientId, settings.spotifyRedirectPort)
    const local = localMedia.getLocalStatus()
    return { ...status, localAvailable: local.available, localTitle: local.title, localArtist: local.artist }
  })

  ipcMain.handle('spotify:disconnect', async () => {
    requireLicensed()
    const status = await spotify.disconnect(getState().settings.spotifyRedirectPort)
    const local = localMedia.getLocalStatus()
    return { ...status, localAvailable: local.available, localTitle: local.title, localArtist: local.artist }
  })

  ipcMain.handle('spotify:player', async () => {
    requireLicensed()
    const settings = getState().settings
    const preference = normalizeMediaPreference(settings.mediaSource)
    const status = await spotify.getStatus(settings.spotifyRedirectPort)
    const sessionId = localMedia.currentMediaId(preference)
    if (followWithSpotifyApi(preference, sessionId, status.connected)) {
      try {
        const playback = await spotify.getPlayback(settings.spotifyClientId)
        if (sessionId) {
          const local = localMedia.getLocalPlayback(sessionId)
          // Connect may be playing on a different device. The selected Windows
          // session remains authoritative for the track shown by the notch.
          if (!local.track || local.track.name !== playback.track?.name ||
              local.track.artists !== playback.track?.artists) return local
        }
        if (playback.track || !localMedia.isLocalAvailable(preference)) {
          return { ...playback, localSessionId: sessionId || undefined }
        }
      } catch {
        // Fall through to the Windows media session.
      }
    }
    return localMedia.getLocalPlayback(preference)
  })

  ipcMain.handle('spotify:queue', async () => {
    requireLicensed()
    const settings = getState().settings
    const preference = normalizeMediaPreference(settings.mediaSource)
    const status = await spotify.getStatus(settings.spotifyRedirectPort)
    if (!followWithSpotifyApi(preference, localMedia.currentMediaId(preference), status.connected)) return []
    return spotify.getQueue(settings.spotifyClientId)
  })

  ipcMain.handle('spotify:library', async () => {
    requireLicensed()
    const settings = getState().settings
    const preference = normalizeMediaPreference(settings.mediaSource)
    const status = await spotify.getStatus(settings.spotifyRedirectPort)
    if (!followWithSpotifyApi(preference, localMedia.currentMediaId(preference), status.connected)) return { recent: [], playlists: [] }
    return spotify.getLibrary(settings.spotifyClientId)
  })

/**
 * The real Store package binary. `WindowsApps\Spotify.exe` is only an app
 * execution alias and can return without starting the music app, so prefer
 * the package's own executable when it exists.
 */
function spotifyStoreExe(localAppData: string): string | null {
  const root = path.join(localAppData, 'Microsoft', 'WindowsApps')
  try {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith('SpotifyAB.SpotifyMusic_')) continue
      const candidate = path.join(root, entry, 'Spotify.exe')
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // WindowsApps is not readable here; the other paths may still work.
  }
  return null
}

function findSpotifyDesktopExe(): string | null {
  const username = process.env.USERNAME || ''
  const localAppData = process.env.LOCALAPPDATA || `C:\\Users\\${username}\\AppData\\Local`
  const appData = process.env.APPDATA || `C:\\Users\\${username}\\AppData\\Roaming`
  const candidates = [
    path.join(appData, 'Spotify', 'Spotify.exe'),
    spotifyStoreExe(localAppData),
    path.join(localAppData, 'Microsoft', 'WindowsApps', 'Spotify.exe'),
    'C:\\Program Files\\Spotify\\Spotify.exe',
    'C:\\Program Files (x86)\\Spotify\\Spotify.exe'
  ].filter((value): value is string => Boolean(value))
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // try next
    }
  }
  return null
}

function spotifyUriToWebUrl(target = 'spotify:'): string {
  const match = /^spotify:(track|episode|album|playlist):([A-Za-z0-9]+)$/.exec(target)
  if (match) return `https://open.spotify.com/${match[1]}/${match[2]}`
  return 'https://open.spotify.com'
}

/**
 * Windows denies reads inside `WindowsApps`, so a Store install cannot be
 * found with existsSync. Asking Windows which app owns `spotify:` works for
 * both the classic installer and the Microsoft Store build.
 */
function spotifyDesktopAvailable(): boolean {
  if (findSpotifyDesktopExe()) return true
  try {
    return Boolean(app.getApplicationNameForProtocol('spotify:'))
  } catch {
    return false
  }
}

async function openSpotifyApp(target = 'spotify:'): Promise<boolean> {
  const uri =
    target === 'spotify:' || /^spotify:(track|episode|album|playlist):[A-Za-z0-9]+$/.test(target)
      ? target
      : 'spotify:'
  if (spotifyDesktopAvailable()) {
    // Windows protocol activation is the reliable way into the Store app.
    // Spawning the WindowsApps alias could exit without starting anything,
    // which is why "Open Spotify" sometimes looked like it did nothing.
    try {
      await shell.openExternal(uri)
      return true
    } catch {
      // Fall through to spawning the executable directly.
    }
    const exe = findSpotifyDesktopExe()
    if (exe) {
      try {
        spawn(exe, [], { detached: true, stdio: 'ignore' }).unref()
        return true
      } catch {
        // Fall through to web player if spawning fails.
      }
    }
  }
  // Desktop app is not installed: open Spotify Web Player in the browser
  // instead of triggering Windows' broken "Look for an app in the Store" dialog.
  try {
    await shell.openExternal(spotifyUriToWebUrl(uri))
    return true
  } catch {
    return false
  }
}

/**
 * Plain words for the one case a person can act on: there is no Spotify player
 * for Notch to send the song to. Say what happened, then what to do.
 */
function spotifyDeviceMessage(): string {
  if (!spotifyDesktopAvailable()) {
    return 'Spotify is not installed on this PC. Install it from spotify.com, or play in the Spotify web player, then try again.'
  }
  return 'Notch opened Spotify, but it is still starting. Give it a few seconds, then press Play again.'
}

async function recoverSpotifyDevice(clientId: string): Promise<boolean> {
  const hasDesktop = spotifyDesktopAvailable()
  const opened = await openSpotifyApp('spotify:')
  // A cold Store install can take far longer than a warm one to report itself
  // as a device, so wait for it instead of failing while it is still loading.
  if (opened && (await spotify.waitForDevice(clientId, hasDesktop ? 18000 : 8000))) return true
  if (hasDesktop) {
    try {
      await shell.openExternal('https://open.spotify.com')
    } catch {
      return false
    }
    return spotify.waitForDevice(clientId, 8000)
  }
  return false
}

async function startTrackOnDesktop(clientId: string, uri: string) {
  if (!/^spotify:(track|episode):[A-Za-z0-9]+$/.test(uri)) return null
  const opened = await openSpotifyApp(uri)
  if (!opened) return null
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

  ipcMain.handle('spotify:action', (_event, action, target?: MediaControlTarget) => {
    requireLicensed()
    // Freeze the displayed session before entering the queue. A closed player
    // must never redirect a queued command to another Windows session.
    const preference = normalizeMediaPreference(getState().settings.mediaSource)
    const sessionId = target ? target.sessionId : localMedia.currentMediaId(preference)
    const requestedPreference = target?.preference ?? preference
    const run = spotifyActionQueue.then(async () => {
      const settings = getState().settings
      if (requestedPreference !== normalizeMediaPreference(settings.mediaSource) ||
          (preference !== 'auto' && sessionId !== preference)) {
        throw new Error('The player changed. Choose the song again.')
      }
      const localAvailable = Boolean(sessionId && localMedia.isLocalAvailable(sessionId))
      // A browser video session is never a transport target, even if one was
      // saved before music apps were the only supported sources. Browser YouTube
      // Music sessions are validated by localMedia (using track album/title).
      if (sessionId && !isMusicSourceId(sessionId) && !localAvailable) {
        throw new Error('Notch controls Spotify and YouTube Music only. Open one of those and try again.')
      }
      const canRecoverSpotify =
        action?.type === 'play' &&
        Boolean(sessionId && sessionId.toLowerCase().includes('spotify'))
      if (sessionId && !localAvailable && !canRecoverSpotify) {
        throw new Error('That player is not playing right now. Start a song in it, then try again.')
      }
      if (target && !sessionId && localMedia.currentMediaId(preference)) {
        throw new Error('The player changed. Wait for the song to appear, then try again.')
      }
      if (localAvailable && sessionId && ['play', 'pause', 'next', 'previous', 'seek'].includes(action?.type)) {
        return localMedia.performLocalAction(action, sessionId)
      }
      const status = await spotify.getStatus(settings.spotifyRedirectPort)
      if (requestedPreference !== normalizeMediaPreference(getState().settings.mediaSource)) {
        throw new Error('The player changed. Choose the song again.')
      }
      const enhanced = followWithSpotifyApi(settings.mediaSource, sessionId, status.connected)
      const recoverable =
        action?.type === 'play' || action?.type === 'play-track' || action?.type === 'play-context'
      if ((action?.type === 'play-track' || action?.type === 'play-context') && !status.connected) {
        throw new Error('Spotify is not linked to Notch yet. Connect it in Settings, or press play in the Spotify app instead.')
      }
      if (enhanced && recoverable) {
        const memory = getState().spotifyMemory
        try {
          return await spotify.performAction(settings.spotifyClientId, action, memory)
        } catch (error) {
          if (spotify.isPremiumRequired(error)) throw error
          if (!spotify.isNoActiveDevice(error)) {
            if (!sessionId || !localMedia.isLocalAvailable(sessionId)) throw error
            return localMedia.performLocalAction(action, sessionId)
          }
          const ready = await recoverSpotifyDevice(settings.spotifyClientId)
          if (ready) return spotify.performAction(settings.spotifyClientId, action, memory)
          if (action.type === 'play-track') {
            const recovered = await startTrackOnDesktop(settings.spotifyClientId, action.uri)
            if (recovered) return recovered
          }
          throw new Error(spotifyDeviceMessage())
        }
      }
      if (enhanced) {
        try {
          return await spotify.performAction(settings.spotifyClientId, action, getState().spotifyMemory)
        } catch (error) {
          if (spotify.isPremiumRequired(error) || spotify.isNoActiveDevice(error)) throw error
          if (!sessionId || !localMedia.isLocalAvailable(sessionId)) throw error
        }
      }
      return localMedia.performLocalAction(action, sessionId)
    }).then((playback) => ({ ...playback, localSessionId: sessionId || undefined }))
    spotifyActionQueue = run.catch(() => undefined)
    return run
  })

  ipcMain.handle('spotify:launch', async (_event, target?: string) => {
    requireLicensed()
    const ok = await openSpotifyApp(typeof target === 'string' ? target : 'spotify:')
    logLine(
      `spotify launch ok=${ok} registered=${spotifyDesktopAvailable()} target=${typeof target === 'string' ? target : 'spotify:'}`
    )
    return ok
  })
  ipcMain.handle('sessions:scan', () => {
    requireLicensed()
    return sessions.scanSessions()
  })
  ipcMain.handle('sessions:open-project', (_event, directory: string) => {
    requireLicensed()
    return sessions.openSessionProject(directory)
  })
  ipcMain.handle('sessions:send', (_event, sessionId: string, message: string) => {
    requireLicensed()
    return sessions.sendSessionMessage(sessionId, message)
  })
  ipcMain.handle('sessions:verify', (_event, sessionId: string, message: string) => {
    requireLicensed()
    return sessions.verifySessionMessage(sessionId, message)
  })
  ipcMain.handle('sessions:codex-lock', (_event, sessionId: string) => {
    requireLicensed()
    return sessions.codexThreadLock(sessionId)
  })
  ipcMain.handle('sessions:focus-codex', () => {
    requireLicensed()
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
      void openFromUserAction()
    })
    globalShortcut.register('CommandOrControl+Alt+Space', () => {
      userHidden = !userHidden
      logLine(`user toggle hidden=${userHidden}`)
      applyPresence()
    })
  } catch {
    // Another app may already own the shortcut; the notch is still hoverable.
  }
}

let stopTransferHook: (() => void) | null = null
let openCodeTimer: ReturnType<typeof setInterval> | null = null
let backdropTimer: ReturnType<typeof setInterval> | null = null
let licensedServicesActive = false

// Capture runs (NOTCH_CAPTURE) are throwaway verification instances that read
// a synthetic state file and quit after writing their PNG. Let them start next
// to the live notch instead of refusing, so a capture never has to close it.
const gotLock = isDemoMode || isCaptureMode || app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('child-process-gone', (_event, details) => {
    logLine(
      `child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`
    )
  })

  app.on('second-instance', () => {
    if (!appInitialized) {
      revealPending = true
      return
    }
    if (!mainWindow) createWindow()
    logLine('second instance: revealing existing window')
    void openFromUserAction()
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.notch.dashboard')
    // Native widgets (the select popup, date pickers, scrollbars) follow this,
    // not just the page CSS. Without it the select menu is a white Windows list
    // with near-white option labels.
    nativeTheme.themeSource = 'dark'
    logLine(
      `start v${app.getVersion()} packaged=${app.isPackaged} exe=${process.execPath} userData=${app.getPath('userData')} demo=${isDemoMode}`
    )
    if (!isDemoMode) {
      void readSmartAppControlState().then((sac) => {
        logLine(`smart app control=${sac}`)
      })
    }
    const primaryDisplay = screen.getPrimaryDisplay()
    logLine(
      `display bounds=${JSON.stringify(primaryDisplay.bounds)} workArea=${JSON.stringify(primaryDisplay.workArea)} scale=${primaryDisplay.scaleFactor}`
    )
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (
        permission === 'media' &&
        isLicenseUnlocked() &&
        mainWindow &&
        !mainWindow.isDestroyed() &&
        contents === mainWindow.webContents
      ) {
        const mediaTypes = (details as { mediaTypes?: string[] } | undefined)?.mediaTypes
        callback(!mediaTypes || mediaTypes.every((type) => type === 'video'))
        return
      }
      callback(false)
    })
    session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
      if (
        permission === 'media' &&
        isLicenseUnlocked() &&
        mainWindow &&
        !mainWindow.isDestroyed() &&
        contents === mainWindow.webContents
      ) {
        const mediaType = (details as { mediaType?: string } | undefined)?.mediaType
        return !mediaType || mediaType === 'video'
      }
      return false
    })
    await initState()

    syncLoginItem(getState().settings.launchAtLogin)
    registerIpc()

    let detectingOpenCode = false
    const autoDetectOpenCode = (): void => {
      if (
        detectingOpenCode ||
        sessionLocked ||
        !isLicenseUnlocked() ||
        getState().settings.agentStatus === false
      ) {
        return
      }
      detectingOpenCode = true
      void detectOpenCodePort()
        .then((found) => {
          if (found && getState().settings.openCodeApprovalPort !== found) {
            const next = setState({ settings: { openCodeApprovalPort: found } })
            sendToRenderer('state:updated', next)
            logLine(`opencode port auto-detected ${found}`)
          }
        })
        .catch(() => undefined)
        .finally(() => {
          detectingOpenCode = false
        })
    }

    const startLicensedServices = (): void => {
      if (licensedServicesActive || isDemoMode) return
      licensedServicesActive = true
      syncAgentBridge()
      localMedia.startLocalMediaMonitor()
      startForegroundWatch(
        handleForegroundSample,
        displayPhysicalSize(notchDisplay()),
        getState().settings.browserOnly === true
      )
      refreshVaultWatcher(true)
      scheduleReminders()
      if (!openCodeTimer) {
        autoDetectOpenCode()
        openCodeTimer = setInterval(autoDetectOpenCode, 60_000)
        openCodeTimer.unref?.()
      }
    }

    const stopLicensedServices = (): void => {
      if (!licensedServicesActive) return
      licensedServicesActive = false
      if (openCodeTimer) {
        clearInterval(openCodeTimer)
        openCodeTimer = null
      }
      stopTransferHook?.()
      agentPort = 0
      agentStatusStop()
      sessions.stopSessionActivity()
      localMedia.stopLocalMediaMonitor()
      stopForegroundWatch()
      obsidian.closeVaultWatcher()
      clearReminderTimers()
    }

    await initLicense({
      isDemoMode,
      isCapture: isCaptureMode,
      log: logLine,
      onStateChange: (next) => {
        sendToRenderer('license:state', next)
        if (!isDemoMode && appInitialized) {
          if (isLicenseUnlocked()) startLicensedServices()
          else stopLicensedServices()
        }
      }
    })
    initUpdater({
      isDemoMode,
      isCapture: isCaptureMode,
      autoCheck: getState().settings.autoCheckUpdates !== false,
      log: logLine,
      onStateChange: (next) => sendToRenderer('updater:state', next),
      onBeforeQuitForUpdate: () => {
        quitting = true
        flushState()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.hide()
        }
      }
    })
    if (!isDemoMode) {
      agentToken = loadAgentToken()
      agentStatusEvents.on('change', (value) => {
        if (isLicenseUnlocked()) sendToRenderer('agent:update', value)
      })
    }
    createWindow()
    if (!isDemoStage) createTray()
    appInitialized = true
    if (revealPending) {
      revealPending = false
      void openFromUserAction()
    }
    logLine(`window created bounds=${JSON.stringify(mainWindow?.getBounds())} tray=${Boolean(tray)}`)
    if (!isDemoMode) {
      // Recover/sync saved Spotify Client ID without blocking initial window creation.
      void spotify
        .loadCredentials()
        .then(async (storedCredentials) => {
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
        })
        .catch(() => undefined)
      sessions.sessionSendEvents.on('result', (result) => {
        if (isLicenseUnlocked()) sendToRenderer('session:send-result', result)
      })
      sessions.sessionReplyEvents.on('reply', (event) => {
        if (isLicenseUnlocked()) sendToRenderer('session:reply', event)
      })
      if (isLicenseUnlocked()) {
        startLicensedServices()
      }
    } else {
      refreshVaultWatcher(true)
      scheduleReminders()
    }
    if (!isDemoMode) {
      backdrop.setBackdropNearZone(() => {
        if (!currentMetrics) return null
        const bounds = notchDisplay().bounds
        const { tab } = currentMetrics
        return {
          x: bounds.x + tab.x - 240,
          y: bounds.y + Math.max(0, tab.y - 120),
          width: tab.width + 480,
          height: tab.height + 260
        }
      })
      if (getState().settings.focusMode !== false && isLicenseUnlocked()) {
        backdrop.scheduleBackdropRefresh()
      }
      backdropTimer = setInterval(() => {
        if (
          expanded ||
          userHidden ||
          autoHidden ||
          sessionLocked ||
          !isLicenseUnlocked() ||
          getState().settings.focusMode === false
        ) {
          return
        }
        backdrop.refreshBackdrop()
      }, 120_000)
      backdropTimer.unref?.()
    }
    if (!isDemoStage) registerGlobalShortcuts()

    stateEvents.on('change', (next: AppState) => {
      sendToRenderer('state:updated', next)
      if (isLicenseUnlocked()) {
        scheduleRemindersSoon()
        refreshVaultWatcher()
        if (!isDemoMode) syncAgentBridge()
      }
      syncBackgroundThrottling()
    })

    const handleDisplayChange = (): void => {
      applyBounds()
      if (!isDemoMode && isLicenseUnlocked()) setForegroundTarget(displayPhysicalSize(notchDisplay()))
      if (
        !isDemoStage &&
        mainWindow &&
        !mainWindow.isDestroyed() &&
        !userHidden &&
        !autoHidden &&
        !sessionLocked
      ) {
        mainWindow.setAlwaysOnTop(true, 'screen-saver')
      }
      // A monitor that went away can leave the panel parked off-screen.
      if (expanded) {
        const display = notchDisplay()
        sendToRenderer('notch:expanded', {
          expanded: true,
          viewport: { width: display.bounds.width, height: display.bounds.height }
        })
      }
      logLine(`display change bounds=${JSON.stringify(notchDisplay().bounds)}`)
    }
    screen.on('display-metrics-changed', handleDisplayChange)
    screen.on('display-added', handleDisplayChange)
    screen.on('display-removed', handleDisplayChange)
    if (!isDemoMode) {
      powerMonitor.on('suspend', () => {
        sessionLocked = true
        localMedia.pauseLocalMediaMonitor()
        pauseForegroundWatch()
        if (windowShown) sendToRenderer('notch:presence', { hidden: true })
        logLine('system suspend')
      })
      powerMonitor.on('resume', () => {
        sessionLocked = false
        if (isLicenseUnlocked()) {
          scheduleReminders()
          localMedia.resumeLocalMediaMonitor()
          if (!userHidden) resumeForegroundWatch()
        }
        applyBounds()
        presenceApplied = null
        applyPresence()
        if (windowShown && !userHidden && !autoHidden) {
          sendToRenderer('notch:presence', { hidden: false })
        }
        assertTopmost()
        logLine('system resume')
      })
      powerMonitor.on('lock-screen', () => {
        sessionLocked = true
        localMedia.pauseLocalMediaMonitor()
        pauseForegroundWatch()
        if (windowShown) sendToRenderer('notch:presence', { hidden: true })
        logLine('session locked')
      })
      powerMonitor.on('unlock-screen', () => {
        sessionLocked = false
        applyBounds()
        if (isLicenseUnlocked()) {
          localMedia.resumeLocalMediaMonitor()
          if (!userHidden) resumeForegroundWatch()
        }
        presenceApplied = null
        applyPresence()
        if (windowShown && !userHidden && !autoHidden) {
          sendToRenderer('notch:presence', { hidden: false })
        }
        assertTopmost()
        logLine('session unlocked')
      })
    }

    app.on('activate', () => {
      if (!mainWindow) createWindow()
      void openFromUserAction(false)
    })
  })

  app.on('before-quit', () => {
    quitting = true
    if (revealTimer) {
      clearTimeout(revealTimer)
      revealTimer = null
    }
    if (rendererRecoveryResetTimer) {
      clearTimeout(rendererRecoveryResetTimer)
      rendererRecoveryResetTimer = null
    }
    if (openCodeTimer) {
      clearInterval(openCodeTimer)
      openCodeTimer = null
    }
    if (backdropTimer) {
      clearInterval(backdropTimer)
      backdropTimer = null
    }
    logLineSync('quitting')
    disposeUpdater()
    flushState()
    calendar.flushCalendarCache()
    if (!isDemoMode) {
      stopTransferHook?.()
      agentStatusStop()
      sessions.stopSessionActivity()
      calendar.cancelCalendarConnect()
      spotify.cancelConnect()
      localMedia.stopLocalMediaMonitor()
      stopForegroundWatch()
    }
    obsidian.closeVaultWatcher()
    clearReminderTimers()
    globalShortcut.unregisterAll()
    tray?.destroy()
    tray = null
    if (isDemoMode) cleanupDemoSandbox()
  })

  app.on('window-all-closed', () => {
    if (quitting) app.quit()
  })
}
