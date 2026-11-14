import { ChevronUp, Maximize2, Minimize2, Pin, PinOff, Settings2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { useApp } from '../state/AppContext'
import { SECTION_META, sectionPrefs, visibleSections } from '../lib/sections'
import { formatDateShort, greeting, todayKey } from '../lib/time'
import { Logo } from './Logo'

export function SectionNav() {
  const { page, setPage, state } = useApp()
  const compact = state.settings.panelSize === 'compact'
  const tabs = visibleSections(sectionPrefs(state), { compact })

  return (
    <nav className="nav-tabs" aria-label="Sections">
      {tabs.map((id) => {
        const tab = SECTION_META[id]
        const Icon = tab.icon
        const active = page === id
        return (
          <button
            key={id}
            className={`nav-tab ${active ? 'is-active' : ''}`}
            onClick={() => setPage(id)}
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
    </nav>
  )
}

export function Header() {
  const { page, setPage, pinned, setPinned, state, openSettings, updateSettings, setExpanded } = useApp()
  const compact = state.settings.panelSize === 'compact'
  const firstSection = visibleSections(sectionPrefs(state), { compact })[0]
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
          className={`icon-button ${pinned ? 'is-on' : ''}`}
          onClick={() => setPinned(!pinned)}
          title={
            pinned
              ? 'Pinned — stays open when the pointer leaves'
              : 'Pin — stay open when the pointer leaves'
          }
          aria-pressed={pinned}
        >
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button
          className={`icon-button ${page === 'settings' ? 'is-on' : ''}`}
          onClick={() => (page === 'settings' ? setPage(firstSection) : openSettings())}
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
        <button
          className="close-notch is-collapse"
          onClick={() => setExpanded(false)}
          title="Collapse the notch"
          aria-label="Collapse the notch"
        >
          <ChevronUp size={14} />
          <span>Collapse</span>
        </button>
      </div>
    </header>
  )
}
