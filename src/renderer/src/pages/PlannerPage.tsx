import {
  Bell,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ListTodo,
  Plus,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import { motion } from 'framer-motion'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Task, TaskPriority } from '../../../shared/types'
import {
  addDays,
  dateKey,
  formatDateLong,
  formatDateShort,
  formatTime,
  monthMatrix,
  parseDateKey,
  timeToTimestamp,
  todayKey
} from '../lib/time'
import { useApp } from '../state/AppContext'
import { useNow } from '../state/clock'

interface EditorState {
  task?: Task
  date: string
}

function reminderOffset(task: Task): string {
  if (!task.remindAt || !task.time) return 'none'
  const at = timeToTimestamp(task.date, task.time)
  if (!at) return 'none'
  const minutes = Math.round((at - task.remindAt) / 60000)
  return [0, 5, 10, 30, 60].includes(minutes) ? String(minutes) : 'none'
}

function TaskEditor({
  open,
  editor,
  onClose
}: {
  open: boolean
  editor: EditorState | null
  onClose: () => void
}) {
  const { addTask, patchTask, deleteTask, showToast } = useApp()
  const task = editor?.task
  const [title, setTitle] = useState(task?.title || '')
  const [notes, setNotes] = useState(task?.notes || '')
  const [date, setDate] = useState(editor?.date || todayKey())
  const [time, setTime] = useState(task?.time || '')
  const [priority, setPriority] = useState<TaskPriority>(task?.priority || 'normal')
  const [reminder, setReminder] = useState(reminderOffset(task || ({} as Task)))
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setTitle(task?.title || '')
    setNotes(task?.notes || '')
    setDate(editor?.date || task?.date || todayKey())
    setTime(task?.time || '')
    setPriority(task?.priority || 'normal')
    setReminder(task ? reminderOffset(task) : 'none')
    setError('')
  }, [open, editor, task])

  if (!open) return null

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!title.trim()) {
      setError('Give the task a name.')
      return
    }
    const at = timeToTimestamp(date, time)
    const remindAt = reminder !== 'none' && at ? at - Number(reminder) * 60000 : null
    if (task) {
      patchTask(task.id, {
        title: title.trim(),
        notes: notes.trim() || undefined,
        date,
        time: time || undefined,
        priority,
        remindAt,
        notifiedAt: null
      })
    } else {
      addTask({
        title,
        notes,
        date,
        time: time || undefined,
        priority,
        remindAt
      })
    }
    if (remindAt && remindAt > Date.now()) {
      const day = date === todayKey() ? 'Today' : formatDateShort(date)
      showToast(
        'Reminder set',
        `${title.trim()} · ${day} at ${formatTime(remindAt)}`,
        'success'
      )
    }
    onClose()
  }

  return (
    <form className="task-editor" onSubmit={submit}>
      <span className="eyebrow">{task ? 'Edit task' : 'New task'}</span>
      <input
        className="task-editor-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="What needs doing?"
        autoFocus
      />
      <textarea
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        placeholder="Notes, links, a little context…"
        rows={2}
      />
      <div className="task-editor-grid">
        <label>
          <span>Date</span>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
        <label>
          <span>Time</span>
          <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
        </label>
      </div>
      <div className="task-editor-grid">
        <label>
          <span>Priority</span>
          <div className="priority-picker">
            {(['low', 'normal', 'high'] as TaskPriority[]).map((level) => (
              <button
                type="button"
                key={level}
                className={priority === level ? 'is-active' : ''}
                onClick={() => setPriority(level)}
              >
                {level}
              </button>
            ))}
          </div>
        </label>
        <label>
          <span>Reminder</span>
          <select
            value={reminder}
            onChange={(event) => setReminder(event.target.value)}
            disabled={!time}
            title={time ? undefined : 'Add a time to enable reminders'}
          >
            <option value="none">No reminder</option>
            <option value="0">At task time</option>
            <option value="5">5 minutes before</option>
            <option value="10">10 minutes before</option>
            <option value="30">30 minutes before</option>
            <option value="60">1 hour before</option>
          </select>
        </label>
      </div>
      {error && <span className="form-error">{error}</span>}
      <div className="modal-actions">
        {task && (
          <button
            type="button"
            className="danger-text link-button"
            onClick={() => {
              deleteTask(task.id)
              onClose()
            }}
          >
            <Trash2 size={12} /> Delete
          </button>
        )}
        <span className="modal-spacer" />
        <button type="button" className="soft-button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary-button">
          {task ? 'Save changes' : 'Add task'}
        </button>
      </div>
    </form>
  )
}

export function PlannerPage() {
  const {
    state,
    plannerDate,
    setPlannerDate,
    toggleTask,
    deleteTask,
    addTask
  } = useApp()
  const now = useNow()
  const selected = parseDateKey(plannerDate)
  const [view, setView] = useState({ year: selected.getFullYear(), month: selected.getMonth() })
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [quickTitle, setQuickTitle] = useState('')
  const [quickTime, setQuickTime] = useState('')

  useEffect(() => {
    const target = parseDateKey(plannerDate)
    setView({ year: target.getFullYear(), month: target.getMonth() })
  }, [plannerDate])

  const weeks = useMemo(() => monthMatrix(view.year, view.month), [view])
  const tasksByDate = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const task of state.tasks) {
      const list = map.get(task.date) || []
      list.push(task)
      map.set(task.date, list)
    }
    return map
  }, [state.tasks])

  const dayTasks = useMemo(() => {
    const tasks = (tasksByDate.get(plannerDate) || []).slice()
    return tasks.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      if (a.time && b.time) return a.time.localeCompare(b.time)
      if (a.time) return -1
      if (b.time) return 1
      return b.createdAt - a.createdAt
    })
  }, [tasksByDate, plannerDate])

  const openTasks = dayTasks.filter((task) => !task.done)
  const doneTasks = dayTasks.filter((task) => task.done)
  const reminders = useMemo(() => {
    const open = state.tasks.filter((task) => !task.done && task.remindAt)
    const upcoming = open
      .filter((task) => (task.remindAt || 0) >= now)
      .sort((a, b) => (a.remindAt || 0) - (b.remindAt || 0))
    const overdue = open
      .filter((task) => (task.remindAt || 0) < now)
      .sort((a, b) => (b.remindAt || 0) - (a.remindAt || 0))
    return [...upcoming, ...overdue].slice(0, 5)
  }, [state.tasks, now])
  const today = todayKey()
  const upcoming = useMemo(() => {
    const sortKey = (task: Task): string => `${task.date}T${task.time || '99:99'}`
    const open = state.tasks.filter((task) => !task.done && task.date !== plannerDate)
    const overdue = open
      .filter((task) => task.date < today)
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    const later = open
      .filter((task) => task.date >= today)
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    return [...overdue, ...later].slice(0, 4)
  }, [state.tasks, plannerDate, today])
  const focusMinutes = state.focusLog
    .filter((session) => dateKey(new Date(session.at)) === plannerDate)
    .reduce((sum, session) => sum + session.minutes, 0)
  const doneCount = doneTasks.length
  const monthLabel = new Date(view.year, view.month, 1).toLocaleDateString([], {
    month: 'long',
    year: 'numeric'
  })


  const stepDay = (amount: number): void => {
    setPlannerDate(addDays(plannerDate, amount))
  }

  const shiftMonth = (amount: number): void => {
    const next = new Date(view.year, view.month + amount, 1)
    setView({ year: next.getFullYear(), month: next.getMonth() })
  }

  const quickAdd = (event: FormEvent): void => {
    event.preventDefault()
    if (!quickTitle.trim()) return
    const at = timeToTimestamp(plannerDate, quickTime)
    const reminder = at ? at - 5 * 60 * 1000 : null
    addTask({
      title: quickTitle,
      date: plannerDate,
      time: quickTime || undefined,
      remindAt: reminder && reminder > Date.now() ? reminder : null
    })
    setQuickTitle('')
    setQuickTime('')
  }

  const monthTasks = (date: Date): number => {
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    return (tasksByDate.get(key) || []).filter((task) => !task.done).length
  }

  return (
    <div className="planner-page">
      <section className="calendar-panel">
        <div className="calendar-panel-head">
          <div>
            <span className="eyebrow">Calendar</span>
            <h2>{monthLabel}</h2>
          </div>
          <div className="month-nav">
            <button onClick={() => shiftMonth(-1)}>
              <ChevronLeft size={13} />
            </button>
            <button onClick={() => shiftMonth(1)}>
              <ChevronRight size={13} />
            </button>
          </div>
        </div>

        <div className="month-grid">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
            <span key={day} className="month-weekday">{day.slice(0, 1)}</span>
          ))}
          {weeks.flat().map((date, index) => {
            if (!date) return <span key={`blank-${index}`} className="month-blank" />
            const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
            const count = monthTasks(date)
            return (
              <button
                key={key}
                className={`month-day ${key === plannerDate ? 'is-selected' : ''} ${key === todayKey() ? 'is-today' : ''}`}
                onClick={() => setPlannerDate(key)}
              >
                <span>{date.getDate()}</span>
                {count > 0 && (
                  <span className="month-dots">
                    {Array.from({ length: Math.min(count, 3) }).map((_, dot) => <i key={dot} />)}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <div className="selected-day-card">
          <div className="selected-day-top">
            <span className="eyebrow">Selected day</span>
            <span className="day-pill">{openTasks.length} open</span>
          </div>
          <strong>{formatDateLong(plannerDate)}</strong>
          <p>
            {doneTasks.length} done · {openTasks.length} to go
          </p>
          <button
            className="soft-button compact"
            onClick={() => setPlannerDate(todayKey())}
            disabled={plannerDate === todayKey()}
          >
            <CalendarDays size={12} /> Jump to today
          </button>
        </div>
      </section>

      <section className="day-panel">
        <div className="day-panel-head">
          <div className="day-title">
            <span className="eyebrow">{plannerDate === todayKey() ? 'Today' : 'Plan a day'}</span>
            <h1>{selected.toLocaleDateString([], { day: 'numeric', month: 'long' })}</h1>
            <p>{formatDateLong(plannerDate)}</p>
          </div>
          <div className="day-nav">
            <button onClick={() => stepDay(-1)} aria-label="Previous day"><ChevronLeft size={14} /></button>
            <button onClick={() => setPlannerDate(todayKey())} className="today-button">Today</button>
            <button onClick={() => stepDay(1)} aria-label="Next day"><ChevronRight size={14} /></button>
          </div>
        </div>

        <div className="day-task-scroll">
          {openTasks.length === 0 && doneTasks.length === 0 && (
            <div className="day-empty">
              <Sparkles size={20} />
              <strong>A clear page.</strong>
              <span>Add one thing that would make this day feel good.</span>
            </div>
          )}

          {openTasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              onToggle={() => toggleTask(task.id)}
              onEdit={() => setEditor({ task, date: task.date })}
              onDelete={() => deleteTask(task.id)}
            />
          ))}

          {doneTasks.length > 0 && (
            <div className="done-group">
              <span className="tree-label">{doneTasks.length} completed</span>
              {doneTasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  onToggle={() => toggleTask(task.id)}
                  onEdit={() => setEditor({ task, date: task.date })}
                  onDelete={() => deleteTask(task.id)}
                />
              ))}
            </div>
          )}
        </div>

        <form className="planner-add" onSubmit={quickAdd}>
          <Plus size={15} />
          <input
            value={quickTitle}
            onChange={(event) => setQuickTitle(event.target.value)}
            placeholder={`Add a task for ${formatDateShort(plannerDate)}…`}
            aria-label="Quick task title"
          />
          <input
            type="time"
            value={quickTime}
            onChange={(event) => setQuickTime(event.target.value)}
            className="planner-add-time"
            aria-label="Task time"
          />
          <button
            type="button"
            className="icon-button subtle"
            title="More options"
            onClick={() => setEditor({ date: plannerDate })}
          >
            <ListTodo size={14} />
          </button>
          <button type="submit" className="primary-button compact">Add</button>
        </form>
      </section>

      <aside className="planner-side">
        <div className="side-card upcoming-side">
          <div className="side-card-head">
            <span className="eyebrow">Upcoming{upcoming.length > 0 ? ` · ${upcoming.length}` : ''}</span>
            <CalendarDays size={13} />
          </div>
          <div className="upcoming-list">
            {upcoming.length === 0 && (
              <div className="upcoming-empty">
                <CalendarDays size={16} />
                <span>Nothing scheduled after this day.</span>
                <button className="soft-button compact" onClick={() => setEditor({ date: addDays(plannerDate, 1) })}>
                  <Plus size={12} /> Plan the next day
                </button>
              </div>
            )}
            {upcoming.map((task) => {
              const overdue = task.date < today
              return (
                <button
                  key={task.id}
                  className={`reminder-item ${overdue ? 'is-overdue' : ''}`}
                  onClick={() => {
                    setPlannerDate(task.date)
                    setEditor({ task, date: task.date })
                  }}
                >
                  <span className="reminder-icon"><CalendarDays size={11} /></span>
                  <span className="reminder-copy">
                    <strong>{task.title}</strong>
                    <small>
                      {overdue ? 'Overdue · ' : ''}
                      {formatDateShort(task.date)}
                      {task.time ? ` · ${task.time}` : ''}
                    </small>
                  </span>
                  {overdue && <span className="overdue-label">due</span>}
                </button>
              )
            })}
          </div>
        </div>

        <div className="side-card reminders-side">
          <div className="side-card-head">
            <span className="eyebrow">Reminders{reminders.length > 0 ? ` · ${reminders.length}` : ''}</span>
            <Bell size={13} />
          </div>
          <div className="reminder-list">
            {reminders.length === 0 && (
              <div className="reminder-empty">
                <Bell size={16} />
                <span>No reminders yet. Add a time to a task and choose when to be nudged.</span>
                <button className="soft-button compact" onClick={() => setEditor({ date: plannerDate })}>
                  <Plus size={12} /> Add reminder
                </button>
              </div>
            )}
            {reminders.map((task) => (
              <button
                key={task.id}
                className={`reminder-item ${task.remindAt && task.remindAt < now ? 'is-overdue' : ''}`}
                onClick={() => {
                  setPlannerDate(task.date)
                  setEditor({ task, date: task.date })
                }}
              >
                <span className="reminder-icon"><Bell size={11} /></span>
                <span className="reminder-copy">
                  <strong>{task.title}</strong>
                  <small>
                    {formatDateShort(task.date)}
                    {task.remindAt ? ` · ${formatTime(task.remindAt)}` : ''}
                  </small>
                </span>
                {task.remindAt && task.remindAt < now && <span className="overdue-label">due</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="stats-strip">
          <div title={`${focusMinutes} focused minutes completed on this day`}>
            <Clock3 size={13} />
            <strong>{focusMinutes}m</strong>
            <span>focus</span>
          </div>
          <div>
            <Check size={13} />
            <strong>{doneCount}</strong>
            <span>done</span>
          </div>
          <div>
            <ListTodo size={13} />
            <strong>{openTasks.length}</strong>
            <span>open</span>
          </div>
        </div>
      </aside>

      <TaskEditorModalContainer editor={editor} onClose={() => setEditor(null)} />
    </div>
  )
}

function TaskEditorModalContainer({
  editor,
  onClose
}: {
  editor: EditorState | null
  onClose: () => void
}) {
  useEffect(() => {
    if (!editor) return
    document.body.classList.add('interaction-locked')
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.classList.remove('interaction-locked')
      window.removeEventListener('keydown', onKey)
    }
  }, [editor, onClose])

  return (
    <motion.div
      className={`task-editor-overlay ${editor ? 'is-open' : ''}`}
      initial={false}
      animate={{ opacity: editor ? 1 : 0, pointerEvents: editor ? 'auto' : 'none' }}
      onPointerDown={onClose}
    >
      {editor && (
        <motion.div
          className="task-editor-card"
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button className="task-editor-close" onClick={onClose}><X size={14} /></button>
          <TaskEditor open={Boolean(editor)} editor={editor} onClose={onClose} />
        </motion.div>
      )}
    </motion.div>
  )
}

function TaskItem({
  task,
  onToggle,
  onEdit,
  onDelete
}: {
  task: Task
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const overdue = Boolean(task.remindAt && task.remindAt < Date.now() && !task.done)
  return (
    <div className={`plan-task ${task.done ? 'is-done' : ''}`}>
      <button className="planner-check" onClick={onToggle} aria-label={task.done ? 'Mark incomplete' : 'Mark complete'}>
        {task.done && <Check size={12} strokeWidth={3} />}
      </button>
      <button className="plan-task-body" onClick={onEdit}>
        <span className="plan-task-title">{task.title}</span>
        <span className="plan-task-meta">
          {task.time && <span><Clock3 size={10} /> {task.time}</span>}
          {task.remindAt && (
            <span className={overdue ? 'overdue' : ''}>
              <Bell size={10} /> {formatTime(task.remindAt)}
            </span>
          )}
          {task.notes && <span className="task-note">{task.notes}</span>}
        </span>
      </button>
      <span className={`priority-dot ${task.priority}`} />
      <button className="plan-task-delete" onClick={onDelete} title="Delete task">
        <Trash2 size={12} />
      </button>
    </div>
  )
}
