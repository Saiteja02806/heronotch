/**
 * Home dashboard cards and where they sit.
 *
 * The home grid is three columns wide and two rows tall, so a saved order is
 * also a position: index 0 is top left, index 2 is top right, index 3 is
 * bottom left, and so on. Keeping the order as a plain list (instead of pixel
 * coordinates) means the cards still fill the grid when a section is turned
 * off or the panel switches to its compact one-column size.
 */

/** Cards on the home grid, in the order a new notch shows them. */
export const HOME_CARD_IDS = ['timer', 'music', 'tasks', 'notes', 'sessions', 'calendar'] as const

export type HomeCardId = (typeof HOME_CARD_IDS)[number]

export interface HomeLayoutPrefs {
  /** Every card, including ones whose section is turned off, in grid order. */
  order: HomeCardId[]
}

/** Columns in the home grid. Rows follow from the card count. */
export const HOME_GRID_COLUMNS = 3

const HOME_CARD_SET = new Set<string>(HOME_CARD_IDS)

export function isHomeCardId(value: unknown): value is HomeCardId {
  return typeof value === 'string' && HOME_CARD_SET.has(value)
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export function homeLayoutEqual(
  a: HomeLayoutPrefs | null | undefined,
  b: HomeLayoutPrefs
): boolean {
  if (!a || !Array.isArray(a.order)) return false
  return sameList(a.order, b.order)
}

/**
 * A complete card order. Unknown ids and duplicates are dropped, and cards
 * added after a save are appended so the grid never loses one.
 */
export function normalizeHomeLayout(
  stored: HomeLayoutPrefs | null | undefined
): HomeLayoutPrefs {
  const order: HomeCardId[] = []
  if (stored && Array.isArray(stored.order)) {
    for (const id of stored.order) {
      if (isHomeCardId(id) && !order.includes(id)) order.push(id)
    }
  }
  for (const id of HOME_CARD_IDS) {
    if (!order.includes(id)) order.push(id)
  }
  return { order }
}

/** Cards the grid actually shows, in their saved order. */
export function shownHomeCards(
  layout: HomeLayoutPrefs,
  available: (id: HomeCardId) => boolean
): HomeCardId[] {
  return normalizeHomeLayout(layout).order.filter(available)
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

/** Human name for a grid position, for the little readout in Settings. */
export function homeSlotLabel(index: number): string {
  const row = Math.floor(index / HOME_GRID_COLUMNS) + 1
  const column = (index % HOME_GRID_COLUMNS) + 1
  const columns = ['Left', 'Middle', 'Right']
  return `Row ${row} · ${columns[column - 1]}`
}
