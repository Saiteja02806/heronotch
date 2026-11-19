import type { AgentQuestion, AgentQuestionResponse, AgentQuestionStep, AgentQuestionStepAnswer } from './types'

const MAX_CUSTOM_TEXT = 2000

/** Normalize a question into an explicit list of steps. */
export function questionSteps(question: Pick<AgentQuestion, 'title' | 'detail' | 'options' | 'multiSelect' | 'steps'>): AgentQuestionStep[] {
  if (question.steps && question.steps.length > 0) return question.steps
  return [
    {
      title: question.title,
      detail: question.detail,
      options: question.options,
      multiSelect: question.multiSelect
    }
  ]
}

function isStepAnswerList(value: unknown): value is AgentQuestionStepAnswer[] {
  if (!Array.isArray(value) || value.length === 0) return false
  const first = value[0]
  return Boolean(first && typeof first === 'object' && !Array.isArray(first))
}

function cleanCustomText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\r\n?/g, '\n').trim().slice(0, MAX_CUSTOM_TEXT)
}

/** Validate and normalize either legacy index choice arrays or structured
 * per-step answers carrying preset option indices and/or custom free-text. */
export function normalizeQuestionResponse(
  steps: AgentQuestionStep[],
  response: AgentQuestionResponse
): AgentQuestionStepAnswer[] {
  if (!Array.isArray(response) || response.length === 0) {
    throw new Error('Pick an option or type an answer.')
  }

  let rawPerStep: { choices: unknown[]; customText?: unknown }[]
  if (isStepAnswerList(response)) {
    rawPerStep = steps.map((_, idx) => {
      const entry = response[idx]
      return {
        choices: Array.isArray(entry?.choices) ? entry.choices : [],
        customText: entry?.customText
      }
    })
  } else if (Array.isArray(response[0])) {
    const matrix = response as number[][]
    rawPerStep = steps.map((_, idx) => ({
      choices: Array.isArray(matrix[idx]) ? matrix[idx] : []
    }))
  } else {
    rawPerStep = [
      {
        choices: response as number[]
      }
    ]
  }

  const out: AgentQuestionStepAnswer[] = []
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]
    const raw = rawPerStep[i] || { choices: [] }
    const validChoices = [...new Set(raw.choices.map(Number))]
      .filter((choice) => Number.isInteger(choice) && choice >= 0 && choice < step.options.length)
      .sort((a, b) => a - b)

    const customText = cleanCustomText(raw.customText)
    if (customText && step.allowCustom === false) {
      throw new Error('Pick one of the listed options.')
    }

    if (step.multiSelect === false) {
      if (customText) {
        out.push({ choices: [], customText })
        continue
      }
      if (validChoices.length === 0) {
        throw new Error('Pick an option or type an answer.')
      }
      out.push({ choices: validChoices.slice(0, 1) })
      continue
    }

    if (validChoices.length === 0 && !customText) {
      throw new Error('Pick at least one option or type an answer.')
    }
    out.push(customText ? { choices: validChoices, customText } : { choices: validChoices })
  }

  return out
}

/** Plain answer strings for one step (preset labels followed by any custom text). */
export function stepAnswerTexts(step: AgentQuestionStep, answer: AgentQuestionStepAnswer): string[] {
  const labels = answer.choices
    .map((index) => step.options[index]?.label || '')
    .filter(Boolean)
  const custom = cleanCustomText(answer.customText)
  if (custom) labels.push(custom)
  return labels
}

/** Detailed answer strings for one step (preset labels with descriptions + custom text). */
export function stepAnswerDetailedTexts(step: AgentQuestionStep, answer: AgentQuestionStepAnswer): string[] {
  const parts = answer.choices
    .map((index) => step.options[index])
    .filter((option): option is NonNullable<typeof option> => Boolean(option))
    .map((option) => (option.description ? `${option.label} (${option.description})` : option.label))
  const custom = cleanCustomText(answer.customText)
  if (custom) parts.push(custom)
  return parts
}

/** Compact single-line summary of all step answers for status notices. */
export function summarizeQuestionAnswers(
  steps: AgentQuestionStep[],
  answers: AgentQuestionStepAnswer[]
): string {
  return answers
    .map((ans, idx) => {
      const step = steps[idx] || steps[0]
      return step ? stepAnswerTexts(step, ans).join(' | ') : cleanCustomText(ans.customText)
    })
    .filter(Boolean)
    .join(' · ')
}
