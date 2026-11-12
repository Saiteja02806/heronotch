import type { Accent } from '../../../shared/types'

export interface AccentDefinition {
  label: string
  color: string
  soft: string
  deep: string
}

export const ACCENTS: Record<Accent, AccentDefinition> = {
  coral: { label: 'Coral', color: '#ff6f61', soft: '#ffb4ab', deep: '#c44a3f' },
  mint: { label: 'Mint', color: '#a8e36b', soft: '#d3f5ae', deep: '#5d8f2c' },
  violet: { label: 'Violet', color: '#b79bff', soft: '#d9cbff', deep: '#7357c9' },
  ice: { label: 'Ice', color: '#8ed8ff', soft: '#c7ecff', deep: '#3d88b5' },
  gold: { label: 'Gold', color: '#f6c85f', soft: '#ffe7a8', deep: '#b08a2e' }
}
