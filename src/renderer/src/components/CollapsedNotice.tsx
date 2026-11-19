import type { CSSProperties } from 'react'
import { ArrowUpRight, X } from 'lucide-react'
import { resolveNoticeMeta } from '../lib/notices'
import { useApp, type Page } from '../state/AppContext'

/**
 * The Dynamic-Island style notice card that unfurls under the collapsed notch.
 */
export function CollapsedNotice({
  onOpen,
  onOpenSection
}: {
  onOpen: () => void
  onOpenSection?: (section: Page) => void
}) {
  const {
    toasts,
    dismissToast,
    toastsPaused,
    setToastsPaused,
    agentSnapshot,
    questions,
    openCodePending
  } = useApp()

  // When an approval is active, the collapsed notch bar itself morphs to show
  // inline Approve / Deny buttons, and a question gets its own answer card; a
  // toast stacked under either one would just cover it.
  if (agentSnapshot?.pending.length || openCodePending.length) return null
  if (questions.length) return null

  const toast = toasts.at(-1)
  if (!toast) return null

  const meta = resolveNoticeMeta({
    title: toast.title,
    message: toast.message,
    tone: toast.tone,
    category: toast.category,
    section: toast.section
  })
  const Icon = meta.icon
  const extraCount = Math.max(0, toasts.length - 1)

  return (
    <div
      key={toast.id}
      className={`notch-notice notice-${toast.tone} category-${meta.category}${
        toastsPaused ? ' is-paused' : ''
      }${extraCount > 0 ? ' has-stack' : ''}`}
      style={
        {
          '--notice-tint': meta.tint,
          '--notice-duration': `${toast.durationMs || 5200}ms`
        } as CSSProperties
      }
      role="status"
      aria-live="polite"
      onPointerEnter={() => setToastsPaused(true)}
      onPointerLeave={() => setToastsPaused(false)}
      onClick={() => {
        setToastsPaused(false)
        if (toast.onOpen) {
          toast.onOpen()
          dismissToast(toast.id)
        } else if (meta.section && onOpenSection) {
          onOpenSection(meta.section)
        } else {
          onOpen()
        }
      }}
    >
      <span className="notice-orb" aria-hidden="true">
        <Icon size={14} strokeWidth={2.1} />
      </span>

      <div className="notice-copy">
        <div className="notice-eyebrow-row">
          <span className="notice-badge">{meta.badge}</span>
          {meta.sectionLabel && (
            <span className="notice-jump">
              {meta.sectionLabel}
              <ArrowUpRight size={9} />
            </span>
          )}
        </div>
        <strong>{meta.cleanTitle}</strong>
        {toast.message && <span>{toast.message}</span>}
      </div>

      <div className="notice-rail">
        {toast.actions && toast.actions.length > 0 && (
          <div className="notice-actions">
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
        {extraCount > 0 && (
          <span
            className="notice-stack-pill"
            title={`${toasts.length} notifications`}
          >
            +{extraCount}
          </span>
        )}
        <button
          type="button"
          className="notice-close"
          onClick={(event) => {
            event.stopPropagation()
            dismissToast(toast.id)
          }}
          aria-label="Dismiss"
          title="Dismiss"
        >
          <X size={12} />
        </button>
      </div>

      <span className="notice-progress" aria-hidden="true">
        <span className="notice-progress-bar" />
      </span>
    </div>
  )
}
