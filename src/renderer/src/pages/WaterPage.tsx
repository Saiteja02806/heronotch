import { Minus, Plus, Undo2 } from 'lucide-react'
import { type CSSProperties } from 'react'
import { WATER_GOAL_MAX, WATER_GOAL_MIN } from '../../../shared/types'
import { useApp } from '../state/AppContext'
import { formatTime } from '../lib/time'
import { formatWaterMl, waterFill, waterToday } from '../lib/water'

function MeasuringGlass({
  fill,
  marks,
  label,
  tiny = false,
  shelf = false,
  decorative = false
}: {
  fill: number
  marks: number
  label: string
  tiny?: boolean
  shelf?: boolean
  decorative?: boolean
}) {
  const level = Math.max(0, Math.min(1, fill))
  const steps = Math.max(1, Math.min(WATER_GOAL_MAX, marks))
  return (
    <div
      className={`vessel ${tiny ? 'is-tiny' : ''} ${shelf ? 'is-shelf' : ''} ${level === 0 ? 'is-empty' : ''}`}
      style={{ '--fill': `${level * 100}%` } as CSSProperties}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
    >
      <div className="vessel-lip" />
      <div className="vessel-body">
        <div className="vessel-water" />
        {!tiny && !shelf && (
          <div className="vessel-marks" aria-hidden="true">
            {Array.from({ length: steps }, (_, index) => (
              <span key={index} style={{ bottom: `${((index + 1) / steps) * 100}%` }} />
            ))}
          </div>
        )}
        <div className="vessel-shine" />
      </div>
    </div>
  )
}

export function WaterGlance() {
  const { state, addGlass, setPage } = useApp()
  const water = waterToday(state.water)
  const count = water.pours.length
  const goal = water.goalGlasses
  const fill = waterFill(count, goal)

  return (
    <div className="water-glance">
      <button type="button" className="water-glance-open" onClick={() => setPage('water')}>
        <MeasuringGlass
          tiny
          fill={fill}
          marks={goal}
          label={`${count} of ${goal} glasses`}
        />
        <span className="water-glance-copy">
          <span className="eyebrow">Water</span>
          <strong>
            {count} of {goal}
          </strong>
        </span>
        <span className="water-glance-track" aria-hidden="true">
          <span style={{ width: `${fill * 100}%` }} />
        </span>
      </button>
      <button type="button" className="water-glance-add" onClick={addGlass}>
        <Plus size={13} />
        Add a glass
      </button>
    </div>
  )
}

export function WaterPreview({ fill }: { fill: number }) {
  return <MeasuringGlass shelf decorative fill={fill} marks={8} label="" />
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
