import { useCallback, useEffect } from 'react'
import {
  calendarDayCacheKey,
  type CalendarDeleteResult,
  type CalendarDraft,
  type CalendarEvent,
  type CalendarSaveResult,
  type CalendarStatus,
  type GoogleCalendar
} from '../../../shared/calendar'
import { newEventId } from '../../../shared/taskEvent'
import { type CalendarPhase } from './calendarCache'
import { useCalendarStore, useCalendarStoreState } from './CalendarContext'

export interface GoogleCalendarBook {
  phase: CalendarPhase
  status: CalendarStatus | null
  error: string | null
  calendars: GoogleCalendar[] | null
  picked: string | null
  writable: boolean
  events: CalendarEvent[] | null
  loading: boolean
  truncated: boolean
  saving: boolean
  /** Connected, readable and writable: tasks can be mirrored to this calendar. */
  canSync: boolean
  pickedCalendar: GoogleCalendar | null
  setPicked: (id: string | null) => void
  reload: () => void
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  saveDraft: (draft: CalendarDraft, editing: boolean) => Promise<CalendarSaveResult>
  saveEvent: (event: CalendarEvent, draft: CalendarDraft) => Promise<CalendarSaveResult>
  removeEvent: (eventId: string) => Promise<CalendarDeleteResult>
  newEventId: () => string
  pending: {
    save: () => Promise<void>
    clear: () => void
    exists: boolean
  }
}

/** Reads the selected Google calendar's time zone synchronously from the cache. */
export function usePickedCalendarTimeZone(): string | null {
  const storeState = useCalendarStoreState()
  return storeState.calendars?.find((entry) => entry.id === storeState.picked)?.timeZone ?? null
}

/**
 * Owns the Google Calendar connection, the selected calendar and the events for
 * one day, backed by an app-wide Stale-While-Revalidate cache.
 */
export function useGoogleCalendar(date: string, timeZone?: string): GoogleCalendarBook {
  const store = useCalendarStore()
  const storeState = useCalendarStoreState()

  useEffect(() => {
    void store.ensureView(date, timeZone)
  }, [store, date, timeZone, storeState.picked])

  const reload = useCallback(() => {
    void store.ensureView(date, timeZone, true)
  }, [store, date, timeZone])

  const clearPending = useCallback(() => {
    store.clearPending(date, timeZone)
  }, [store, date, timeZone])

  const pickedCalendar = storeState.calendars?.find((entry) => entry.id === storeState.picked) ?? null
  const writable = Boolean(pickedCalendar?.writable)
  const usable = storeState.phase === 'ready' && Boolean(storeState.picked)
  const viewKey = storeState.picked ? calendarDayCacheKey(storeState.picked, date, timeZone) : ''
  const cachedDay = viewKey ? storeState.days[viewKey] : undefined
  const error = storeState.error || (viewKey ? storeState.viewErrors[viewKey] ?? null : null)
  const loading = Boolean((viewKey && storeState.loadingViews[viewKey]) || storeState.metadataLoading)

  return {
    phase: storeState.phase,
    status: storeState.status,
    error,
    calendars: storeState.calendars,
    picked: storeState.picked,
    writable,
    events: cachedDay ? cachedDay.events : null,
    loading,
    truncated: cachedDay ? cachedDay.truncated : false,
    saving: storeState.saving,
    canSync: usable && writable && Boolean(storeState.status?.connected),
    pickedCalendar,
    setPicked: store.setPicked,
    reload,
    connect: store.connect,
    disconnect: store.disconnect,
    saveDraft: store.saveDraft,
    saveEvent: store.saveEvent,
    removeEvent: store.removeEvent,
    newEventId,
    pending: {
      save: store.retryPending,
      clear: clearPending,
      exists: Boolean(storeState.pending)
    }
  }
}
