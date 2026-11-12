import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useApp } from '../state/AppContext'

export function Toasts() {
  const { toasts, dismissToast } = useApp()
  return (
    <div className="toast-stack" aria-live="polite">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            className={`toast toast-${toast.tone}`}
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 460, damping: 34 }}
          >
            <span className="toast-accent" />
            <div className="toast-copy">
              <strong>{toast.title}</strong>
              {toast.message && <span>{toast.message}</span>}
            </div>
            <button className="toast-close" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
              <X size={13} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
