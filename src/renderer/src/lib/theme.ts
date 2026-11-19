import type { Accent } from '../../../shared/types'

export interface AccentDefinition {
  label: string
  color: string
  soft: string
  deep: string
}

/**
 * Default is Obsidian (clean monochrome black-glass), alongside curated
 * color finishes (Blue, Orange, Red, Coral, Mint, Violet, Ocean, Amber,
 * Rose, Emerald) and full custom-hex personalization.
 */
export const ACCENTS: Record<Accent, AccentDefinition> = {
  obsidian: { label: 'Obsidian', color: '#f2f2f2', soft: '#ffffff', deep: '#c4c4c4' },
  blue: { label: 'Blue', color: '#3b82f6', soft: '#60a5fa', deep: '#1d4ed8' },
  orange: { label: 'Orange', color: '#f97316', soft: '#fb923c', deep: '#c2410c' },
  red: { label: 'Red', color: '#ef4444', soft: '#f87171', deep: '#b91c1c' },
  coral: { label: 'Coral', color: '#ff6f61', soft: '#ff9a8f', deep: '#d9483b' },
  mint: { label: 'Mint', color: '#3ddc97', soft: '#7cebb9', deep: '#20a86e' },
  violet: { label: 'Violet', color: '#9d8eff', soft: '#bfb5ff', deep: '#6f5ce6' },
  ice: { label: 'Ocean', color: '#38bdf8', soft: '#7dd3fc', deep: '#0284c7' },
  gold: { label: 'Amber', color: '#fbbf24', soft: '#fde68a', deep: '#d97706' },
  rose: { label: 'Rose', color: '#f472b6', soft: '#f9a8d4', deep: '#db2777' },
  emerald: { label: 'Emerald', color: '#34d399', soft: '#6ee7b7', deep: '#059669' },
  custom: { label: 'Custom', color: '#7ec8e3', soft: '#b4e1f2', deep: '#3e92b5' }
}

export const PRESET_ACCENTS: Exclude<Accent, 'custom'>[] = [
  'obsidian',
  'blue',
  'orange',
  'red',
  'coral',
  'mint',
  'violet',
  'ice',
  'gold',
  'rose',
  'emerald'
]

function normalizeHex(hex?: string): string | null {
  if (!hex) return null
  const clean = hex.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(clean)) return clean.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(clean)) {
    const [, r, g, b] = clean
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return null
}

function mixHex(hex: string, target: string, ratio: number): string {
  const parse = (value: string): [number, number, number] => [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16)
  ]
  const [r1, g1, b1] = parse(hex)
  const [r2, g2, b2] = parse(target)
  const mix = (a: number, b: number) =>
    Math.round(a + (b - a) * ratio)
      .toString(16)
      .padStart(2, '0')
  return `#${mix(r1, r2)}${mix(g1, g2)}${mix(b1, b2)}`
}

export function resolveAccent(accent: Accent, customHex?: string): AccentDefinition {
  if (accent === 'custom') {
    const valid = normalizeHex(customHex) || ACCENTS.custom.color
    return {
      label: 'Custom',
      color: valid,
      soft: mixHex(valid, '#ffffff', 0.32),
      deep: mixHex(valid, '#000000', 0.25)
    }
  }
  return ACCENTS[accent] || ACCENTS.obsidian
}
