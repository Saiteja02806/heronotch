import { Bot, ChevronDown, Flame, Music2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { useApp, useTimerClock } from '../state/AppContext'
import { useMedia } from '../state/MediaContext'
import { formatTimer, todayKey } from '../lib/time'
import type { NotchStyle } from '../../../shared/types'
import { EdgeGlow } from './EdgeGlow'
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
  style: styleProp
}: {
  onOpen: () => void
  onOpenSessions?: () => void
  style?: NotchStyle
}) {
  const { state, sessions, glowTick } = useApp()
  const { remaining: timerRemaining } = useTimerClock()
  const { playback, progressMs } = useMedia()
  const style = styleProp || state.settings.notchStyle || 'minimal'
  const detailed = style === 'full' || style === 'compact' || style === 'pill'
  const track = playback?.track
  const progress = track && track.duration ? Math.min(1, progressMs / track.duration) : 0
  const liveSessions = sessions?.sessions.filter((session) => session.active).length || 0
  // Coding agents worth a glance while the tab is collapsed. App presence is
  // the honest "how many IDEs are open" number; live conversations cover an
  // agent chatting without a spotted process. Shown on every tab style, even
  // the bare ones — otherwise the only way to find out is to open the notch,
  // which nobody does on spec.
  const runningApps = sessions?.apps.filter((app) => app.running).length ?? 0
  const agentCount = Math.max(runningApps, liveSessions)
  const today = todayKey()
  const nextTask = state.tasks
    .filter((task) => !task.done && task.date === today)
    .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'))[0]
  const showTimer = detailed && style !== 'pill' && timerRemaining > 0 && state.timer.running
  const showSessions = detailed && style !== 'pill' && agentCount > 0
  const showFloatingBadge = !detailed && agentCount > 0
  const showEmptyEqualizer = !detailed && Boolean(track && playback?.playing)

  return (
    <button className={`collapsed-bar style-${style}`} onClick={onOpen} aria-label="Open Notch">
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
          {showSessions && (
            <span
              className="mini-sessions"
              role="button"
              title={`${agentCount} coding ${agentCount === 1 ? 'agent' : 'agents'} running — see sessions`}
              onClick={(event) => {
                event.stopPropagation()
                onOpenSessions?.()
              }}
            >
              <Bot size={10} />
              {agentCount}
            </span>
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
        <span
          className="mini-sessions is-float"
          role="button"
          title={`${agentCount} coding ${agentCount === 1 ? 'agent' : 'agents'} running — see sessions`}
          onClick={(event) => {
            event.stopPropagation()
            onOpenSessions?.()
          }}
        >
          <Bot size={9} />
          {agentCount}
        </span>
      )}
      <EdgeGlow tick={glowTick} ready />
    </button>
  )
}
