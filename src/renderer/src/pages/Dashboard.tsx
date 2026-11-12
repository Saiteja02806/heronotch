import {
  ArrowUpRight,
  Bot,
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  FileText,
  Flame,
  FolderOpen,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  SkipBack,
  SkipForward,
  Sparkles,
  SquareTerminal
} from 'lucide-react'
import { motion } from 'framer-motion'
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { Task, VaultNode } from '../../../shared/types'
import {
  formatDateShort,
  formatDuration,
  formatTimer,
  greeting,
  monthMatrix,
  timeToTimestamp,
  todayKey
} from '../lib/time'
import { useApp } from '../state/AppContext'
import { useMedia } from '../state/MediaContext'
import { SessionBadge, relativeSessionTime } from '../components/SessionBits'
import { useVaultPicker } from '../hooks/useVaultPicker'

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
  const hue = useMemo(() => {
    let hash = 0
    for (let index = 0; index < seed.length; index += 1) hash = seed.charCodeAt(index) + ((hash << 5) - hash)
    return Math.abs(hash) % 360
  }, [seed])

  return (
    <div
      className={`artwork ${className}`}
      style={{
        width: size,
        height: size,
        background: image
          ? undefined
          : `radial-gradient(circle at 25% 20%, hsl(${hue} 70% 62%), transparent 55%),
             radial-gradient(circle at 78% 72%, hsl(${(hue + 70) % 360} 65% 42%), transparent 58%),
             linear-gradient(145deg, hsl(${(hue + 20) % 360} 40% 20%), #0d0e10)`
      }}
    >
      {image ? <img src={image} alt="" /> : <Music2 size={size ? Math.max(16, size * 0.24) : 24} />}
    </div>
  )
}

function TimerCard() {
  const {
    state,
    timerRemaining,
    timerProgress,
    startTimer,
    pauseTimer,
    resetTimer,
    setTimerMode
  } = useApp()
  const timer = state.timer
  const total = timer.durations[timer.mode] * 60
  const label = timer.mode === 'focus' ? 'Focus' : timer.mode === 'short' ? 'Short break' : 'Long break'
  const ringProgress = Math.max(0, Math.min(1, timerRemaining / Math.max(1, total)))
  const running = timer.running

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
        style={{ '--ring-progress': `${ringProgress * 360}deg` } as CSSProperties}
        onClick={() => (running ? pauseTimer() : startTimer())}
        aria-label={running ? 'Pause timer' : 'Start timer'}
      >
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
            {mode === 'focus' ? 'Focus' : mode === 'short' ? 'Short' : 'Long'}
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
        <span className="timer-length">{timer.durations[timer.mode]} min</span>
      </div>
    </article>
  )
}

function MusicCard() {
  const { setPage, showToast } = useApp()
  const { status, playback, queue, togglePlay, action, progressMs, pending } = useMedia()
  const track = playback?.track
  const connected = Boolean(status?.connected || status?.localAvailable)
  const duration = track?.duration || 0
  const elapsed = duration ? Math.min(progressMs, duration) : progressMs
  const progress = duration ? Math.min(1, elapsed / duration) : 0
  const changing = pending === 'next' || pending === 'previous'

  const play = (event: ReactMouseEvent): void => {
    event.stopPropagation()
    if (!connected || !track) {
      setPage('music')
      if (!connected) showToast('Spotify is not connected', 'Open Music to sign in.')
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
          Now playing
        </span>
        <span className="mini-badge">
          <Music2 size={11} />
          {connected ? playback?.device?.name || 'Spotify' : 'Offline'}
        </span>
      </div>

      <div className="music-body">
        <Artwork image={track?.image} seed={track?.id || 'notch'} size={132} className="music-art" />
        <div className={`music-info ${changing ? 'is-changing' : ''}`}>
          <h2>{track?.name || (connected ? 'Nothing playing' : 'Make room for music')}</h2>
          <p>
            {track?.artists ||
              (connected
                ? 'Start a track in Spotify and it will show up here.'
                : 'Connect Spotify to control playback without leaving your notch.')}
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
            <button className="control-button" onClick={skip('previous')} aria-label="Previous track">
              <SkipBack size={15} fill="currentColor" />
            </button>
            <button className="control-button is-primary" onClick={play} aria-label={playback?.playing ? 'Pause' : 'Play'}>
              {playback?.playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
            </button>
            <button className="control-button" onClick={skip('next')} aria-label="Next track">
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
  const today = todayKey()
  const tasks = useMemo(() => {
    const order = { high: 0, normal: 1, low: 2 } as const
    return state.tasks
      .filter((task) => task.date === today)
      .sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1
        if (a.time && b.time) return a.time.localeCompare(b.time)
        if (a.time) return -1
        if (b.time) return 1
        return order[a.priority] - order[b.priority]
      })
  }, [state.tasks, today])

  const doneCount = tasks.filter((task) => task.done).length
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
        {tasks.slice(0, 4).map((task) => (
          <TaskRow key={task.id} task={task} onToggle={() => toggleTask(task.id)} />
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

function TaskRow({ task, onToggle }: { task: Task; onToggle: () => void }) {
  return (
    <div className={`task-row ${task.done ? 'is-done' : ''}`}>
      <button className="task-check" onClick={onToggle} aria-label={task.done ? 'Mark incomplete' : 'Mark complete'}>
        {task.done && <Check size={11} strokeWidth={3} />}
      </button>
      <span className={`priority-dot ${task.priority}`} />
      <span className="task-title">{task.title}</span>
      {task.time && (
        <span className="task-time">
          <Clock3 size={10} />
          {task.time}
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
            Obsidian
          </span>
          <h2 className="card-title">{vaultName || 'Your second brain'}</h2>
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
          <p>Point Notch at your vault. Read, write and create notes without breaking flow.</p>
          <button className="soft-button" onClick={() => void chooseVault()}>
            <FolderOpen size={13} />
            Choose vault
          </button>
        </div>
      ) : (
        <div className="recent-notes">
          {loading && <span className="loading-line">Reading vault…</span>}
          {!loading && files.length === 0 && (
            <button
              className="soft-button"
              onClick={() => {
                openNote('')
                showToast('Vault is empty', 'Create your first note in the Notes tab.', 'default')
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
              <span className="recent-note-folder">{file.path.split('/').slice(0, -1).join('/') || 'Vault'}</span>
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
  const { sessions, sessionsLoading, refreshSessions, setPage, now } = useApp()
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
        {apps.length === 0 && <span className="session-app-chip">Scanning…</span>}
      </div>

      <div className="session-preview">
        {preview.length === 0 && (
          <div className="session-empty">
            <SquareTerminal size={17} />
            <span>No coding sessions found. Open Codex, OpenCode or Anti Gravity.</span>
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

export function Dashboard() {
  const { state } = useApp()
  const vaultName = state.settings.vaultPath?.split(/[\\/]/).filter(Boolean).pop()
  return (
    <div className="dashboard">
      <div className="dashboard-sr">
        {greeting()}. {vaultName ? `${vaultName} vault connected.` : 'No vault connected.'}
      </div>
      <TimerCard />
      <MusicCard />
      <TasksCard />
      <ObsidianCard />
      <SessionsCard />
      <CalendarCard />
    </div>
  )
}
