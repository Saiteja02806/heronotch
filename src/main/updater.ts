import { app, autoUpdater as electronAutoUpdater, shell } from 'electron'
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'
import {
  cleanReleaseNotes,
  createInitialUpdateState,
  friendlyUpdaterError,
  GITHUB_LATEST_API_URL,
  GITHUB_RELEASES_URL,
  isMissingManifestError,
  isNewerVersion,
  normalizeVersionTag,
  selectGitHubReleaseAsset,
  type GitHubLatestReleasePayload,
  type UpdateInstallKind,
  type UpdateState
} from '../shared/updates'

const INITIAL_CHECK_DELAY_MS = 20_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface UpdaterHostHooks {
  isDemoMode: boolean
  isCapture: boolean
  autoCheck: boolean
  log: (line: string) => void
  onStateChange: (state: UpdateState) => void
  onBeforeQuitForUpdate: () => void
}

let hooks: UpdaterHostHooks | null = null
let state: UpdateState = createInitialUpdateState('0.0.0', 'source')
let nativeUpdater: AppUpdater | null = null
let nativeListenersWired = false
let checkPromise: Promise<UpdateState> | null = null
let downloadPromise: Promise<UpdateState> | null = null
let initialTimer: NodeJS.Timeout | null = null
let periodicTimer: NodeJS.Timeout | null = null
let initialized = false

export function detectInstallKind(input: {
  isDemoMode: boolean
  isCapture: boolean
  isPackaged: boolean
  isWindowsStore?: boolean
  portableExecutableFile?: string
}): UpdateInstallKind {
  if (input.isDemoMode || input.isCapture) return 'disabled'
  if (input.isWindowsStore) return 'store'
  if (!input.isPackaged) return 'source'
  if (input.portableExecutableFile) return 'portable'
  return 'nsis'
}

function publish(next: Partial<UpdateState>): UpdateState {
  state = { ...state, ...next }
  hooks?.onStateChange(state)
  return state
}

function safeLog(line: string): void {
  hooks?.log(line)
}

function getStubMode(): string | null {
  if (app.isPackaged) return null
  const raw = process.env.NOTCH_UPDATE_STUB?.trim().toLowerCase()
  return raw || null
}

function applyStubState(mode: string): UpdateState {
  const current = state.currentVersion
  const nextVer = '99.0.0'
  if (mode === 'up-to-date') {
    return publish({
      status: 'up-to-date',
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      downloadUrl: null,
      progress: null,
      transferredBytes: null,
      totalBytes: null,
      bytesPerSecond: null,
      checkedAt: Date.now(),
      error: null,
      canAutoDownload: false,
      canAutoInstall: false
    })
  }
  if (mode === 'error') {
    return publish({
      status: 'error',
      checkedAt: Date.now(),
      error: 'Could not reach GitHub Releases. Check your internet connection and try again.',
      progress: null,
      canAutoDownload: false,
      canAutoInstall: false
    })
  }
  if (mode === 'downloading') {
    return publish({
      status: 'downloading',
      availableVersion: nextVer,
      releaseName: `Notch ${nextVer}`,
      releaseNotes: '• Faster settings navigation\n• In-app updater with progress and one-click restart',
      releaseUrl: `${GITHUB_RELEASES_URL}/tag/v${nextVer}`,
      downloadUrl: `${GITHUB_RELEASES_URL}/download/v${nextVer}/Notch-Setup-${nextVer}.exe`,
      progress: 58,
      transferredBytes: 42 * 1024 * 1024,
      totalBytes: 72 * 1024 * 1024,
      bytesPerSecond: 4.8 * 1024 * 1024,
      checkedAt: Date.now(),
      error: null,
      canAutoDownload: true,
      canAutoInstall: false
    })
  }
  if (mode === 'downloaded') {
    return publish({
      status: 'downloaded',
      availableVersion: nextVer,
      releaseName: `Notch ${nextVer}`,
      releaseNotes: '• Faster settings navigation\n• In-app updater with progress and one-click restart',
      releaseUrl: `${GITHUB_RELEASES_URL}/tag/v${nextVer}`,
      downloadUrl: `${GITHUB_RELEASES_URL}/download/v${nextVer}/Notch-Setup-${nextVer}.exe`,
      progress: 100,
      transferredBytes: 72 * 1024 * 1024,
      totalBytes: 72 * 1024 * 1024,
      bytesPerSecond: null,
      checkedAt: Date.now(),
      error: null,
      canAutoDownload: true,
      canAutoInstall: true
    })
  }
  // 'available' (or any truthy stub)
  return publish({
    status: 'available',
    availableVersion: nextVer,
    releaseName: `Notch ${nextVer} (preview after ${current})`,
    releaseNotes: '• Faster settings navigation\n• In-app updater with progress and one-click restart',
    releaseUrl: `${GITHUB_RELEASES_URL}/tag/v${nextVer}`,
    downloadUrl: `${GITHUB_RELEASES_URL}/download/v${nextVer}/Notch-Setup-${nextVer}.exe`,
    progress: null,
    transferredBytes: null,
    totalBytes: null,
    bytesPerSecond: null,
    checkedAt: Date.now(),
    error: null,
    canAutoDownload: state.installKind === 'nsis' || mode === 'available-auto',
    canAutoInstall: false
  })
}

function getAutoUpdater(): AppUpdater {
  if (!nativeUpdater) {
    // Lazy require avoids instantiating NsisUpdater when running portable/source/demo.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('electron-updater') as { autoUpdater: AppUpdater }
    nativeUpdater = mod.autoUpdater
  }
  if (!nativeListenersWired) {
    nativeListenersWired = true
    const updater = nativeUpdater
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = /-/.test(state.currentVersion)
    updater.logger = {
      info: (message: unknown) => safeLog(`updater: ${String(message)}`),
      warn: (message: unknown) => safeLog(`updater warn: ${String(message)}`),
      error: (message: unknown) => safeLog(`updater error: ${String(message)}`),
      debug: () => undefined
    }
    const configOverride = !app.isPackaged ? process.env.NOTCH_UPDATE_CONFIG_PATH?.trim() : ''
    if (configOverride) {
      updater.forceDevUpdateConfig = true
      updater.updateConfigPath = configOverride
    }
    const feedOverride = !app.isPackaged ? process.env.NOTCH_UPDATE_FEED_URL?.trim() : ''
    if (feedOverride) {
      updater.forceDevUpdateConfig = true
      updater.setFeedURL({ provider: 'generic', url: feedOverride })
    }

    updater.on('update-available', (info: UpdateInfo) => {
      const version = normalizeVersionTag(info.version)
      publish({
        status: 'available',
        availableVersion: version,
        releaseName: info.releaseName || `Notch ${version}`,
        releaseNotes: cleanReleaseNotes(info.releaseNotes),
        releaseUrl: `${GITHUB_RELEASES_URL}/tag/v${version}`,
        downloadUrl: null,
        publishedAt: info.releaseDate || null,
        progress: null,
        transferredBytes: null,
        totalBytes: null,
        bytesPerSecond: null,
        checkedAt: Date.now(),
        error: null,
        canAutoDownload: true,
        canAutoInstall: false
      })
      safeLog(`updater: available v${version}`)
    })

    updater.on('update-not-available', () => {
      publish({
        status: 'up-to-date',
        availableVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseUrl: GITHUB_RELEASES_URL,
        downloadUrl: null,
        publishedAt: null,
        progress: null,
        transferredBytes: null,
        totalBytes: null,
        bytesPerSecond: null,
        checkedAt: Date.now(),
        error: null,
        canAutoDownload: false,
        canAutoInstall: false
      })
      safeLog('updater: up to date')
    })

    updater.on('download-progress', (progress: ProgressInfo) => {
      publish({
        status: 'downloading',
        progress: Math.max(0, Math.min(100, Math.round(progress.percent))),
        transferredBytes: progress.transferred,
        totalBytes: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
        error: null
      })
    })

    updater.on('update-downloaded', (info: UpdateInfo) => {
      const version = normalizeVersionTag(info.version)
      publish({
        status: 'downloaded',
        availableVersion: version,
        releaseName: info.releaseName || state.releaseName || `Notch ${version}`,
        releaseNotes: cleanReleaseNotes(info.releaseNotes) ?? state.releaseNotes,
        releaseUrl: `${GITHUB_RELEASES_URL}/tag/v${version}`,
        progress: 100,
        bytesPerSecond: null,
        error: null,
        canAutoDownload: true,
        canAutoInstall: true
      })
      safeLog(`updater: downloaded v${version}`)
    })

    updater.on('error', (cause: Error) => {
      safeLog(`updater: event error (${cause?.message || String(cause)})`)
      if (state.status === 'downloading' || state.status === 'downloaded') {
        publish({
          status: 'error',
          progress: null,
          bytesPerSecond: null,
          error: friendlyUpdaterError(cause),
          canAutoInstall: false
        })
      }
    })

    // BaseUpdater emits before-quit-for-update on Electron's built-in autoUpdater.
    // Hook it so Notch's close-prevention flag (`quitting`) always opens cleanly.
    const handleQuit = (): void => {
      safeLog('updater: before-quit-for-update')
      hooks?.onBeforeQuitForUpdate()
    }
    electronAutoUpdater.on('before-quit-for-update', handleQuit)
  }
  return nativeUpdater
}

async function checkGitHubReleaseApi(manual: boolean, previous: UpdateState): Promise<UpdateState> {
  const endpoint =
    (!app.isPackaged ? process.env.NOTCH_UPDATE_API_URL?.trim() : '') || GITHUB_LATEST_API_URL
  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Notch/${state.currentVersion}`
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000)
    })
    if (!response.ok) {
      throw new Error(`GitHub returned status ${response.status}`)
    }
    const payload = (await response.json()) as GitHubLatestReleasePayload
    if (payload.draft === true) {
      throw new Error('Latest release is still a draft')
    }
    const allowPrerelease = /-/.test(state.currentVersion)
    if (payload.prerelease === true && !allowPrerelease) {
      return publish({
        status: 'up-to-date',
        availableVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseUrl: GITHUB_RELEASES_URL,
        downloadUrl: null,
        publishedAt: null,
        progress: null,
        transferredBytes: null,
        totalBytes: null,
        bytesPerSecond: null,
        checkedAt: Date.now(),
        error: null,
        canAutoDownload: false,
        canAutoInstall: false
      })
    }

    const rawTag = typeof payload.tag_name === 'string' ? payload.tag_name : ''
    const remoteVersion = normalizeVersionTag(rawTag)
    const htmlUrl =
      typeof payload.html_url === 'string' && /^https:\/\//i.test(payload.html_url)
        ? payload.html_url
        : GITHUB_RELEASES_URL

    if (remoteVersion && isNewerVersion(remoteVersion, state.currentVersion)) {
      const releaseName =
        typeof payload.name === 'string' && payload.name.trim()
          ? payload.name.trim()
          : `Notch ${remoteVersion}`
      const publishedAt = typeof payload.published_at === 'string' ? payload.published_at : null
      const downloadUrl = selectGitHubReleaseAsset(payload.assets, state.installKind, htmlUrl)
      safeLog(`updater: GitHub release available v${remoteVersion} (kind=${state.installKind})`)
      return publish({
        status: 'available',
        availableVersion: remoteVersion,
        releaseName,
        releaseNotes: cleanReleaseNotes(payload.body),
        releaseUrl: htmlUrl,
        downloadUrl,
        publishedAt,
        progress: null,
        transferredBytes: null,
        totalBytes: null,
        bytesPerSecond: null,
        checkedAt: Date.now(),
        error: null,
        canAutoDownload: false,
        canAutoInstall: false
      })
    }

    safeLog(`updater: GitHub release up to date (${state.currentVersion})`)
    return publish({
      status: 'up-to-date',
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseUrl: htmlUrl,
      downloadUrl: null,
      publishedAt: null,
      progress: null,
      transferredBytes: null,
      totalBytes: null,
      bytesPerSecond: null,
      checkedAt: Date.now(),
      error: null,
      canAutoDownload: false,
      canAutoInstall: false
    })
  } catch (cause) {
    safeLog(`updater: GitHub check failed (${cause instanceof Error ? cause.message : String(cause)})`)
    if (!manual) {
      return publish(previous)
    }
    return publish({
      ...previous,
      status: 'error',
      checkedAt: Date.now(),
      error: friendlyUpdaterError(cause)
    })
  }
}

export function initUpdater(nextHooks: UpdaterHostHooks): void {
  hooks = nextHooks
  const stub = !nextHooks.isDemoMode ? getStubMode() : null
  const devFeedOverride = !app.isPackaged && !nextHooks.isDemoMode && Boolean(process.env.NOTCH_UPDATE_FEED_URL?.trim())
  const devLiveCapture =
    !app.isPackaged &&
    !nextHooks.isDemoMode &&
    (Boolean(process.env.NOTCH_UPDATE_API_URL?.trim()) || process.env.NOTCH_UPDATE_LIVE_CHECK === '1')
  const overrideKind: UpdateInstallKind | null = stub
    ? stub === 'available-auto' || stub === 'downloading' || stub === 'downloaded'
      ? 'nsis'
      : stub === 'available-portable'
        ? 'portable'
        : 'source'
    : devFeedOverride
      ? 'nsis'
      : null
  const installKind =
    overrideKind ??
    detectInstallKind({
      isDemoMode: nextHooks.isDemoMode,
      isCapture: nextHooks.isCapture && !devLiveCapture,
      isPackaged: app.isPackaged,
      isWindowsStore: Boolean(process.windowsStore),
      portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE
    })
  state = createInitialUpdateState(app.getVersion(), installKind)
  initialized = true
  hooks.onStateChange(state)

  if (stub) {
    applyStubState(stub)
    return
  }

  syncAutoUpdateChecks(nextHooks.autoCheck)
}

export function syncAutoUpdateChecks(enabled: boolean): void {
  if (!initialized) return
  if (initialTimer) {
    clearTimeout(initialTimer)
    initialTimer = null
  }
  if (periodicTimer) {
    clearInterval(periodicTimer)
    periodicTimer = null
  }
  if (
    !enabled ||
    state.installKind === 'disabled' ||
    state.installKind === 'store' ||
    state.installKind === 'source' ||
    getStubMode()
  ) {
    return
  }
  initialTimer = setTimeout(() => {
    initialTimer = null
    void checkForUpdates({ manual: false })
  }, INITIAL_CHECK_DELAY_MS)
  initialTimer.unref?.()

  periodicTimer = setInterval(() => {
    void checkForUpdates({ manual: false })
  }, CHECK_INTERVAL_MS)
  periodicTimer.unref?.()
}

export function disposeUpdater(): void {
  if (initialTimer) {
    clearTimeout(initialTimer)
    initialTimer = null
  }
  if (periodicTimer) {
    clearInterval(periodicTimer)
    periodicTimer = null
  }
}

export function getUpdateState(): UpdateState {
  return state
}

export async function checkForUpdates(options?: { manual?: boolean }): Promise<UpdateState> {
  const manual = Boolean(options?.manual)
  if (!initialized || state.installKind === 'disabled' || state.installKind === 'store') return state
  if (state.status === 'downloading' || state.status === 'downloaded') return state
  if (checkPromise) return checkPromise

  const stub = getStubMode()
  if (stub) {
    return applyStubState(stub)
  }

  const previous = { ...state }
  checkPromise = (async () => {
    publish({ status: 'checking', error: null })

    if (state.installKind === 'nsis') {
      try {
        const updater = getAutoUpdater()
        const result = await updater.checkForUpdates()
        if (!result) {
          return await checkGitHubReleaseApi(manual, previous)
        }
        return state
      } catch (cause) {
        if (isMissingManifestError(cause)) {
          safeLog('updater: latest.yml missing, falling back to GitHub Releases API')
          return await checkGitHubReleaseApi(manual, previous)
        }
        safeLog(`updater: check failed (${cause instanceof Error ? cause.message : String(cause)})`)
        if (!manual) {
          return publish(previous)
        }
        return publish({
          ...previous,
          status: 'error',
          checkedAt: Date.now(),
          error: friendlyUpdaterError(cause)
        })
      }
    }

    return await checkGitHubReleaseApi(manual, previous)
  })().finally(() => {
    checkPromise = null
  })

  return checkPromise
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (!initialized || state.installKind === 'disabled' || state.installKind === 'store') return state

  const stub = getStubMode()
  if (stub) {
    applyStubState('downloading')
    await new Promise((resolve) => setTimeout(resolve, 450))
    return applyStubState('downloaded')
  }

  if (state.status === 'downloaded') return state
  if (state.installKind !== 'nsis' || !state.canAutoDownload) {
    openUpdateRelease()
    return state
  }
  if (downloadPromise) return downloadPromise

  downloadPromise = (async () => {
    publish({
      status: 'downloading',
      progress: state.progress ?? 0,
      error: null
    })
    try {
      await getAutoUpdater().downloadUpdate()
      return state
    } catch (cause) {
      safeLog(`updater: download failed (${cause instanceof Error ? cause.message : String(cause)})`)
      return publish({
        status: 'error',
        progress: null,
        bytesPerSecond: null,
        error: friendlyUpdaterError(cause),
        canAutoInstall: false
      })
    }
  })().finally(() => {
    downloadPromise = null
  })

  return downloadPromise
}

export function installUpdate(): boolean {
  if (!initialized || state.installKind !== 'nsis' || !state.canAutoInstall || state.status !== 'downloaded') {
    return false
  }
  if (getStubMode()) {
    safeLog('updater: stub install ignored')
    return false
  }
  safeLog(`updater: installing v${state.availableVersion || 'next'}`)
  hooks?.onBeforeQuitForUpdate()
  try {
    getAutoUpdater().quitAndInstall(true, true)
    return true
  } catch (cause) {
    safeLog(`updater: quitAndInstall failed (${cause instanceof Error ? cause.message : String(cause)})`)
    publish({
      status: 'error',
      error: friendlyUpdaterError(cause)
    })
    return false
  }
}

export function openUpdateRelease(): void {
  const candidate = state.downloadUrl || state.releaseUrl || GITHUB_RELEASES_URL
  if (/^https:\/\/github\.com\/Saiteja02806\/heronotch(\/|$)/i.test(candidate)) {
    void shell.openExternal(candidate)
    return
  }
  void shell.openExternal(GITHUB_RELEASES_URL)
}
