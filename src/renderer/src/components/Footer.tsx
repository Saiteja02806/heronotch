import { CircleCheck, Droplet, FolderOpen, Music2, PersonStanding } from 'lucide-react'
import { useApp } from '../state/AppContext'
import { useMedia } from '../state/MediaContext'
import { usePosture } from '../state/PostureContext'
import { sectionPrefs, sectionVisible, visibleSections } from '../lib/sections'
import { waterCount } from '../lib/water'
import { todayKey } from '../lib/time'
import { CompactSlot } from './CompactSlot'
import { SectionNav } from './Header'
import { Logo } from './Logo'

export function Footer() {
  const { state, setPage } = useApp()
  const { playerName, playerAvailable } = useMedia()
  const posture = usePosture()
  const vaultName = state.settings.vaultPath?.split(/[\\/]/).filter(Boolean).pop()
  const openToday = state.tasks.filter((task) => !task.done && task.date === todayKey()).length
  const spotifyLive = playerAvailable
  const waterOn = sectionVisible(state, 'water')
  const glasses = waterOn ? waterCount(state.water) : 0
  // Posture needs no add action here; the score is only worth the space while
  // the coach is actually running.
  const postureOn = posture.enabled && sectionVisible(state, 'posture')
  const compact = state.settings.panelSize === 'compact'
  const sectionCount = visibleSections(sectionPrefs(state)).length

  if (compact) {
    return (
      <footer className="statusbar is-section-nav">
        <SectionNav />
        <CompactSlot />
      </footer>
    )
  }

  return (
    <footer className="statusbar">
      <div className="status-left">
      <div className="status-brand">
        <Logo size={15} />
        <strong>{window.notchDemo ? 'Hero Notch' : 'notch'}</strong>
      </div>
      <div className="status-cluster">
        <span className={`status-dot ${vaultName ? 'online' : ''}`} />
        <span className="status-label">
          <FolderOpen size={12} />
          {vaultName || 'No folder'}
        </span>
        <span className="status-separator" />
        <span className={`status-label ${spotifyLive ? 'online-text' : ''}`}>
          <Music2 size={12} />
          {spotifyLive ? playerName : `${playerName} · unavailable`}
        </span>
        <span className="status-separator" />
        <span className="status-label">
          <CircleCheck size={12} />
          {openToday} left today
        </span>
        {waterOn && (
          <>
            <span className="status-separator" />
            <button type="button" className="status-label water-status" onClick={() => setPage('water')}>
              <Droplet size={12} />
              {glasses}/{state.water.goalGlasses}
            </button>
          </>
        )}
        {postureOn && (
          <>
            <span className="status-separator" />
            <button
              type="button"
              className={`status-label posture-status ${
                posture.score === null
                  ? 'is-idle'
                  : posture.score >= posture.threshold
                    ? 'is-good'
                    : posture.score >= posture.threshold - 12
                      ? 'is-warn'
                      : 'is-bad'
              }`}
              onClick={() => setPage('posture')}
              title={
                posture.score === null
                  ? posture.status === 'away'
                    ? 'Posture coach is paused — nobody in frame, it wakes when you are back'
                    : 'Posture coach is on — nobody in frame'
                  : `Posture ${posture.score} — ${posture.metrics?.advice || 'open the coach'}`
              }
            >
              <PersonStanding size={12} />
              {posture.score !== null ? posture.score : posture.status === 'away' ? 'Away' : 'No pose'}
            </button>
          </>
        )}
      </div>
      </div>
      <div className="shortcut-hints">
        <span>
          <kbd>Ctrl</kbd>
          <kbd>⇧</kbd>
          <kbd>Space</kbd> toggle
        </span>
        <span>
          <kbd>1</kbd>
          {sectionCount > 1 && (
            <>
              –<kbd>{sectionCount}</kbd>
            </>
          )}{' '}
          sections
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </footer>
  )
}
