import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, ShieldAlert } from 'lucide-react'
import type { AgentSnapshot, AgentTool } from '../../../shared/types'
import { useApp } from '../state/AppContext'
import { playPostureRing as playChime } from '../lib/alertSound'

const LABELS: Record<AgentTool, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor'
}

export function AgentStatus() {
  const { state, showToast } = useApp()
  const compact = state.settings.panelSize === 'compact'
  const soundOn = state.settings.codingReplySound === true
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const mountedAt = useRef(Date.now())
  const seen = useRef(new Set<string>())

  useEffect(() => {
    let alive = true
    void window.notch.agent.status().then((value) => {
      if (alive) setSnapshot(value)
    })
    const off = window.notch.agent.onUpdate((value) => {
      if (!alive) return
      setSnapshot(value)
      // Only announce new events, never a re-render of an old card.
      for (const item of value.statuses) {
        if (item.state !== 'waiting' && item.state !== 'done') continue
        const key = `${item.tool}:${item.state}:${item.at}`
        if (seen.current.has(key) || item.at < mountedAt.current - 2000) continue
        seen.current.add(key)
        showToast(
          `${LABELS[item.tool]} ${item.state === 'waiting' ? 'needs you' : 'finished'}`,
          item.title,
          item.state === 'waiting' ? 'default' : 'success'
        )
        if (soundOn) playChime()
      }
    })
    return () => {
      alive = false
      off()
    }
  }, [showToast, soundOn])

  async function decide(id: string, reply: 'allow' | 'deny') {
    setBusy(true)
    try {
      await window.notch.agent.decide(id, reply)
      setSnapshot(await window.notch.agent.status())
    } catch (cause) {
      showToast('Could not send that decision', cause instanceof Error ? cause.message : String(cause), 'error')
    } finally {
      setBusy(false)
    }
  }

  const pending = snapshot?.pending || []
  const waitingTools = new Set(pending.map((item) => item.tool))
  const recent = (snapshot?.statuses || []).filter(
    (item) => item.state !== 'working' && !waitingTools.has(item.tool)
  )
  const visible = compact ? pending.length > 0 || recent.length > 0 : true
  if (!visible) return null

  return (
    <section className={`agent-status ${compact ? 'is-compact' : ''}`} aria-label="Coding tools">
      <div className="agent-status-head">
        <span className="eyebrow">Coding tools</span>
        {pending.length > 0 && <span className="agent-status-alert">{pending.length} need{pending.length === 1 ? 's' : ''} you</span>}
      </div>

      {pending.map((item) => (
        <article className="agent-status-item is-waiting" key={item.id}>
          <span className="agent-status-icon"><Loader2 size={13} className="spin" /></span>
          <div className="agent-status-copy">
            <strong>{LABELS[item.tool]} is waiting for you</strong>
            <span>{item.title}</span>
            {!compact && item.detail && <small>{item.detail}</small>}
          </div>
          <div className="agent-status-actions">
            <button className="primary-button" disabled={busy} onClick={() => void decide(item.id, 'allow')}>
              <Check size={11} /> Approve
            </button>
            <button className="soft-button" disabled={busy} onClick={() => void decide(item.id, 'deny')}>
              Deny
            </button>
          </div>
        </article>
      ))}

      {recent.map((item) => (
          <article className={`agent-status-item is-${item.state}`} key={`${item.tool}-${item.at}`}>
            <span className="agent-status-icon">
              {item.state === 'done' ? <Check size={13} /> : <ShieldAlert size={13} />}
            </span>
            <div className="agent-status-copy">
              <strong>{LABELS[item.tool]} · {item.state === 'done' ? 'Done' : 'Waiting for you'}</strong>
              <span>{item.title}</span>
              {item.detail && <small>{item.detail}</small>}
            </div>
          </article>
        ))}

      {!compact && !pending.length && !recent.length && (
        <p className="agent-status-empty">
          {snapshot?.running
            ? 'Quiet for now. Add the hooks once in Settings → Notch and your tools will check in here.'
            : 'The local status bridge is off. Turn it on in Settings → Notch.'}
        </p>
      )}
    </section>
  )
}
