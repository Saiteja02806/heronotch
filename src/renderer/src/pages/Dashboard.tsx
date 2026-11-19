import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bot,
  CalendarDays,
  Camera,
  CameraOff,
  Check,
  ChevronRight,
  Clock3,
  FileText,
  Flame,
  FolderOpen,
  GripVertical,
  Music2,
  Pause,
  PersonStanding,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  SkipBack,
  SkipForward,
  Sparkles,
  SquareTerminal,
  X
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import type { Task, VaultNode } from '../../../shared/types'
import { playbackHeading } from '../../../shared/mediaFollow'
import {
  convertTaskSchedule,
  formatDateShort,
  formatDuration,
  formatMinutes,
  formatTaskClock,
  formatTimer,
  greeting,
  monthMatrix,
  resolvePlannerTimeZone,
  resolveSystemTimeZone,
  timeToTimestamp,
  todayKey,
  todayKeyInZone
} from '../lib/time'
import { useApp, useTimerClock } from '../state/AppContext'
import { useNowWhen } from '../state/clock'
import { useHomeEdit } from '../state/HomeEditContext'
import { useMedia } from '../state/MediaContext'
import { usePosture } from '../state/PostureContext'
import { SessionBadge, relativeSessionTime } from '../components/SessionBits'
import { PhoneTransfer } from '../components/PhoneTransfer'
import { ProgressRing } from '../components/ProgressRing'
import { useVaultPicker } from '../hooks/useVaultPicker'
import { waterCount } from '../lib/water'
import { usePickedCalendarTimeZone } from '../state/useGoogleCalendar'
import { HOME_CARD_META, homeCardAvailable, homeLayoutFor } from '../lib/sections'
import { WaterCard } from './WaterPage'
import {
  DEFAULT_HOME_HIDDEN,
  HOME_CARD_IDS,
  defaultHomeLayout,
  homeGridColumns,
  homeLayoutEqual,
  homeSlotLabel,
  moveHomeCard,
  removeHomeCard,
  reorderHomeCards,
  setHomeCardCount,
  shownHomeCards,
  toggleHomeCard,
  type HomeCardId
} from '../../../shared/homeLayout'

function Artwork({
  image,
  seed,
  size,
  className = ''
}: {
  image?: string | null
  seed: string
  size?: number
  className?: string
}) {
  const tone = useMemo(() => {
    let hash = 0
    for (let index = 0; index < seed.length; index += 1) hash = seed.charCodeAt(index) + ((hash << 5) - hash)
    return 5 + (Math.abs(hash) % 6)
  }, [seed])

  return (
    <div
      className={`artwork ${className}`}
      style={{
        width: size,
        height: size,
        background: image
          ? undefined
          : `radial-gradient(circle at 25% 20%, hsl(0 0% ${tone + 11}%), transparent 55%),
             radial-gradient(circle at 78% 72%, hsl(0 0% ${tone}%), transparent 58%),
             linear-gradient(145deg, hsl(0 0% ${tone - 2}%), #050505)`
      }}
    >
      {image ? <img src={image} alt="" /> : <Music2 size={size ? Math.max(16, size * 0.24) : 24} />}
    </div>
  )
}

function TimerCard() {
  const {
    state,
    startTimer,
    pauseTimer,
    resetTimer,
    setTimerMode,
    update
  } = useApp()
  const { remaining: timerRemaining } = useTimerClock()
  const timer = state.timer
  const total = timer.durations[timer.mode] * 60
  const label = timer.mode === 'focus' ? 'Focus' : timer.mode === 'short' ? 'Break' : 'Long'
  const ringProgress = Math.max(0, Math.min(1, timerRemaining / Math.max(1, total)))
  const running = timer.running
  const [customMin, setCustomMin] = useState(String(timer.durations[timer.mode]))

  useEffect(() => {
    if (!running) setCustomMin(String(timer.durations[timer.mode]))
  }, [timer.mode, timer.durations, running])

  const applyCustom = (): void => {
    const minutes = Math.min(180, Math.max(1, Number(customMin) || timer.durations[timer.mode]))
    setCustomMin(String(minutes))
    update({
      timer: {
        ...timer,
        durations: { ...timer.durations, [timer.mode]: minutes },
        remaining: minutes * 60,
        running: false,
        endsAt: null
      }
    })
  }

  return (
    <article className="card timer-card">
      <div className="card-heading">
        <span className="eyebrow">Focus</span>
        <span className="mini-badge">
          <Flame size={11} />
          {timer.completedToday} today
        </span>
      </div>

      <button
        className={`timer-disc ${running ? 'is-running' : ''}`}
        onClick={() => (running ? pauseTimer() : startTimer())}
        aria-label={running ? 'Pause timer' : 'Start timer'}
      >
        <svg className="timer-ring" viewBox="0 0 116 116" aria-hidden="true">
          <circle className="timer-ring-track" cx="58" cy="58" r="52" />
          <circle
            className="timer-ring-value"
            cx="58"
            cy="58"
            r="52"
            pathLength={100}
            strokeDasharray={`${Math.max(0.001, ringProgress) * 100} ${100 - Math.max(0.001, ringProgress) * 100}`}
          />
        </svg>
        <span className="timer-disc-face">
          <span className="timer-disc-label">{label}</span>
          <span className="timer-disc-time">{formatTimer(timerRemaining)}</span>
        </span>
      </button>

      <div className="timer-modes">
        {(['focus', 'short', 'long'] as const).map((mode) => (
          <button
            key={mode}
            className={timer.mode === mode ? 'is-active' : ''}
            onClick={() => setTimerMode(mode)}
          >
            {mode === 'focus' ? 'Focus' : mode === 'short' ? 'Break' : 'Long'}
          </button>
        ))}
      </div>

      <div className="timer-controls">
        <button className="timer-ghost" onClick={resetTimer} aria-label="Reset timer">
          <RotateCcw size={14} />
        </button>
        <button className="timer-play" onClick={() => (running ? pauseTimer() : startTimer())}>
          {running ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
          {running ? 'Pause' : 'Start'}
        </button>
        <label className="timer-length timer-length--edit">
          <input
            type="number"
            min={1}
            max={180}
            value={customMin}
            onChange={(event) => setCustomMin(event.target.value)}
            onBlur={applyCustom}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                applyCustom()
              }
            }}
            aria-label="Minutes for this timer"
          />
          <span>min</span>
        </label>
      </div>
    </article>
  )
}

function MusicCard() {
  const { setPage } = useApp()
  const { playback, queue, togglePlay, action, progressMs, pending, playerName, playerAvailable } = useMedia()
  const track = playback?.track
  const connected = playerAvailable
  const duration = track?.duration || 0
  const elapsed = duration ? Math.min(progressMs, duration) : progressMs
  const progress = duration ? Math.min(1, elapsed / duration) : 0
  const changing = pending === 'next' || pending === 'previous'

  const play = (event: ReactMouseEvent): void => {
    event.stopPropagation()
    if (!track && !connected) {
      setPage('music')
      return
    }
    void togglePlay()
  }

  const skip = (direction: 'next' | 'previous') => (event: ReactMouseEvent): void => {
    event.stopPropagation()
    if (!connected) return
    void action({ type: direction })
  }

  return (
    <article className="card music-card" onClick={() => setPage('music')}>
      <div className="music-ambient" aria-hidden="true">
        {track?.image && <img src={track.image} alt="" />}
      </div>
      <div className="card-heading">
        <span className="eyebrow">
          <span className={`live-dot ${playback?.playing ? 'is-live' : ''}`} />
          {playbackHeading(playback)}
        </span>
        <span className="mini-badge">
          <Music2 size={11} />
          {playerName}{!connected && ' · unavailable'}
        </span>
      </div>

      <div className="music-body">
        <Artwork image={track?.image} seed={track?.id || 'notch'} size={132} className="music-art" />
        <div className={`music-info ${changing ? 'is-changing' : ''}`}>
          <h2>{track?.name || (connected ? 'Nothing playing' : 'Make room for music')}</h2>
          <p>
            {track?.artists ||
              (connected
                ? `Start playback in ${playerName} and it will show up here.`
                : 'Start playback in your selected player to control it from the notch.')}
          </p>

          <div className={`seek-line ${track ? '' : 'is-empty'}`}>
            <span className="seek-fill" style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="seek-times">
            <span>{formatDuration(elapsed)}</span>
            <span>{track ? formatDuration(duration) : '--:--'}</span>
          </div>

          {track && playback?.queueAvailable && (
            <div className="music-next">
              <span className="music-next-label">Next</span>
              <span className="music-next-name">
                {queue[0] ? queue[0].name : 'Queue is empty'}
              </span>
              {queue[0] && <span className="music-next-artist">· {queue[0].artists}</span>}
            </div>
          )}

          <div className="music-controls">
            <button className="control-button" onClick={skip('previous')} aria-label="Previous track" disabled={!connected || playback?.controls?.previous === false}>
              <SkipBack size={15} fill="currentColor" />
            </button>
            <button className="control-button is-primary" onClick={play} aria-label={playback?.playing ? 'Pause' : 'Play'}>
              {playback?.playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
            </button>
            <button className="control-button" onClick={skip('next')} aria-label="Next track" disabled={!connected || playback?.controls?.next === false}>
              <SkipForward size={15} fill="currentColor" />
            </button>
            <span className="music-open">
              Open player <ArrowUpRight size={11} />
            </span>
          </div>
        </div>
      </div>
    </article>
  )
}

function TasksCard() {
  const { state, toggleTask, addTask, openPlanner } = useApp()
  const [draft, setDraft] = useState('')
  const systemTz = resolveSystemTimeZone()
  const displayTimeZone = resolvePlannerTimeZone(usePickedCalendarTimeZone())
  const today = todayKeyInZone(displayTimeZone)
  const tasks = useMemo(() => {
    const order = { high: 0, normal: 1, low: 2 } as const
    return state.tasks
      .map((task) => {
        const converted = convertTaskSchedule(
          task.date,
          task.time,
          task.timeZone || systemTz,
          displayTimeZone
        )
        return {
          task,
          displayDate: converted.date,
          displayTime: converted.time
        }
      })
      .filter((entry) => entry.displayDate === today)
      .sort((a, b) => {
        if (a.task.done !== b.task.done) return a.task.done ? 1 : -1
        if (a.displayTime && b.displayTime) return a.displayTime.localeCompare(b.displayTime)
        if (a.displayTime) return -1
        if (b.displayTime) return 1
        return order[a.task.priority] - order[b.task.priority]
      })
  }, [state.tasks, systemTz, displayTimeZone, today])

  const doneCount = tasks.filter((entry) => entry.task.done).length
  const openCount = tasks.length - doneCount

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!draft.trim()) return
    addTask({ title: draft, date: today })
    setDraft('')
  }

  return (
    <article className="card tasks-card">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Today</span>
          <h2 className="card-title">
            {openCount > 0 ? `${openCount} things left` : tasks.length ? 'All clear' : 'A fresh page'}
          </h2>
        </div>
        <button className="icon-button subtle" onClick={() => openPlanner(today)} title="Open planner">
          <CalendarDays size={14} />
        </button>
      </div>

      <div className="today-tasks">
        {tasks.length === 0 && (
          <div className="empty-mini">
            <Sparkles size={17} />
            <span>Nothing on the docket. Add one small thing.</span>
          </div>
        )}
        {tasks.slice(0, 4).map((entry) => (
          <TaskRow
            key={entry.task.id}
            task={entry.task}
            displayDate={entry.displayDate}
            displayTime={entry.displayTime}
            displayTimeZone={displayTimeZone}
            onToggle={() => toggleTask(entry.task.id)}
          />
        ))}
        {tasks.length > 4 && <span className="more-tasks">+{tasks.length - 4} more in Plan</span>}
      </div>

      <form className="quick-add" onSubmit={submit}>
        <Plus size={14} />
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add a task for today…"
          aria-label="Add a task for today"
        />
        {draft && <button type="submit">Add</button>}
      </form>
    </article>
  )
}

function TaskRow({
  task,
  displayDate,
  displayTime,
  displayTimeZone,
  onToggle
}: {
  task: Task
  displayDate: string
  displayTime?: string
  displayTimeZone: string
  onToggle: () => void
}) {
  return (
    <div className={`task-row ${task.done ? 'is-done' : ''}`}>
      <button className="task-check" onClick={onToggle} aria-label={task.done ? 'Mark incomplete' : 'Mark complete'}>
        {task.done && <Check size={11} strokeWidth={3} />}
      </button>
      <span className={`priority-dot ${task.priority}`} />
      <span className="task-title">{task.title}</span>
      {displayTime && (
        <span className="task-time">
          <Clock3 size={10} />
          {formatTaskClock(displayDate, displayTime, displayTimeZone, true)}
        </span>
      )}
    </div>
  )
}

function ObsidianCard() {
  const { state, openNote, vaultRevision, showToast } = useApp()
  const { chooseVault } = useVaultPicker()
  const [tree, setTree] = useState<VaultNode[]>([])
  const [loading, setLoading] = useState(false)
  const vaultPath = state.settings.vaultPath

  useEffect(() => {
    let alive = true
    if (!vaultPath) {
      setTree([])
      return
    }
    setLoading(true)
    void window.notch.obsidian
      .tree(vaultPath)
      .then((next) => {
        if (alive) setTree(next)
      })
      .catch(() => {
        if (alive) setTree([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [vaultPath, vaultRevision])

  const { files, folders } = useMemo(() => {
    const collected: { path: string; name: string; modified: number }[] = []
    let folderCount = 0
    const walk = (nodes: VaultNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'folder') {
          folderCount += 1
          walk(node.children || [])
        } else if (node.ext === '.md' || node.ext === '.markdown') {
          collected.push({ path: node.path, name: node.name.replace(/\.md$/i, ''), modified: node.modified || 0 })
        }
      }
    }
    walk(tree)
    collected.sort((a, b) => b.modified - a.modified)
    return { files: collected, folders: folderCount }
  }, [tree])

  const vaultName = vaultPath?.split(/[\\/]/).filter(Boolean).pop()

  return (
    <article className="card obsidian-card">
      <div className="card-heading">
        <div>
          <span className="eyebrow">
            <span className="obsidian-spark" />
            Notes
          </span>
          <h2 className="card-title">{vaultName || 'Your notes'}</h2>
        </div>
        {vaultPath && (
          <button className="icon-button subtle" onClick={() => openNote(state.notes.lastPath || files[0]?.path || '')} title="Open notes">
            <ArrowUpRight size={14} />
          </button>
        )}
      </div>

      {!vaultPath ? (
        <div className="vault-empty">
          <div className="vault-stack" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <p>Open a folder of notes. Read, write and create without breaking flow.</p>
          <button className="soft-button" onClick={() => void chooseVault()}>
            <FolderOpen size={13} />
            Open folder
          </button>
        </div>
      ) : (
        <div className="recent-notes">
          {loading && <span className="loading-line">Reading folder…</span>}
          {!loading && files.length === 0 && (
            <button
              className="soft-button"
              onClick={() => {
                openNote('')
                showToast('Folder is empty', 'Create your first note in the Notes tab.', 'default')
              }}
            >
              <Plus size={13} />
              Create first note
            </button>
          )}
          {files.slice(0, 3).map((file) => (
            <button key={file.path} className="recent-note" onClick={() => openNote(file.path)}>
              <FileText size={13} />
              <span className="recent-note-name">{file.name}</span>
              <span className="recent-note-folder">{file.path.split('/').slice(0, -1).join('/') || 'Root'}</span>
              <ChevronRight size={12} />
            </button>
          ))}
          {files.length > 0 && (
            <span className="vault-meta">
              {files.length} notes · {folders} folders
            </span>
          )}
        </div>
      )}
    </article>
  )
}

function SessionsCard() {
  const { sessions, sessionsLoading, refreshSessions, setPage, expanded } = useApp()
  const now = useNowWhen(expanded)
  const active = sessions?.sessions.filter((session) => session.active && !session.subagent) || []
  const recent = sessions?.sessions.filter((session) => !session.active && !session.subagent) || []
  const subagents = sessions?.sessions.filter((session) => session.subagent) || []
  const preview = [...active, ...recent, ...subagents].slice(0, 2)
  const apps = sessions?.apps.slice(0, 3) || []
  const running = sessions?.apps.filter((app) => app.running).length || 0

  return (
    <article className="card sessions-card" onClick={() => setPage('sessions')}>
      <div className="card-heading">
        <div>
          <span className="eyebrow">
            <span className={`live-dot ${active.length ? 'is-live' : ''}`} />
            Coding sessions
          </span>
          <h2 className="card-title">
            {active.length > 0 ? `${active.length} live right now` : 'Local agent activity'}
          </h2>
        </div>
        <button
          className="icon-button subtle"
          onClick={(event) => {
            event.stopPropagation()
            void refreshSessions()
          }}
          title="Refresh sessions"
        >
          <RefreshCw size={13} className={sessionsLoading ? 'spin' : ''} />
        </button>
      </div>

      <div className="session-apps">
        {apps.map((app) => (
          <span key={app.provider} className={`session-app-chip ${app.running ? 'is-running' : ''}`}>
            <i />
            {app.label}
          </span>
        ))}
        {apps.length === 0 && (
          <span className="session-app-chip">{sessions?.error ? 'Unavailable' : 'Scanning…'}</span>
        )}
      </div>

      <div className="session-preview">
        {preview.length === 0 && (
          <div className="session-empty">
            <SquareTerminal size={17} />
            <span>
              {sessions?.error
                ? 'Session scan failed. Open Sessions to refresh.'
                : running > 0
                  ? 'An app is open, but no conversation was found yet.'
                  : 'No coding sessions found. Open Codex, OpenCode or Anti Gravity.'}
            </span>
          </div>
        )}
        {preview.map((session) => (
          <div className="session-preview-row" key={session.id}>
            <SessionBadge provider={session.provider} size={26} />
            <span className="session-preview-copy">
              <strong>{session.title}</strong>
              <small>
                {session.project || 'workspace'}
                {session.origin ? ` · ${session.origin}` : ''}
              </small>
            </span>
            {session.active ? (
              <span className="session-live">live</span>
            ) : (
              <span className="session-preview-time">{relativeSessionTime(session.updatedAt, now)}</span>
            )}
          </div>
        ))}
      </div>

      <div className="session-card-foot">
        <span>
          <Bot size={11} /> {running} apps running
        </span>
        <span>
          Open sessions <ChevronRight size={11} />
        </span>
      </div>
    </article>
  )
}

function CalendarCard() {
  const { state, openPlanner } = useApp()
  const [viewDate, setViewDate] = useState(() => new Date())
  const month = viewDate.getMonth()
  const year = viewDate.getFullYear()
  const weeks = useMemo(() => monthMatrix(year, month), [year, month])
  const tasksByDate = useMemo(() => {
    const map = new Map<string, number>()
    for (const task of state.tasks) {
      if (task.done) continue
      const key = task.date
      map.set(key, (map.get(key) || 0) + 1)
    }
    return map
  }, [state.tasks])
  const today = todayKey()
  const nextTask = state.tasks
    .filter((task) => !task.done && task.date >= today)
    .filter((task) => {
      if (task.date !== today || !task.time) return true
      const at = timeToTimestamp(task.date, task.time)
      return at === null || at >= Date.now()
    })
    .sort((a, b) => `${a.date}${a.time || '99:99'}`.localeCompare(`${b.date}${b.time || '99:99'}`))[0]

  return (
    <article className="card calendar-card">
      <div className="card-heading">
        <span className="eyebrow">Calendar</span>
        <div className="calendar-nav">
          <button
            onClick={() => setViewDate((value) => new Date(value.getFullYear(), value.getMonth() - 1, 1))}
            aria-label="Previous month"
          >
            <ChevronRight size={12} className="flip" />
          </button>
          <span>
            {viewDate.toLocaleDateString([], { month: 'long', year: year !== new Date().getFullYear() ? 'numeric' : undefined })}
          </span>
          <button
            onClick={() => setViewDate((value) => new Date(value.getFullYear(), value.getMonth() + 1, 1))}
            aria-label="Next month"
          >
            <ChevronRight size={12} />
          </button>
        </div>
      </div>

      <div className="mini-calendar">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => (
          <span key={`${day}-${index}`} className="weekday">
            {day}
          </span>
        ))}
        {weeks.flat().map((date, index) => {
          if (!date) return <span key={`empty-${index}`} />
          const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
          const count = tasksByDate.get(key) || 0
          return (
            <button
              key={key}
              className={`calendar-day ${key === today ? 'is-today' : ''} ${date.getMonth() !== month ? 'is-muted' : ''}`}
              onClick={() => openPlanner(key)}
              title={count ? `${count} open task${count === 1 ? '' : 's'}` : formatDateShort(key)}
            >
              {date.getDate()}
              {count > 0 && <span className="calendar-dot" />}
            </button>
          )
        })}
      </div>

      <button className="next-up" onClick={() => openPlanner(nextTask?.date || today)}>
        <span className="next-up-label">Next up</span>
        <span className="next-up-title">{nextTask ? nextTask.title : 'Nothing scheduled'}</span>
        <span className="next-up-time">
          {nextTask ? (nextTask.date === today ? nextTask.time || 'Today' : formatDateShort(nextTask.date)) : 'Free'}
        </span>
      </button>
    </article>
  )
}

function PostureCard() {
  const { setPage } = useApp()
  const posture = usePosture()
  const total = posture.goodSeconds + posture.badSeconds
  const goodPercent = total > 0 ? Math.round((posture.goodSeconds / total) * 100) : 0
  const score = posture.score ?? 0
  const hasScore = posture.status === 'running' && posture.score !== null
  const color = hasScore
    ? score >= posture.threshold
      ? '#4ade80'
      : score >= posture.threshold - 12
        ? '#fbbf24'
        : '#f87171'
    : 'var(--accent)'
  const word = hasScore
    ? score >= posture.threshold
      ? 'Good'
      : score >= posture.threshold - 12
        ? 'Getting bent'
        : 'Bad'
    : ''

  return (
    <article className="card posture-card" onClick={() => setPage('posture')}>
      <div className="card-heading">
        <span className="eyebrow">
          <span className={`live-dot ${posture.enabled && hasScore ? 'is-live' : ''}`} />
          Posture
        </span>
        <span className="mini-badge">
          <PersonStanding size={11} />
          {posture.enabled
            ? hasScore
              ? `${word} · ${score}`
              : posture.status === 'away'
                ? 'Paused'
                : 'Camera on'
            : 'Camera off'}
        </span>
      </div>

      <div className="posture-card-body">
        <div className="posture-card-ring" style={{ '--score-color': color } as CSSProperties}>
          <ProgressRing
            progress={(hasScore ? score : total > 0 ? goodPercent : 0) / 100}
            size={84}
            stroke={6}
            color={color}
            track="rgba(255,255,255,.08)"
          >
            <strong>{hasScore ? score : total > 0 ? `${goodPercent}%` : '—'}</strong>
            <span>{hasScore ? 'score' : total > 0 ? 'good' : 'idle'}</span>
          </ProgressRing>
        </div>

        <div className="posture-card-info">
          <h2>
            {!posture.enabled
              ? 'Posture coach'
              : hasScore
                ? score >= posture.threshold
                  ? 'Sitting tall'
                  : score >= posture.threshold - 12
                    ? 'Getting bent'
                    : 'Sit up straight'
                : posture.status === 'away'
                  ? 'Paused while away'
                  : 'Finding your seat…'}
          </h2>
          <p>
            {!posture.enabled
              ? 'Private on-device alignment coach. No frames stored.'
              : posture.metrics?.advice ||
                (total > 0
                  ? `${goodPercent}% good alignment logged today.`
                  : 'Keep your head and shoulders in view to start scoring.')}
          </p>

          <div className="posture-day-track" aria-hidden="true">
            {total > 0 && (
              <>
                <span className="is-good" style={{ width: `${goodPercent}%` }} />
                <span className="is-bad" style={{ width: `${100 - goodPercent}%` }} />
              </>
            )}
          </div>
          <div className="seek-times">
            <span>{formatMinutes(Math.round(posture.goodSeconds / 60))} good</span>
            <span>{formatMinutes(Math.round(posture.badSeconds / 60))} bad</span>
          </div>

          <div className="posture-card-controls">
            <button
              type="button"
              className="soft-button compact"
              onClick={(event) => {
                event.stopPropagation()
                if (posture.enabled) posture.disable()
                else posture.enable()
              }}
            >
              {posture.enabled ? <CameraOff size={12} /> : <Camera size={12} />}
              {posture.enabled ? 'Turn off' : 'Turn on'}
            </button>
            <span className="music-open">
              Open posture <ArrowUpRight size={11} />
            </span>
          </div>
        </div>
      </div>
    </article>
  )
}

export function Dashboard() {
  const { state, updateSettings, showToast } = useApp()
  const { editing, setEditing } = useHomeEdit()
  const [dragId, setDragId] = useState<HomeCardId | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const vaultName = state.settings.vaultPath?.split(/[\\/]/).filter(Boolean).pop()
  const avail = (id: HomeCardId): boolean => homeCardAvailable(state, id)
  const layout = homeLayoutFor(state)
  const shown = shownHomeCards(layout, avail)
  const availableCards = HOME_CARD_IDS.filter(avail)
  const shownSet = new Set(shown)
  const columns = homeGridColumns(shown.length)
  const glasses = shown.includes('water') ? waterCount(state.water) : null

  const cards: Record<HomeCardId, ReactNode> = {
    timer: <TimerCard />,
    music: <MusicCard />,
    tasks: <TasksCard />,
    notes: <ObsidianCard />,
    sessions: <SessionsCard />,
    calendar: <CalendarCard />,
    water: <WaterCard />,
    posture: <PostureCard />,
    phone: <PhoneTransfer />
  }

  const isDefault = homeLayoutEqual(layout, defaultHomeLayout())

  const applyCount = (count: number): void => {
    const next = setHomeCardCount(layout, count, avail)
    const nextShown = shownHomeCards(next, avail)
    updateSettings({ homeLayout: next })
    showToast(
      `Home · ${nextShown.length} sections`,
      `Showing ${nextShown.length} sections in a ${homeGridColumns(nextShown.length)}-column layout.`,
      'success'
    )
  }

  const handleToggleCard = (id: HomeCardId): void => {
    const meta = HOME_CARD_META[id]
    const next = toggleHomeCard(layout, id, avail)
    if (!next) {
      showToast('Keep one section', 'At least one section stays on the home panel.')
      return
    }
    const nextShown = shownHomeCards(next, avail)
    const added = nextShown.includes(id)
    updateSettings({ homeLayout: next })
    showToast(
      added ? `${meta.label} added to Home` : `${meta.label} removed from Home`,
      added
        ? `Home now shows ${nextShown.length} sections.`
        : 'You can add it back anytime while customizing Home.',
      'success'
    )
  }

  const handleRemoveCard = (id: HomeCardId): void => {
    const meta = HOME_CARD_META[id]
    const next = removeHomeCard(layout, id, avail)
    if (!next) {
      showToast('Keep one section', 'At least one section stays on the home panel.')
      return
    }
    updateSettings({ homeLayout: next })
    showToast(
      `${meta.label} removed from Home`,
      'Click its pill in the Customize bar anytime to add it back.',
      'success'
    )
  }

  const moveVisibleCard = (id: HomeCardId, toIndex: number): void => {
    const nextShown = moveHomeCard(shown, id, toIndex)
    updateSettings({
      homeLayout: reorderHomeCards(layout, nextShown)
    })
    setDragId(null)
    setOverIndex(null)
  }

  const resetLayout = (): void => {
    updateSettings({
      homeLayout: {
        order: [...HOME_CARD_IDS],
        hidden: [...DEFAULT_HOME_HIDDEN]
      }
    })
    setDragId(null)
    setOverIndex(null)
    showToast('Home reset', 'Back to the default six sections.', 'success')
  }

  const gridClass =
    shown.length === 1
      ? 'is-grid-1'
      : shown.length === 2
        ? 'is-grid-2'
        : shown.length === 3
          ? 'is-grid-3'
          : shown.length === 4
            ? 'is-grid-4'
            : shown.length === 5
              ? 'is-grid-5'
              : shown.length === 6
                ? 'is-grid-6'
                : 'is-grid-many'

  return (
    <div className={`home-shell ${editing ? 'is-editing' : ''}`}>
      {editing && (
        <div className="home-toolbar" role="region" aria-label="Personalize Home sections">
          <div className="home-preset-group" role="group" aria-label="Section count presets">
            <span className="home-toolbar-label">Layout</span>
            {([2, 4, 6] as const)
              .filter((count) => count <= availableCards.length)
              .map((count) => (
                <button
                  key={count}
                  type="button"
                  data-home-preset={count}
                  className={`home-preset-pill ${shown.length === count ? 'is-active' : ''}`}
                  onClick={() => applyCount(count)}
                  aria-pressed={shown.length === count}
                  title={`Show ${count} sections on Home`}
                >
                  {count}
                </button>
              ))}
            {shown.length !== 2 && shown.length !== 4 && shown.length !== 6 && (
              <span className="home-preset-custom" title={`${shown.length} sections on Home`}>
                {shown.length}
              </span>
            )}
          </div>

          <div className="home-section-pills" role="group" aria-label="Available sections for Home">
            {availableCards.map((id) => {
              const meta = HOME_CARD_META[id]
              const Icon = meta.icon
              const on = shownSet.has(id)
              return (
                <button
                  key={id}
                  type="button"
                  data-home-section-pill={id}
                  className={`home-section-pill ${on ? 'is-on' : 'is-off'}`}
                  onClick={() => handleToggleCard(id)}
                  aria-pressed={on}
                  title={
                    on
                      ? `${meta.label} is on Home — click to remove`
                      : `Add ${meta.label} to Home — ${meta.note}`
                  }
                >
                  {!on && <Plus size={10} className="home-pill-state" />}
                  <Icon size={11} />
                  <span>{meta.shortLabel}</span>
                  {on && <X size={10} className="home-pill-state is-remove" />}
                </button>
              )
            })}
          </div>

          <div className="home-toolbar-actions">
            {!isDefault && (
              <button
                type="button"
                data-home-reset="true"
                className="home-action-pill"
                onClick={resetLayout}
                title="Reset Home to the default six sections"
              >
                <RotateCcw size={11} />
                <span>Reset</span>
              </button>
            )}
            <button
              type="button"
              className="home-action-pill is-active"
              onClick={() => setEditing(false)}
              title="Finish editing Home cards"
            >
              <Check size={11} />
              <span>Done</span>
            </button>
          </div>
        </div>
      )}

      <div
        className={`dashboard ${gridClass} ${!isDefault ? 'is-custom-layout' : ''}`}
        data-card-count={shown.length}
        data-grid-cols={columns}
      >
        <p className="dashboard-sr">
          {greeting()}. {shown.includes('notes') ? (vaultName ? `${vaultName} folder connected.` : 'No notes folder connected.') : ''}
          {glasses !== null ? ` Water, ${glasses} of ${state.water.goalGlasses} glasses.` : ''}
        </p>
        {shown.map((id, index) => {
          const meta = HOME_CARD_META[id]
          return (
            <div
              key={id}
              data-home-card={id}
              className={`home-card-slot ${dragId === id ? 'is-dragging' : ''} ${
                overIndex === index && dragId !== id ? 'is-over' : ''
              }`}
              onDragOver={(event) => {
                if (!editing || !dragId) return
                event.preventDefault()
                if (overIndex !== index) setOverIndex(index)
              }}
              onDrop={(event) => {
                if (!editing || !dragId) return
                event.preventDefault()
                moveVisibleCard(dragId, index)
              }}
            >
              {editing && (
                <div className="home-card-edit-bar">
                  <button
                    type="button"
                    className="home-card-drag"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', id)
                      setDragId(id)
                    }}
                    onDragEnd={() => {
                      setDragId(null)
                      setOverIndex(null)
                    }}
                    title="Drag to move this card"
                  >
                    <GripVertical size={12} />
                    <span>{homeSlotLabel(index, shown.length)}</span>
                  </button>
                  <div className="home-card-edit-controls">
                    <button
                      type="button"
                      className="home-card-step"
                      disabled={index === 0}
                      onClick={() => moveVisibleCard(id, index - 1)}
                      aria-label={`Move ${meta.label} earlier`}
                      title="Move earlier"
                    >
                      <ArrowLeft size={11} />
                    </button>
                    <button
                      type="button"
                      className="home-card-step"
                      disabled={index === shown.length - 1}
                      onClick={() => moveVisibleCard(id, index + 1)}
                      aria-label={`Move ${meta.label} later`}
                      title="Move later"
                    >
                      <ArrowRight size={11} />
                    </button>
                    <button
                      type="button"
                      data-home-card-remove={id}
                      className="home-card-remove"
                      disabled={shown.length <= 1}
                      onClick={() => handleRemoveCard(id)}
                      aria-label={`Remove ${meta.label} from Home`}
                      title={
                        shown.length <= 1
                          ? 'At least one section stays on Home'
                          : `Remove ${meta.label} from Home`
                      }
                    >
                      <X size={11} />
                      <span>Remove</span>
                    </button>
                  </div>
                </div>
              )}
              {cards[id]}
            </div>
          )
        })}
      </div>
    </div>
  )
}
