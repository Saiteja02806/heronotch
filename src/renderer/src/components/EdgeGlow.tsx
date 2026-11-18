import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * A thin accent light that travels the visible outline once, then fades.
 * The stroke stays inside the host, so it does not change hit testing.
 * Reduced motion replaces the sweep with a short fade of the same line.
 */

let claimedTick = 0

interface Outline {
  w: number
  h: number
  r: number
  flat: boolean
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function outlinePath(width: number, height: number, radius: number, flatTop: boolean): string {
  const inset = 1.2
  const left = inset
  const top = inset
  const right = Math.max(left + 2, width - inset)
  const bottom = Math.max(top + 2, height - inset)
  const r = Math.max(0, Math.min(radius, (right - left) / 2, (bottom - top) / 2))
  if (r < 0.75) {
    if (flatTop) return `M ${left} ${top} L ${left} ${bottom} L ${right} ${bottom} L ${right} ${top}`
    return `M ${left} ${top} H ${right} V ${bottom} H ${left} Z`
  }
  if (flatTop) {
    return [
      `M ${round(left)} ${round(top)}`,
      `L ${round(left)} ${round(bottom - r)}`,
      `A ${round(r)} ${round(r)} 0 0 0 ${round(left + r)} ${round(bottom)}`,
      `L ${round(right - r)} ${round(bottom)}`,
      `A ${round(r)} ${round(r)} 0 0 0 ${round(right)} ${round(bottom - r)}`,
      `L ${round(right)} ${round(top)}`
    ].join(' ')
  }
  // Start on the left edge (mid-height) so the light enters from the side edges,
  // runs down and around the bottom, up the right edge, then across the top.
  const midY = (top + bottom) / 2
  return [
    `M ${round(left)} ${round(midY)}`,
    `V ${round(bottom - r)}`,
    `A ${round(r)} ${round(r)} 0 0 0 ${round(left + r)} ${round(bottom)}`,
    `H ${round(right - r)}`,
    `A ${round(r)} ${round(r)} 0 0 0 ${round(right)} ${round(bottom - r)}`,
    `V ${round(top + r)}`,
    `A ${round(r)} ${round(r)} 0 0 0 ${round(right - r)} ${round(top)}`,
    `H ${round(left + r)}`,
    `A ${round(r)} ${round(r)} 0 0 0 ${round(left)} ${round(top + r)}`,
    'Z'
  ].join(' ')
}

export function EdgeGlow({ tick, ready }: { tick: number; ready: boolean }) {
  const probe = useRef<HTMLSpanElement>(null)
  const lastTick = useRef(0)
  const [play, setPlay] = useState(0)
  const [box, setBox] = useState<Outline | null>(null)

  useEffect(() => {
    if (tick === 0 || tick === lastTick.current) return
    lastTick.current = tick
    if (!ready) return
    setPlay(tick)
  }, [tick, ready])

  useLayoutEffect(() => {
    if (!play) return
    const host = probe.current?.parentElement
    if (!host) return
    const rect = host.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return
    const style = getComputedStyle(host)
    const bottom = parseFloat(style.borderBottomLeftRadius) || 0
    const top = parseFloat(style.borderTopLeftRadius) || 0
    setBox({
      w: rect.width,
      h: rect.height,
      r: Math.min(bottom, rect.width / 2, rect.height / 2),
      flat: top < 1
    })
    const timer = window.setTimeout(() => {
      setPlay(0)
      setBox(null)
    }, 1450)
    return () => window.clearTimeout(timer)
  }, [play])

  const gradient = `edge-glow-${play}`
  const path = box ? outlinePath(box.w, box.h, box.r, box.flat) : ''

  return (
    <>
      <span ref={probe} className="edge-glow-probe" aria-hidden="true" />
      {box && play > 0 && (
        <svg
          key={play}
          className="edge-glow"
          viewBox={`0 0 ${box.w} ${box.h}`}
          width={box.w}
          height={box.h}
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={box.w} y2={box.h}>
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.15" />
              <stop offset="0.42" stopColor="var(--accent)" />
              <stop offset="1" stopColor="#ffffff" />
            </linearGradient>
          </defs>
          <path className="edge-glow-halo" d={path} pathLength={100} stroke={`url(#${gradient})`} />
          <path className="edge-glow-line" d={path} pathLength={100} stroke={`url(#${gradient})`} />
        </svg>
      )}
    </>
  )
}
