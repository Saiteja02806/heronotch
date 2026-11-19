import { TerminalSquare } from 'lucide-react'
import { useApp } from '../state/AppContext'

export function OpenCodeApprovals() {
  const {
    state,
    openCodePending: rows,
    openCodeError: error,
    approvalBusy: busy,
    decideOpenCode
  } = useApp()
  const port = state.settings.openCodeApprovalPort
  if (!port) return null
  if (!error && rows.length === 0) return null
  return (
    <section className="agent-status is-compact opencode-approvals" aria-label="OpenCode approvals">
      <div className="agent-status-head">
        <span className="eyebrow">OpenCode approval</span>
        {rows.length > 0 && <span className="agent-status-alert">{rows.length} waiting</span>}
      </div>
      {error && (
        <div className="agent-status-error" role="alert">
          {error}
        </div>
      )}
      {rows.map((item) => (
        <article key={item.fingerprint} className="agent-status-item is-waiting">
          <span className="agent-status-icon" aria-hidden="true">
            <TerminalSquare size={12} />
          </span>
          <div className="agent-status-copy">
            <strong>
              {item.operation} · {item.session}
            </strong>
            <span className="opencode-cmd-inline">{item.details}</span>
          </div>
          <div className="agent-status-actions">
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              data-demo-opencode-approve="true"
              onClick={() => void decideOpenCode(item, 'once')}
            >
              Approve
            </button>
            <button
              type="button"
              className="soft-button"
              disabled={busy}
              onClick={() => void decideOpenCode(item, 'reject')}
            >
              Deny
            </button>
          </div>
        </article>
      ))}
    </section>
  )
}
