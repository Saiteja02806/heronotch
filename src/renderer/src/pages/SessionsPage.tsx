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
import { useMemo, useState, type CSSProperties } from 'react'
import type { CodingSession } from '../../../shared/types'
import { useApp } from '../state/AppContext'
import { SESSION_META, SessionBadge, sessionAge } from '../components/SessionBits'
import { Modal } from '../components/Modal'

const SENDABLE = new Set(['codex', 'opencode', 'antigravity'])

export function SessionsPage() {
  const { sessions, sessionsLoading, refreshSessions, showToast, now } = useApp()
  const [query, setQuery] = useState('')
  const [showSubagents, setShowSubagents] = useState(false)
  const [composer, setComposer] = useState<CodingSession | null>(null)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sendErrorCode, setSendErrorCode] = useState<string | null>(null)

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
    setComposer(session)
    setMessage('')
    setSendError(null)
    setSendErrorCode(null)
  }

  const closeComposer = (): void => {
    if (sending) return
    setComposer(null)
    setMessage('')
    setSendError(null)
    setSendErrorCode(null)
  }

  const send = async (): Promise<void> => {
    if (!composer || !message.trim()) return
    setSending(true)
    setSendError(null)
    try {
      const result = await window.notch.sessions.send(composer.id, message)
      if (!result.ok) {
        setSendError(result.error || 'The agent command could not be started.')
        setSendErrorCode(result.code || null)
        return
      }
      setSendErrorCode(null)
      showToast(
        `Sending to ${SESSION_META[composer.provider].label}`,
        composer.project
          ? `The agent is picking this up in ${composer.project}.`
          : 'The agent is picking this up in its own app.',
        'default'
      )
      setComposer(null)
      setMessage('')
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Could not send the message.')
    } finally {
      setSending(false)
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
    setComposer(null)
    setMessage('')
    setSendError(null)
    setSendErrorCode(null)
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
              {grouped.active.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  now={now}
                  onMessage={() => openComposer(session)}
                  onOpen={() => void openProject(session.directory)}
                />
              ))}
            </div>
          )}

          {grouped.recent.length > 0 && (
            <div className="session-group">
              <span className="session-group-label">Recent · {grouped.recent.length}</span>
              {grouped.recent.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  now={now}
                  onMessage={() => openComposer(session)}
                  onOpen={() => void openProject(session.directory)}
                />
              ))}
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

      <Modal
        open={Boolean(composer)}
        onClose={closeComposer}
        title={composer ? `Message ${SESSION_META[composer.provider].label}` : 'Message agent'}
        eyebrow={composer?.project || 'Local session'}
        width={540}
      >
        {composer && (
          <div className="session-compose">
            <div className="session-compose-target">
              <SessionBadge provider={composer.provider} size={34} />
              <div>
                <strong>{composer.title}</strong>
                <span>
                  {SESSION_META[composer.provider].label}
                  {composer.model ? ` · ${composer.model}` : ''}
                  {composer.active ? ' · working now' : ` · last active ${sessionAge(composer.updatedAt, now)}`}
                </span>
              </div>
            </div>
            <textarea
              className="session-compose-input"
              value={message}
              onChange={(event) => {
                setMessage(event.target.value)
                if (sendError) setSendError(null)
                if (sendErrorCode) setSendErrorCode(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  void send()
                }
              }}
              autoFocus
              placeholder="Send a follow-up to this session…"
              rows={5}
              maxLength={12000}
            />
            <div className="session-compose-meta">
              <span>{message.length.toLocaleString()} / 12,000</span>
              <span>Ctrl Enter to send</span>
            </div>
            <p className="session-compose-note">
              The message goes to the existing local {SESSION_META[composer.provider].label} session.
              Tool approvals still happen in that app. This can take a while to respond.
            </p>
            {sendError && <div className="session-compose-error">{sendError}</div>}
            <div className="modal-actions">
              <button className="soft-button" onClick={closeComposer} disabled={sending}>Cancel</button>
              {sendErrorCode === 'codex-open' && (
                <button className="soft-button" onClick={() => void copyAndOpenChatGpt()}>
                  <Copy size={13} /> Copy &amp; open ChatGPT
                </button>
              )}
              <button
                className="primary-button"
                onClick={() => void send()}
                disabled={!message.trim() || sending}
              >
                {sending ? <Loader2 size={13} className="spin" /> : <MessageSquare size={13} />}
                {sending ? 'Sending…' : 'Send to agent'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

function SessionRow({
  session,
  now,
  onMessage,
  onOpen
}: {
  session: CodingSession
  now: number
  onMessage: () => void
  onOpen: () => void
}) {
  const meta = SESSION_META[session.provider]
  const canSend = SENDABLE.has(session.provider) && !session.subagent
  return (
    <div className={`session-row ${session.active ? 'is-live' : ''}`}>
      <SessionBadge provider={session.provider} size={30} />
      <button className="session-row-copy" onClick={canSend ? onMessage : onOpen}>
        <span className="session-row-title">
          <strong>{session.title}</strong>
          {session.subagent && <span className="session-tag">subagent</span>}
          {session.origin && !session.subagent && <span className="session-tag muted">{session.origin}</span>}
        </span>
        <span className="session-row-detail">
          <span className="session-provider" style={{ color: meta.color }}>{meta.label}</span>
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
            className="session-send"
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
  )
}
