import type { AppState } from '../../../shared/types'
import type { Page } from '../state/AppContext'

export interface OptionalSection {
  id: 'water'
  label: string
  page: Page
  shortcut: string
  summary: string
  detail: string
}

export const OPTIONAL_SECTIONS: OptionalSection[] = [
  {
    id: 'water',
    label: 'Water',
    page: 'water',
    shortcut: '8',
    summary: 'Count glasses through the day.',
    detail: 'A measuring glass on its own tab. Add it when you want it. Remove it and today\'s count stays saved.'
  }
]

export function sectionEnabled(state: AppState, id: OptionalSection['id']): boolean {
  if (id === 'water') return Boolean(state.water?.enabled)
  return false
}
