import {
  Check,
  Clock3,
  Copy,
  Cpu,
  FolderOpen,
  Loader2,
  LogIn,
  MessageSquare,
  RefreshCw,
  Search,
  ShieldCheck,
  TerminalSquare
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { CodingSession, SessionProvider } from '../../../shared/types'
import { useApp } from '../state/AppContext'
import { useNowWhen } from '../state/clock'
import { SESSION_META, SessionBadge, sessionAge } from '../components/SessionBits'
import { OpenCodeApprovals } from '../components/OpenCodeApprovals'
import { AgentStatus } from '../components/AgentStatus'
// 'deepai' is included so the Message option exists for DeepAI Code sessions.
// DeepAI Code owns its threads and exposes no local delivery channel yet; if a
// send is attempted, the main process refuses it with code 'deepai-external'
// and the composer's status line explains, so no always-on notice is needed.
const SENDABLE = new Set(['codex', 'opencode', 'antigravity', 'claude', 'deepai'])

type DeliveryPhase = 'idle' | 'sending' | 'delivered' | 'unconfirmed' | 'failed'

export function SessionsPage() {
  const { sessions, sessionsLoading, refreshSessions, showToast, repliedSessionId, state, expanded } = useApp()
  const now = useNowWhen(expanded)
  const compact = state.settings.panelSize === 'compact'
  const [query, setQuery] = useState('')
  const [appFilter, setAppFilter] = useState<SessionProvider | null>(null)
  const [showSubagents, setShowSubagents] = useState(false)
  const [composer, setComposer] = useState<CodingSession | null>(null)
  const [message, setMessage] = useState('')
  const [phase, setPhase] = useState<DeliveryPhase>('idle')
  const [sendNote, setSendNote] = useState<string | null>(null)
  const [sendErrorCode, setSendErrorCode] = useState<string | null>(null)
  // Armed while waiting for a Codex thread to close in ChatGPT; the watcher
  // delivers the queued message the moment the lock is released.
  const [watching, setWatching] = useState(false)
  const composerRef = useRef<CodingSession | null>(null)
  composerRef.current = composer
  const noteTimer = useRef<number | null>(null)
  const phaseRef = useRef<DeliveryPhase>('idle')
  // The message is cleared the moment it goes out, so keep it for restoring on
  // a failure.
  const lastSentRef = useRef('')
  // Row-level feedback for a message that was handed to the queue or delivered
  // later, while its composer was already closed.
  const [rowFlash, setRowFlash] = useState<Record<string, { text: string; tone: 'ok' | 'wait' }>>({})
  const rowTimers = useRef(new Map<string, number>())
  const sending = phase === 'sending'
  phaseRef.current = phase

  const flashRow = (sessionId: string, text: string, tone: 'ok' | 'wait', hold = 2600): void => {
    const running = rowTimers.current.get(sessionId)
    if (running) window.clearTimeout(running)
    setRowFlash((current) => ({ ...current, [sessionId]: { text, tone } }))
    rowTimers.current.set(
      sessionId,
      window.setTimeout(() => {
        rowTimers.current.delete(sessionId)
        setRowFlash((current) => {
          const next = { ...current }
          delete next[sessionId]
          return next
        })
      }, hold)
    )
  }

  const stopNoteTimer = (): void => {
    if (noteTimer.current) window.clearTimeout(noteTimer.current)
    noteTimer.current = null
  }

  const flashNote = (text: string, hold = 2400): void => {
    stopNoteTimer()
    setSendNote(text)
    noteTimer.current = window.setTimeout(() => {
      noteTimer.current = null
      setSendNote(null)
    }, hold)
  }

  useEffect(() => () => {
    if (noteTimer.current) window.clearTimeout(noteTimer.current)
  }, [])

  const all = sessions?.sessions || []
  const subagentCount = all.filter((session) => session.subagent).length
  const apps = sessions?.apps || []
  const runningApps = apps.filter((app) => app.running)
  const runningCount = runningApps.length
  const filterLabel = appFilter ? runningApps.find((app) => app.provider === appFilter)?.label || appFilter : null

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return all.filter((session) => {
      if (!showSubagents && session.subagent) return false
      if (appFilter && session.provider !== appFilter) return false
      if (!needle) return true
      return `${session.title} ${session.project || ''} ${session.provider} ${session.model || ''} ${session.origin || ''}`
        .toLowerCase()
        .includes(needle)
    })
  }, [all, query, showSubagents, appFilter])

  const grouped = useMemo(
    () => ({
      active: filtered.filter((session) => session.active),
      recent: filtered.filter((session) => !session.active)
    }),
    [filtered]
  )

  // The heading names what is actually here instead of a fixed tool list.
  const toolCount = useMemo(
    () => new Set((sessions?.sessions || []).map((session) => session.provider)).size,
    [sessions]
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
    setWatching(false)
  }

  // A send keeps running in the main process, so closing the composer never
  // waits for it.
  const closeComposer = (): void => {
    setComposer(null)
    setMessage('')
    setPhase('idle')
    setSendNote(null)
    setSendErrorCode(null)
    setWatching(false)
  }

  // While armed, watch the Codex thread-writer lock and deliver as soon as the
  // thread is no longer open in ChatGPT.
  const watchRetriesRef = useRef(0)
  useEffect(() => {
    if (!watching || !composer || phase !== 'failed' || sendErrorCode !== 'codex-open') return
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const status = await window.notch.sessions.codexLock(composer.id)
        if (!alive) return
        if (status.missing) {
          setWatching(false)
          setSendNote('That session is no longer in the latest scan.')
          return
        }
        if (!status.locked) {
          if (watchRetriesRef.current >= 2) {
            setWatching(false)
            setSendNote('Could not deliver to Codex automatically. Press Send to try again.')
            return
          }
          watchRetriesRef.current += 1
          setWatching(false)
          setSendNote(null)
          void send()
        }
      } catch {
        // Keep watching; a single failed check is not a reason to stop.
      }
    }
    const timer = window.setInterval(tick, 2000)
    void tick()
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [watching, composer, phase, sendErrorCode])

  useEffect(() => {
    return window.notch.sessions.onSendResult((result) => {
      // A queued message is delivered later, long after its composer closed, so
      // the row itself has to report it.
      if (result.status === 'queued') {
        flashRow(result.sessionId, `Queued · ${result.position ?? 1}`, 'wait')
        void refreshSessions()
        return
      }
      if (result.status === 'delivered') {
        flashRow(result.sessionId, window.notchDemo ? 'Delivered' : 'Sent', 'ok')
        void refreshSessions()
      } else {
        void refreshSessions()
      }
      const current = composerRef.current
      if (!current || current.id !== result.sessionId) return
      if (result.status === 'delivered') {
        watchRetriesRef.current = 0
        // The composer already said "Sent" when the command started.
        if (phaseRef.current === 'sending') {
          setPhase('delivered')
          flashNote(window.notchDemo ? 'Delivered' : 'Sent')
        }
        setSendErrorCode(null)
        setMessage((draft) => (draft.trim() === lastSentRef.current.trim() ? '' : draft))
        return
      }
      if (result.status === 'unconfirmed') {
        setPhase('unconfirmed')
        stopNoteTimer()
        setSendNote(result.error || 'Not visible in the session yet')
        setMessage((current) => (current.trim() ? current : lastSentRef.current))
        return
      }
      setPhase('failed')
      setSendErrorCode(result.code || null)
      stopNoteTimer()
      setMessage((current) => (current.trim() ? current : lastSentRef.current))
      setSendNote(
        result.code === 'codex-open'
          ? 'Codex has this thread open, so Notch keeps the message and sends it as soon as you close the thread.'
          : result.error || 'The agent command failed.'
      )
      if (result.code === 'codex-open') setWatching(true)
      if (result.code === 'session-gone') void refreshSessions()
    })
  }, [refreshSessions])

  const toggleWatch = (): void => {
    if (watching) {
      setWatching(false)
      setSendNote('Not watching this thread anymore. Close the thread and press Send.')
    } else {
      setWatching(true)
      setSendNote(
        'Watching this thread. Close it in ChatGPT and Notch delivers the message automatically.'
      )
    }
  }

  const send = async (): Promise<void> => {
    if (!composer || !message.trim() || sending) return
    const text = message
    lastSentRef.current = text
    setPhase('sending')
    stopNoteTimer()
    setSendNote(null)
    setSendErrorCode(null)
    try {
      const result = await window.notch.sessions.send(composer.id, text)
      if (result.queued) {
        // The session is mid-turn: the message is held and delivered when it
        // goes quiet. Close the composer — the queue owns the text now.
        setPhase('idle')
        setMessage('')
        setSendNote(null)
        setSendErrorCode(null)
        flashRow(composer.id, `Queued · ${result.position ?? 1}`, 'wait')
        setComposer(null)
        void refreshSessions()
        return
      }
      if (result.handedOff) {
        // The Claude app owns this chat, so Notch opened it there with the
        // message on the clipboard. Nothing was sent; say what to do next.
        setPhase('unconfirmed')
        setSendNote(result.note || 'Notch copied your message. Paste it into the chat in the Claude app.')
        setSendErrorCode(result.code || null)
        flashRow(composer.id, 'Copied', 'wait')
        return
      }
      if (result.pending) {
        // The command is running. Delivery is verified in the background, so the
        // composer only says "Sent".
        setPhase('delivered')
        setMessage('')
        flashNote(window.notchDemo ? 'Delivered' : 'Sent')
        return
      }
      setPhase('failed')
      stopNoteTimer()
      setSendNote(
        result.code === 'codex-open'
          ? 'Codex has this thread open, so Notch keeps the message and sends it as soon as you close the thread.'
          : result.error || 'The agent command could not be started.'
      )
      setSendErrorCode(result.code || null)
      if (result.code === 'codex-open') setWatching(true)
      if (result.code === 'session-gone') void refreshSessions()
    } catch (error) {
      setPhase('failed')
      setSendNote(error instanceof Error ? error.message : 'Could not send the message.')
    }
  }

  // Provider commands can exit before their store is flushed; re-reading it is
  // how an "unconfirmed" send becomes a confirmed one without sending twice.
  const checkDelivery = async (): Promise<void> => {
    if (!composer || !message.trim() || sending) return
    const text = message
    setPhase('sending')
    setSendNote('Reading that session’s local store…')
    setSendErrorCode(null)
    try {
      const result = await window.notch.sessions.verify(composer.id, text)
      if (composerRef.current?.id !== composer.id) return
      if (result.ok) {
        setPhase('delivered')
        setMessage('')
        flashNote(window.notchDemo ? 'Delivered' : 'Sent')
        return
      }
      setPhase('unconfirmed')
      setSendNote(result.error || 'That message is still not in the session’s store.')
    } catch (error) {
      setPhase('unconfirmed')
      setSendNote(error instanceof Error ? error.message : 'Could not read the session store.')
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
          <span className="sessions-apps-count">
            {runningCount} of {apps.length}
          </span>
        </div>
        <div className="sessions-apps-list">
          {(sessions?.apps || []).map((app) => {
            const meta = SESSION_META[app.provider]
            const stateMeta =
              app.state === 'working'
                ? { label: 'Working', cls: 'is-live' }
                : app.state === 'open'
                  ? { label: 'Open', cls: 'is-open' }
                  : app.state === 'idle'
                    ? { label: 'Background', cls: 'is-idle' }
                    : { label: 'Closed', cls: '' }
            return (
              <div
                key={app.provider}
                className={`agent-card ${app.running ? 'is-running' : ''}`}
                style={{ '--agent-color': meta.color } as CSSProperties}
              >
                <div className="agent-card-top">
                  <SessionBadge provider={app.provider} size={24} />
                  <span className="agent-name">{app.label}</span>
                  <span className={`agent-state ${stateMeta.cls}`}>
                    <i /> {stateMeta.label}
                  </span>
                </div>
                <p className="agent-window">
                  <span>Latest</span>
                  {app.windowTitle ||
                    (app.state === 'idle'
                      ? 'Only background processes'
                      : app.running
                        ? 'No active conversation'
                        : 'Not running')}
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
        <OpenCodeApprovals />
        <AgentStatus />
        <header className="sessions-head">
          <div>
            <span className="eyebrow">
              <span className={`live-dot ${grouped.active.length ? 'is-live' : ''}`} />
              Coding sessions
            </span>
            <h1>{grouped.active.length ? `${grouped.active.length} live` : 'Session board'}</h1>
            <p>
              {toolCount > 1
                ? `Conversations from ${toolCount} coding tools on this machine.`
                : 'Conversations on this machine.'}
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

        {compact && (
          <div className="sessions-running" role="group" aria-label="Apps running on this machine">
            <button
              type="button"
              className={`sessions-running-count ${runningCount ? 'is-live' : ''} ${appFilter ? 'is-filtered' : ''}`}
              onClick={() => setAppFilter(null)}
              disabled={!appFilter}
              title={appFilter ? 'Show sessions from every app' : 'Apps running on this machine'}
            >
              <span className="live-dot" />
              {appFilter ? `\u00d7 ${filterLabel}` : `${runningCount} running`}
            </button>
            <div className="sessions-running-list">
              {runningApps.map((app) => (
                <button
                  key={app.provider}
                  type="button"
                  className={`session-app-chip is-running ${appFilter === app.provider ? 'is-selected' : ''}`}
                  aria-pressed={appFilter === app.provider}
                  onClick={() =>
                    app.sessions === 0
                      ? undefined
                      : setAppFilter((current) => (current === app.provider ? null : app.provider))
                  }
                  disabled={app.sessions === 0}
                  title={
                    appFilter === app.provider
                      ? `Show every app again`
                      : app.sessions === 0
                        ? `${app.label} has no conversations yet`
                        : `Show ${app.label} sessions`
                  }
                >
                  <i />
                  {app.label}
                </button>
              ))}
              {runningCount === 0 && (
                <span className="session-app-chip">
                  {sessions?.error ? 'Apps unavailable' : sessions ? 'No apps running' : 'Checking…'}
                </span>
              )}
            </div>
          </div>
        )}

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
              <span className="eyebrow">{query ? 'No match' : appFilter ? 'Filtered' : 'All quiet'}</span>
              <h2>
                {query
                  ? 'Nothing matches that search.'
                  : appFilter
                    ? `No ${filterLabel} sessions on this machine.`
                    : 'No sessions found yet.'}
              </h2>
              <p>
                {query
                  ? 'Try a project name, model, or a shorter search.'
                  : appFilter
                    ? `${filterLabel} is running, but it has no saved conversations here yet.`
                    : subagentCount > 0 && !showSubagents
                      ? 'Only subagent conversations are present right now. Show subagents to see them.'
                      : 'Open a Codex thread, start an OpenCode session, or pick up an Anti Gravity conversation.'}
              </p>
              <button
                className="soft-button"
                onClick={() => {
                  if (query) setQuery('')
                  else if (appFilter) setAppFilter(null)
                  else if (subagentCount > 0) setShowSubagents(true)
                  else void refreshSessions()
                }}
              >
                {query
                  ? 'Clear search'
                  : appFilter
                    ? 'Show all apps'
                    : subagentCount > 0 && !showSubagents
                      ? 'Show subagents'
                      : 'Scan again'}
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
        replied={repliedSessionId === session.id}
        flash={rowFlash[session.id]}
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
        onCheck={() => void checkDelivery()}
        onCancel={closeComposer}
        onCopy={() => void copyAndOpenChatGpt()}
        watching={watching}
        onWatch={toggleWatch}
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
  replied,
  onMessage,
  onOpen,
  onDraft,
  onSend,
  onCheck,
  onCancel,
  onCopy,
  watching,
  onWatch,
  flash
}: {
  session: CodingSession
  now: number
  open: boolean
  message: string
  phase: DeliveryPhase
  note: string | null
  errorCode: string | null
  replied: boolean
  onMessage: () => void
  onOpen: () => void
  onDraft: (value: string) => void
  onSend: () => void
  onCheck: () => void
  onCancel: () => void
  onCopy: () => void
  watching: boolean
  onWatch: () => void
  flash?: { text: string; tone: 'ok' | 'wait' }
}) {
  const meta = SESSION_META[session.provider]
  const canSend = SENDABLE.has(session.provider) && !session.subagent
  const sending = phase === 'sending'
  const inputRef = useRef<HTMLInputElement>(null)
  const noteRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus({ preventScroll: true })
    inputRef.current?.closest('.session-row')?.scrollIntoView({ block: 'nearest' })
  }, [open])
  // A status line ("Sent", an error) can land below the fold in compact mode.
  // Keep the feedback the user is waiting for in view.
  useEffect(() => {
    if (!open || !note) return
    noteRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open, note])
  return (
    <div
      data-session-id={session.id}
      className={`session-row ${session.active ? 'is-live' : ''} ${open ? 'is-composing' : ''} ${
        replied ? 'is-replied' : ''
      }`}
    >
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
          {session.queued ? (
            <span className="session-queued" title="Held until this session finishes its current turn">
              <Clock3 size={10} /> {session.queued} queued
            </span>
          ) : flash ? (
            <span className={`session-flash is-${flash.tone}`}>{flash.text}</span>
          ) : null}
          {session.active ? (
            <span className="session-live"><i /> live</span>
          ) : (
            <span className="session-row-time">{sessionAge(session.updatedAt, now)}</span>
          )}
          {canSend && (
            <button
              data-demo-message-btn={session.id}
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
            <button type="button" className="soft-button compact session-inline-cancel" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button compact session-inline-send"
              disabled={!message.trim() || sending}
            >
              {sending ? <Loader2 size={12} className="spin" /> : <MessageSquare size={12} />}
              {sending ? 'Sending' : 'Send'}
            </button>
          </div>
          {note && <p ref={noteRef} className={`session-inline-status is-${phase}`}>{note}</p>}
          {/* Only an unconfirmed send can be settled by reading the store again;
              a failed command never wrote anything. */}
          {phase === 'unconfirmed' && (
            <div className="session-inline-codex">
              <button
                type="button"
                className="soft-button compact session-inline-copy"
                onClick={onCheck}
                disabled={sending || !message.trim()}
              >
                <RefreshCw size={12} /> Check again
              </button>
            </div>
          )}
          {errorCode === 'claude-signin' && (
            <div className="session-inline-codex">
              <button
                type="button"
                className="primary-button compact session-inline-copy"
                onClick={() => void window.notch.agent.claudeLogin()}
              >
                <LogIn size={12} /> Sign in to Claude Code
              </button>
            </div>
          )}
          {errorCode === 'codex-open' && (
            <div className="session-inline-codex">
              <button
                type="button"
                className={`compact ${watching ? 'primary-button session-inline-copy' : 'soft-button session-inline-copy'}`}
                onClick={onWatch}
              >
                {watching ? (
                  <>
                    <Loader2 size={12} className="spin" /> Watching… click to stop
                  </>
                ) : (
                  <>
                    <Clock3 size={12} /> Send when the thread closes
                  </>
                )}
              </button>
              <button type="button" className="soft-button compact session-inline-copy" onClick={onCopy}>
                <Copy size={12} /> Copy &amp; open ChatGPT
              </button>
            </div>
          )}
        </form>
      )}
    </div>
  )
}
