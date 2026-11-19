import { AlertCircle, ArrowUpRight, CheckCircle2, ChevronUp, KeyRound, Loader2, RefreshCw } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useApp } from '../state/AppContext'
import { Logo } from './Logo'

export function LicenseGate() {
  const { licenseState, activateLicense, validateLicense, deactivateLicense, setExpanded } = useApp()
  const [keyInput, setKeyInput] = useState('')
  const [busy, setBusy] = useState(false)

  const status = licenseState?.status ?? 'unlicensed'
  const error = licenseState?.error ?? null
  const isExpired = status === 'expired'
  const isInvalid = status === 'invalid'

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy || !keyInput.trim()) return
    setBusy(true)
    try {
      await activateLicense(keyInput)
    } finally {
      setBusy(false)
    }
  }

  const handleRevalidate = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await validateLicense()
    } finally {
      setBusy(false)
    }
  }

  const handleResetStored = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await deactivateLicense()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="license-gate">
      <div className="license-topbar">
        <div className="brand-lockup">
          <Logo size={22} />
          <div className="brand-copy">
            <strong>Notch</strong>
            <span>Activate license</span>
          </div>
        </div>
        <button
          type="button"
          className="soft-button"
          onClick={() => setExpanded(false)}
          title="Collapse Notch"
        >
          <ChevronUp size={13} /> Collapse
        </button>
      </div>

      <div className="license-gate-body">
        <div className={`license-card ${error || isInvalid || isExpired ? 'has-error' : ''}`}>
          <div className="update-card-top">
            <span className={`update-icon ${error || isInvalid || isExpired ? 'is-error' : 'is-available'}`}>
              {error || isInvalid || isExpired ? <AlertCircle size={16} /> : <KeyRound size={16} />}
            </span>
            <div className="update-copy">
              <strong>
                {isExpired
                  ? 'Re-verify your Notch license'
                  : isInvalid
                    ? 'License is no longer active'
                    : 'Activate Notch'}
              </strong>
              <span>
                {isExpired
                  ? 'Connect to the internet and verify your saved key, or activate a new key.'
                  : 'Enter the one-time license key from your purchase email to unlock Notes, Music, Planner, Sessions, and Posture.'}
              </span>
            </div>
            <span className="update-kind-pill">
              {licenseState?.mode === 'test' ? 'Dodo Test' : 'Dodo License'}
            </span>
          </div>

          {licenseState?.maskedKey && (
            <div className="license-meta">
              <span>Saved key: <code>{licenseState.maskedKey}</code></span>
              {licenseState.customerEmail && <span>{licenseState.customerEmail}</span>}
            </div>
          )}

          {error && <p className="license-error" role="alert">{error}</p>}

          <form className="license-form" onSubmit={(e) => void handleSubmit(e)}>
            <input
              type="text"
              className="license-input"
              placeholder="Paste your license key (e.g. 2b1f8e2d-…)"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              aria-label="License key"
            />
            <button
              type="submit"
              className="primary-button"
              disabled={busy || !keyInput.trim()}
            >
              {busy ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
              {busy ? 'Activating…' : 'Activate'}
            </button>
          </form>

          <div className="button-row update-actions">
            {(isExpired || isInvalid) && licenseState?.maskedKey && (
              <>
                <button
                  type="button"
                  className="soft-button"
                  disabled={busy}
                  onClick={() => void handleRevalidate()}
                >
                  <RefreshCw size={13} /> Verify saved key
                </button>
                <button
                  type="button"
                  className="soft-button"
                  disabled={busy}
                  onClick={() => void handleResetStored()}
                >
                  Clear saved key
                </button>
              </>
            )}
            <button
              type="button"
              className="soft-button"
              onClick={() => window.notch.openExternal(licenseState?.purchaseUrl || 'https://www.buildnotch.app/pricing')}
            >
              Get a license key <ArrowUpRight size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
