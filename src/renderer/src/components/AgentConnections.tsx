import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { AgentConnection } from '../../../shared/types'

const STATE_LABEL: Record<AgentConnection['state'], string> = {
  ready: 'Ready',
  idle: 'Waiting',
  attention: 'Needs a fix',
  limited: 'Questions only',
  missing: 'Not installed'
}

const STATE_RANK: Record<AgentConnection['state'], number> = {
  ready: 0,
  attention: 1,
  idle: 2,
  limited: 3,
  missing: 4
}

/** Live report of which coding tools can send approvals and questions to the
 * notch on this PC. Nothing here needs copying or pasting: Notch wires the tools
 * itself, and Reconnect simply runs that again. */
export function AgentConnections(): React.JSX.Element {
  const [rows, setRows] = useState<AgentConnection[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async (reconnect: boolean): Promise<void> => {
    if (reconnect) setBusy(true)
    try {
      const next = reconnect ? await window.notch.agent.reconnect() : await window.notch.agent.connections()
      setRows(next)
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      if (reconnect) setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
    const timer = window.setInterval(() => void load(false), 6000)
    return () => window.clearInterval(timer)
  }, [load])

  const signIn = async (): Promise<void> => {
    try {
      await window.notch.agent.claudeLogin()
    } finally {
      // The sign-in finishes in the browser; look again soon and while it runs.
      window.setTimeout(() => void load(false), 4000)
      window.setTimeout(() => void load(false), 12000)
    }
  }

  const sorted = rows ? [...rows].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]) : []

  return (
    <div className="agent-connections">
      <div className="setting-row agent-connections-head">
        <span className="setting-copy">
          <strong>Connected tools</strong>
          <small>Notch connects these on its own. Nothing to copy or paste. Keep Notch running.</small>
        </span>
        <button type="button" className="agent-connections-reconnect" disabled={busy} onClick={() => void load(true)}>
          <RefreshCw size={11} className={busy ? 'spin' : ''} /> Reconnect
        </button>
      </div>
      {failed && !rows ? <p className="agent-connections-empty">Could not read the tool status.</p> : null}
      {rows && sorted.length === 0 ? <p className="agent-connections-empty">No coding tools found.</p> : null}
      {sorted.map((row) => (
        <div key={row.tool} className={`agent-connection is-${row.state}`}>
          <span className="agent-connection-dot" aria-hidden="true" />
          <span className="agent-connection-copy">
            <strong>{row.label}</strong>
            <small>{row.detail}</small>
          </span>
          {row.action === 'claude-login' ? (
            <button type="button" className="agent-connections-reconnect" onClick={() => void signIn()}>
              Sign in
            </button>
          ) : (
            <span className="agent-connection-state">{STATE_LABEL[row.state]}</span>
          )}
        </div>
      ))}
    </div>
  )
}
