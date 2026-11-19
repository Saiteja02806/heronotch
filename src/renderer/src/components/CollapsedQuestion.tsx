import { useRef, useState } from 'react'
import { ArrowUpRight, Check, CornerDownLeft } from 'lucide-react'
import type { AgentQuestionStep, AgentQuestionStepAnswer, NotchStyle } from '../../../shared/types'
import { agentToolLabel } from '../../../shared/agentTools'
import { useApp } from '../state/AppContext'
import { EdgeGlow } from './EdgeGlow'

interface StepDraft {
  choices: number[]
  customText: string
}

const EMPTY_DRAFT: StepDraft = { choices: [], customText: '' }

/**
 * The unified collapsed notch card shown when a session asks a question.
 *
 * Rather than splitting a summary strip above a detached floating box, the
 * notch itself smoothly expands downward into one seamless dark card holding
 * the header, stacked options (including an inline "Other" free-text input),
 * and footer.
 */

export function CollapsedQuestion({
  style = 'minimal',
  glowTick = 0,
  expanded: expandedProp,
  onOpenSessions
}: {
  style?: NotchStyle
  glowTick?: number
  expanded?: boolean
  onOpenSessions?: () => void
}) {
  const { questions, approvalBusy, expanded: ctxExpanded, decideAgentQuestion, releaseAgentQuestion } =
    useApp()
  const expanded = expandedProp ?? ctxExpanded
  const question = questions[0]
  const customInputRef = useRef<HTMLInputElement | null>(null)
  const [wizard, setWizard] = useState<{
    id: string
    stepIndex: number
    byStep: Record<number, StepDraft>
  } | null>(null)
  if (!question || expanded) return null

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
  const activeWizard =
    wizard && wizard.id === question.id
      ? wizard
      : { id: question.id, stepIndex: 0, byStep: {} as Record<number, StepDraft> }
  const stepIndex = Math.min(activeWizard.stepIndex, steps.length - 1)
  const currentStep = steps[stepIndex] || steps[0]
  const totalSteps = steps.length
  const isLastStep = stepIndex >= totalSteps - 1
  const multi = currentStep.multiSelect
  const allowCustom = currentStep.allowCustom !== false
  const draft = activeWizard.byStep[stepIndex] || EMPTY_DRAFT
  const picked = draft.choices
  const customText = draft.customText
  const trimmedCustom = customText.trim()
  const hasCustom = allowCustom && trimmedCustom.length > 0
  const selectedCount = picked.length + (hasCustom ? 1 : 0)
  const options = currentStep.options
  const toolLabel = agentToolLabel(question.tool)
  const subDetail =
    currentStep.detail || (totalSteps === 1 && question.detail ? question.detail : '')

  const updateCurrentStep = (next: StepDraft, nextStepIndex = stepIndex): void => {
    setWizard({
      id: question.id,
      stepIndex: nextStepIndex,
      byStep: {
        ...activeWizard.byStep,
        [stepIndex]: next
      }
    })
  }

  const toStepAnswer = (entry: StepDraft): AgentQuestionStepAnswer => {
    const trimmed = entry.customText.trim()
    const sorted = [...entry.choices].sort((a, b) => a - b)
    return trimmed ? { choices: sorted, customText: trimmed } : { choices: sorted }
  }

  const submitAll = (finalDraft: StepDraft): void => {
    const answers: AgentQuestionStepAnswer[] = steps.map((_, idx) =>
      toStepAnswer(idx === stepIndex ? finalDraft : activeWizard.byStep[idx] || EMPTY_DRAFT)
    )
    void decideAgentQuestion(question.id, answers)
  }

  const commitMultiOrCustom = (): void => {
    if (approvalBusy) return
    if (multi) {
      if (selectedCount === 0) return
      const nextDraft: StepDraft = {
        choices: [...picked].sort((a, b) => a - b),
        customText: allowCustom ? trimmedCustom : ''
      }
      if (!isLastStep) {
        updateCurrentStep(nextDraft, stepIndex + 1)
        return
      }
      submitAll(nextDraft)
      return
    }
    if (!hasCustom) return
    const nextDraft: StepDraft = { choices: [], customText: trimmedCustom }
    if (!isLastStep) {
      updateCurrentStep(nextDraft, stepIndex + 1)
      return
    }
    submitAll(nextDraft)
  }

  return (
    <div
      className={`collapsed-bar style-${style} has-question notch-question-card${multi ? ' is-multi' : ''}`}
      role="dialog"
      aria-label={`${toolLabel} question`}
    >
      <div className="notch-question-head">
        <span className="notch-question-dot" aria-hidden="true" />
        <div className="notch-question-copy">
          <div className="notch-question-meta">
            <strong>
              {toolLabel} asks{totalSteps > 1 ? ` · ${stepIndex + 1} of ${totalSteps}` : ''}
            </strong>
            {totalSteps > 1 && (
              <span className="notch-question-steps" aria-hidden="true">
                {steps.map((_, idx) => (
                  <i
                    key={idx}
                    className={
                      idx === stepIndex ? 'is-current' : idx < stepIndex ? 'is-done' : ''
                    }
                  />
                ))}
              </span>
            )}
          </div>
          <span>{currentStep.title}</span>
          {subDetail && <small>{subDetail}</small>}
        </div>
        {onOpenSessions && (
          <button
            type="button"
            className="notch-question-open"
            onClick={(event) => {
              event.stopPropagation()
              onOpenSessions()
            }}
            title="Open the full session"
            aria-label="Open the full session"
          >
            <ArrowUpRight size={12} />
          </button>
        )}
      </div>

      <div className="notch-question-list">
        {options.map((option, index) => {
          const selected = multi && picked.includes(index)
          return (
            <button
              key={`${stepIndex}-${option.label}-${index}`}
              data-demo-question-row={index}
              type="button"
              className={`notch-question-row${selected ? ' is-picked' : ''}`}
              disabled={approvalBusy}
              onClick={() => {
                if (multi) {
                  const nextPicked = selected
                    ? picked.filter((item) => item !== index)
                    : [...picked, index]
                  updateCurrentStep({ choices: nextPicked, customText })
                  return
                }
                const nextDraft: StepDraft = { choices: [index], customText: '' }
                if (!isLastStep) {
                  updateCurrentStep(nextDraft, stepIndex + 1)
                  return
                }
                submitAll(nextDraft)
              }}
            >
              {multi ? (
                <span className={`notch-question-box${selected ? ' is-on' : ''}`} aria-hidden="true">
                  {selected && <Check size={8} strokeWidth={3.6} />}
                </span>
              ) : (
                <span className="notch-question-num" aria-hidden="true">
                  {index + 1}
                </span>
              )}
              <span className="notch-question-row-copy">
                <span className="notch-question-row-label">{option.label}</span>
                {option.description && (
                  <span className="notch-question-row-note">{option.description}</span>
                )}
              </span>
              {!multi && <ArrowUpRight className="notch-question-row-go" size={10} />}
            </button>
          )
        })}

        {allowCustom && (
          <div
            className={`notch-question-row notch-question-other${hasCustom ? ' is-picked' : ''}`}
            onClick={() => customInputRef.current?.focus()}
          >
            {multi ? (
              <button
                type="button"
                className={`notch-question-box notch-question-box-btn${hasCustom ? ' is-on' : ''}`}
                disabled={approvalBusy}
                aria-label={hasCustom ? 'Clear custom answer' : 'Focus custom answer'}
                onClick={(event) => {
                  event.stopPropagation()
                  if (hasCustom) {
                    updateCurrentStep({ choices: picked, customText: '' })
                  } else {
                    customInputRef.current?.focus()
                  }
                }}
              >
                {hasCustom && <Check size={8} strokeWidth={3.6} />}
              </button>
            ) : (
              <span className="notch-question-num" aria-hidden="true">
                {options.length + 1}
              </span>
            )}
            <input
              ref={customInputRef}
              type="text"
              className="notch-question-other-input"
              placeholder="Type your own answer…"
              value={customText}
              disabled={approvalBusy}
              maxLength={2000}
              aria-label="Type your own answer"
              onClick={(event) => event.stopPropagation()}
              onChange={(event) =>
                updateCurrentStep({
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
            {!multi && (
              <button
                type="button"
                className="notch-question-other-send"
                disabled={approvalBusy || !hasCustom}
                title={isLastStep ? 'Send typed answer (Enter)' : 'Next step (Enter)'}
                aria-label={isLastStep ? 'Send typed answer' : 'Next step'}
                onClick={(event) => {
                  event.stopPropagation()
                  commitMultiOrCustom()
                }}
              >
                <span>{isLastStep ? 'Send' : 'Next'}</span>
                <CornerDownLeft size={10} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="notch-question-foot">
        {stepIndex > 0 && (
          <button
            type="button"
            className="notch-question-release"
            disabled={approvalBusy}
            onClick={() =>
              setWizard({
                ...activeWizard,
                stepIndex: Math.max(0, stepIndex - 1)
              })
            }
          >
            Back
          </button>
        )}
        {multi ? (
          <button
            type="button"
            className="notch-question-send"
            data-demo-question-send="true"
            disabled={approvalBusy || selectedCount === 0}
            onClick={commitMultiOrCustom}
          >
            <Check size={10} strokeWidth={2.8} />
            {isLastStep
              ? `Send${selectedCount > 0 ? ` ${selectedCount}` : ''}`
              : `Next${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
          </button>
        ) : (
          <span className="notch-question-hint">
            {totalSteps > 1
              ? `Step ${stepIndex + 1} of ${totalSteps} · Pick or type`
              : allowCustom
                ? 'Pick one or type'
                : 'Pick one'}
          </span>
        )}
        <button
          type="button"
          className="notch-question-release"
          disabled={approvalBusy}
          onClick={() => void releaseAgentQuestion(question.id)}
          title="Leave this to the tool's own window"
        >
          Answer in the tool
        </button>
      </div>
      <EdgeGlow tick={glowTick} ready={!expanded} />
    </div>
  )
}
