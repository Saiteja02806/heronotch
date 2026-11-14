import {
  Bot,
  CalendarDays,
  Droplet,
  LayoutGrid,
  Music2,
  NotebookPen,
  PersonStanding,
  type LucideIcon
} from 'lucide-react'
import {
  moveSection,
  normalizeSectionPrefs,
  SECTION_IDS,
  toggleSection,
  visibleSections,
  type SectionId
} from '../../../shared/sections'
import type { AppState } from '../../../shared/types'

export { moveSection, SECTION_IDS, toggleSection, visibleSections, type SectionId }

export interface SectionMeta {
  id: SectionId
  label: string
  /** What stays when the section is taken off the notch. */
  kept: string
}

export const SECTION_META: Record<SectionId, SectionMeta & { icon: LucideIcon }> = {
  home: {
    id: 'home',
    label: 'Home',
    icon: LayoutGrid,
    kept: 'The focus timer keeps running, and its history stays.'
  },
  notes: {
    id: 'notes',
    label: 'Notes',
    icon: NotebookPen,
    kept: 'The folder stays connected. Nothing is unread or removed.'
  },
  music: {
    id: 'music',
    label: 'Music',
    icon: Music2,
    kept: 'Spotify stays connected, including the track on the collapsed tab.'
  },
  planner: {
    id: 'planner',
    label: 'Plan',
    icon: CalendarDays,
    kept: 'Tasks and reminders stay. Reminders still arrive on time.'
  },
  sessions: {
    id: 'sessions',
    label: 'Sessions',
    icon: Bot,
    kept: 'Session history stays, and the collapsed tab still counts live ones.'
  },
  posture: {
    id: 'posture',
    label: 'Posture',
    icon: PersonStanding,
    kept: 'The camera turns off. Your baseline and today’s score stay.'
  },
  water: {
    id: 'water',
    label: 'Water',
    icon: Droplet,
    kept: 'Today’s glasses and your goal stay saved.'
  }
}

export function sectionPrefs(state: AppState) {
  return normalizeSectionPrefs(state.settings.sections, Boolean(state.water?.enabled))
}

export function sectionVisible(state: AppState, id: SectionId, compact = false): boolean {
  return visibleSections(sectionPrefs(state), { compact }).includes(id)
}
