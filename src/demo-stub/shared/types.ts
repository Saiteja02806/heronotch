export type DemoPlatform = 'macos' | 'windows'
export type DemoQuestionMode = 'none' | 'single' | 'multi'

export interface DemoConfig {
  isDemo: boolean
  isStage: boolean
  isCapture: boolean
  showCaptions: boolean
  autoPlay: boolean
  vaultPath: string
  wallpaperUrl: string
  platform: DemoPlatform
}

export interface DemoChapter {
  id: string
  act: number
  title: string
  description: string
  shortcut: string
  startMs: number
  endMs: number
  startSec: number
  endSec: number
}

export interface DemoManifest {
  product: 'Hero Notch'
  version: string
  width: number
  height: number
  fps: number
  durationSec: number
  platforms: string[]
  pricing: {
    earlyBird: string
    standard: string
  }
  chapters: DemoChapter[]
}

export interface DemoApi {
  getConfig: () => Promise<DemoConfig>
  getPostureVideo: () => Promise<Uint8Array>
  setPlatform: (platform: DemoPlatform) => Promise<DemoPlatform>
  onPlatform: (callback: (platform: DemoPlatform) => void) => () => void
  fireReminder: (title: string, time?: string) => Promise<void>
  setOpenCodeApproval: (enabled: boolean) => Promise<void>
  setQuestionMode: (mode: DemoQuestionMode) => Promise<void>
  simulatePhoneReceive: (payload?: { name: string; text: boolean } | null) => Promise<void>
  setCaptions: (visible: boolean) => Promise<boolean>
  reset: () => Promise<void>
  reportDone: (chapters: DemoChapter[]) => void
}
