import {
  Bell,
  Bot,
  CalendarDays,
  CircleCheck,
  Droplet,
  Flame,
  Music2,
  NotebookPen,
  PersonStanding,
  ShieldAlert,
  Smartphone,
  Sparkles,
  type LucideIcon
} from 'lucide-react'
import type { Page } from '../state/AppContext'

export type NoticeCategory =
  | 'reminder'
  | 'timer'
  | 'posture'
  | 'water'
  | 'session'
  | 'music'
  | 'calendar'
  | 'notes'
  | 'phone'
  | 'system'

export interface NoticeAction {
  label: string
  onClick: () => void
  variant?: 'primary' | 'soft'
}

export interface NoticeMeta {
  category: NoticeCategory
  badge: string
  cleanTitle: string
  section: Page | null
  sectionLabel: string | null
  icon: LucideIcon
  tint: string
}

const SECTION_LABELS: Record<Page, string> = {
  home: 'Home',
  notes: 'Notes',
  music: 'Music',
  planner: 'Plan',
  sessions: 'Sessions',
  posture: 'Posture',
  water: 'Water',
  phone: 'Phone',
  settings: 'Settings'
}

const AGENT_PROVIDERS: { match: RegExp; label: string }[] = [
  { match: /\bclaude(\s+code)?\b/i, label: 'Claude Code' },
  { match: /\bcodex\b/i, label: 'Codex' },
  { match: /\bcursor\b/i, label: 'Cursor' },
  { match: /\bopencode\b/i, label: 'OpenCode' },
  { match: /\bantigravity\b|\banti\s+gravity\b/i, label: 'Antigravity' },
  { match: /\bwindsurf\b/i, label: 'Windsurf' },
  { match: /\bzed\b/i, label: 'Zed' }
]

export function resolveNoticeMeta(input: {
  title: string
  message?: string
  tone: 'default' | 'success' | 'error'
  category?: NoticeCategory
  section?: Page
}): NoticeMeta {
  const rawTitle = input.title.trim()
  const text = `${rawTitle} ${input.message || ''}`.toLowerCase()

  let category: NoticeCategory = input.category ?? 'system'
  if (!input.category) {
    if (
      rawTitle.toLowerCase().startsWith('water reminder') ||
      text.includes('drink water') ||
      text.includes('hydrat') ||
      /\bwater\b/.test(text)
    ) {
      category = 'water'
    } else if (rawTitle.startsWith('Reminder ·') || text.includes('reminder')) {
      category = 'reminder'
    } else if (
      text.includes('focus session') ||
      text.includes('break is over') ||
      text.includes('focus lengths') ||
      text.includes('focused minutes')
    ) {
      category = 'timer'
    } else if (text.includes('posture') || text.includes('slouch') || text.includes('sit tall')) {
      category = 'posture'
    } else if (
      text.includes('session') ||
      text.includes('agent') ||
      text.includes('claude') ||
      text.includes('codex') ||
      text.includes('cursor') ||
      text.includes('opencode') ||
      text.includes('antigravity') ||
      text.includes('replied') ||
      text.includes('delivered to ')
    ) {
      category = 'session'
    } else if (text.includes('calendar') || text.includes('event added') || text.includes('event updated')) {
      category = 'calendar'
    } else if (text.includes('spotify') || text.includes('music') || text.includes('playback')) {
      category = 'music'
    } else if (text.includes('phone') || text.includes('transfer') || text.includes('qr')) {
      category = 'phone'
    } else if (text.includes('vault') || text.includes('note ') || text.includes('folder')) {
      category = 'notes'
    }
  }

  let section: Page | null = input.section ?? null
  if (!section) {
    switch (category) {
      case 'reminder':
      case 'calendar':
        section = 'planner'
        break
      case 'timer':
        section = 'home'
        break
      case 'posture':
        section = 'posture'
        break
      case 'water':
        section = 'water'
        break
      case 'session':
        section = 'sessions'
        break
      case 'music':
        section = 'music'
        break
      case 'notes':
        section = 'notes'
        break
      case 'phone':
        section = 'phone'
        break
      default:
        section = null
    }
  }

  const brandName = typeof window !== 'undefined' && window.notchDemo ? 'Hero Notch' : 'Notch'
  let badge = brandName
  let cleanTitle = rawTitle
  let icon: LucideIcon = Bell
  let tint = 'var(--accent)'

  switch (category) {
    case 'reminder': {
      badge = 'Reminder'
      cleanTitle = rawTitle.replace(/^Reminder\s*·\s*/i, '').trim() || rawTitle
      icon = Bell
      tint = 'var(--accent)'
      break
    }
    case 'timer': {
      badge = 'Focus Timer'
      icon = Flame
      tint = input.tone === 'success' ? 'var(--spotify)' : 'var(--accent)'
      break
    }
    case 'posture': {
      badge = 'Posture Coach'
      icon = PersonStanding
      tint = input.tone === 'success' ? 'var(--spotify)' : '#fbbf24'
      break
    }
    case 'water': {
      badge = 'Hydration'
      cleanTitle = rawTitle.replace(/^Water\s+reminder\s*·\s*/i, '').trim() || rawTitle
      icon = Droplet
      tint = '#7ec8e3'
      break
    }
    case 'session': {
      const provider = AGENT_PROVIDERS.find((item) => item.match.test(rawTitle) || item.match.test(text))
      badge = provider ? provider.label : 'Coding Session'
      const repliedMatch = rawTitle.match(/^.+?\s+replied:\s*(.+)$/i)
      if (repliedMatch?.[1]) {
        cleanTitle = `Replied · ${repliedMatch[1].trim()}`
      } else if (provider) {
        const stripped = rawTitle.replace(provider.match, '').replace(/^[\s·:—-]+/, '').trim()
        if (stripped) {
          cleanTitle = stripped.charAt(0).toUpperCase() + stripped.slice(1)
        }
      }
      icon = text.includes('replied') || text.includes('finished') ? Sparkles : Bot
      tint = input.tone === 'success' ? 'var(--spotify)' : input.tone === 'error' ? '#ff6f61' : 'var(--accent)'
      break
    }
    case 'calendar': {
      badge = 'Calendar'
      icon = CalendarDays
      tint = input.tone === 'error' ? '#ff6f61' : 'var(--accent)'
      break
    }
    case 'music': {
      badge = text.includes('spotify') ? 'Spotify' : 'Music'
      icon = Music2
      tint = input.tone === 'error' ? '#ff6f61' : 'var(--spotify)'
      break
    }
    case 'notes': {
      badge = 'Notes'
      icon = NotebookPen
      tint = input.tone === 'error' ? '#ff6f61' : '#a78bfa'
      break
    }
    case 'phone': {
      badge = 'Phone Transfer'
      icon = Smartphone
      tint = input.tone === 'error' ? '#ff6f61' : 'var(--accent)'
      break
    }
    default: {
      if (input.tone === 'success') {
        badge = 'Done'
        icon = CircleCheck
        tint = 'var(--spotify)'
      } else if (input.tone === 'error') {
        badge = 'Attention'
        icon = ShieldAlert
        tint = '#ff6f61'
      } else {
        badge = brandName
        icon = Bell
        tint = 'var(--accent)'
      }
      break
    }
  }

  if (input.tone === 'error') {
    tint = '#ff6f61'
  } else if (input.tone === 'success' && category === 'system') {
    tint = 'var(--spotify)'
  }

  return {
    category,
    badge,
    cleanTitle,
    section,
    sectionLabel: section ? SECTION_LABELS[section] : null,
    icon,
    tint
  }
}
