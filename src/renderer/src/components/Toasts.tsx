import type { CSSProperties } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUpRight, X } from 'lucide-react'
import { resolveNoticeMeta } from '../lib/notices'
import { useApp } from '../state/AppContext'

export function Toasts() {
  const { toasts, dismissToast, toastsPaused, setToastsPaused, page, setPage } = useApp()

  return (
    <div
      className={`toast-stack${toastsPaused ? ' is-paused' : ''}`}
      aria-live="polite"
      onPointerEnter={() => setToastsPaused(true)}
      onPointerLeave={() => setToastsPaused(false)}
    >
      <AnimatePresence>
        {toasts.map((toast) => {
          const meta = resolveNoticeMeta({
            title: toast.title,
            message: toast.message,
            tone: toast.tone,
            category: toast.category,
            section: toast.section
          })
          const Icon = meta.icon
          const canNavigate = Boolean(meta.section && meta.section !== page)

          return (
            <motion.div
              key={toast.id}
              className={`toast toast-${toast.tone} category-${meta.category}${
                canNavigate ? ' is-clickable' : ''
              }${toastsPaused ? ' is-paused' : ''}`}
              style={
                {
                  '--notice-tint': meta.tint,
                  '--notice-duration': `${toast.durationMs || 5200}ms`
                } as CSSProperties
              }
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 460, damping: 34 }}
              onClick={() => {
                if (toast.onOpen) {
                  toast.onOpen()
                  dismissToast(toast.id)
                } else if (meta.section && meta.section !== page) {
                  setPage(meta.section)
                }
              }}
            >
              <span className="toast-orb" aria-hidden="true">
                <Icon size={13} strokeWidth={2.1} />
              </span>

              <div className="toast-copy">
                <div className="toast-eyebrow-row">
                  <span className="toast-badge">{meta.badge}</span>
                  {canNavigate && meta.sectionLabel && (
                    <span className="toast-jump">
                      {meta.sectionLabel}
                      <ArrowUpRight size={9} />
                    </span>
                  )}
                </div>
                <strong>{meta.cleanTitle}</strong>
                {toast.message && <span>{toast.message}</span>}
              </div>

              <div className="toast-rail">
                {toast.actions && toast.actions.length > 0 && (
                  <div className="toast-actions">
                    {toast.actions.map((action) => (
                      <button
                        key={action.label}
                        type="button"
                        className={`notice-action-btn is-${action.variant || 'soft'}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          setToastsPaused(false)
                          action.onClick()
                          dismissToast(toast.id)
                        }}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className="toast-close"
                  onClick={(event) => {
                    event.stopPropagation()
                    dismissToast(toast.id)
                  }}
                  aria-label="Dismiss"
                  title="Dismiss"
                >
                  <X size={13} />
                </button>
              </div>

              <span className="toast-progress" aria-hidden="true">
                <span className="toast-progress-bar" />
              </span>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
