import { Check, Maximize2, Minimize2, Settings2, SlidersHorizontal } from 'lucide-react'
import { motion } from 'framer-motion'
import { useEffect } from 'react'
import { useApp } from '../state/AppContext'
import { useNowWhen } from '../state/clock'
import { useHomeEdit } from '../state/HomeEditContext'
import { SECTION_META, sectionPrefs, visibleSections } from '../lib/sections'
import { formatDateShort, todayKey } from '../lib/time'

export function SectionNav() {
  const { page, setPage, state } = useApp()
  const compact = state.settings.panelSize === 'compact'
  const tabs = visibleSections(sectionPrefs(state), { compact })

  return (
    <nav className="nav-tabs" aria-label="Sections">
      {tabs.map((id, index) => {
        const tab = SECTION_META[id]
        const Icon = tab.icon
        const active = page === id
        return (
          <button
            key={id}
            data-demo-nav={id}
            className={`nav-tab ${active ? 'is-active' : ''}`}
            onClick={() => setPage(id)}
            title={`${tab.label} (${index + 1})`}
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
  const { page, setPage, state, openSettings, updateSettings, expanded, updateState } = useApp()
  const { editing, setEditing } = useHomeEdit()
  const now = useNowWhen(expanded)
  const compact = state.settings.panelSize === 'compact'
  const firstSection = visibleSections(sectionPrefs(state), { compact })[0]
  const clock = new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const hasUpdateNotice =
    updateState?.status === 'available' || updateState?.status === 'downloaded'

  useEffect(() => {
    if ((!expanded || page !== 'home') && editing) setEditing(false)
  }, [expanded, page, editing, setEditing])

  return (
    <header className="topbar">
      {!compact && <SectionNav />}

      <div className="top-actions">
        <div className="header-date">
          <span>{formatDateShort(todayKey())}</span>
          <strong>{clock}</strong>
        </div>
        {page === 'home' && (
          <button
            type="button"
            data-home-edit-toggle="true"
            className={`close-notch is-customize ${editing ? 'is-active' : ''}`}
            onClick={() => setEditing((current) => !current)}
            title={editing ? 'Finish customizing Home' : 'Customize Home sections and layout'}
            aria-pressed={editing}
          >
            {editing ? <Check size={13} /> : <SlidersHorizontal size={13} />}
            <span>{editing ? 'Done' : 'Customize'}</span>
          </button>
        )}
        <button
          data-demo-settings-btn="true"
          className={`icon-button has-badge ${page === 'settings' ? 'is-on' : ''}`}
          onClick={() => (page === 'settings' ? setPage(firstSection) : openSettings())}
          title={
            hasUpdateNotice
              ? `Settings · Update ${updateState?.availableVersion ?? ''} ${updateState?.status === 'downloaded' ? 'ready' : 'available'}`
              : 'Settings'
          }
          aria-pressed={page === 'settings'}
        >
          <Settings2 size={15} />
          {hasUpdateNotice && <span className="update-badge-dot" aria-hidden="true" />}
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
