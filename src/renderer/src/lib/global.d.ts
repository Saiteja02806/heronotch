import type { NotchApi } from '../../../shared/types'

declare global {
  interface Window {
    notch: NotchApi
  }
}

export {}
