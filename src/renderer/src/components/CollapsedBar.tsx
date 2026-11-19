import { ArrowUpRight, Bot, Check, ChevronDown, Flame, Music2, PersonStanding, X } from 'lucide-react'
import { motion } from 'framer-motion'
import { useApp, useTimerClock } from '../state/AppContext'
import { useMedia } from '../state/MediaContext'
import { usePosture } from '../state/PostureContext'
import { formatTimer, todayKey } from '../lib/time'
import type { NotchStyle } from '../../../shared/types'
import { agentToolShortLabel, countActiveAgents } from '../../../shared/agentTools'
import { EdgeGlow } from './EdgeGlow'
import { CollapsedQuestion } from './CollapsedQuestion'
import { Logo } from './Logo'

function Equalizer({ playing }: { playing: boolean }) {
  return (
    <span className={`equalizer ${playing ? 'is-playing' : ''}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}

export function CollapsedBar({
  onOpen,
  onOpenSessions,
  onOpenPosture,
  style: styleProp
}: {
  onOpen: () => void
  onOpenSessions?: () => void
  onOpenPosture?: () => void
  style?: NotchStyle
}) {
  const {
    state,
    sessions,
    glowTick,
    welcomeActive,
    expanded,
    agentSnapshot,
    questions,
    openCodePending,
    approvalBusy,
    decideAgent,
    decideOpenCode
  } = useApp()
  const { remaining: timerRemaining } = useTimerClock()
  const { playback, progressMs } = useMedia()
  const posture = usePosture()
  const style = styleProp || state.settings.notchStyle || 'minimal'
  const detailed = style === 'full' || style === 'compact' || style === 'pill'
  const agentPerm = agentSnapshot?.pending[0]
  const openCodePerm = openCodePending[0]
  const agentQuestion = questions[0]
  const hasApproval = Boolean(agentPerm || openCodePerm)
  const hasQuestion = Boolean(agentQuestion)
  const track = playback?.track
  const progress = track && track.duration ? Math.min(1, progressMs / track.duration) : 0
  // Count only currently active non-subagent coding chats plus fresh un-scanned hooks.
  const agentCount = countActiveAgents({ sessions, agentSnapshot, questions, openCodePending })
  const today = todayKey()
  const nextTask = state.tasks
    .filter((task) => !task.done && task.date === today)
    .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'))[0]
  const showTimer = detailed && timerRemaining > 0 && state.timer.running
  // Keep the posture affordance on the tab while the coach is on, even when the
  // chair is empty. A chip that vanishes whenever nobody is in frame reads as a
  // broken feature rather than an idle one.
  const postureTracked = posture.enabled && posture.status === 'running' && posture.score !== null
  const showPosture =
    detailed &&
    posture.enabled &&
    (posture.status === 'running' || posture.status === 'no-pose' || posture.status === 'away')
  const postureState =
    posture.score === null
      ? 'is-idle'
      : posture.score >= posture.threshold
        ? 'is-good'
        : posture.score >= posture.threshold - 12
          ? 'is-warn'
          : 'is-bad'
  const showSessions = detailed && agentCount > 0
  const showFloatingBadge = !detailed && agentCount > 0
  const showEmptyEqualizer = !detailed && Boolean(track && playback?.playing)

  if (hasQuestion) {
    return (
      <CollapsedQuestion
        style={style}
        glowTick={glowTick}
        expanded={expanded}
        onOpenSessions={onOpenSessions || onOpen}
      />
    )
  }

  if (hasApproval) {
    const compactApproval = style === 'pill-tiny' || style === 'notch-micro'
    const toolLabel = agentPerm
      ? agentToolShortLabel(agentPerm.tool)
      : 'OpenCode'
    const summary = agentPerm
      ? agentPerm.title || agentPerm.detail || 'Needs approval'
      : openCodePerm
        ? `${openCodePerm.operation}${openCodePerm.details ? ` · ${openCodePerm.details}` : ''}`
        : 'Needs approval'

    return (
      <div
        className={`collapsed-bar style-${style} has-approval${compactApproval ? ' is-compact-approval' : ''}`}
        role="group"
        aria-label={`${toolLabel} approval request`}
      >
        <button
          type="button"
          className="notch-approval-main"
          onClick={() => (onOpenSessions ? onOpenSessions() : onOpen())}
          title="Click to view full session in Notch"
        >
          <span className="notch-approval-dot" />
          <span className="notch-approval-copy">
            <strong>{toolLabel}</strong>
            <span>{summary}</span>
          </span>
        </button>
        <div className="notch-approval-actions">
          <button
            type="button"
            className="notch-approve-btn"
            disabled={approvalBusy}
            onClick={(event) => {
              event.stopPropagation()
              if (agentPerm) void decideAgent(agentPerm.id, 'allow')
              else if (openCodePerm) void decideOpenCode(openCodePerm, 'once')
            }}
            title="Approve"
            aria-label="Approve"
          >
            <Check size={compactApproval ? 12 : 10} strokeWidth={2.7} />
            {!compactApproval && 'Approve'}
          </button>
          <button
            type="button"
            className="notch-deny-btn"
            disabled={approvalBusy}
            onClick={(event) => {
              event.stopPropagation()
              if (agentPerm) void decideAgent(agentPerm.id, 'deny')
              else if (openCodePerm) void decideOpenCode(openCodePerm, 'reject')
            }}
            title="Deny"
            aria-label="Deny"
          >
            <X size={compactApproval ? 12 : 10} strokeWidth={2.5} />
            {!compactApproval && 'Deny'}
          </button>
          <button
            type="button"
            className="notch-expand-btn"
            onClick={(event) => {
              event.stopPropagation()
              if (onOpenSessions) onOpenSessions()
              else onOpen()
            }}
            title="Open full Notch"
            aria-label="Open full Notch"
          >
            <ArrowUpRight size={12} />
          </button>
        </div>
        <EdgeGlow tick={glowTick} ready={!expanded} />
      </div>
    )
  }

  return (
    <div
      className={`collapsed-bar style-${style}${welcomeActive && !hasApproval && !hasQuestion ? ' is-welcome' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      aria-label="Open Notch"
    >
      {detailed ? (
        <>
          {track ? (
            <>
              <span className="mini-art">
                {track.image ? <img src={track.image} alt="" /> : <Music2 size={12} />}
              </span>
              <span className="mini-meta">
                <span className="mini-title">{track.name}</span>
                <span className="mini-artist">{track.artists}</span>
              </span>
            </>
          ) : (
            <>
              <span className="mini-logo">
                <Logo size={18} />
              </span>
              <span className="mini-meta">
                <span className="mini-title">Your day, at a glance</span>
                <span className="mini-artist">
                  {nextTask
                    ? nextTask.title
                    : `${state.tasks.filter((task) => !task.done && task.date === today).length} open tasks today`}
                </span>
              </span>
            </>
          )}

          <span className="mini-spacer" />
          {showTimer && (
            <motion.span
              className="mini-timer"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
            >
              <Flame size={11} />
              {formatTimer(timerRemaining)}
            </motion.span>
          )}
          {showPosture && (
            <button
              type="button"
              className={`mini-posture ${postureState}`}
              title={
                postureTracked
                  ? `Posture ${posture.score} — ${posture.metrics?.advice || 'Open posture coach'}`
                  : 'Posture coach is on — nobody in frame'
              }
              aria-label={
                postureTracked ? `Posture score ${posture.score}` : 'Posture coach is on, nobody in frame'
              }
              onClick={(event) => {
                event.stopPropagation()
                onOpenPosture?.()
              }}
            >
              <span className="mini-posture-dot" />
              <PersonStanding size={10} />
              {postureTracked ? posture.score : '—'}
            </button>
          )}
          {showSessions && (
            <button
              type="button"
              className="mini-sessions"
              title={`${agentCount} active coding ${agentCount === 1 ? 'session' : 'sessions'} — see sessions`}
              onClick={(event) => {
                event.stopPropagation()
                onOpenSessions?.()
              }}
            >
              <Bot size={10} />
              {agentCount}
            </button>
          )}
          <ChevronDown size={12} className="mini-chevron" />
          {track && (
            <span className="mini-progress" aria-hidden="true">
              <span style={{ width: `${progress * 100}%` }} />
            </span>
          )}
        </>
      ) : showEmptyEqualizer ? (
        <Equalizer playing />
      ) : null}
      {showFloatingBadge && (
        <button
          type="button"
          className="mini-sessions is-float"
          title={`${agentCount} active coding ${agentCount === 1 ? 'session' : 'sessions'} — see sessions`}
          onClick={(event) => {
            event.stopPropagation()
            onOpenSessions?.()
          }}
        >
          <Bot size={9} />
          {agentCount}
        </button>
      )}
      <EdgeGlow tick={glowTick} ready={!expanded} />
    </div>
  )
}
