import type { DemoOverlayState } from './DemoOverlay'

export interface DirectorHooks {
  setExpanded: (value: boolean) => void
  setPage: (
    page: 'home' | 'notes' | 'music' | 'planner' | 'sessions' | 'posture' | 'water' | 'phone' | 'settings'
  ) => void
  openSettings: (
    section?: 'appearance' | 'notch' | 'home' | 'sections' | 'obsidian' | 'spotify' | 'phone' | 'about'
  ) => void
  clearToasts: () => void
  refreshOpenCode: () => void
  refreshSessions: () => Promise<void>
}

export const INITIAL_DEMO_UI: DemoOverlayState = {
  cursorX: 0,
  cursorY: 0,
  cursorVisible: false,
  clicking: false,
  rippleKey: 0,
  rippleX: 0,
  rippleY: 0,
  keycap: null,
  caption: null,
  endCardVisible: false,
  running: false,
  paused: false,
  completed: false
}

export class DemoDirector {
  constructor(_hooks: DirectorHooks, _onUpdate: (next: DemoOverlayState) => void) {}
  updateHooks(_hooks: DirectorHooks): void {}
  async run(): Promise<void> {}
  togglePause(): void {}
  abort(): void {}
}
