import { useSyncExternalStore } from 'react'

/**
 * A one-second clock that only re-renders components that read it.
 * The old 500ms `now` value lived on the app context, so every consumer
 * re-rendered twice a second, including during the open animation.
 */

let current = Date.now()
const listeners = new Set<() => void>()
let timer: number | null = null
let paused = false

function emit(): void {
  if (paused) return
  current = Date.now()
  listeners.forEach((listener) => listener())
}

function ensure(): void {
  if (timer !== null) return
  // Resuming after an idle stretch: refresh the value first, so the first read
  // is not a timestamp from the last time anything was listening.
  current = Date.now()
  timer = window.setInterval(emit, 1000)
}

export function subscribeClock(listener: () => void): () => void {
  listeners.add(listener)
  ensure()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }
}

export function useNow(): number {
  return useSyncExternalStore(subscribeClock, () => current, () => Date.now())
}

const idleSubscribe = (): (() => void) => () => undefined

/**
 * Same clock, but only while `active`. A paused track does not need a fresh
 * timestamp every second, and staying unsubscribed lets the interval stop
 * entirely instead of re-rendering whatever reads it once a second.
 */
export function useNowWhen(active: boolean): number {
  return useSyncExternalStore(active ? subscribeClock : idleSubscribe, () => current, () =>
    Date.now()
  )
}

/** Hold clock updates for a short animation so a tick cannot land mid-flight. */
export function setClockPaused(next: boolean): void {
  paused = next
  if (!next) emit()
}
