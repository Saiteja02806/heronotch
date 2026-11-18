import { useState } from 'react'
import { ArrowUpRight, Check } from 'lucide-react'
import type { AgentQuestionStep, NotchStyle } from '../../../shared/types'
import { agentToolLabel } from '../../../shared/agentTools'
import { useApp } from '../state/AppContext'
import { EdgeGlow } from './EdgeGlow'

/**
 * The unified collapsed notch card shown when a session asks a question.
 *
 * Rather than splitting a summary strip above a detached floating box, the
 * notch itself smoothly expands downward into one seamless dark card holding
 * the header, stacked options, and footer.
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
  const [wizard, setWizard] = useState<{
    id: string
    stepIndex: number
    byStep: Record<number, number[]>
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
      : { id: question.id, stepIndex: 0, byStep: {} as Record<number, number[]> }
  const stepIndex = Math.min(activeWizard.stepIndex, steps.length - 1)
  const currentStep = steps[stepIndex] || steps[0]
  const totalSteps = steps.length
  const isLastStep = stepIndex >= totalSteps - 1
  const multi = currentStep.multiSelect
  const picked = activeWizard.byStep[stepIndex] || []
  const options = currentStep.options
  const toolLabel = agentToolLabel(question.tool)
  const subDetail =
    currentStep.detail || (totalSteps === 1 && question.detail ? question.detail : '')

  const submitAll = (finalStepChoices: number[]): void => {
    if (totalSteps === 1) {
      void decideAgentQuestion(question.id, finalStepChoices)
      return
    }
    const matrix = steps.map((_, idx) =>
      idx === stepIndex ? finalStepChoices : activeWizard.byStep[idx] || []
    )
    void decideAgentQuestion(question.id, matrix)
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
          <strong>
            {toolLabel} asks{totalSteps > 1 ? ` · ${stepIndex + 1}/${totalSteps}` : ''}
          </strong>
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
            <ArrowUpRight size={11} />
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
                  setWizard({
                    id: question.id,
                    stepIndex,
                    byStep: {
                      ...activeWizard.byStep,
                      [stepIndex]: nextPicked
                    }
                  })
                  return
                }
                if (!isLastStep) {
                  setWizard({
                    id: question.id,
                    stepIndex: stepIndex + 1,
                    byStep: {
                      ...activeWizard.byStep,
                      [stepIndex]: [index]
                    }
                  })
                  return
                }
                submitAll([index])
              }}
            >
              {multi && (
                <span className={`notch-question-box${selected ? ' is-on' : ''}`} aria-hidden="true">
                  {selected && <Check size={8} strokeWidth={3.6} />}
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
            disabled={approvalBusy || picked.length === 0}
            onClick={() => {
              const sorted = [...picked].sort((a, b) => a - b)
              if (!isLastStep) {
                setWizard({
                  id: question.id,
                  stepIndex: stepIndex + 1,
                  byStep: {
                    ...activeWizard.byStep,
                    [stepIndex]: sorted
                  }
                })
                return
              }
              submitAll(sorted)
            }}
          >
            <Check size={10} strokeWidth={2.8} />
            {isLastStep ? `Send${picked.length > 0 ? ` ${picked.length}` : ''}` : `Next${picked.length > 0 ? ` (${picked.length})` : ''}`}
          </button>
        ) : (
          <span className="notch-question-hint">
            {totalSteps > 1 ? `Step ${stepIndex + 1} of ${totalSteps} · Pick one` : 'Pick one'}
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
