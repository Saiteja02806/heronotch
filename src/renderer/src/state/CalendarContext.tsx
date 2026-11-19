import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useApp } from './AppContext'
import { createCalendarStore, type CalendarStoreState } from './calendarCache'

export type CalendarStore = ReturnType<typeof createCalendarStore>

const CalendarContext = createContext<CalendarStore | null>(null)

/**
 * Keeps Google Calendar status, calendars, and recently viewed day events alive
 * across tab navigation and app restarts so switching to Plan renders cached
 * data immediately while revalidating silently when needed.
 */
export function CalendarProvider({ children }: { children: ReactNode }) {
  const { showToast } = useApp()
  const showToastRef = useRef(showToast)
  showToastRef.current = showToast

  const storeRef = useRef<CalendarStore | null>(null)
  if (!storeRef.current) {
    storeRef.current = createCalendarStore({
      api: window.notch.calendar,
      onToast: (title, message, tone) => showToastRef.current(title, message, tone)
    })
  }

  useEffect(() => {
    void storeRef.current?.hydrate()
  }, [])

  return <CalendarContext.Provider value={storeRef.current}>{children}</CalendarContext.Provider>
}

export function useCalendarStore(): CalendarStore {
  const store = useContext(CalendarContext)
  if (!store) throw new Error('useCalendarStore must be used inside CalendarProvider')
  return store
}

export function useCalendarStoreState(): CalendarStoreState {
  const store = useCalendarStore()
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
