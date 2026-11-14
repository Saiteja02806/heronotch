import {
  Bot,
  Check,
  Clock3,
  Copy,
  Cpu,
  FolderOpen,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  ShieldCheck,
  TerminalSquare
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { CodingSession } from '../../../shared/types'
import { useApp } from '../state/AppContext'
import { SESSION_META, SessionBadge, sessionAge } from '../components/SessionBits'
const SENDABLE = new Set(['codex', 'opencode', 'antigravity'])

type DeliveryPhase = 'idle' | 'sending' | 'delivered' | 'unconfirmed' | 'failed'

export function SessionsPage() {
  const { sessions, sessionsLoading, refreshSessions, showToast, now } = useApp()
  const [query, setQuery] = useState('')
  const [showSubagents, setShowSubagents] = useState(false)
  const [composer, setComposer] = useState<CodingSession | null>(null)
  const [message, setMessage] = useState('')
  const [phase, setPhase] = useState<DeliveryPhase>('idle')
  const [sendNote, setSendNote] = useState<string | null>(null)
  const [sendErrorCode, setSendErrorCode] = useState<string | null>(null)
  const composerRef = useRef<CodingSession | null>(null)
  composerRef.current = composer
  const sending = phase === 'sending'

  const all = sessions?.sessions || []
  const subagentCount = all.filter((session) => session.subagent).length

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return all.filter((session) => {
      if (!showSubagents && session.subagent) return false
      if (!needle) return true
      return `${session.title} ${session.project || ''} ${session.provider} ${session.model || ''} ${session.origin || ''}`
        .toLowerCase()
        .includes(needle)
    })
  }, [all, query, showSubagents])

  const grouped = useMemo(
    () => ({
      active: filtered.filter((session) => session.active),
      recent: filtered.filter((session) => !session.active)
    }),
    [filtered]
  )

  const openProject = async (directory: string | null): Promise<void> => {
    if (!directory) return
    try {
      await window.notch.sessions.openProject(directory)
    } catch (error) {
      showToast('Could not open project', error instanceof Error ? error.message : directory, 'error')
    }
  }

  const openComposer = (session: CodingSession): void => {
    if (sending) return
    setComposer(session)
    setMessage('')
    setPhase('idle')
    setSendNote(null)
    setSendErrorCode(null)
  }

  const closeComposer = (): void => {
    if (sending) return
    setComposer(null)
    setMessage('')
    setPhase('idle')
    setSendNote(null)
    setSendErrorCode(null)
  }

  useEffect(() => {
    return window.notch.sessions.onSendResult((result) => {
      const current = composerRef.current
      if (!current || current.id !== result.sessionId) return
      if (result.status === 'delivered') {
        setPhase('delivered')
        setSendNote(`Delivered to this ${result.label} session.`)
        setSendErrorCode(null)
        setMessage('')
        return
      }
      if (result.status === 'unconfirmed') {
        setPhase('unconfirmed')
        setSendNote(result.error || 'The command finished, but that message was not found in this session.')
        return
      }
      setPhase('failed')
      setSendNote(result.error || 'The agent command failed.')
    })
  }, [])

  const send = async (): Promise<void> => {
    if (!composer || !message.trim() || sending) return
    const text = message
    setPhase('sending')
    setSendNote(null)
    setSendErrorCode(null)
    try {
      const result = await window.notch.sessions.send(composer.id, text)
      if (result.pending) return
      setPhase('failed')
      setSendNote(result.error || 'The agent command could not be started.')
      setSendErrorCode(result.code || null)
    } catch (error) {
      setPhase('failed')
      setSendNote(error instanceof Error ? error.message : 'Could not send the message.')
    }
  }

  const copyAndOpenChatGpt = async (): Promise<void> => {
    if (!composer || !message.trim()) return
    window.notch.copyText(message)
    const focused = await window.notch.sessions.focusCodex()
    showToast(
      'Message copied',
      focused ? 'Paste it into ChatGPT and press Enter.' : 'Open ChatGPT, then paste the message.',
      focused ? 'success' : 'default'
    )
    setPhase('failed')
    setSendNote(focused ? 'Copied. Paste it into ChatGPT and press Enter.' : 'Copied. Open ChatGPT, then paste the message.')
    setSendErrorCode('codex-open')
  }

  return (
    <div className="sessions-page">
      <aside className="sessions-apps-column">
        <div className="sessions-apps-head">
          <span className="eyebrow">Running locally</span>
          <Bot size={14} />
        </div>
        <div className="sessions-apps-list">
          {(sessions?.apps || []).map((app) => {
            const meta = SESSION_META[app.provider]
            return (
              <div
                key={app.provider}
                className={`agent-card ${app.running ? 'is-running' : ''}`}
                style={{ '--agent-color': meta.color } as CSSProperties}
              >
                <div className="agent-card-top">
                  <SessionBadge provider={app.provider} size={24} />
                  <span className="agent-name">{app.label}</span>
                  <span className={`agent-state ${app.running ? 'is-live' : ''}`}>
                    <i /> {app.running ? 'Running' : 'Closed'}
                  </span>
                </div>
                <p className="agent-window">
                  <span>Latest</span>
                  {app.windowTitle || (app.running ? 'No active conversation' : 'Not running')}
                </p>
                <div className="agent-stats">
                  <span><Cpu size={10} /> {app.processCount} process{app.processCount === 1 ? '' : 'es'}</span>
                  <span><TerminalSquare size={10} /> {app.sessions} session{app.sessions === 1 ? '' : 's'}</span>
                </div>
              </div>
            )
          })}
          {!sessions && (
            <div className="agent-card is-loading">
              <span className="agent-state"><RefreshCw size={11} className="spin" /> Scanning</span>
            </div>
          )}
        </div>

        <div className="sessions-privacy">
          <ShieldCheck size={13} />
          <div>
            <strong>Read on this machine</strong>
            <span>Sessions are read from local app databases. Nothing is uploaded.</span>
          </div>
        </div>
      </aside>

      <section className="sessions-list-panel">
        <header className="sessions-head">
          <div>
            <span className="eyebrow">
              <span className={`live-dot ${grouped.active.length ? 'is-live' : ''}`} />
              Coding sessions
            </span>
            <h1>{grouped.active.length ? `${grouped.active.length} live` : 'Session board'}</h1>
            <p>
              Codex, OpenCode and Anti Gravity conversations on this machine.
              {subagentCount > 0 ? ` ${subagentCount} subagent${subagentCount === 1 ? '' : 's'} tucked away.` : ''}
            </p>
          </div>
          <div className="sessions-head-actions">
            <span className="scan-stamp">
              <Clock3 size={10} />
              {sessions ? `Scanned ${sessionAge(sessions.scannedAt, now)}` : 'Scanning…'}
            </span>
            <button className="soft-button compact" onClick={() => void refreshSessions()} disabled={sessionsLoading}>
              <RefreshCw size={12} className={sessionsLoading ? 'spin' : ''} /> Refresh
            </button>
          </div>
        </header>

        <div className="sessions-toolbar">
          <label className="sessions-search">
            <Search size={12} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by title, project or model…"
            />
            {query && <button onClick={() => setQuery('')} aria-label="Clear search">×</button>}
          </label>
          {subagentCount > 0 && (
            <button
              className={`session-filter ${showSubagents ? 'is-on' : ''}`}
              onClick={() => setShowSubagents((value) => !value)}
              title="Show or hide subagent conversations"
            >
              {showSubagents ? <Check size={11} /> : null}
              Subagents <span>{subagentCount}</span>
            </button>
          )}
        </div>

        <div className="sessions-scroll">
          {sessions?.error && <div className="sessions-error">{sessions.error}</div>}

          {grouped.active.length > 0 && (
            <div className="session-group">
              <span className="session-group-label">
                <span className="live-dot is-live" /> Working now · {grouped.active.length}
              </span>
              {grouped.active.map(renderRow)}
            </div>
          )}

          {grouped.recent.length > 0 && (
            <div className="session-group">
              <span className="session-group-label">Recent · {grouped.recent.length}</span>
              {grouped.recent.map(renderRow)}
            </div>
          )}

          {sessions && filtered.length === 0 && (
            <div className="sessions-empty">
              <div className="sessions-empty-mark">
                {query ? <Search size={26} /> : <TerminalSquare size={28} />}
              </div>
              <span className="eyebrow">{query ? 'No match' : 'All quiet'}</span>
              <h2>{query ? 'Nothing matches that search.' : 'No sessions found yet.'}</h2>
              <p>
                {query
                  ? 'Try a project name, model, or a shorter search.'
                  : subagentCount > 0 && !showSubagents
                    ? 'Only subagent conversations are present right now. Show subagents to see them.'
                    : 'Open a Codex thread, start an OpenCode session, or pick up an Anti Gravity conversation.'}
              </p>
              <button
                className="soft-button"
                onClick={() => {
                  if (query) setQuery('')
                  else if (subagentCount > 0) setShowSubagents(true)
                  else void refreshSessions()
                }}
              >
                {query ? 'Clear search' : subagentCount > 0 && !showSubagents ? 'Show subagents' : 'Scan again'}
              </button>
            </div>
          )}

          {!sessions && (
            <div className="sessions-empty">
              <div className="sessions-empty-mark"><RefreshCw size={26} className="spin" /></div>
              <h2>Reading local sessions…</h2>
              <p>Checking Codex state, OpenCode’s workspace database and Anti Gravity conversations.</p>
            </div>
          )}
        </div>
      </section>

    </div>
  )

  function renderRow(session: CodingSession) {
    const open = composer?.id === session.id
    return (
      <SessionRow
        key={session.id}
        session={session}
        now={now}
        open={open}
        message={open ? message : ''}
        phase={open ? phase : 'idle'}
        note={open ? sendNote : null}
        errorCode={open ? sendErrorCode : null}
        onMessage={() => openComposer(session)}
        onOpen={() => void openProject(session.directory)}
        onDraft={(value) => {
          setMessage(value)
          if (phase === 'failed' || phase === 'unconfirmed' || phase === 'delivered') {
            setPhase('idle')
            setSendNote(null)
            setSendErrorCode(null)
          }
        }}
        onSend={() => void send()}
        onCancel={closeComposer}
        onCopy={() => void copyAndOpenChatGpt()}
      />
    )
  }
}

function SessionRow({
  session,
  now,
  open,
  message,
  phase,
  note,
  errorCode,
  onMessage,
  onOpen,
  onDraft,
  onSend,
  onCancel,
  onCopy
}: {
  session: CodingSession
  now: number
  open: boolean
  message: string
  phase: DeliveryPhase
  note: string | null
  errorCode: string | null
  onMessage: () => void
  onOpen: () => void
  onDraft: (value: string) => void
  onSend: () => void
  onCancel: () => void
  onCopy: () => void
}) {
  const meta = SESSION_META[session.provider]
  const canSend = SENDABLE.has(session.provider) && !session.subagent
  const sending = phase === 'sending'
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus({ preventScroll: true })
    inputRef.current?.closest('.session-row')?.scrollIntoView({ block: 'nearest' })
  }, [open])
  return (
    <div className={`session-row ${session.active ? 'is-live' : ''} ${open ? 'is-composing' : ''}`}>
      <div className="session-row-main">
        <SessionBadge provider={session.provider} size={30} />
        <button className="session-row-copy" onClick={canSend ? onMessage : onOpen}>
          <span className="session-row-title">
            <strong>{session.title}</strong>
            {session.subagent && <span className="session-tag">subagent</span>}
            {session.origin && !session.subagent && <span className="session-tag muted">{session.origin}</span>}
          </span>
          <span className="session-row-detail">
            <span className="session-provider">{meta.label}</span>
            {session.model && <span className="session-model">{session.model}</span>}
            {session.detail && <span>{session.detail}</span>}
            {session.project && (
              <span className="session-project">
                <FolderOpen size={9} /> {session.project}
              </span>
            )}
          </span>
        </button>
        <div className="session-row-side">
          {session.active ? (
            <span className="session-live"><i /> live</span>
          ) : (
            <span className="session-row-time">{sessionAge(session.updatedAt, now)}</span>
          )}
          {canSend && (
            <button
              className={`session-send ${open ? 'is-on' : ''}`}
              onClick={onMessage}
              title={`Send a message to ${meta.label}`}
            >
              <MessageSquare size={12} />
              <span>Message</span>
            </button>
          )}
          <button
            className="icon-button subtle"
            onClick={onOpen}
            disabled={!session.directory}
            title="Open project folder"
          >
            <FolderOpen size={12} />
          </button>
        </div>
      </div>
      {open && (
        <form
          className="session-inline"
          onSubmit={(event) => {
            event.preventDefault()
            onSend()
          }}
        >
          <div className="session-inline-line">
            <input
              ref={inputRef}
              className="session-inline-input"
              value={message}
              onChange={(event) => onDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  event.preventDefault()
                  onCancel()
                }
              }}
              placeholder={`Message this ${meta.label} session`}
              maxLength={12000}
              disabled={sending}
              aria-label={`Message this ${meta.label} session`}
            />
            <button type="button" className="soft-button compact session-inline-cancel" onClick={onCancel} disabled={sending}>
              Cancel
            </button>
            <button type="submit" className="primary-button compact session-inline-send" disabled={!message.trim() || sending}>
              {sending ? <Loader2 size={12} className="spin" /> : <MessageSquare size={12} />}
              {sending ? 'Sending' : 'Send'}
            </button>
          </div>
          {note && <p className={`session-inline-status is-${phase}`}>{note}</p>}
          {errorCode === 'codex-open' && (
            <button type="button" className="soft-button session-inline-copy" onClick={onCopy}>
              <Copy size={12} /> Copy &amp; open ChatGPT
            </button>
          )}
        </form>
      )}
    </div>
  )
}
