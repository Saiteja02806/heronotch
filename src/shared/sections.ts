/** Header sections, in the order a new notch shows them. Settings is not one of these. */
export const SECTION_IDS = ['home', 'notes', 'music', 'planner', 'sessions', 'posture', 'water'] as const

export type SectionId = (typeof SECTION_IDS)[number]

export interface SectionPrefs {
  /** Every section, including hidden ones, in nav order. */
  order: SectionId[]
  /** Sections taken off the notch. Their saved data is left alone. */
  hidden: SectionId[]
}

const SECTION_ID_SET = new Set<string>(SECTION_IDS)

export function isSectionId(value: unknown): value is SectionId {
  return typeof value === 'string' && SECTION_ID_SET.has(value)
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export function sectionsEqual(a: SectionPrefs | undefined, b: SectionPrefs): boolean {
  if (!a) return false
  return sameList(a.order, b.order) && sameList(a.hidden, b.hidden)
}

/**
 * Visibility and order for the header sections.
 * Missing prefs migrate from the old water-only switch: water stays off the
 * notch when `water.enabled` was false, and every other section stays on.
 * Once prefs exist, `water.enabled` is ignored so hiding water later does not
 * depend on that flag, and the water log itself is never touched here.
 */
export function normalizeSectionPrefs(
  stored: SectionPrefs | null | undefined,
  waterEnabled: boolean
): SectionPrefs {
  const hasPrefs = Boolean(
    stored && (Array.isArray(stored.order) || Array.isArray(stored.hidden))
  )
  const order: SectionId[] = []
  if (hasPrefs && Array.isArray(stored?.order)) {
    for (const id of stored.order) {
      if (isSectionId(id) && !order.includes(id)) order.push(id)
    }
  }
  for (const id of SECTION_IDS) {
    if (!order.includes(id)) order.push(id)
  }

  let hiddenIds: SectionId[]
  if (hasPrefs && Array.isArray(stored?.hidden)) {
    hiddenIds = stored.hidden.filter(isSectionId)
  } else if (hasPrefs) {
    hiddenIds = []
  } else {
    hiddenIds = waterEnabled ? [] : ['water']
  }
  const hiddenSet = new Set(hiddenIds)
  let hidden = order.filter((id) => hiddenSet.has(id))
  if (order.every((id) => hiddenSet.has(id))) {
    hidden = hidden.filter((id) => id !== order[0])
  }
  return { order, hidden }
}

/** Sections on the bar, in order. Compact keeps Home off the bar while another section is on. */
export function visibleSections(prefs: SectionPrefs, options?: { compact?: boolean }): SectionId[] {
  const hidden = new Set(prefs.hidden)
  let visible = prefs.order.filter((id) => !hidden.has(id))
  if (options?.compact && visible.length > 1) visible = visible.filter((id) => id !== 'home')
  if (visible.length === 0) visible = [prefs.order[0] ?? 'home']
  return visible
}

/** Returns null when the toggle would hide the last remaining section. */
export function toggleSection(prefs: SectionPrefs, id: SectionId): SectionPrefs | null {
  const hidden = new Set(prefs.hidden)
  if (!prefs.order.includes(id)) return prefs
  if (hidden.has(id)) {
    hidden.delete(id)
  } else if (prefs.order.filter((item) => !hidden.has(item)).length <= 1) {
    return null
  } else {
    hidden.add(id)
  }
  return { order: prefs.order, hidden: prefs.order.filter((item) => hidden.has(item)) }
}

export function moveSection(prefs: SectionPrefs, id: SectionId, toIndex: number): SectionPrefs {
  const order = [...prefs.order]
  const from = order.indexOf(id)
  if (from < 0) return prefs
  const to = Math.max(0, Math.min(order.length - 1, toIndex))
  if (from === to) return prefs
  const [item] = order.splice(from, 1)
  order.splice(to, 0, item!)
  const hidden = new Set(prefs.hidden)
  return { order, hidden: order.filter((entry) => hidden.has(entry)) }
}
