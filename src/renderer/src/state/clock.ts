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

/** Hold clock updates for a short animation so a tick cannot land mid-flight. */
export function setClockPaused(next: boolean): void {
  paused = next
  if (!next) emit()
}
