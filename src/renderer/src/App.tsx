import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { NotchMetrics } from '../../shared/types'
import { dockedPanelLeft, dockedPanelSize } from '../../shared/notchLayout'
import { ErrorBoundary } from './components/ErrorBoundary'
import { CollapsedBar } from './components/CollapsedBar'
import { EdgeGlow } from './components/EdgeGlow'
import { CollapsedNotice } from './components/CollapsedNotice'
import { CompactSlotProvider } from './components/CompactSlot'
import { Footer } from './components/Footer'
import { Header } from './components/Header'
import { LicenseGate } from './components/LicenseGate'
import { Toasts } from './components/Toasts'
import type { DemoOverlayState } from '@demo/renderer/DemoOverlay'
import type { DemoDirector } from '@demo/renderer/demoDirector'
import { resolveAccent } from './lib/theme'
import { Dashboard } from './pages/Dashboard'
import { MusicPage } from './pages/MusicPage'
import { NotesPage } from './pages/NotesPage'
import { PlannerPage } from './pages/PlannerPage'
import { PosturePage } from './pages/PosturePage'
import { SessionsPage } from './pages/SessionsPage'
import { SettingsPage } from './pages/SettingsPage'
import { WaterPage } from './pages/WaterPage'
import { PhonePage } from './pages/PhonePage'
import { sectionPrefs, visibleSections, type SectionId } from './lib/sections'
import { AppProvider, useApp } from './state/AppContext'
import { CalendarProvider } from './state/CalendarContext'
import { setClockPaused } from './state/clock'
import { MediaProvider } from './state/MediaContext'
import { PostureProvider } from './state/PostureContext'

const DemoDesktopStage = lazy(() =>
  import('@demo/renderer/DemoDesktopStage').then((m) => ({ default: m.DemoDesktopStage }))
)
const DemoOverlay = lazy(() =>
  import('@demo/renderer/DemoOverlay').then((m) => ({ default: m.DemoOverlay }))
)

const INITIAL_DEMO_UI: DemoOverlayState = {
  cursorX: 0,
  cursorY: 0,
  cursorVisible: false,
  clicking: false,
  rippleKey: 0,
  rippleX: 0,
  rippleY: 0,
  keycap: null,
  caption: null,
  endCardVisible: false,
  running: false,
  paused: false,
  completed: false
}

const OPEN_MS = 240

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
  root.style.setProperty('--inset-right', `${next.inset?.right ?? 0}px`)
  root.style.setProperty('--inset-bottom', `${next.inset?.bottom ?? 0}px`)
  root.classList.add('tab-ready')
}

// The desktop behind focus mode. A transparent window cannot blur what is
// behind it, so main sends the last snapshot of the screen and it is blurred
// here once, into a small image, instead of running a live blur filter.
function useFocusBackdrop(): string | null {
  const [source, setSource] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void window.notch.getBackdrop().then((image) => {
      if (alive && image) setSource(image)
    })
    const off = window.notch.onBackdrop((event) => {
      if (event.image) setSource(event.image)
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  useEffect(() => {
    if (!source) return
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
      context.filter = 'blur(14px)'
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
  const focusBackdrop = useFocusBackdrop()
  const {
    state,
    expanded,
    viewport,
    setExpanded,
    pinned,
    page,
    setPage,
    toasts,
    openSettings,
    glowTick,
    agentSnapshot,
    questions,
    openCodePending,
    licenseLocked,
    licenseState,
    clearToasts,
    refreshOpenCode,
    refreshSessions,
    demoConfig,
    demoPlatform,
    setDemoPlatform
  } = useApp()
  const compact = state.settings.panelSize === 'compact'
  const focusMode = state.settings.focusMode !== false
  const isDemoStage = Boolean(demoConfig?.isStage)
  const [demoUi, setDemoUi] = useState<DemoOverlayState>(INITIAL_DEMO_UI)
  const [demoCaptions, setDemoCaptions] = useState(true)
  const demoDirectorRef = useRef<DemoDirector | null>(null)
  const demoHooksRef = useRef({
    setExpanded,
    setPage,
    openSettings,
    clearToasts,
    refreshOpenCode,
    refreshSessions
  })
  demoHooksRef.current = {
    setExpanded,
    setPage,
    openSettings,
    clearToasts,
    refreshOpenCode,
    refreshSessions
  }

  useEffect(() => {
    if (demoConfig) setDemoCaptions(demoConfig.showCaptions)
  }, [demoConfig])

  useEffect(() => {
    if (!demoConfig?.isStage) return
    let active = true
    let startTimer: number | null = null
    let director: DemoDirector | null = null
    let cleanupStart: (() => void) | null = null

    void import('@demo/renderer/demoDirector').then((mod) => {
      if (!active) return
      const created = new mod.DemoDirector(demoHooksRef.current, (next) => setDemoUi(next))
      director = created
      demoDirectorRef.current = created
      setDemoUi(mod.INITIAL_DEMO_UI)
      const startNow = (): void => {
        created.updateHooks(demoHooksRef.current)
        void created.run()
      }
      window.addEventListener('hero-notch-start-demo', startNow)
      cleanupStart = () => window.removeEventListener('hero-notch-start-demo', startNow)
      if (demoConfig.autoPlay) {
        startTimer = window.setTimeout(startNow, 150)
      }
    })

    return () => {
      active = false
      cleanupStart?.()
      if (startTimer !== null) window.clearTimeout(startTimer)
      director?.abort()
      if (director && demoDirectorRef.current === director) demoDirectorRef.current = null
    }
  }, [demoConfig?.isStage, demoConfig?.autoPlay])
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
  const pointerFrame = useRef<number | null>(null)
  const [metrics, setMetrics] = useState<NotchMetrics | null>(null)
  const [closing, setClosing] = useState(false)
  const [settled, setSettled] = useState(false)
  const accent = resolveAccent(state.settings.accent, state.settings.customAccent)
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
      if (typing || licenseLocked) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const next = pageForKey(event.key, visibleSections(sectionPrefs(state), { compact }))
      if (!next) return
      event.preventDefault()
      setPage(next)
      if (!expanded) setExpanded(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [compact, expanded, licenseLocked, setExpanded, setPage, state.settings.sections, state.water.enabled])

  useEffect(() => {
    if (page === 'settings') return
    const visible = visibleSections(sectionPrefs(state), { compact })
    if (!visible.includes(page as SectionId)) setPage(visible[0])
  }, [compact, page, setPage, state.settings.sections, state.water.enabled])

  useEffect(() => {
    return () => {
      if (expandTimer.current) clearTimeout(expandTimer.current)
      if (collapseTimer.current) clearTimeout(collapseTimer.current)
      if (pointerFrame.current !== null) cancelAnimationFrame(pointerFrame.current)
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
      const question = document.querySelector('.notch-question-card')
      // The notice slides in with a transform. Its animated box is a few pixels
      // off for the first frames, and a shape cut from that box clips the card's
      // left and top edge. So the notice is shaped from its layout box (the
      // transform is ignored) with room for the slide on the sides it travels from.
      const layoutBox = (element: HTMLElement, slideX: number, slideY: number): DOMRect => {
        const left = element.offsetLeft
        const top = element.offsetTop
        return new DOMRect(left, top, element.offsetWidth + slideX, element.offsetHeight + slideY)
      }
      const rects = [bar, notice, question]
        .filter((element): element is HTMLElement => element instanceof HTMLElement)
        .map((element) =>
          element === notice ? layoutBox(element, 24, 14) : element.getBoundingClientRect()
        )
      const barRect = bar.getBoundingClientRect()
      // The answer card hangs off the bar it belongs to. --tab-left/--tab-w are
      // the placed tab, which is not where the bar ends up once a style or a
      // wide approval bar reshapes it, so the card uses the measured box.
      document.documentElement.style.setProperty(
        '--collapsed-bar-bottom',
        `${Math.round(barRect.bottom)}px`
      )
      document.documentElement.style.setProperty(
        '--collapsed-bar-top',
        `${Math.round(barRect.top)}px`
      )
      document.documentElement.style.setProperty(
        '--collapsed-bar-center',
        `${Math.round(barRect.left + barRect.width / 2)}px`
      )
      // One region per element. The tab sits at the top and a notice sits in
      // the bottom-right corner, so a box around all of them would swallow
      // the mouse over the whole desktop.
      window.notch.setShape(
        rects.map((rect) => {
          const x = Math.max(0, Math.round(rect.left - 4))
          const y = Math.max(0, Math.round(rect.top - 4))
          return {
            x,
            y,
            width: Math.max(1, Math.round(rect.right + 4) - x),
            height: Math.max(1, Math.round(rect.bottom + 4) - y)
          }
        })
      )
    }
    report()
    // Measure again as the card settles, so the shape never keeps a stale box.
    const settleTimers = [120, 320, 700].map((ms) => window.setTimeout(report, ms))
    const observer = new ResizeObserver(report)
    const bar = document.querySelector('.collapsed-bar')
    const notice = document.querySelector('.notch-notice')
    const question = document.querySelector('.notch-question-card')
    if (bar) observer.observe(bar)
    if (notice) observer.observe(notice)
    if (question) observer.observe(question)
    window.addEventListener('resize', report)
    return () => {
      settleTimers.forEach((timer) => window.clearTimeout(timer))
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [
    expanded,
    metrics,
    state.settings.notchStyle,
    toasts,
    agentSnapshot?.pending.length,
    questions.length,
    openCodePending.length
  ])

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
    if (agentSnapshot?.pending.length || questions.length || openCodePending.length) return
    if (expanded || expandTimer.current) return
    if (Date.now() < reopenBlockedUntil.current) return
    expandTimer.current = setTimeout(() => {
      expandTimer.current = null
      setExpanded(true)
    }, state.settings.hoverDelay)
  }

  const onPointerEnter = (event: ReactPointerEvent<HTMLDivElement>): void => {
    pointerInside.current = true
    if (expanded) {
      if (collapseTimer.current) clearTimeout(collapseTimer.current)
      return
    }
    if (
      event.target instanceof Element &&
      (event.target.closest('.notch-notice') || event.target.closest('.notch-question-card'))
    ) {
      if (expandTimer.current) {
        clearTimeout(expandTimer.current)
        expandTimer.current = null
      }
      return
    }
    armExpand()
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    pointerInside.current = true
    if (
      !expanded &&
      event.target instanceof Element &&
      (event.target.closest('.notch-notice') || event.target.closest('.notch-question-card'))
    ) {
      if (expandTimer.current) {
        clearTimeout(expandTimer.current)
        expandTimer.current = null
      }
      return
    }
    armExpand()
  }

  const onPointerLeave = (): void => {
    const wasInside = pointerInside.current
    pointerInside.current = false
    if (expandTimer.current) {
      clearTimeout(expandTimer.current)
      expandTimer.current = null
    }
    if (isDemoStage) return
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
    // Only real writing protects the panel from closing. An empty composer or a
    // focused button must not pin it open.
    const hasText =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? active.value.trim().length > 0
        : Boolean(active?.isContentEditable && (active.textContent || '').trim().length > 0)
    if ((editing && hasText) || document.body.classList.contains('interaction-locked')) return
    if (collapseTimer.current) clearTimeout(collapseTimer.current)
    collapseTimer.current = setTimeout(() => setExpanded(false), 700)
  }

  // Clicking anywhere outside Notch moves focus away from the window. The main
  // process owns that dismissal (it also knows about native file pickers, which
  // blur the window without being an outside click).
  const openImmediately = (): void => {
    clearTimers()
    setExpanded(true)
  }

  const reduce = state.settings.reduceMotion === true || prefersReducedMotion()

  // A single low-opacity light follows the pointer across the glass. The
  // update is coalesced to one animation frame so moving over the panel never
  // queues a style write per pointer event.
  const trackPointerLight = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (reduce) return
    const panel = event.currentTarget
    const rect = panel.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    const x = ((event.clientX - rect.left) / rect.width) * 100
    const y = ((event.clientY - rect.top) / rect.height) * 100
    if (pointerFrame.current !== null) return
    pointerFrame.current = requestAnimationFrame(() => {
      pointerFrame.current = null
      panel.style.setProperty('--pointer-x', `${x.toFixed(2)}%`)
      panel.style.setProperty('--pointer-y', `${y.toFixed(2)}%`)
      panel.style.setProperty('--pointer-o', '1')
    })
  }

  const fadePointerLight = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (pointerFrame.current !== null) {
      cancelAnimationFrame(pointerFrame.current)
      pointerFrame.current = null
    }
    event.currentTarget.style.setProperty('--pointer-o', '0')
  }

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
    // A toast springs in with a scale and offset. Shape it from its layout box
    // (transform ignored) so the first frames never clip its edge, and measure
    // again once it has settled because this effect does not re-run on its own.
    const toastRects = (): { x: number; y: number; width: number; height: number }[] => {
      const out: { x: number; y: number; width: number; height: number }[] = []
      for (const node of document.querySelectorAll('.toast')) {
        if (!(node instanceof HTMLElement)) continue
        const stack = node.offsetParent instanceof HTMLElement ? node.offsetParent.getBoundingClientRect() : null
        const left = (stack ? stack.left : 0) + node.offsetLeft
        const top = (stack ? stack.top : 0) + node.offsetTop
        if (node.offsetWidth < 2 || node.offsetHeight < 2) continue
        out.push({
          x: Math.max(0, Math.floor(left) - 6),
          y: Math.max(0, Math.floor(top) - 6),
          width: Math.ceil(node.offsetWidth) + 12,
          height: Math.ceil(node.offsetHeight) + 20
        })
      }
      return out
    }
    rects.push(...toastRects())
    window.notch.setShape({ focusOff: true, rects })
    const hasToast = rects.length > 1
    const timers = hasToast
      ? [160, 420, 900].map((ms) =>
          window.setTimeout(() => {
            const next = rects.slice(0, 1).concat(toastRects())
            window.notch.setShape({ focusOff: true, rects: next })
          }, ms)
        )
      : []
    return () => timers.forEach((timer) => window.clearTimeout(timer))
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
      }${expanded && !focusMode ? ' is-shaped' : ''}${compact ? ' is-panel-compact' : ''}${metrics?.noticeAbove ? ' is-notice-above' : ''}${isDemoStage ? ' is-demo-stage' : ''}${demoUi.endCardVisible ? ' is-endcard' : ''}`}
      style={appStyle}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      {isDemoStage && demoConfig && (
        <Suspense fallback={null}>
          <DemoDesktopStage platform={demoPlatform} wallpaperUrl={demoConfig.wallpaperUrl} />
        </Suspense>
      )}
      {expanded && focusMode && (
        <div
          className={`focus-backdrop${closing ? ' is-closing' : ''}`}
          onClick={() => setExpanded(false)}
        >
          {focusBackdrop && (
            <div
              className="focus-backdrop-image is-prepared"
              style={{ backgroundImage: `url("${focusBackdrop}")` }}
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
        }${expanded && !settled && !closing ? ' is-opening' : ''}${reduce ? ' is-instant' : ''}`}
        style={{ left: dockedLeft, top: 0, width: dockedSize.width, height: dockedSize.height }}
        onPointerMove={trackPointerLight}
        onPointerLeave={fadePointerLight}
        onTransitionEnd={(event) => {
          if (event.propertyName !== 'transform' || event.target !== event.currentTarget) return
          if (closingRef.current) {
            finishClose(closeGen.current)
            return
          }
          if (expandedRef.current) setSettled(true)
        }}
      >
        <div className="panel-ambient" aria-hidden="true">
          <span className="liquid-blob is-accent" />
          <span className="liquid-blob is-cool" />
          <span className="liquid-blob is-warm" />
          <span className="liquid-sheen" />
        </div>
        <div className="panel-light" aria-hidden="true" />
        <div className="panel-body">
          {!licenseState ? null : licenseLocked ? (
            <LicenseGate />
          ) : (
            <CompactSlotProvider>
              <Header />
              <main className="page-host">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={page}
                    className="page-frame"
                    initial={isDemoStage ? { opacity: 0.45, y: 4 } : { opacity: 0, y: 9 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={isDemoStage ? undefined : { opacity: 0, y: -5 }}
                    transition={{ duration: isDemoStage ? 0.11 : 0.17, ease: [0.22, 1, 0.36, 1] }}
                  >
                    {page === 'home' && <Dashboard />}
                    {page === 'notes' && <NotesPage />}
                    {page === 'music' && <MusicPage />}
                    {page === 'planner' && <PlannerPage />}
                    {page === 'sessions' && <SessionsPage />}
                    {page === 'posture' && <PosturePage />}
                    {page === 'water' && <WaterPage />}
                    {page === 'phone' && <PhonePage />}
                    {page === 'settings' && <SettingsPage />}
                  </motion.div>
                </AnimatePresence>
              </main>
              <Footer />
            </CompactSlotProvider>
          )}
        </div>
        <EdgeGlow tick={glowTick} ready={settled && !closing && expanded} />
      </div>
      <div className={`collapsed-layer${expanded ? ' is-hidden' : ''}`}>
        <CollapsedBar
          onOpen={openImmediately}
          onOpenSessions={() => {
            setPage('sessions')
            openImmediately()
          }}
          onOpenPosture={() => {
            setPage('posture')
            openImmediately()
          }}
          style={metrics?.style}
        />
        {!expanded && (
          <CollapsedNotice
            onOpen={openImmediately}
            onOpenSection={(section) => {
              setPage(section)
              openImmediately()
            }}
          />
        )}
      </div>
      {expanded && <Toasts />}
      {isDemoStage && demoConfig && (
        <Suspense fallback={null}>
          <DemoOverlay
            ui={demoUi}
            config={demoConfig}
            platform={demoPlatform}
            showCaptions={demoCaptions}
            onToggleCaptions={() => {
              setDemoCaptions((prev) => {
                const next = !prev
                void window.notchDemo?.setCaptions(next)
                return next
              })
            }}
            onTogglePause={() => {
              const dir = demoDirectorRef.current
              if (!dir) return
              if (demoUi.completed || !demoUi.running) {
                dir.updateHooks(demoHooksRef.current)
                void dir.run()
              } else {
                dir.togglePause()
              }
            }}
            onReplay={() => {
              const dir = demoDirectorRef.current
              if (!dir) return
              dir.updateHooks(demoHooksRef.current)
              void dir.run()
            }}
            onSwitchPlatform={(next) => {
              void setDemoPlatform(next)
            }}
          />
        </Suspense>
      )}
    </div>
    </MotionConfig>
  )
}

export function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <CalendarProvider>
          <MediaProvider>
            <PostureProvider>
              <Shell />
            </PostureProvider>
          </MediaProvider>
        </CalendarProvider>
      </AppProvider>
    </ErrorBoundary>
  )
}
