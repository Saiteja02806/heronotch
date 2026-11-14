import { AnimatePresence, motion, type TargetAndTransition } from 'framer-motion'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { NotchMetrics } from '../../shared/types'
import { dockedPanelLeft, dockedPanelSize } from '../../shared/notchLayout'
import { ErrorBoundary } from './components/ErrorBoundary'
import { CollapsedBar } from './components/CollapsedBar'
import { EdgeGlow } from './components/EdgeGlow'
import { CollapsedNotice } from './components/CollapsedNotice'
import { CompactSlotProvider } from './components/CompactSlot'
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
import { WaterPage } from './pages/WaterPage'
import { OPTIONAL_SECTIONS, sectionEnabled } from './lib/sections'
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

const FLIGHT_MS = 420

function pageForKey(key: string, enabled: (page: Page) => boolean): Page | null {
  if (key in PAGE_KEYS) return PAGE_KEYS[key]
  const extra = OPTIONAL_SECTIONS.find((section) => section.shortcut === key)
  if (!extra || !enabled(extra.page)) return null
  return extra.page
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function applyTabMetrics(next: NotchMetrics): void {
  const root = document.documentElement
  root.style.setProperty('--tab-left', `${next.tab.x}px`)
  root.style.setProperty('--tab-top', `${next.tab.y}px`)
  root.style.setProperty('--tab-w', `${next.tab.width}px`)
  root.style.setProperty('--tab-h', `${next.tab.height}px`)
  root.style.setProperty('--tab-tx', '0px')
  root.classList.add('tab-ready')
}

function flightBox(
  left: number,
  top: number,
  width: number,
  height: number,
  topRadius: number,
  bottomRadius: number
): TargetAndTransition {
  return {
    left,
    top,
    width,
    height,
    borderTopLeftRadius: topRadius,
    borderTopRightRadius: topRadius,
    borderBottomRightRadius: bottomRadius,
    borderBottomLeftRadius: bottomRadius
  }
}

function Shell() {
  const { state, expanded, backdrop, viewport, setExpanded, pinned, page, setPage, toasts, openSettings, glowTick } =
    useApp()
  const compact = state.settings.panelSize === 'compact'
  const focusMode = state.settings.focusMode !== false
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerInside = useRef(false)
  const reopenBlockedUntil = useRef(0)
  const ignoreLeaveUntil = useRef(0)
  const expandedRef = useRef(expanded)
  const closingRef = useRef(false)
  const closeSent = useRef(false)
  const closeGen = useRef(0)
  const closeStartedAt = useRef(0)
  const metricsRef = useRef<NotchMetrics | null>(null)
  const [metrics, setMetrics] = useState<NotchMetrics | null>(null)
  const [closing, setClosing] = useState(false)
  const [settled, setSettled] = useState(false)
  const accent = ACCENTS[state.settings.accent]
  expandedRef.current = expanded
  const sawExpanded = useRef(expanded)
  if (expanded && !sawExpanded.current) ignoreLeaveUntil.current = Date.now() + FLIGHT_MS + 80
  sawExpanded.current = expanded

  const publishMetrics = useCallback((next: NotchMetrics | null) => {
    if (!next) return
    metricsRef.current = next
    setMetrics(next)
    applyTabMetrics(next)
  }, [])

  useLayoutEffect(() => {
    let alive = true
    void window.notch.getMetrics().then((next) => {
      if (alive) publishMetrics(next)
    })
    const off = window.notch.onMetrics((next) => publishMetrics(next))
    const giveUp = window.setTimeout(() => document.documentElement.classList.add('tab-ready'), 600)
    return () => {
      alive = false
      off()
      window.clearTimeout(giveUp)
    }
  }, [publishMetrics])

  const finishClose = useCallback((generation: number) => {
    if (closeGen.current !== generation || closeSent.current) return
    closeSent.current = true
    void window.notch.setExpanded(false)
  }, [])

  const beginClose = useCallback(() => {
    if (!expandedRef.current || closingRef.current) return
    if (prefersReducedMotion()) {
      void window.notch.setExpanded(false)
      return
    }
    const generation = ++closeGen.current
    closingRef.current = true
    closeSent.current = false
    closeStartedAt.current = Date.now()
    setClosing(true)
    window.setTimeout(() => finishClose(generation), FLIGHT_MS + 90)
  }, [finishClose])

  useEffect(() => {
    const onClose = (): void => beginClose()
    const off = window.notch.onRequestClose(onClose)
    window.addEventListener('notch-request-close', onClose)
    const offPrepare = window.notch.onPrepareOpen(() => {
      document.documentElement.classList.add('notch-opening')
      window.setTimeout(() => {
        if (!expandedRef.current) document.documentElement.classList.remove('notch-opening')
      }, 500)
    })
    return () => {
      off()
      offPrepare()
      window.removeEventListener('notch-request-close', onClose)
    }
  }, [beginClose])

  useEffect(() => {
    if (!expanded) {
      reopenBlockedUntil.current = Date.now() + 400
      closingRef.current = false
      setClosing(false)
      setSettled(false)
      return
    }
    closeGen.current += 1
    closingRef.current = false
    closeSent.current = false
    setClosing(false)
    document.documentElement.classList.remove('notch-opening')
  }, [expanded])

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
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const next = pageForKey(event.key, (target) => {
        const section = OPTIONAL_SECTIONS.find((item) => item.page === target)
        return section ? sectionEnabled(state, section.id) : true
      })
      if (!next) return
      event.preventDefault()
      setPage(compact && next === 'home' ? 'notes' : next)
      if (!expanded) setExpanded(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [compact, expanded, setExpanded, setPage, state.water.enabled])

  useEffect(() => {
    if (compact && page === 'home') setPage('notes')
  }, [compact, page, setPage])

  useEffect(() => {
    if (page === 'water' && !state.water.enabled) setPage(compact ? 'notes' : 'home')
  }, [compact, page, setPage, state.water.enabled])

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
  }, [expanded, metrics, state.settings.notchStyle, toasts])

  useEffect(() => {
    if (!expanded) return
    if (focusMode) {
      window.notch.setShape({ focusOff: true, rects: null })
      return
    }
    // No backdrop, so the window must not cover the desktop. Shape input and
    // drawing to the panel and any toast; everything else falls through.
    let frame = 0
    let last = ''
    const report = (): void => {
      const nodes: Element[] = [
        ...document.querySelectorAll('.panel'),
        ...document.querySelectorAll('.toast')
      ]
      const rects = nodes.flatMap((node) => {
        if (!(node instanceof HTMLElement)) return []
        const rect = node.getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2) return []
        return [
          {
            x: Math.max(0, Math.floor(rect.left) - 2),
            y: Math.max(0, Math.floor(rect.top) - 2),
            width: Math.ceil(rect.width) + 6,
            height: Math.ceil(rect.height) + 6
          }
        ]
      })
      const key = JSON.stringify(rects)
      if (rects.length > 0 && key !== last) {
        last = key
        window.notch.setShape({ focusOff: true, rects })
      }
      frame = window.requestAnimationFrame(report)
    }
    frame = window.requestAnimationFrame(report)
    return () => window.cancelAnimationFrame(frame)
  }, [expanded, focusMode, compact, page, toasts, settled, closing])

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
    if (!expanded || closingRef.current) return
    if (Date.now() < ignoreLeaveUntil.current) return
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

  const reduce = prefersReducedMotion()
  const tabWidth = metrics?.tabScreen.width ?? 200
  const tabHeight = metrics?.tabScreen.height ?? 28
  const tabRadius = metrics?.tab.radius ?? 12
  const pill = tabRadius >= 400
  const tabLeft = metrics ? metrics.tabScreen.x - window.screenX : Math.round((viewport.width - tabWidth) / 2)
  const tabTop = metrics ? metrics.tabScreen.y - window.screenY : 0
  const tabShape = flightBox(
    tabLeft,
    tabTop,
    tabWidth,
    tabHeight,
    pill ? tabHeight / 2 : 0,
    pill ? tabHeight / 2 : Math.min(tabRadius, tabHeight / 2)
  )
  const dockedSize = dockedPanelSize(viewport.width, viewport.height, compact)
  const docked = flightBox(
    dockedPanelLeft(tabLeft + tabWidth / 2, dockedSize.width, viewport.width),
    0,
    dockedSize.width,
    dockedSize.height,
    0,
    compact ? 22 : 30
  )
  const from = reduce ? docked : tabShape
  const to = closing ? tabShape : docked
  const appStyle = {
    '--accent': accent.color,
    '--accent-soft': accent.soft,
    '--accent-deep': accent.deep,
    '--panel-h': `${dockedSize.height}px`,
    '--panel-w': `${dockedSize.width}px`,
    '--panel-left': `${typeof docked.left === 'number' ? docked.left : 0}px`
  } as CSSProperties

  return (
    <div
      className={`app ${expanded ? 'is-expanded' : 'is-collapsed'}${
        expanded && focusMode ? ' is-focus-mode' : ''
      }${compact ? ' is-panel-compact' : ''}${metrics?.noticeAbove ? ' is-notice-above' : ''}`}
      style={appStyle}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      {expanded && focusMode && (
        <div
          className={`focus-backdrop${closing ? ' is-closing' : ''}`}
          onClick={() => setExpanded(false)}
        >
          {backdrop && (
            <div
              className="focus-backdrop-image"
              style={{ backgroundImage: `url("${backdrop}")` }}
            />
          )}
          <div className="focus-backdrop-tint" />
          {settled && !closing && (
            <span className="focus-hint">
              Focused · click outside to close · turn off focus mode in{' '}
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  openSettings('notch')
                }}
              >
                Settings
              </button>
            </span>
          )}
        </div>
      )}
      {expanded ? (
        <motion.div
          className={`panel is-spatial${!settled || closing ? ' is-flying' : ''}${closing ? ' is-closing' : ''}`}
          initial={from}
          animate={to}
          transition={{ duration: reduce ? 0 : FLIGHT_MS / 1000, ease: [0.22, 1, 0.36, 1] }}
          onAnimationComplete={() => {
            if (closingRef.current) {
              if (!prefersReducedMotion() && Date.now() - closeStartedAt.current < FLIGHT_MS - 40) return
              finishClose(closeGen.current)
              return
            }
            setSettled(true)
          }}
        >
          <motion.div
            className="panel-body"
            initial={{ opacity: reduce ? 1 : 0 }}
            animate={{ opacity: closing ? 0 : 1 }}
            transition={{ duration: reduce ? 0 : 0.2, delay: closing || reduce ? 0 : 0.12 }}
          >
            <CompactSlotProvider>
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
                    {page === 'water' && <WaterPage />}
                    {page === 'settings' && <SettingsPage />}
                  </motion.div>
                </AnimatePresence>
              </main>
              <Footer />
            </CompactSlotProvider>
          </motion.div>
          <EdgeGlow tick={glowTick} ready={settled && !closing} />
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
