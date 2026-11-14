import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, type CSSProperties } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { CollapsedBar } from './components/CollapsedBar'
import { CollapsedNotice } from './components/CollapsedNotice'
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
  const { state, expanded, backdrop, setExpanded, pinned, page, setPage, toasts } = useApp()
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerInside = useRef(false)
  const reopenBlockedUntil = useRef(0)
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

  useEffect(() => {
    // After a collapse the pointer is often still sitting on the notch (for
    // example: hover to open, press Esc). No pointerenter fires again, so hover
    // would look dead until the cursor leaves and returns. Re-arming on the
    // next pointermove fixes that, and the short block stops Esc from reopening
    // the notch immediately.
    if (!expanded) reopenBlockedUntil.current = Date.now() + 400
  }, [expanded])

  useEffect(() => {
    if (expanded) return
    // Shape the window to the tab. Windows refuses to make the window shorter
    // than ~38px, and the leftover transparent margin used to block the hover
    // of whatever is behind it (a browser tab), so no hand cursor appeared
    // there. Outside this rectangle the mouse now falls through.
    const report = (): void => {
      const bar = document.querySelector('.collapsed-bar')
      if (!(bar instanceof HTMLElement)) return
      const notice = document.querySelector('.notch-notice')
      const rects = [bar, notice]
        .filter((element): element is HTMLElement => element instanceof HTMLElement)
        .map((element) => element.getBoundingClientRect())
      const barRect = bar.getBoundingClientRect()
      document.documentElement.style.setProperty(
        '--collapsed-bar-bottom',
        `${Math.round(barRect.bottom)}px`
      )
      const left = Math.min(...rects.map((rect) => rect.left))
      const top = Math.min(...rects.map((rect) => rect.top))
      const right = Math.max(...rects.map((rect) => rect.right))
      const bottom = Math.max(...rects.map((rect) => rect.bottom))
      const x = Math.max(0, Math.round(left - 4))
      const y = Math.max(0, Math.round(top - 4))
      window.notch.setShape({
        x,
        y,
        width: Math.max(1, Math.round(right + 4) - x),
        height: Math.max(1, Math.round(bottom + 4) - y)
      })
    }
    report()
    const observer = new ResizeObserver(report)
    const bar = document.querySelector('.collapsed-bar')
    const notice = document.querySelector('.notch-notice')
    if (bar) observer.observe(bar)
    if (notice) observer.observe(notice)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [expanded, state.settings.notchStyle, toasts])

  const armExpand = (): void => {
    if (state.settings.openTrigger === 'click') return
    if (expanded || expandTimer.current) return
    if (Date.now() < reopenBlockedUntil.current) return
    expandTimer.current = setTimeout(() => {
      expandTimer.current = null
      setExpanded(true)
    }, state.settings.hoverDelay)
  }

  const onPointerEnter = (): void => {
    pointerInside.current = true
    if (expanded) {
      if (collapseTimer.current) clearTimeout(collapseTimer.current)
      return
    }
    armExpand()
  }

  const onPointerMove = (): void => {
    pointerInside.current = true
    armExpand()
  }

  const onPointerLeave = (): void => {
    const wasInside = pointerInside.current
    pointerInside.current = false
    if (expandTimer.current) {
      clearTimeout(expandTimer.current)
      expandTimer.current = null
    }
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
      {expanded ? <Toasts /> : <CollapsedNotice onOpen={openImmediately} />}
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
