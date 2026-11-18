import type { DemoApi } from '@demo/shared/types'
import type { NotchApi } from '../../../shared/types'

declare global {
  interface Window {
    notch: NotchApi
    notchDemo?: DemoApi
  }
}

export {}
