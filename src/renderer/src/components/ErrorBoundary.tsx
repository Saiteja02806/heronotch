import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RotateCcw, Power } from 'lucide-react'
import { Logo } from './Logo'

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Notch renderer error', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    return (
      <div className="error-screen">
        <Logo size={34} />
        <span className="eyebrow">Something slipped</span>
        <h1>The notch hit a snag.</h1>
        <p>{this.state.error.message || 'An unexpected error interrupted the dashboard.'}</p>
        <div className="error-actions">
          <button className="primary-button" onClick={() => window.location.reload()}>
            <RotateCcw size={14} /> Reload notch
          </button>
          <button className="soft-button" onClick={() => window.notch.quit()}>
            <Power size={13} /> Quit
          </button>
        </div>
      </div>
    )
  }
}
