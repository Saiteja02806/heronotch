import {
  Bell,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  ListTodo,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import { motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { CalendarEvent } from '../../../shared/calendar'
import { taskEventDraft } from '../../../shared/taskEvent'
import type { Task, TaskPriority } from '../../../shared/types'
import {
  addDays,
  clockRangeLabel,
  clockSortKey,
  convertTaskSchedule,
  formatDateKeyInZone,
  formatDateLong,
  formatDateShort,
  formatTaskClock,
  formatTime,
  monthMatrix,
  parseDateKey,
  resolvePlannerTimeZone,
  resolveSystemTimeZone,
  sameTimeZoneOffset,
  shortTimeZoneLabel,
  timeToTimestamp,
  todayKeyInZone
} from '../lib/time'
import { useApp } from '../state/AppContext'
import { useGoogleCalendar, usePickedCalendarTimeZone } from '../state/useGoogleCalendar'
import { CalendarEventEditor } from '../components/CalendarEventEditor'
import { GoogleCalendarStrip } from '../components/GoogleCalendarStrip'
import '../calendar.css'

interface EditorState {
  task?: Task
  date: string
}

interface UpcomingGroup {
  key: string
  label: string
  overdue: boolean
  tasks: Task[]
}

interface TaskPayload {
  title: string
  notes?: string
  date: string
  time?: string
  timeZone?: string
  priority: TaskPriority
  remindAt: number | null
}

interface ProjectedTask {
  task: Task
  displayDate: string
  displayTime?: string
  sourceTimeZone: string
  timestamp: number | null
  shifted: boolean
}

type AgendaItem =
  | { kind: 'task'; key: string; sort: string; item: ProjectedTask }
  | { kind: 'event'; key: string; sort: string; event: CalendarEvent }

const UPCOMING_LIMIT = 6

function dayLabel(key: string, today: string): string {
  if (key === today) return 'Today'
  if (key === addDays(today, 1)) return 'Tomorrow'
  const weekday = parseDateKey(key).toLocaleDateString([], { weekday: 'short' })
  return `${weekday} · ${formatDateShort(key)}`
}

function sortByMoment(a: ProjectedTask, b: ProjectedTask): number {
  return `${a.displayDate}T${a.displayTime || '99:99'}`.localeCompare(
    `${b.displayDate}T${b.displayTime || '99:99'}`
  )
}

function reminderOffset(task: Task, systemTimeZone: string): string {
  if (!task.remindAt || !task.time) return 'none'
  const sourceZone = task.timeZone || systemTimeZone
  const at = timeToTimestamp(task.date, task.time, sourceZone)
  if (!at) return 'none'
  const minutes = Math.round((at - task.remindAt) / 60000)
  return [0, 5, 10, 30, 60].includes(minutes) ? String(minutes) : 'none'
}

function TaskEditor({
  open,
  editor,
  canSync,
  timeZone,
  today,
  onClose,
  onCommit,
  onDelete
}: {
  open: boolean
  editor: EditorState | null
  canSync: boolean
  timeZone: string
  today: string
  onClose: () => void
  onCommit: (payload: TaskPayload, existing?: Task) => void
  onDelete: (task: Task) => void
}) {
  const { showToast } = useApp()
  const task = editor?.task
  const systemTz = resolveSystemTimeZone()
  const initialSchedule = task
    ? convertTaskSchedule(task.date, task.time, task.timeZone || systemTz, timeZone)
    : { date: editor?.date || today, time: '' }
  const [title, setTitle] = useState(task?.title || '')
  const [notes, setNotes] = useState(task?.notes || '')
  const [date, setDate] = useState(initialSchedule.date)
  const [time, setTime] = useState(initialSchedule.time || '')
  const [priority, setPriority] = useState<TaskPriority>(task?.priority || 'normal')
  const [reminder, setReminder] = useState(reminderOffset(task || ({} as Task), systemTz))
  const [error, setError] = useState('')
  const tzLabel = shortTimeZoneLabel(timeZone)

  useEffect(() => {
    if (!open) return
    const nextSchedule = task
      ? convertTaskSchedule(task.date, task.time, task.timeZone || systemTz, timeZone)
      : { date: editor?.date || today, time: '' }
    setTitle(task?.title || '')
    setNotes(task?.notes || '')
    setDate(nextSchedule.date)
    setTime(nextSchedule.time || '')
    setPriority(task?.priority || 'normal')
    setReminder(task ? reminderOffset(task, systemTz) : 'none')
    setError('')
  }, [open, editor, task, timeZone, today, systemTz])

  if (!open) return null

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!title.trim()) {
      setError('Give the task a name.')
      return
    }
    const at = timeToTimestamp(date, time, timeZone)
    const remindAt = reminder !== 'none' && at ? at - Number(reminder) * 60000 : null
    const payload: TaskPayload = {
      title: title.trim(),
      notes: notes.trim() || undefined,
      date,
      time: time || undefined,
      timeZone: time ? timeZone : undefined,
      priority,
      remindAt
    }
    if (remindAt && remindAt > Date.now()) {
      const day = date === today ? 'Today' : formatDateShort(date)
      showToast('Reminder set', `${title.trim()} · ${day} at ${formatTime(remindAt, timeZone)}`, 'success')
    }
    onCommit(payload, task)
    onClose()
  }

  return (
    <form className="task-editor" onSubmit={submit}>
      <button type="button" className="task-editor-close" onClick={onClose} aria-label="Close">
        <X size={14} />
      </button>
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
          <span>Time ({tzLabel})</span>
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
            data-demo-task-reminder="true"
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
      <span className={`task-editor-sync ${canSync ? '' : 'is-local'}`}>
        <CalendarDays size={10} />
        {canSync
          ? task?.eventId
            ? 'Changes update this task’s Google Calendar event'
            : 'Saved to your Google Calendar too'
          : 'Saved here only — connect Google Calendar to sync it'}
      </span>
      {error && <span className="form-error">{error}</span>}
      <div className="modal-actions">
        {task && (
          <button
            type="button"
            className="danger-text link-button"
            onClick={() => {
              onDelete(task)
              onClose()
            }}
          >
            <Trash2 size={12} /> Delete
          </button>
        )}
        <span className="modal-spacer" />
        <button type="button" className="soft-button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary-button" data-demo-task-submit="true">
          {task ? 'Save changes' : 'Add task'}
        </button>
      </div>
    </form>
  )
}

function EventItem({
  event,
  displayTimeZone,
  writable,
  onEdit
}: {
  event: CalendarEvent
  displayTimeZone: string
  writable: boolean
  onEdit: () => void
}) {
  const time = event.allDay ? 'All day' : clockRangeLabel(event.start, event.end, displayTimeZone)
  return (
    <div className="plan-task plan-event">
      <span className="plan-event-mark" aria-hidden="true">
        <CalendarDays size={11} />
      </span>
      <button
        type="button"
        className="plan-task-body"
        onClick={onEdit}
        disabled={!writable}
        title={writable ? 'Edit this Google Calendar event' : 'This calendar is read only'}
      >
        <span className="plan-task-title">{event.title || '(no title)'}</span>
        <span className="plan-task-meta">
          <span>
            <Clock3 size={10} /> {time}
          </span>
          {event.location && <span className="task-note">{event.location}</span>}
        </span>
      </button>
      {event.url?.startsWith('https://calendar.google.com/') && (
        <a
          className="plan-event-open"
          href={event.url}
          target="_blank"
          rel="noreferrer"
          title="Open in Google Calendar"
          aria-label={`Open ${event.title} in Google Calendar`}
        >
          <ExternalLink size={11} />
        </a>
      )}
    </div>
  )
}

export function PlannerPage() {
  const {
    state,
    plannerDate,
    setPlannerDate,
    toggleTask,
    deleteTask,
    addTask,
    patchTask,
    updateSettings,
    showToast
  } = useApp()
  const systemTz = resolveSystemTimeZone()
  const calendarTz = usePickedCalendarTimeZone()
  const displayTimeZone = resolvePlannerTimeZone(calendarTz)
  const book = useGoogleCalendar(plannerDate, displayTimeZone)
  const selected = parseDateKey(plannerDate)
  const [view, setView] = useState({ year: selected.getFullYear(), month: selected.getMonth() })
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [eventEditor, setEventEditor] = useState<CalendarEvent | null>(null)
  const [quickTitle, setQuickTitle] = useState('')
  const [quickTime, setQuickTime] = useState('')

  useEffect(() => {
    const target = parseDateKey(plannerDate)
    setView({ year: target.getFullYear(), month: target.getMonth() })
  }, [plannerDate])

  const weeks = useMemo(() => monthMatrix(view.year, view.month), [view])
  const projectedTasks = useMemo<ProjectedTask[]>(() => {
    return state.tasks.map((task) => {
      const sourceTimeZone = task.timeZone || systemTz
      const converted = convertTaskSchedule(task.date, task.time, sourceTimeZone, displayTimeZone)
      return {
        task,
        displayDate: converted.date,
        displayTime: converted.time,
        sourceTimeZone,
        timestamp: converted.timestamp,
        shifted: Boolean(
          task.time &&
            !sameTimeZoneOffset(sourceTimeZone, displayTimeZone, converted.timestamp ?? Date.now())
        )
      }
    })
  }, [state.tasks, systemTz, displayTimeZone])

  const tasksByDate = useMemo(() => {
    const map = new Map<string, ProjectedTask[]>()
    for (const entry of projectedTasks) {
      const list = map.get(entry.displayDate) || []
      list.push(entry)
      map.set(entry.displayDate, list)
    }
    return map
  }, [projectedTasks])

  const dayTasks = useMemo(() => {
    const tasks = (tasksByDate.get(plannerDate) || []).slice()
    return tasks.sort((a, b) => {
      if (a.task.done !== b.task.done) return a.task.done ? 1 : -1
      if (a.displayTime && b.displayTime) return a.displayTime.localeCompare(b.displayTime)
      if (a.displayTime) return -1
      if (b.displayTime) return 1
      return b.task.createdAt - a.task.createdAt
    })
  }, [tasksByDate, plannerDate])

  const openTasks = useMemo(() => dayTasks.filter((entry) => !entry.task.done), [dayTasks])
  const doneTasks = useMemo(() => dayTasks.filter((entry) => entry.task.done), [dayTasks])
  const today = todayKeyInZone(displayTimeZone)

  // Events mirrored from a task are shown as that task, never twice.
  const linkedEventIds = useMemo(
    () => new Set(state.tasks.map((task) => task.eventId).filter((id): id is string => Boolean(id))),
    [state.tasks]
  )
  const dayEvents = useMemo(
    () => (book.events || []).filter((event) => !linkedEventIds.has(event.id)),
    [book.events, linkedEventIds]
  )

  // One agenda per day: calendar events and tasks share a single time order.
  const agenda = useMemo(() => {
    const items: AgendaItem[] = [
      ...openTasks.map<AgendaItem>((entry) => ({
        kind: 'task',
        key: `task:${entry.task.id}`,
        sort: entry.displayTime ? `1${entry.displayTime}` : '2',
        item: entry
      })),
      ...dayEvents.map<AgendaItem>((event) => ({
        kind: 'event',
        key: `event:${event.id}`,
        sort: event.allDay ? '0' : `1${clockSortKey(event.start, displayTimeZone)}`,
        event
      }))
    ]
    return items.sort((a, b) => a.sort.localeCompare(b.sort))
  }, [openTasks, dayEvents, displayTimeZone])

  // Everything still open beyond the day in view, grouped by day: overdue
  // items stay visible, but the list is capped so the column never floods.
  const upcoming = useMemo(() => {
    const open = projectedTasks.filter((entry) => !entry.task.done && entry.displayDate !== plannerDate)
    const overdue = open.filter((entry) => entry.displayDate < today).sort((a, b) => sortByMoment(b, a))
    const groups: { key: string; label: string; overdue: boolean; tasks: ProjectedTask[] }[] = []
    if (overdue.length > 0) {
      groups.push({ key: 'overdue', label: 'Overdue', overdue: true, tasks: overdue.slice(0, 3) })
    }
    const byDate = new Map<string, ProjectedTask[]>()
    for (const entry of open.filter((entry) => entry.displayDate >= today)) {
      const list = byDate.get(entry.displayDate) || []
      list.push(entry)
      byDate.set(entry.displayDate, list)
    }
    let room = UPCOMING_LIMIT - Math.min(overdue.length, 3)
    for (const date of [...byDate.keys()].sort()) {
      if (room <= 0) break
      const tasks = byDate.get(date)!.sort(sortByMoment).slice(0, room)
      groups.push({ key: date, label: dayLabel(date, today), overdue: false, tasks })
      room -= tasks.length
    }
    return { groups, total: open.length, shown: groups.reduce((sum, group) => sum + group.tasks.length, 0) }
  }, [projectedTasks, plannerDate, today])

  const focusMinutes = state.focusLog
    .filter((session) => formatDateKeyInZone(session.at, displayTimeZone) === plannerDate)
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

  /**
   * Tasks are the source of truth; the calendar event is their mirror. The
   * event id is fixed before the request so a retry after a lost response
   * updates the same event instead of creating a second one.
   */
  const commitTask = useCallback(
    async (payload: TaskPayload, existing?: Task) => {
      let link: { eventId?: string; eventEtag?: string } = {}
      if (book.canSync && payload.title.trim()) {
        const eventId = existing?.eventId || book.newEventId()
        const liveEvent = existing?.eventId
          ? (book.events || []).find((ev) => ev.id === existing.eventId)
          : undefined
        const resolvedEtag = liveEvent?.etag || existing?.eventEtag
        const draft = taskEventDraft(
          payload,
          eventId,
          existing?.eventId ? resolvedEtag : undefined,
          payload.timeZone || displayTimeZone
        )
        const result = await book.saveDraft(draft, Boolean(resolvedEtag))
        if (result.ok) {
          link = { eventId: result.event.id, eventEtag: result.event.etag }
        } else if (result.uncertain) {
          // Keep the id so the same event is retried, not duplicated.
          link = { eventId }
          showToast('Google has not confirmed yet', 'The task is saved here. Retry the save from Google Calendar.', 'error')
        } else {
          showToast('Task saved here only', result.error, 'error')
        }
      }
      if (existing) patchTask(existing.id, { ...payload, notifiedAt: null, ...link })
      else addTask({ ...payload, ...link })
    },
    [addTask, book, displayTimeZone, patchTask, showToast]
  )

  const removeTask = useCallback(
    async (task: Task) => {
      if (task.eventId) {
        if (!book.canSync) {
          showToast(
            'Task removed',
            'Its Google Calendar event stays until the calendar is connected again.',
            'error'
          )
        } else {
          const result = await book.removeEvent(task.eventId)
          if (!result.ok) {
            showToast('Task removed', `Its Google Calendar event is still there: ${result.error}`, 'error')
          }
        }
      }
      deleteTask(task.id)
    },
    [book, deleteTask, showToast]
  )

  const quickAdd = (event: FormEvent): void => {
    event.preventDefault()
    if (!quickTitle.trim()) return
    const at = timeToTimestamp(plannerDate, quickTime, displayTimeZone)
    const reminder = at ? at - 5 * 60 * 1000 : null
    void commitTask({
      title: quickTitle,
      date: plannerDate,
      time: quickTime || undefined,
      timeZone: quickTime ? displayTimeZone : undefined,
      priority: 'normal',
      remindAt: reminder && reminder > Date.now() ? reminder : null
    })
    setQuickTitle('')
    setQuickTime('')
  }

  const monthTasks = (date: Date): number => {
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    return (tasksByDate.get(key) || []).filter((entry) => !entry.task.done).length
  }

  const daySubtitle = dayEvents.length
    ? `${formatDateLong(plannerDate)} · ${dayEvents.length} event${dayEvents.length === 1 ? '' : 's'}`
    : formatDateLong(plannerDate)

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
                className={`month-day ${key === plannerDate ? 'is-selected' : ''} ${key === today ? 'is-today' : ''}`}
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
            onClick={() => setPlannerDate(today)}
            disabled={plannerDate === today}
          >
            <CalendarDays size={12} /> Jump to today
          </button>
        </div>
      </section>

      <section className="day-panel">
        <div className="day-panel-head">
          <div className="day-title">
            <span className="eyebrow">{plannerDate === today ? 'Today' : 'Plan a day'}</span>
            <h1>{selected.toLocaleDateString([], { day: 'numeric', month: 'long' })}</h1>
            <p>{daySubtitle}</p>
          </div>
          <div className="day-nav-cluster">
            <div className="day-nav">
              <button onClick={() => stepDay(-1)} aria-label="Previous day"><ChevronLeft size={14} /></button>
              <button onClick={() => setPlannerDate(today)} className="today-button">Today</button>
              <button onClick={() => stepDay(1)} aria-label="Next day"><ChevronRight size={14} /></button>
            </div>
          </div>
        </div>

        <div className="day-task-scroll">
          {agenda.length === 0 && doneTasks.length === 0 && (
            <div className="day-empty">
              {book.loading && !book.events ? (
                <span className="day-empty-loading">
                  <Loader2 size={13} className="spin" /> Syncing Google Calendar…
                </span>
              ) : (
                <>
                  <Sparkles size={20} />
                  <strong>A clear page.</strong>
                  <span>
                    {book.canSync
                      ? 'Add one thing — it is written to your calendar too.'
                      : 'Add one thing that would make this day feel good.'}
                  </span>
                </>
              )}
            </div>
          )}

          {agenda.map((entry) =>
            entry.kind === 'task' ? (
              <TaskItem
                key={entry.key}
                projected={entry.item}
                displayTimeZone={displayTimeZone}
                onToggle={() => toggleTask(entry.item.task.id)}
                onEdit={() => setEditor({ task: entry.item.task, date: entry.item.displayDate })}
                onDelete={() => void removeTask(entry.item.task)}
              />
            ) : (
              <EventItem
                key={entry.key}
                event={entry.event}
                displayTimeZone={displayTimeZone}
                writable={book.writable}
                onEdit={() => setEventEditor(entry.event)}
              />
            )
          )}

          {doneTasks.length > 0 && (
            <div className="done-group">
              <span className="tree-label">{doneTasks.length} completed</span>
              {doneTasks.map((entry) => (
                <TaskItem
                  key={entry.task.id}
                  projected={entry}
                  displayTimeZone={displayTimeZone}
                  onToggle={() => toggleTask(entry.task.id)}
                  onEdit={() => setEditor({ task: entry.task, date: entry.displayDate })}
                  onDelete={() => void removeTask(entry.task)}
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

        <GoogleCalendarStrip book={book} />

        <div className="side-card upcoming-side">
          <div className="side-card-head">
            <span className="eyebrow">Upcoming</span>
            {upcoming.total > 0 && (
              <span className="day-pill">
                {upcoming.total} task{upcoming.total === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {upcoming.groups.length === 0 ? (
            <p className="upcoming-none">Nothing planned for later days yet.</p>
          ) : (
            <div className="upcoming-list">
              {upcoming.groups.map((group) => (
                <div className="upcoming-group" key={group.key}>
                  <span className={`upcoming-day ${group.overdue ? 'is-overdue' : ''}`}>
                    {group.label}
                  </span>
                  {group.tasks.map((entry) => (
                    <div className="upcoming-item" key={entry.task.id}>
                      <button
                        type="button"
                        className="upcoming-check"
                        aria-label={`Mark ${entry.task.title} complete`}
                        title="Mark complete"
                        onClick={() => toggleTask(entry.task.id)}
                      />
                      <button
                        type="button"
                        className="upcoming-body"
                        onClick={() => setPlannerDate(entry.displayDate)}
                        title={`Go to ${formatDateLong(entry.displayDate)}`}
                      >
                        <span className="upcoming-title">{entry.task.title}</span>
                        <span className="upcoming-meta">
                          {entry.task.remindAt && <Bell size={9} />}
                          {group.overdue
                            ? formatDateShort(entry.displayDate)
                            : entry.displayTime
                              ? formatTaskClock(entry.displayDate, entry.displayTime, displayTimeZone, true)
                              : 'Anytime'}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              ))}
              {upcoming.total > upcoming.shown && (
                <span className="upcoming-more">+{upcoming.total - upcoming.shown} more</span>
              )}
            </div>
          )}
        </div>
      </aside>

      <EditorOverlay open={Boolean(editor)} onClose={() => setEditor(null)}>
        {editor && (
          <TaskEditor
            open
            editor={editor}
            canSync={book.canSync}
            timeZone={displayTimeZone}
            today={today}
            onClose={() => setEditor(null)}
            onCommit={(payload, existing) => void commitTask(payload, existing)}
            onDelete={(task) => void removeTask(task)}
          />
        )}
      </EditorOverlay>

      <EditorOverlay open={Boolean(eventEditor)} onClose={() => setEventEditor(null)}>
        {eventEditor && (
          <CalendarEventEditor
            event={eventEditor}
            book={book}
            timeZone={displayTimeZone}
            onClose={() => setEventEditor(null)}
          />
        )}
      </EditorOverlay>
    </div>
  )
}

function EditorOverlay({
  open,
  onClose,
  children
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
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
  }, [open, onClose])

  if (!open) return null

  return (
    <motion.div
      className="task-editor-overlay is-open"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      onPointerDown={onClose}
    >
      <motion.div
        className="task-editor-card"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {children}
      </motion.div>
    </motion.div>
  )
}

function TaskItem({
  projected,
  displayTimeZone,
  onToggle,
  onEdit,
  onDelete
}: {
  projected: ProjectedTask
  displayTimeZone: string
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { task, displayDate, displayTime } = projected
  const overdue = Boolean(task.remindAt && task.remindAt < Date.now() && !task.done)
  const formattedTime = displayTime
    ? formatTaskClock(displayDate, displayTime, displayTimeZone, true)
    : null
  return (
    <div className={`plan-task ${task.done ? 'is-done' : ''}`}>
      <button className="planner-check" onClick={onToggle} aria-label={task.done ? 'Mark incomplete' : 'Mark complete'}>
        {task.done && <Check size={12} strokeWidth={3} />}
      </button>
      <button className="plan-task-body" onClick={onEdit}>
        <span className="plan-task-title">{task.title}</span>
        <span className="plan-task-meta">
          {formattedTime && <span><Clock3 size={10} /> {formattedTime}</span>}
          {task.remindAt && (
            <span className={overdue ? 'overdue' : ''}>
              <Bell size={10} /> {formatTime(task.remindAt, displayTimeZone)}
            </span>
          )}
          {task.notes && <span className="task-note">{task.notes}</span>}
        </span>
      </button>
      {task.eventId && (
        <span className="task-synced" title="Also on Google Calendar">
          <CalendarDays size={10} />
        </span>
      )}
      <span className={`priority-dot ${task.priority}`} />
      <button className="plan-task-delete" onClick={onDelete} title="Delete task">
        <Trash2 size={12} />
      </button>
    </div>
  )
}
