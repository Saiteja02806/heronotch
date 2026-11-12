import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, type CSSProperties } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { CollapsedBar } from './components/CollapsedBar'
import { Footer } from './components/Footer'
import { Header } from './components/Header'
import { Toasts } from './components/Toasts'
import { ACCENTS } from './lib/theme'
import { Dashboard } from './pages/Dashboard'
import { MusicPage } from './pages/MusicPage'
import { NotesPage } from './pages/NotesPage'
import { PlannerPage } from './pages/PlannerPage'
import { PosturePage } from './pages/PosturePage'
import { SessionsPage } from './pages/SessionsPage'
import { SettingsPage } from './pages/SettingsPage'
import { AppProvider, useApp, type Page } from './state/AppContext'
import { MediaProvider } from './state/MediaContext'
import { PostureProvider } from './state/PostureContext'

const PAGE_KEYS: Record<string, Page> = {
  '1': 'home',
  '2': 'notes',
  '3': 'music',
  '4': 'planner',
  '5': 'sessions',
  '6': 'posture',
  '7': 'settings'
}

function Shell() {
  const { state, expanded, backdrop, setExpanded, pinned, page, setPage } = useApp()
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerInside = useRef(false)
  const accent = ACCENTS[state.settings.accent]

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent.color)
    document.documentElement.style.setProperty('--accent-soft', accent.soft)
    document.documentElement.style.setProperty('--accent-deep', accent.deep)
    document.documentElement.dataset.accent = state.settings.accent
  }, [accent, state.settings.accent])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if (event.key === 'Escape') {
        if (document.body.classList.contains('interaction-locked')) return
        if (typing) {
          ;(target as HTMLElement).blur()
          return
        }
        setExpanded(false)
        return
      }
      if (typing) return
      if (event.key in PAGE_KEYS && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault()
        setPage(PAGE_KEYS[event.key])
        if (!expanded) setExpanded(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded, setExpanded, setPage])

  useEffect(() => {
    return () => {
      if (expandTimer.current) clearTimeout(expandTimer.current)
      if (collapseTimer.current) clearTimeout(collapseTimer.current)
    }
  }, [])

  const clearTimers = (): void => {
    if (expandTimer.current) clearTimeout(expandTimer.current)
    if (collapseTimer.current) clearTimeout(collapseTimer.current)
    expandTimer.current = null
    collapseTimer.current = null
  }

  const onPointerEnter = (): void => {
    pointerInside.current = true
    if (expanded) {
      if (collapseTimer.current) clearTimeout(collapseTimer.current)
      return
    }
    if (expandTimer.current) clearTimeout(expandTimer.current)
    expandTimer.current = setTimeout(() => {
      setExpanded(true)
    }, state.settings.hoverDelay)
  }

  const onPointerMove = (): void => {
    pointerInside.current = true
  }

  const onPointerLeave = (): void => {
    const wasInside = pointerInside.current
    pointerInside.current = false
    if (expandTimer.current) clearTimeout(expandTimer.current)
    if (!expanded) return
    if (!wasInside) return
    if (pinned) return
    const active = document.activeElement as HTMLElement | null
    const editing =
      active &&
      (active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT' ||
        active.isContentEditable)
    if (editing || document.body.classList.contains('interaction-locked')) return
    if (collapseTimer.current) clearTimeout(collapseTimer.current)
    collapseTimer.current = setTimeout(() => setExpanded(false), 700)
  }

  const openImmediately = (): void => {
    clearTimers()
    setExpanded(true)
  }

  const appStyle = {
    '--accent': accent.color,
    '--accent-soft': accent.soft,
    '--accent-deep': accent.deep
  } as CSSProperties

  return (
    <div
      className={`app ${expanded ? 'is-expanded is-focus-mode' : 'is-collapsed'}`}
      style={appStyle}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      {expanded && (
        <div
          className="focus-backdrop"
          onClick={() => setExpanded(false)}
          aria-hidden="true"
        >
          {backdrop && (
            <div
              className="focus-backdrop-image"
              style={{ backgroundImage: `url("${backdrop}")` }}
            />
          )}
          <div className="focus-backdrop-tint" />
          <span className="focus-hint">Focused · click outside to close</span>
        </div>
      )}
      {expanded ? (
        <motion.div
          className="panel"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          <Header />
          <main className="page-host">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={page}
                className="page-frame"
                initial={{ opacity: 0, y: 9 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.17, ease: [0.22, 1, 0.36, 1] }}
              >
                {page === 'home' && <Dashboard />}
                {page === 'notes' && <NotesPage />}
                {page === 'music' && <MusicPage />}
                {page === 'planner' && <PlannerPage />}
                {page === 'sessions' && <SessionsPage />}
                {page === 'posture' && <PosturePage />}
                {page === 'settings' && <SettingsPage />}
              </motion.div>
            </AnimatePresence>
          </main>
          <Footer />
        </motion.div>
      ) : (
        <CollapsedBar onOpen={openImmediately} />
      )}
      <Toasts />
    </div>
  )
}

export function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <MediaProvider>
          <PostureProvider>
            <Shell />
          </PostureProvider>
        </MediaProvider>
      </AppProvider>
    </ErrorBoundary>
  )
}
