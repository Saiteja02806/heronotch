import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCw
} from 'lucide-react'
import { motion } from 'framer-motion'
import { useState } from 'react'
import type { UpdateInstallKind } from '../../../shared/types'
import { useApp } from '../state/AppContext'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatCheckedAt(timestamp: number | null): string | null {
  if (!timestamp) return null
  const deltaSec = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (deltaSec < 45) return 'just now'
  if (deltaSec < 3600) return `${Math.round(deltaSec / 60)}m ago`
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function installKindLabel(kind: UpdateInstallKind): string {
  switch (kind) {
    case 'nsis':
      return 'Windows installer'
    case 'portable':
      return 'Portable app'
    case 'store':
      return 'Microsoft Store'
    case 'source':
      return 'Source build'
    default:
      return 'Preview mode'
  }
}

export function UpdatesCard({ version }: { version: string }) {
  const {
    state,
    updateSettings,
    updateState,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    openUpdateRelease
  } = useApp()
  const [busy, setBusy] = useState(false)

  const currentVersion = updateState?.currentVersion || version || '1.0.0'
  const status = updateState?.status || 'idle'
  const installKind = updateState?.installKind || 'source'
  const availableVersion = updateState?.availableVersion
  const checkedLabel = formatCheckedAt(updateState?.checkedAt ?? null)
  const autoCheck = state.settings.autoCheckUpdates !== false

  const runCheck = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await checkForUpdates()
    } finally {
      setBusy(false)
    }
  }

  const runDownload = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await downloadUpdate()
    } finally {
      setBusy(false)
    }
  }

  const renderIcon = () => {
    if (status === 'checking' || status === 'downloading' || busy) {
      return <Loader2 size={16} className="spin" />
    }
    if (status === 'downloaded') return <RotateCw size={16} />
    if (status === 'available') return <Download size={16} />
    if (status === 'error') return <AlertCircle size={16} />
    if (status === 'up-to-date') return <Check size={16} />
    return <RefreshCw size={15} />
  }

  let headline = `Notch v${currentVersion}`
  if (status === 'checking') headline = 'Checking for updates…'
  else if (status === 'up-to-date') headline = 'Notch is up to date'
  else if (status === 'available' && availableVersion) headline = `Notch ${availableVersion} is available`
  else if (status === 'downloading' && availableVersion) {
    headline = `Downloading Notch ${availableVersion}…`
  } else if (status === 'downloaded' && availableVersion) {
    headline = `Notch ${availableVersion} is ready to install`
  } else if (status === 'error') {
    headline = 'Could not complete update'
  }

  let detail = `Version ${currentVersion} · ${installKindLabel(installKind)}`
  if (installKind === 'store') {
    detail = 'Managed by Microsoft Store · Updates install automatically through Windows.'
  } else if (checkedLabel && (status === 'idle' || status === 'up-to-date')) {
    detail = `${detail} · Checked ${checkedLabel}`
  }
  if (status === 'error' && updateState?.error) {
    detail = updateState.error
  } else if (status === 'downloading') {
    const pct = updateState?.progress ?? 0
    const transfer =
      updateState?.transferredBytes != null && updateState?.totalBytes
        ? `${formatBytes(updateState.transferredBytes)} / ${formatBytes(updateState.totalBytes)}`
        : null
    const speed =
      updateState?.bytesPerSecond && updateState.bytesPerSecond > 0
        ? `${formatBytes(updateState.bytesPerSecond)}/s`
        : null
    detail = [`${pct}%`, transfer, speed].filter(Boolean).join(' · ')
  } else if (status === 'downloaded') {
    detail = 'Restart Notch to apply the update. Your notes, settings, and sessions stay intact.'
  } else if (status === 'available') {
    if (installKind === 'portable') {
      detail =
        'Portable build · downloads the new .exe from GitHub Releases. Your data in %APPDATA% stays intact.'
    } else if (installKind === 'source') {
      detail = 'Running from source · pull the latest commit and run npm run build, or view the release.'
    } else if (updateState?.canAutoDownload) {
      detail = `Current version ${currentVersion} · Downloads directly inside Notch, then restarts to finish.`
    } else {
      detail = `Current version ${currentVersion} · Installer available on GitHub Releases.`
    }
  }

  return (
    <section className="setting-group">
      <div className="setting-group-head">
        <h3>Updates</h3>
        <p>
          {installKind === 'store'
            ? 'Updates are verified, signed, and delivered automatically by Microsoft Store.'
            : 'Keep Notch up to date from GitHub Releases without touching your notes or settings.'}
        </p>
      </div>

      <div className={`update-card is-${status}`}>
        <div className="update-card-top">
          <span className={`update-icon is-${status}`} aria-hidden="true">
            {renderIcon()}
          </span>
          <div className="update-copy">
            <strong>{headline}</strong>
            <span>{detail}</span>
          </div>
          <span className="update-kind-pill">{installKindLabel(installKind)}</span>
        </div>

        {status === 'downloading' && (
          <div
            className="update-progress"
            role="progressbar"
            aria-valuenow={updateState?.progress ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="update-progress-bar"
              style={{ width: `${Math.max(4, updateState?.progress ?? 0)}%` }}
            />
          </div>
        )}

        {updateState?.releaseNotes && (status === 'available' || status === 'downloaded') && (
          <pre className="update-notes">{updateState.releaseNotes}</pre>
        )}

        <div className="button-row update-actions">
          {status === 'downloaded' && updateState?.canAutoInstall && (
            <button type="button" className="primary-button" onClick={() => void installUpdate()}>
              <RotateCw size={13} /> Restart to update
            </button>
          )}

          {status === 'available' && (
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() =>
                installKind === 'source' ? openUpdateRelease() : void runDownload()
              }
            >
              {installKind === 'source' ? <ExternalLink size={13} /> : <Download size={13} />}
              {installKind === 'source'
                ? 'View release on GitHub'
                : installKind === 'portable'
                  ? 'Download portable .exe'
                  : updateState?.canAutoDownload
                    ? 'Download & update'
                    : 'Download installer'}
            </button>
          )}

          {status === 'downloading' && (
            <button type="button" className="primary-button" disabled>
              <Loader2 size={13} className="spin" />
              Downloading {updateState?.progress ?? 0}%
            </button>
          )}

          {status !== 'downloading' && status !== 'downloaded' && status !== 'available' && installKind !== 'store' && (
            <button
              type="button"
              className={status === 'error' ? 'primary-button' : 'soft-button'}
              disabled={busy || status === 'checking' || installKind === 'disabled'}
              onClick={() => void runCheck()}
            >
              {status === 'checking' || busy ? (
                <Loader2 size={13} className="spin" />
              ) : (
                <RefreshCw size={13} />
              )}
              {status === 'checking' || busy
                ? 'Checking…'
                : status === 'error'
                  ? 'Try again'
                  : 'Check for updates'}
            </button>
          )}

          {status === 'available' && (
            <button
              type="button"
              className="soft-button"
              disabled={busy}
              onClick={() => void runCheck()}
            >
              <RefreshCw size={13} /> Check again
            </button>
          )}

          {installKind !== 'store' && (
            <button type="button" className="soft-button" onClick={openUpdateRelease}>
              <ArrowUpRight size={13} /> GitHub Releases
            </button>
          )}
        </div>
      </div>

      {installKind !== 'disabled' && installKind !== 'store' && (
        <button
          type="button"
          className="setting-row toggle-row"
          onClick={() => updateSettings({ autoCheckUpdates: !autoCheck })}
          role="switch"
          aria-checked={autoCheck}
        >
          <span className="setting-copy">
            <strong>Check for updates automatically</strong>
            <small>
              Quietly checks GitHub Releases on launch and every few hours. Nothing installs without you.
            </small>
          </span>
          <span className={`switch ${autoCheck ? 'is-on' : ''}`}>
            <motion.span
              animate={{ x: autoCheck ? 16 : 0 }}
              transition={{ type: 'spring', stiffness: 520, damping: 32 }}
            />
          </span>
        </button>
      )}
    </section>
  )
}
