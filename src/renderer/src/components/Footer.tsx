import { CircleCheck, Droplet, FolderOpen, Music2 } from 'lucide-react'
import { useApp } from '../state/AppContext'
import { useMedia } from '../state/MediaContext'
import { waterCount } from '../lib/water'
import { todayKey } from '../lib/time'
import { CompactSlot } from './CompactSlot'
import { SectionNav } from './Header'
import { Logo } from './Logo'

export function Footer() {
  const { state, setPage } = useApp()
  const { status } = useMedia()
  const vaultName = state.settings.vaultPath?.split(/[\\/]/).filter(Boolean).pop()
  const openToday = state.tasks.filter((task) => !task.done && task.date === todayKey()).length
  const spotifyLive = Boolean(status?.connected || status?.localAvailable)
  const waterOn = Boolean(state.water?.enabled)
  const glasses = waterOn ? waterCount(state.water) : 0
  const compact = state.settings.panelSize === 'compact'

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
        <strong>notch</strong>
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
          {spotifyLive ? (status?.connected ? 'Spotify' : 'Spotify Desktop') : 'Spotify off'}
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
      </div>
      </div>
      <div className="shortcut-hints">
        <span>
          <kbd>Ctrl</kbd>
          <kbd>⇧</kbd>
          <kbd>Space</kbd> toggle
        </span>
        <span>
          <kbd>1</kbd>–<kbd>7</kbd> sections
        </span>
        {waterOn && (
          <span>
            <kbd>8</kbd> water
          </span>
        )}
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </footer>
  )
}
