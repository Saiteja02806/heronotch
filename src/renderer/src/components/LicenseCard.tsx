import { AlertCircle, ArrowUpRight, CheckCircle2, KeyRound, Loader2, RefreshCw, Unlink } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useApp } from '../state/AppContext'

function statusLabel(status: string, mode: string): string {
  if (mode === 'demo-bypass') return 'Demo mode'
  if (status === 'active') return 'Active'
  if (mode === 'dev-bypass') return 'Dev bypass'
  if (status === 'expired') return 'Needs check'
  if (status === 'invalid') return 'Inactive'
  return 'Unlicensed'
}

export function LicenseCard() {
  const { licenseState, activateLicense, validateLicense, deactivateLicense } = useApp()
  const [keyInput, setKeyInput] = useState('')
  const [busy, setBusy] = useState(false)

  if (!licenseState || licenseState.mode === 'demo-bypass') return null

  const status = licenseState.status
  const isActive = status === 'active'
  const error = licenseState.error

  const handleActivate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy || !keyInput.trim()) return
    setBusy(true)
    try {
      const next = await activateLicense(keyInput)
      if (next.status === 'active') setKeyInput('')
    } finally {
      setBusy(false)
    }
  }

  const runAction = async (fn: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const cardClass = isActive
    ? 'update-card is-downloaded'
    : error || status === 'invalid' || status === 'expired'
      ? 'update-card is-error'
      : 'update-card'

  const iconClass = isActive
    ? 'update-icon is-up-to-date'
    : error || status === 'invalid' || status === 'expired'
      ? 'update-icon is-error'
      : 'update-icon'

  return (
    <section className="setting-group">
      <div className="setting-group-head">
        <h3>License</h3>
        <p>Activated via Dodo Payments. You can verify or move your seat between PCs anytime.</p>
      </div>

      <div className={cardClass}>
        <div className="update-card-top">
          <span className={iconClass} aria-hidden="true">
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : isActive ? (
              <CheckCircle2 size={16} />
            ) : error ? (
              <AlertCircle size={16} />
            ) : (
              <KeyRound size={15} />
            )}
          </span>
          <div className="update-copy">
            <strong>
              {isActive
                ? licenseState.productName || 'Notch license active'
                : licenseState.mode === 'dev-bypass'
                  ? 'Development build (unlicensed)'
                  : 'No active license'}
            </strong>
            <span>
              {isActive
                ? [licenseState.maskedKey, licenseState.customerEmail, 'Activated on this PC']
                    .filter(Boolean)
                    .join(' · ')
                : 'Paste a license key from Dodo Payments to bind this PC.'}
            </span>
          </div>
          <span className="update-kind-pill">{statusLabel(status, licenseState.mode)}</span>
        </div>

        {error && <p className="license-error">{error}</p>}

        {!isActive && (
          <form className="license-form" onSubmit={(e) => void handleActivate(e)}>
            <input
              type="text"
              className="license-input"
              placeholder="Paste Dodo Payments license key…"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              aria-label="License key"
            />
            <button type="submit" className="primary-button" disabled={busy || !keyInput.trim()}>
              {busy ? 'Activating…' : 'Activate'}
            </button>
          </form>
        )}

        <div className="button-row update-actions">
          {licenseState.maskedKey && (
            <>
              <button
                type="button"
                className="soft-button"
                disabled={busy}
                onClick={() => void runAction(validateLicense)}
              >
                <RefreshCw size={13} /> Verify now
              </button>
              <button
                type="button"
                className="soft-button danger-text"
                disabled={busy}
                onClick={() => void runAction(deactivateLicense)}
              >
                <Unlink size={13} /> Deactivate device
              </button>
            </>
          )}
          {!isActive && (
            <button
              type="button"
              className="soft-button"
              onClick={() => window.notch.openExternal(licenseState.purchaseUrl)}
            >
              Get license <ArrowUpRight size={13} />
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
