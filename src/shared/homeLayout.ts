/**
 * Home dashboard cards and where they sit.
 *
 * Every section in Notch can live on the Home grid. A new notch starts with six
 * cards (Focus, Now playing, Today, Notes, Coding sessions, Calendar), and the
 * user can switch to 2, 4, 6 or any custom count, remove any card they do not
 * want, add sections like Water, Posture or Phone, and reorder them freely.
 *
 * A card whose header section is switched off in Settings → Sections is not
 * shown and not offered. Callers pass that rule in as `available`.
 */

/** Every section card available for the home grid. */
export const HOME_CARD_IDS = [
  'timer',
  'music',
  'tasks',
  'notes',
  'sessions',
  'calendar',
  'water',
  'posture',
  'phone'
] as const

export type HomeCardId = (typeof HOME_CARD_IDS)[number]

/** Cards available to add on a fresh notch. */
export const DEFAULT_HOME_HIDDEN: readonly HomeCardId[] = ['water', 'posture', 'phone']

export interface HomeLayoutPrefs {
  /** Every card, including hidden ones, in grid order. */
  order: HomeCardId[]
  /** Cards taken off the home panel. Absent on older saves. */
  hidden?: HomeCardId[]
}

export type HomeCardFilter = (id: HomeCardId) => boolean

const ALL: HomeCardFilter = () => true

const HOME_CARD_SET = new Set<string>(HOME_CARD_IDS)

export function isHomeCardId(value: unknown): value is HomeCardId {
  return typeof value === 'string' && HOME_CARD_SET.has(value)
}

export function defaultHomeLayout(): Required<HomeLayoutPrefs> {
  return {
    order: [...HOME_CARD_IDS],
    hidden: [...DEFAULT_HOME_HIDDEN]
  }
}

/** How many columns the Home grid uses for a given number of visible cards. */
export function homeGridColumns(visibleCount = 6): number {
  if (visibleCount <= 1) return 1
  if (visibleCount === 2 || visibleCount === 4) return 2
  return 3
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export interface NormalizeHomeOptions {
  /**
   * Older saves only: the old Home put the Water card in the Now playing spot
   * when Music was off and Water was on. Keep that card where it was.
   */
  legacyWaterInMusicSlot?: boolean
}

/**
 * A complete card order and hidden list. Unknown ids and duplicates are
 * dropped and newly introduced cards are appended. Older saves without
 * `hidden` keep their original six cards and get Water, Posture and Phone as
 * cards they can add.
 */
export function normalizeHomeLayout(
  stored: HomeLayoutPrefs | null | undefined,
  options: NormalizeHomeOptions = {}
): Required<HomeLayoutPrefs> {
  let order: HomeCardId[] = []
  if (stored && Array.isArray(stored.order)) {
    for (const id of stored.order) {
      if (isHomeCardId(id) && !order.includes(id)) order.push(id)
    }
  }
  for (const id of HOME_CARD_IDS) {
    if (!order.includes(id)) order.push(id)
  }

  let hiddenIds: HomeCardId[]
  if (stored && Array.isArray(stored.hidden)) {
    hiddenIds = stored.hidden.filter(isHomeCardId)
  } else {
    hiddenIds = [...DEFAULT_HOME_HIDDEN]
    if (options.legacyWaterInMusicSlot) {
      hiddenIds = hiddenIds.filter((id) => id !== 'water')
      order = order.filter((id) => id !== 'water')
      order.splice(order.indexOf('music') + 1, 0, 'water')
    }
  }
  const hiddenSet = new Set<HomeCardId>(hiddenIds)
  let hidden = order.filter((id) => hiddenSet.has(id))
  if (order.every((id) => hiddenSet.has(id))) {
    hidden = hidden.filter((id) => id !== order[0])
  }
  const visible = order.filter((id) => !hidden.includes(id))
  return {
    order: [...visible, ...hidden],
    hidden
  }
}

export function homeLayoutEqual(
  a: HomeLayoutPrefs | null | undefined,
  b: HomeLayoutPrefs | null | undefined
): boolean {
  if (!a || !b || !Array.isArray(a.order) || !Array.isArray(b.order)) return false
  const left = normalizeHomeLayout(a)
  const right = normalizeHomeLayout(b)
  return sameList(left.order, right.order) && sameList(left.hidden, right.hidden)
}

/** Cards the grid actually shows, in their saved order. Never empty. */
export function shownHomeCards(
  layout: HomeLayoutPrefs | null | undefined,
  available: HomeCardFilter = ALL
): HomeCardId[] {
  const normalized = normalizeHomeLayout(layout)
  const hiddenSet = new Set(normalized.hidden)
  const shown = normalized.order.filter((id) => !hiddenSet.has(id) && available(id))
  if (shown.length > 0) return shown
  // Focus has no section switch, so it is the safe card to fall back on.
  return [normalized.order.find(available) ?? 'timer']
}

/** Cards that could be added right now: off Home, and their section is on. */
export function hiddenHomeCards(
  layout: HomeLayoutPrefs | null | undefined,
  available: HomeCardFilter = ALL
): HomeCardId[] {
  const normalized = normalizeHomeLayout(layout)
  const shownSet = new Set(shownHomeCards(normalized, available))
  const hiddenSet = new Set(normalized.hidden)
  return normalized.order.filter((id) => hiddenSet.has(id) && !shownSet.has(id) && available(id))
}

/**
 * Saves a new order for the cards on screen. Cards that are not on screen
 * (hidden, or waiting on a section that is off) keep their place behind them.
 */
export function reorderHomeCards(
  layout: HomeLayoutPrefs | null | undefined,
  nextShown: readonly HomeCardId[]
): Required<HomeLayoutPrefs> {
  const normalized = normalizeHomeLayout(layout)
  const rest = normalized.order.filter((id) => !nextShown.includes(id))
  return normalizeHomeLayout({ order: [...nextShown, ...rest], hidden: normalized.hidden })
}

/** Adds a card to the home grid (at `atIndex` or after the visible cards). */
export function addHomeCard(
  layout: HomeLayoutPrefs | null | undefined,
  id: HomeCardId,
  atIndex?: number,
  available: HomeCardFilter = ALL
): Required<HomeLayoutPrefs> {
  const normalized = normalizeHomeLayout(layout)
  const hiddenSet = new Set(normalized.hidden)
  for (const visibleId of shownHomeCards(normalized, available)) {
    hiddenSet.delete(visibleId)
  }
  const shown = normalized.order.filter((entry) => !hiddenSet.has(entry) && entry !== id)
  const hidden = normalized.order.filter((entry) => hiddenSet.has(entry) && entry !== id)
  const target =
    typeof atIndex === 'number' && Number.isFinite(atIndex)
      ? Math.max(0, Math.min(shown.length, Math.trunc(atIndex)))
      : shown.length
  shown.splice(target, 0, id)
  return {
    order: [...shown, ...hidden],
    hidden
  }
}

/**
 * Removes a card from the home grid. Returns null when it is the last card
 * on screen.
 */
export function removeHomeCard(
  layout: HomeLayoutPrefs | null | undefined,
  id: HomeCardId,
  available: HomeCardFilter = ALL
): Required<HomeLayoutPrefs> | null {
  const normalized = normalizeHomeLayout(layout)
  const onScreen = shownHomeCards(normalized, available)
  if (onScreen.length <= 1 && onScreen.includes(id)) return null
  const hiddenSet = new Set(normalized.hidden)
  if (hiddenSet.has(id)) return normalized
  const nextShown = normalized.order.filter((entry) => !hiddenSet.has(entry) && entry !== id)
  const nextHidden = [id, ...normalized.order.filter((entry) => hiddenSet.has(entry))]
  return {
    order: [...nextShown, ...nextHidden],
    hidden: nextHidden
  }
}

/** Toggles a card on or off the home grid. Returns null if hiding the last card. */
export function toggleHomeCard(
  layout: HomeLayoutPrefs | null | undefined,
  id: HomeCardId,
  available: HomeCardFilter = ALL
): Required<HomeLayoutPrefs> | null {
  const normalized = normalizeHomeLayout(layout)
  if (shownHomeCards(normalized, available).includes(id)) {
    return removeHomeCard(normalized, id, available)
  }
  return addHomeCard(normalized, id, undefined, available)
}

/**
 * Shows the first `count` available cards in the user's order and hides the
 * other available ones, so switching between 2, 4 and 6 keeps their priority.
 * Cards whose section is off keep whatever state they had.
 */
export function setHomeCardCount(
  layout: HomeLayoutPrefs | null | undefined,
  count: number,
  available: HomeCardFilter = ALL
): Required<HomeLayoutPrefs> {
  const normalized = normalizeHomeLayout(layout)
  const usable = normalized.order.filter(available)
  const target = Math.max(1, Math.min(usable.length, Math.trunc(count)))
  const nextShown = usable.slice(0, target)
  const nextHiddenUsable = usable.slice(target)
  const parked = normalized.order.filter((id) => !available(id))
  const parkedShown = parked.filter((id) => !normalized.hidden.includes(id))
  const parkedHidden = parked.filter((id) => normalized.hidden.includes(id))
  const hidden = [...nextHiddenUsable, ...parkedHidden]
  return {
    order: [...nextShown, ...parkedShown, ...hidden],
    hidden
  }
}

/** Moves one card to a grid index. Returns the same order when nothing changes. */
export function moveHomeCard(
  order: readonly HomeCardId[],
  id: HomeCardId,
  toIndex: number
): HomeCardId[] {
  const next = [...order]
  const from = next.indexOf(id)
  if (from < 0) return next
  const to = Math.max(0, Math.min(next.length - 1, Math.trunc(toIndex)))
  if (from === to) return next
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

/** Human name for a grid position, matching the active 1-, 2- or 3-column layout. */
export function homeSlotLabel(index: number, visibleCount = 6): string {
  const columns = homeGridColumns(visibleCount)
  if (columns === 1) return 'Full panel'
  const row = Math.floor(index / columns) + 1
  if (columns === 2) {
    const side = index % 2 === 0 ? 'Left' : 'Right'
    return `Row ${row} · ${side}`
  }
  const colNames = ['Left', 'Middle', 'Right']
  return `Row ${row} · ${colNames[index % 3] ?? 'Right'}`
}
