import type { BrowserWindow } from 'electron'
import type { AppState, AppStatePatch, NotchDisplay } from '../../shared/types'
import type { DemoChapter } from '../shared/types'

/** Production no-op stub for @demo/main so demo code is never bundled into releases. */
export const isDemoMode = false
export const isDemoStage = false
export const isDemoCapture = false

export function initDemoSandbox(): void {}

export function cleanupDemoSandbox(): void {}

export function demoDisplays(): NotchDisplay[] {
  return []
}

export function syncDemoPlatformFromDisplay(
  _displayId: string | undefined,
  _sendToRenderer: (channel: string, payload?: unknown) => void
): void {}

export function registerDemoIpc(_host: {
  getMainWindow: () => BrowserWindow | null
  sendToRenderer: (channel: string, payload?: unknown) => void
  applyStatePatch: (patch: AppStatePatch) => AppState
  resetAppState: (next: AppState) => void
  onChaptersDone?: (chapters: DemoChapter[]) => void
}): void {}
