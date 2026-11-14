import {
  Bot,
  CalendarDays,
  Droplet,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Music2,
  NotebookPen,
  PersonStanding,
  Pin,
  PinOff,
  Settings2
} from 'lucide-react'
import { motion } from 'framer-motion'
import { useApp, type Page } from '../state/AppContext'
import { OPTIONAL_SECTIONS, sectionEnabled } from '../lib/sections'
import { formatDateShort, greeting, todayKey } from '../lib/time'
import { Logo } from './Logo'

const EXTRA_ICONS = {
  water: Droplet
} as const

const TABS: { id: Page; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'home', label: 'Home', icon: LayoutGrid },
  { id: 'notes', label: 'Notes', icon: NotebookPen },
  { id: 'music', label: 'Music', icon: Music2 },
  { id: 'planner', label: 'Plan', icon: CalendarDays },
  { id: 'sessions', label: 'Sessions', icon: Bot },
  { id: 'posture', label: 'Posture', icon: PersonStanding }
]

export function SectionNav() {
  const { page, setPage, state } = useApp()
  const compact = state.settings.panelSize === 'compact'
  const tabs = compact ? TABS.filter((tab) => tab.id !== 'home') : TABS
  const extras = OPTIONAL_SECTIONS.filter((section) => sectionEnabled(state, section.id))

  return (
    <nav className="nav-tabs" aria-label="Sections">
      {tabs.map((tab) => {
        const Icon = tab.icon
        const active = page === tab.id
        return (
          <button
            key={tab.id}
            className={`nav-tab ${active ? 'is-active' : ''}`}
            onClick={() => setPage(tab.id)}
            title={tab.label}
            aria-current={active ? 'page' : undefined}
          >
            {active && (
              <motion.span
                className="nav-active"
                layoutId="nav-active"
                transition={{ type: 'spring', stiffness: 430, damping: 34 }}
              />
            )}
            <Icon size={compact ? 13 : 15} />
            <span>{tab.label}</span>
          </button>
        )
      })}
      {extras.length > 0 && <span className="nav-divider" aria-hidden="true" />}
      {extras.map((section) => {
        const Icon = EXTRA_ICONS[section.id]
        const active = page === section.page
        return (
          <button
            key={section.id}
            className={`nav-tab ${active ? 'is-active' : ''}`}
            onClick={() => setPage(section.page)}
            title={section.label}
            aria-current={active ? 'page' : undefined}
          >
            {active && (
              <motion.span
                className="nav-active"
                layoutId="nav-active"
                transition={{ type: 'spring', stiffness: 430, damping: 34 }}
              />
            )}
            <Icon size={compact ? 13 : 15} />
            <span>{section.label}</span>
          </button>
        )
      })}
    </nav>
  )
}

export function Header() {
  const { page, setPage, pinned, setPinned, state, openSettings, updateSettings } = useApp()
  const compact = state.settings.panelSize === 'compact'
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
                ? `${vaultName} notes`
                : 'personal dashboard'}
          </span>
        </div>
      </div>

      {!compact && <SectionNav />}

      <div className="top-actions">
        <div className="header-date">
          <span>{formatDateShort(todayKey())}</span>
          <strong>{clock}</strong>
        </div>
        <button
          className={`icon-button compact-hide ${pinned ? 'is-on' : ''}`}
          onClick={() => setPinned(!pinned)}
          title={pinned ? 'Unpin the notch' : 'Keep the notch open'}
          aria-pressed={pinned}
        >
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button
          className={`icon-button compact-hide ${page === 'settings' ? 'is-on' : ''}`}
          onClick={() => (page === 'settings' ? setPage('home') : openSettings())}
          title="Settings"
          aria-pressed={page === 'settings'}
        >
          <Settings2 size={15} />
        </button>
        <button
          className={`close-notch ${compact ? 'is-enlarge' : ''}`}
          onClick={() => updateSettings({ panelSize: compact ? 'full' : 'compact' })}
          title={compact ? 'Enlarge the notch' : 'Make the notch smaller'}
          aria-pressed={compact}
        >
          {compact ? <Maximize2 size={15} /> : <Minimize2 size={13} />}
          <span>{compact ? 'Enlarge' : 'Compact'}</span>
        </button>
      </div>
    </header>
  )
}
