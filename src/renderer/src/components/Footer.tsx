import { CircleCheck, FolderOpen, Music2 } from 'lucide-react'
import { useApp } from '../state/AppContext'
import { useMedia } from '../state/MediaContext'
import { todayKey } from '../lib/time'

export function Footer() {
  const { state } = useApp()
  const { status } = useMedia()
  const vaultName = state.settings.vaultPath?.split(/[\\/]/).filter(Boolean).pop()
  const openToday = state.tasks.filter((task) => !task.done && task.date === todayKey()).length
  const spotifyLive = Boolean(status?.connected || status?.localAvailable)

  return (
    <footer className="statusbar">
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
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </footer>
  )
}
