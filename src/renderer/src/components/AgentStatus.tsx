import { Check, CornerDownLeft, HelpCircle, Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'
import type { AgentQuestion, AgentQuestionStep, AgentQuestionStepAnswer } from '../../../shared/types'
import { agentToolLabel } from '../../../shared/agentTools'
import { useApp } from '../state/AppContext'

interface StepDraft {
  choices: number[]
  customText: string
}

const EMPTY_DRAFT: StepDraft = { choices: [], customText: '' }

function QuestionCard({ question, busy }: { question: AgentQuestion; busy: boolean }) {
  const { decideAgentQuestion, releaseAgentQuestion } = useApp()
  const customInputRef = useRef<HTMLInputElement | null>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [byStep, setByStep] = useState<Record<number, StepDraft>>({})
  const steps: AgentQuestionStep[] =
    question.steps && question.steps.length > 0
      ? question.steps
      : [
          {
            title: question.title,
            detail: question.detail,
            options: question.options,
            multiSelect: question.multiSelect
          }
        ]
  const clampedStep = Math.min(stepIndex, steps.length - 1)
  const currentStep = steps[clampedStep] || steps[0]
  const totalSteps = steps.length
  const isLastStep = clampedStep >= totalSteps - 1
  const multi = currentStep.multiSelect
  const allowCustom = currentStep.allowCustom !== false
  const draft = byStep[clampedStep] || EMPTY_DRAFT
  const picked = draft.choices
  const customText = draft.customText
  const trimmedCustom = customText.trim()
  const hasCustom = allowCustom && trimmedCustom.length > 0
  const selectedCount = picked.length + (hasCustom ? 1 : 0)
  const canSend = multi && selectedCount > 0 && !busy
  const subDetail =
    currentStep.detail || (totalSteps === 1 && question.detail ? question.detail : '')

  const setCurrentDraft = (next: StepDraft): void => {
    setByStep((prev) => ({
      ...prev,
      [clampedStep]: next
    }))
  }

  const toStepAnswer = (entry: StepDraft): AgentQuestionStepAnswer => {
    const trimmed = entry.customText.trim()
    const sorted = [...entry.choices].sort((a, b) => a - b)
    return trimmed ? { choices: sorted, customText: trimmed } : { choices: sorted }
  }

  const submitAll = (finalDraft: StepDraft): void => {
    const answers: AgentQuestionStepAnswer[] = steps.map((_, idx) =>
      toStepAnswer(idx === clampedStep ? finalDraft : byStep[idx] || EMPTY_DRAFT)
    )
    void decideAgentQuestion(question.id, answers)
  }

  const commitMultiOrCustom = (): void => {
    if (busy) return
    if (multi) {
      if (selectedCount === 0) return
      const nextDraft: StepDraft = {
        choices: [...picked].sort((a, b) => a - b),
        customText: allowCustom ? trimmedCustom : ''
      }
      if (!isLastStep) {
        setCurrentDraft(nextDraft)
        setStepIndex(clampedStep + 1)
        return
      }
      submitAll(nextDraft)
      return
    }
    if (!hasCustom) return
    const nextDraft: StepDraft = { choices: [], customText: trimmedCustom }
    if (!isLastStep) {
      setCurrentDraft(nextDraft)
      setStepIndex(clampedStep + 1)
      return
    }
    submitAll(nextDraft)
  }

  return (
    <article className="agent-question">
      <div className="agent-question-copy">
        <span className="agent-question-icon">
          <HelpCircle size={13} />
        </span>
        <div>
          <div className="agent-question-meta">
            <strong>
              {agentToolLabel(question.tool)} asks
              {totalSteps > 1 ? ` · ${clampedStep + 1} of ${totalSteps}` : ''}
            </strong>
            {totalSteps > 1 && (
              <span className="notch-question-steps" aria-hidden="true">
                {steps.map((_, idx) => (
                  <i
                    key={idx}
                    className={
                      idx === clampedStep ? 'is-current' : idx < clampedStep ? 'is-done' : ''
                    }
                  />
                ))}
              </span>
            )}
          </div>
          <span>{currentStep.title}</span>
          {subDetail && <small>{subDetail}</small>}
        </div>
      </div>
      <div className={`agent-question-options${multi ? ' is-multi' : ''}`}>
        {currentStep.options.map((option, index) => {
          const selected = picked.includes(index)
          return (
            <button
              key={`${clampedStep}-${option.label}-${index}`}
              type="button"
              className={`agent-question-option${selected ? ' is-picked' : ''}`}
              disabled={busy}
              title={option.description || option.label}
              onClick={() => {
                if (multi) {
                  setCurrentDraft({
                    choices: selected
                      ? picked.filter((item) => item !== index)
                      : [...picked, index],
                    customText
                  })
                  return
                }
                const nextDraft: StepDraft = { choices: [index], customText: '' }
                if (!isLastStep) {
                  setCurrentDraft(nextDraft)
                  setStepIndex(clampedStep + 1)
                  return
                }
                submitAll(nextDraft)
              }}
            >
              <span className="agent-question-num" aria-hidden="true">
                {index + 1}
              </span>
              <span className="agent-question-label">
                {option.label}
                {option.description && <em>{option.description}</em>}
              </span>
              {selected && <Check size={12} />}
            </button>
          )
        })}

        {allowCustom && (
          <div
            className={`agent-question-option agent-question-other${hasCustom ? ' is-picked' : ''}`}
            onClick={() => customInputRef.current?.focus()}
          >
            <span className="agent-question-num" aria-hidden="true">
              {currentStep.options.length + 1}
            </span>
            <input
              ref={customInputRef}
              type="text"
              className="agent-question-other-input"
              placeholder="Type your own answer…"
              value={customText}
              disabled={busy}
              maxLength={2000}
              aria-label="Type your own answer"
              onClick={(event) => event.stopPropagation()}
              onChange={(event) =>
                setCurrentDraft({
                  choices: multi ? picked : [],
                  customText: event.target.value
                })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  commitMultiOrCustom()
                }
              }}
            />
            {!multi ? (
              <button
                type="button"
                className="agent-question-other-send"
                disabled={busy || !hasCustom}
                title={isLastStep ? 'Send typed answer (Enter)' : 'Next step (Enter)'}
                aria-label={isLastStep ? 'Send typed answer' : 'Next step'}
                onClick={(event) => {
                  event.stopPropagation()
                  commitMultiOrCustom()
                }}
              >
                <span>{isLastStep ? 'Send' : 'Next'}</span>
                <CornerDownLeft size={11} />
              </button>
            ) : (
              hasCustom && <Check size={12} />
            )}
          </div>
        )}
      </div>
      <div className="agent-question-foot">
        {clampedStep > 0 && (
          <button
            type="button"
            className="soft-button"
            disabled={busy}
            onClick={() => setStepIndex(Math.max(0, clampedStep - 1))}
          >
            Back
          </button>
        )}
        {multi && (
          <button
            type="button"
            className="primary-button"
            disabled={!canSend}
            onClick={commitMultiOrCustom}
          >
            <Check size={11} />{' '}
            {isLastStep
              ? `Send answer${selectedCount > 1 ? ` (${selectedCount})` : ''}`
              : `Next step${selectedCount > 1 ? ` (${selectedCount})` : ''}`}
          </button>
        )}
        <button
          type="button"
          className="soft-button"
          disabled={busy}
          onClick={() => void releaseAgentQuestion(question.id)}
          title="Close this card; the question stays in the tool's own window"
        >
          Answer in the tool instead
        </button>
      </div>
    </article>
  )
}

export function AgentStatus() {
  const { state, agentSnapshot: snapshot, questions, approvalBusy: busy, decideAgent } = useApp()
  const compact = state.settings.panelSize === 'compact'

  const pending = snapshot?.pending || []
  // Only interrupt the Sessions page when a tool is actually waiting on the
  // user: an approval or a question. "Done" and "quiet" notices are not worth the room.
  if (pending.length === 0 && questions.length === 0) return null

  return (
    <section className={`agent-status ${compact ? 'is-compact' : ''}`} aria-label="Coding tools">
      <div className="agent-status-head">
        <span className="eyebrow">Coding tools</span>
        {(pending.length > 0 || questions.length > 0) && (
          <span className="agent-status-alert">
            {questions.length + pending.length} need{questions.length + pending.length === 1 ? 's' : ''} you
          </span>
        )}
      </div>

      {questions.map((question) => (
        <QuestionCard key={question.id} question={question} busy={busy} />
      ))}

      {pending.map((item) => (
        <article className="agent-status-item is-waiting" key={item.id}>
          <span className="agent-status-icon">
            <Loader2 size={13} className="spin" />
          </span>
          <div className="agent-status-copy">
            <strong>{agentToolLabel(item.tool)} is waiting for you</strong>
            <span>{item.title}</span>
            {!compact && item.detail && <small>{item.detail}</small>}
          </div>
          <div className="agent-status-actions">
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void decideAgent(item.id, 'allow')}
            >
              <Check size={11} /> Approve
            </button>
            <button
              className="soft-button"
              disabled={busy}
              onClick={() => void decideAgent(item.id, 'deny')}
            >
              Deny
            </button>
          </div>
        </article>
      ))}
    </section>
  )
}
