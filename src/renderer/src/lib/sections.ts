import {
  Bot,
  CalendarDays,
  Droplet,
  FileText,
  LayoutGrid,
  ListChecks,
  Music2,
  NotebookPen,
  PersonStanding,
  Smartphone,
  Timer,
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
import { normalizeHomeLayout, type HomeCardId } from '../../../shared/homeLayout'
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
  },
  phone: {
    id: 'phone',
    label: 'Phone',
    icon: Smartphone,
    kept: 'Saved text stays in the draft, and transfers keep expiring on schedule.'
  }
}

export interface HomeCardMeta {
  id: HomeCardId
  label: string
  shortLabel: string
  note: string
  icon: LucideIcon
  /** Header section opened by this card, if any. */
  section?: SectionId
}

export const HOME_CARD_META: Record<HomeCardId, HomeCardMeta> = {
  timer: {
    id: 'timer',
    label: 'Focus',
    shortLabel: 'Focus',
    note: 'Timer, modes and start controls.',
    icon: Timer
  },
  music: {
    id: 'music',
    label: 'Now playing',
    shortLabel: 'Music',
    note: 'Player, album art and queue.',
    icon: Music2,
    section: 'music'
  },
  tasks: {
    id: 'tasks',
    label: 'Today',
    shortLabel: 'Today',
    note: 'Today’s tasks and quick add.',
    icon: ListChecks,
    section: 'planner'
  },
  notes: {
    id: 'notes',
    label: 'Notes',
    shortLabel: 'Notes',
    note: 'Recent notes from your folder.',
    icon: FileText,
    section: 'notes'
  },
  sessions: {
    id: 'sessions',
    label: 'Coding sessions',
    shortLabel: 'Sessions',
    note: 'Live agent activity and recent runs.',
    icon: Bot,
    section: 'sessions'
  },
  calendar: {
    id: 'calendar',
    label: 'Calendar',
    shortLabel: 'Calendar',
    note: 'Month grid and what is next.',
    icon: CalendarDays,
    section: 'planner'
  },
  water: {
    id: 'water',
    label: 'Water',
    shortLabel: 'Water',
    note: 'Daily glasses, goal and drink reminders.',
    icon: Droplet,
    section: 'water'
  },
  posture: {
    id: 'posture',
    label: 'Posture',
    shortLabel: 'Posture',
    note: 'Live posture score and camera coach.',
    icon: PersonStanding,
    section: 'posture'
  },
  phone: {
    id: 'phone',
    label: 'Phone',
    shortLabel: 'Phone',
    note: 'Same-Wi-Fi file and text transfer.',
    icon: Smartphone,
    section: 'phone'
  }
}

export function sectionPrefs(state: AppState) {
  return normalizeSectionPrefs(state.settings.sections, Boolean(state.water?.enabled))
}

export function sectionVisible(state: AppState, id: SectionId, compact = false): boolean {
  return visibleSections(sectionPrefs(state), { compact }).includes(id)
}

/** A Home card is offered only while its header section is on (Focus has none). */
export function homeCardAvailable(state: AppState, id: HomeCardId): boolean {
  const section = HOME_CARD_META[id].section
  return !section || sectionVisible(state, section)
}

/** The saved Home layout, with older saves keeping Water in Music's spot. */
export function homeLayoutFor(state: AppState) {
  return normalizeHomeLayout(state.settings.homeLayout, {
    legacyWaterInMusicSlot: !sectionVisible(state, 'music') && sectionVisible(state, 'water')
  })
}
