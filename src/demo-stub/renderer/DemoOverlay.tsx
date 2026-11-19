import type { DemoConfig, DemoPlatform } from '../shared/types'

export interface DemoCaption {
  act: number
  totalActs: number
  title: string
  subtitle: string
  shortcut?: string
}

export interface DemoOverlayState {
  cursorX: number
  cursorY: number
  cursorVisible: boolean
  clicking: boolean
  rippleKey: number
  rippleX: number
  rippleY: number
  keycap: string | null
  caption: DemoCaption | null
  endCardVisible: boolean
  running: boolean
  paused: boolean
  completed: boolean
}

export interface DemoOverlayProps {
  ui: DemoOverlayState
  config: DemoConfig
  platform: DemoPlatform
  showCaptions: boolean
  onToggleCaptions: () => void
  onTogglePause: () => void
  onReplay: () => void
  onSwitchPlatform: (next: DemoPlatform) => void
}

export function DemoOverlay(_props: DemoOverlayProps) {
  return null
}
