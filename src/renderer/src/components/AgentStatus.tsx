import { Check, HelpCircle, Loader2, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import type { AgentQuestion, AgentQuestionStep } from '../../../shared/types'
import { agentToolLabel } from '../../../shared/agentTools'
import { useApp } from '../state/AppContext'

function QuestionCard({ question, busy }: { question: AgentQuestion; busy: boolean }) {
  const { decideAgentQuestion, releaseAgentQuestion } = useApp()
  const [stepIndex, setStepIndex] = useState(0)
  const [byStep, setByStep] = useState<Record<number, number[]>>({})
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
  const picked = byStep[clampedStep] || []
  const canSend = multi && picked.length > 0 && !busy
  const subDetail =
    currentStep.detail || (totalSteps === 1 && question.detail ? question.detail : '')

  const submitAll = (finalStepChoices: number[]): void => {
    if (totalSteps === 1) {
      void decideAgentQuestion(question.id, finalStepChoices)
      return
    }
    const matrix = steps.map((_, idx) => (idx === clampedStep ? finalStepChoices : byStep[idx] || []))
    void decideAgentQuestion(question.id, matrix)
  }

  return (
    <article className="agent-question">
      <div className="agent-question-copy">
        <span className="agent-question-icon">
          <HelpCircle size={13} />
        </span>
        <div>
          <strong>
            {agentToolLabel(question.tool)} asks
            {totalSteps > 1 ? ` · ${clampedStep + 1}/${totalSteps}` : ''}
          </strong>
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
                  setByStep((prev) => ({
                    ...prev,
                    [clampedStep]: selected
                      ? picked.filter((item) => item !== index)
                      : [...picked, index]
                  }))
                  return
                }
                if (!isLastStep) {
                  setByStep((prev) => ({ ...prev, [clampedStep]: [index] }))
                  setStepIndex(clampedStep + 1)
                  return
                }
                submitAll([index])
              }}
            >
              <span className="agent-question-label">
                {option.label}
                {option.description && <em>{option.description}</em>}
              </span>
              {selected && <Check size={12} />}
            </button>
          )
        })}
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
            onClick={() => {
              const sorted = [...picked].sort((a, b) => a - b)
              if (!isLastStep) {
                setByStep((prev) => ({ ...prev, [clampedStep]: sorted }))
                setStepIndex(clampedStep + 1)
                return
              }
              submitAll(sorted)
            }}
          >
            <Check size={11} />{' '}
            {isLastStep
              ? `Send answer${picked.length > 1 ? ` (${picked.length})` : ''}`
              : `Next step${picked.length > 1 ? ` (${picked.length})` : ''}`}
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
  const waitingTools = new Set<string>([
    ...pending.map((item) => item.tool),
    ...questions.map((item) => item.tool)
  ])
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
