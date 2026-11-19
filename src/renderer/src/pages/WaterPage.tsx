import { ArrowUpRight, Bell, BellOff, BellRing, Droplet, Minus, Plus, Undo2 } from 'lucide-react'
import { type CSSProperties } from 'react'
import { WATER_GOAL_MAX, WATER_GOAL_MIN } from '../../../shared/types'
import { useApp, useWaterReminderClock } from '../state/AppContext'
import { playWaterRing } from '../lib/alertSound'
import { formatTime } from '../lib/time'
import {
  WATER_REMINDER_PRESETS,
  formatWaterCountdown,
  formatWaterMl,
  formatWaterReminderLong,
  formatWaterReminderShort,
  waterFill,
  waterToday
} from '../lib/water'

function MeasuringGlass({
  fill,
  marks,
  label,
  tiny = false,
  shelf = false,
  card = false,
  decorative = false
}: {
  fill: number
  marks: number
  label: string
  tiny?: boolean
  shelf?: boolean
  card?: boolean
  decorative?: boolean
}) {
  const level = Math.max(0, Math.min(1, fill))
  const steps = Math.max(1, Math.min(WATER_GOAL_MAX, marks))
  return (
    <div
      className={`vessel ${tiny ? 'is-tiny' : ''} ${shelf ? 'is-shelf' : ''} ${card ? 'is-card' : ''} ${level === 0 ? 'is-empty' : ''}`}
      style={{ '--fill': `${level * 100}%` } as CSSProperties}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
    >
      <div className="vessel-body">
        <div className="vessel-water" />
        {!tiny && !shelf && (
          <div className="vessel-marks" aria-hidden="true">
            {Array.from({ length: steps }, (_, index) => (
              <span key={index} style={{ bottom: `${((index + 1) / steps) * 100}%` }} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function WaterCard() {
  const { state, addGlass, undoGlass, setPage } = useApp()
  const { active, intervalMinutes, remainingMs, remindAt } = useWaterReminderClock()
  const water = waterToday(state.water)
  const count = water.pours.length
  const goal = water.goalGlasses
  const fill = waterFill(count, goal)
  const reached = count >= goal && goal > 0
  const lastPour = water.pours.at(-1)

  return (
    <article className="card water-card" onClick={() => setPage('water')}>
      <div className="card-heading">
        <span className="eyebrow">
          <Droplet size={11} className="is-water-icon" />
          Water
        </span>
        <span className="mini-badge">
          {active ? (
            <>
              <Bell size={11} />
              Every {formatWaterReminderShort(intervalMinutes)}
            </>
          ) : (
            formatWaterMl(count, water.glassMl)
          )}
        </span>
      </div>

      <div className="water-card-body">
        <div className="water-card-vessel">
          <MeasuringGlass
            card
            fill={fill}
            marks={goal}
            label={`${count} of ${goal} glasses`}
          />
        </div>
        <div className="water-card-info">
          <h2>
            {count} of {goal} {goal === 1 ? 'glass' : 'glasses'}
          </h2>
          <p>
            {reached
              ? `Daily goal reached · ${formatWaterMl(count, water.glassMl)} poured today.`
              : active && remindAt
                ? `Next reminder in ${formatWaterCountdown(remainingMs)} · rings at ${formatTime(remindAt)}.`
                : lastPour
                  ? `Last glass at ${formatTime(lastPour)} · ${formatWaterMl(count, water.glassMl)} today.`
                  : `Daily goal: ${goal} ${goal === 1 ? 'glass' : 'glasses'} (${formatWaterMl(goal, water.glassMl)}).`}
          </p>

          <div className="water-glance-track" aria-hidden="true">
            <span style={{ width: `${fill * 100}%` }} />
          </div>
          <div className="seek-times">
            <span>{formatWaterMl(count, water.glassMl)}</span>
            <span>{formatWaterMl(goal, water.glassMl)}</span>
          </div>

          <div className="water-card-controls">
            <button
              type="button"
              className="water-glance-add"
              onClick={(event) => {
                event.stopPropagation()
                addGlass()
              }}
            >
              <Plus size={13} />
              Add a glass
            </button>
            <button
              type="button"
              className="soft-button compact water-undo"
              disabled={count === 0}
              onClick={(event) => {
                event.stopPropagation()
                undoGlass()
              }}
            >
              <Undo2 size={12} />
              Undo
            </button>
            <span className="music-open">
              Open water <ArrowUpRight size={11} />
            </span>
          </div>
        </div>
      </div>
    </article>
  )
}

export function WaterPreview({ fill }: { fill: number }) {
  return <MeasuringGlass shelf decorative fill={fill} marks={8} label="" />
}

function WaterReminderControl() {
  const { setWaterReminder, addGlass, showToast } = useApp()
  const { active, intervalMinutes, remainingMs, remindAt } = useWaterReminderClock()

  const chooseInterval = (minutes: number): void => {
    setWaterReminder(minutes)
    if (minutes <= 0) {
      showToast('Water reminder off', 'Automatic drink reminders paused.', 'default', {
        category: 'water',
        section: 'water'
      })
      return
    }
    playWaterRing()
    showToast(
      `Water reminder · every ${formatWaterReminderLong(minutes)}`,
      'It will ring when time is up, and resets whenever you log a glass.',
      'success',
      {
        category: 'water',
        section: 'water'
      }
    )
  }

  return (
    <div className="water-reminder" role="group" aria-label="Water drink reminder">
      <div className="water-reminder-head">
        <span className="water-reminder-label">
          {active ? <Bell size={12} /> : <BellOff size={12} />}
          <span>Drink reminder</span>
        </span>
        {active && remindAt ? (
          <span className="water-reminder-status is-active" aria-live="off">
            Rings in <strong>{formatWaterCountdown(remainingMs)}</strong> · {formatTime(remindAt)}
          </span>
        ) : (
          <span className="water-reminder-status">Off</span>
        )}
      </div>
      <div className="water-reminder-pills">
        {WATER_REMINDER_PRESETS.map((minutes) => {
          const selected = intervalMinutes === minutes
          return (
            <button
              key={minutes}
              type="button"
              className={`water-reminder-pill ${selected ? 'is-active' : ''}`}
              onClick={() => chooseInterval(minutes)}
              aria-pressed={selected}
              title={
                minutes === 0
                  ? 'Turn off water reminder'
                  : `Remind me to drink water every ${formatWaterReminderLong(minutes)}`
              }
            >
              {formatWaterReminderShort(minutes)}
            </button>
          )
        })}
        {active && (
          <button
            type="button"
            className="water-reminder-test"
            onClick={() => {
              playWaterRing()
              showToast(
                'Water reminder · Time to drink water',
                `Every ${formatWaterReminderLong(intervalMinutes)} reminder preview.`,
                'default',
                {
                  category: 'water',
                  section: 'water',
                  actions: [
                    {
                      label: 'Add a glass',
                      variant: 'primary',
                      onClick: () => addGlass()
                    }
                  ]
                }
              )
            }}
            title="Test reminder ring"
            aria-label="Test reminder ring"
          >
            <BellRing size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

export function WaterPage() {
  const { state, addGlass, undoGlass, setWaterGoal, openSettings } = useApp()
  const water = waterToday(state.water)
  const count = water.pours.length
  const goal = water.goalGlasses
  const fill = waterFill(count, goal)
  const latestFirst = [...water.pours].reverse()
  const reached = count >= goal && goal > 0

  return (
    <div className="water-page">
      <div className="water-stage">
        <MeasuringGlass
          fill={fill}
          marks={goal}
          label={
            count === 0
              ? 'Empty glass'
              : `${count} of ${goal} glasses, ${formatWaterMl(count, water.glassMl)}`
          }
        />
      </div>

      <div className="water-panel">
        <span className="eyebrow">Water</span>
        <div className="water-figure" aria-live="polite">
          <span className="water-count">{count}</span>
          <span className="water-count-caption">
            {count === 0 ? 'Nothing poured yet' : `of ${goal} ${goal === 1 ? 'glass' : 'glasses'}`}
            <small>{formatWaterMl(count, water.glassMl)}</small>
          </span>
        </div>
        {reached && <p className="water-reached">Goal reached{count > goal ? ` · ${count - goal} extra` : ''}</p>}

        <div className="water-goal">
          <button
            type="button"
            className="icon-button"
            onClick={() => setWaterGoal(goal - 1)}
            disabled={goal <= WATER_GOAL_MIN}
            aria-label="Lower the daily goal"
          >
            <Minus size={14} />
          </button>
          <span>
            <small>Daily goal</small>
            <strong>
              {goal} {goal === 1 ? 'glass' : 'glasses'}
            </strong>
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={() => setWaterGoal(goal + 1)}
            disabled={goal >= WATER_GOAL_MAX}
            aria-label="Raise the daily goal"
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="water-actions">
          <button type="button" className="water-add" onClick={addGlass}>
            <Plus size={15} />
            Add a glass
          </button>
          <button type="button" className="soft-button water-undo" onClick={undoGlass} disabled={count === 0}>
            <Undo2 size={13} />
            Undo last
          </button>
        </div>

        <WaterReminderControl />

        <div className="water-log">
          <span className="eyebrow">Today</span>
          {latestFirst.length === 0 ? (
            <p>No glasses yet. The first one starts the count.</p>
          ) : (
            <ul>
              {latestFirst.map((at, index) => (
                <li key={`${at}-${index}`}>
                  <span>{formatTime(at)}</span>
                  <span>1 glass · {formatWaterMl(1, water.glassMl)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button type="button" className="water-manage" onClick={() => openSettings('sections')}>
          Manage sections
        </button>
      </div>
    </div>
  )
}
