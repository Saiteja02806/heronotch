import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useApp } from '../state/AppContext'

/**
 * The reminder / posture notice that unfolds under the collapsed notch.
 *
 * The expanded panel already has toasts in the corner, but when the notch is
 * collapsed the window is shaped to the tab, so a corner toast would be clipped
 * away. This card lives directly below the tab, inside the shaped region, and
 * is therefore visible while you work in another app.
 */
export function CollapsedNotice({ onOpen }: { onOpen: () => void }) {
  const { toasts, dismissToast } = useApp()
  const toast = toasts.at(-1)
  if (!toast) return null
  return (
    <div
      className={`notch-notice notice-${toast.tone}`}
      role="status"
      aria-live="polite"
      onClick={onOpen}
    >
      <span className="notice-accent" />
      <div className="notice-copy">
        <strong>{toast.title}</strong>
        {toast.message && <span>{toast.message}</span>}
      </div>
      <button
        className="notice-close"
        onClick={(event) => {
          event.stopPropagation()
          dismissToast(toast.id)
        }}
        aria-label="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  )
}
