import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
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
import { sectionPrefs, visibleSections, type SectionId } from './lib/sections'
import { AppProvider, useApp } from './state/AppContext'
import { setClockPaused } from './state/clock'
import { MediaProvider } from './state/MediaContext'
import { PostureProvider } from './state/PostureContext'

const OPEN_MS = 280

function pageForKey(key: string, visible: SectionId[]): SectionId | null {
  const index = Number(key) - 1
  if (!Number.isInteger(index) || index < 0 || index >= visible.length) return null
  return visible[index] ?? null
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

function usePreparedBackdrop(source: string | null): string | null {
  const [prepared, setPrepared] = useState<string | null>(null)
  useEffect(() => {
    if (!source) {
      setPrepared(null)
      return
    }
    let cancelled = false
    const image = new Image()
    image.onload = () => {
      const width = 480
      const height = Math.max(1, Math.round((width * image.height) / Math.max(1, image.width)))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) return
      context.filter = 'blur(16px)'
      context.drawImage(image, -24, -24, width + 48, height + 48)
      if (!cancelled) setPrepared(canvas.toDataURL('image/jpeg', 0.72))
    }
    image.src = source
    return () => {
      cancelled = true
    }
  }, [source])
  return prepared
}

function Shell() {
  const { state, expanded, backdrop, viewport, setExpanded, pinned, page, setPage, toasts, openSettings, glowTick } =
    useApp()
  const preparedBackdrop = usePreparedBackdrop(backdrop)
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
  if (expanded && !sawExpanded.current) ignoreLeaveUntil.current = Date.now() + OPEN_MS + 40
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
    window.setTimeout(() => finishClose(generation), OPEN_MS + 40)
  }, [finishClose])

  useEffect(() => {
    const onClose = (): void => beginClose()
    const off = window.notch.onRequestClose(onClose)
    window.addEventListener('notch-request-close', onClose)
    const offPrepare = window.notch.onPrepareOpen(() => {
      document.documentElement.classList.add('notch-opening')
      window.setTimeout(() => {
        if (!expandedRef.current) document.documentElement.classList.remove('notch-opening')
      }, 320)
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
      const next = pageForKey(event.key, visibleSections(sectionPrefs(state), { compact }))
      if (!next) return
      event.preventDefault()
      setPage(next)
      if (!expanded) setExpanded(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [compact, expanded, setExpanded, setPage, state.settings.sections, state.water.enabled])

  useEffect(() => {
    if (page === 'settings') return
    const visible = visibleSections(sectionPrefs(state), { compact })
    if (!visible.includes(page as SectionId)) setPage(visible[0])
  }, [compact, page, setPage, state.settings.sections, state.water.enabled])

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

  useLayoutEffect(() => {
    if (!expanded) return
    const marks = performance.getEntriesByName('notch-open-request')
    const started = marks.length > 0 ? marks[marks.length - 1].startTime : performance.now()
    const frame = window.requestAnimationFrame(() => {
      window.notch.reportTiming('open-first-frame', performance.now() - started)
      performance.clearMarks('notch-open-request')
    })
    return () => window.cancelAnimationFrame(frame)
  }, [expanded])

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

  const reduce = state.settings.reduceMotion === true || prefersReducedMotion()
  const tabWidth = metrics?.tabScreen.width ?? 200
  const tabHeight = metrics?.tabScreen.height ?? 28
  const tabLeft = metrics ? metrics.tab.x : Math.round((viewport.width - tabWidth) / 2)
  const tabTop = metrics ? metrics.tab.y : 0
  const dockedSize = dockedPanelSize(viewport.width, viewport.height, compact)
  const dockedLeft = dockedPanelLeft(tabLeft + tabWidth / 2, dockedSize.width, viewport.width)
  const atTab = (!expanded || closing) && !reduce
  const scaleX = dockedSize.width > 0 ? tabWidth / dockedSize.width : 1
  const scaleY = dockedSize.height > 0 ? tabHeight / dockedSize.height : 1
  const appStyle = {
    '--accent': accent.color,
    '--accent-soft': accent.soft,
    '--accent-deep': accent.deep,
    '--panel-h': `${dockedSize.height}px`,
    '--panel-w': `${dockedSize.width}px`,
    '--panel-left': `${dockedLeft}px`,
    '--flight-x': `${tabLeft - dockedLeft}px`,
    '--flight-y': `${tabTop}px`,
    '--flight-sx': String(scaleX),
    '--flight-sy': String(scaleY)
  } as CSSProperties

  useEffect(() => {
    if (!expanded) return
    if (focusMode) {
      window.notch.setShape({ focusOff: true, rects: null })
      return
    }
    // One shape for the whole flight: the tab and the settled panel. Measuring
    // the transformed box every frame would call setShape on each tick, which
    // is a Win32 region update and drops frames.
    const flight = !settled || closing
    const rects = [
      flight
        ? {
            x: Math.max(0, Math.floor(Math.min(tabLeft, dockedLeft)) - 4),
            y: 0,
            width:
              Math.ceil(Math.max(tabLeft + tabWidth, dockedLeft + dockedSize.width) - Math.min(tabLeft, dockedLeft)) +
              8,
            height: Math.ceil(Math.max(tabTop + tabHeight, dockedSize.height)) + 8
          }
        : {
            x: Math.max(0, Math.floor(dockedLeft) - 2),
            y: 0,
            width: Math.ceil(dockedSize.width) + 6,
            height: Math.ceil(dockedSize.height) + 6
          }
    ]
    for (const node of document.querySelectorAll('.toast')) {
      if (!(node instanceof HTMLElement)) continue
      const rect = node.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) continue
      rects.push({
        x: Math.max(0, Math.floor(rect.left) - 2),
        y: Math.max(0, Math.floor(rect.top) - 2),
        width: Math.ceil(rect.width) + 6,
        height: Math.ceil(rect.height) + 6
      })
    }
    window.notch.setShape({ focusOff: true, rects })
  }, [
    expanded,
    focusMode,
    compact,
    page,
    toasts,
    settled,
    closing,
    tabLeft,
    tabTop,
    tabWidth,
    tabHeight,
    dockedLeft,
    dockedSize.width,
    dockedSize.height
  ])

  useLayoutEffect(() => {
    const system = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.documentElement.classList.toggle('reduce-motion', state.settings.reduceMotion === true || system)
  }, [state.settings.reduceMotion])

  useEffect(() => {
    const flying = ((expanded && !settled) || closing) && !reduce
    setClockPaused(flying)
    return () => setClockPaused(false)
  }, [expanded, settled, closing, reduce])

  useEffect(() => {
    if (!expanded || closing) return
    if (reduce) {
      setSettled(true)
      return
    }
    const timer = window.setTimeout(() => setSettled(true), OPEN_MS + 50)
    return () => window.clearTimeout(timer)
  }, [expanded, closing, reduce])

  return (
    <MotionConfig reducedMotion={reduce ? 'always' : 'user'}>
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
          {preparedBackdrop && (
            <div
              className="focus-backdrop-image is-prepared"
              style={{ backgroundImage: `url("${preparedBackdrop}")` }}
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
      <div
        className={`panel is-spatial ${atTab ? 'is-from-tab' : 'is-open'}${!expanded ? ' is-parked' : ''}${
          closing ? ' is-closing' : ''
        }${reduce ? ' is-instant' : ''}`}
        style={{ left: dockedLeft, top: 0, width: dockedSize.width, height: dockedSize.height }}
        onTransitionEnd={(event) => {
          if (event.propertyName !== 'transform' || event.target !== event.currentTarget) return
          if (closingRef.current) {
            finishClose(closeGen.current)
            return
          }
          if (expandedRef.current) setSettled(true)
        }}
      >
        <div className="panel-body">
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
        </div>
        <EdgeGlow tick={glowTick} ready={settled && !closing && expanded} />
      </div>
      <div className={`collapsed-layer${expanded ? ' is-hidden' : ''}`}>
        <CollapsedBar onOpen={openImmediately} />
        {!expanded && <CollapsedNotice onOpen={openImmediately} />}
      </div>
      {expanded && <Toasts />}
    </div>
    </MotionConfig>
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
