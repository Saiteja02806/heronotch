import {
  Bot,
  CalendarDays,
  ChevronsUp,
  LayoutGrid,
  Music2,
  NotebookPen,
  PersonStanding,
  Pin,
  PinOff,
  Settings2
} from 'lucide-react'
import { motion } from 'framer-motion'
import { useApp, type Page } from '../state/AppContext'
import { formatDateShort, greeting, todayKey } from '../lib/time'
import { Logo } from './Logo'

const TABS: { id: Page; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'home', label: 'Home', icon: LayoutGrid },
  { id: 'notes', label: 'Notes', icon: NotebookPen },
  { id: 'music', label: 'Music', icon: Music2 },
  { id: 'planner', label: 'Plan', icon: CalendarDays },
  { id: 'sessions', label: 'Sessions', icon: Bot },
  { id: 'posture', label: 'Posture', icon: PersonStanding }
]

export function Header() {
  const { page, setPage, pinned, setPinned, setExpanded, state, openSettings } = useApp()
  const clock = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const vaultName = state.settings.vaultPath?.split(/[\\/]/).filter(Boolean).pop()

  return (
    <header className="topbar">
      <div className="brand-lockup">
        <Logo size={26} />
        <div className="brand-copy">
          <strong>notch</strong>
          <span>
            {state.settings.userName
              ? `${greeting()}, ${state.settings.userName}`
              : vaultName
                ? `${vaultName} vault`
                : 'personal dashboard'}
          </span>
        </div>
      </div>

      <nav className="nav-tabs" aria-label="Sections">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const active = page === tab.id
          return (
            <button
              key={tab.id}
              className={`nav-tab ${active ? 'is-active' : ''}`}
              onClick={() => setPage(tab.id)}
              aria-current={active ? 'page' : undefined}
            >
              {active && (
                <motion.span
                  className="nav-active"
                  layoutId="nav-active"
                  transition={{ type: 'spring', stiffness: 430, damping: 34 }}
                />
              )}
              <Icon size={15} />
              <span>{tab.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="top-actions">
        <div className="header-date">
          <span>{formatDateShort(todayKey())}</span>
          <strong>{clock}</strong>
        </div>
        <button
          className={`icon-button ${pinned ? 'is-on' : ''}`}
          onClick={() => setPinned(!pinned)}
          title={pinned ? 'Unpin the notch' : 'Keep the notch open'}
          aria-pressed={pinned}
        >
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button
          className={`icon-button ${page === 'settings' ? 'is-on' : ''}`}
          onClick={() => (page === 'settings' ? setPage('home') : openSettings())}
          title="Settings"
          aria-pressed={page === 'settings'}
        >
          <Settings2 size={15} />
        </button>
        <button className="close-notch" onClick={() => setExpanded(false)} title="Collapse notch (Esc)">
          <ChevronsUp size={14} />
          <span>Collapse</span>
        </button>
      </div>
    </header>
  )
}
