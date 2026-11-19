/**
 * A tiny, local-only bridge between Notch and the hooks that Claude Code,
 * Codex and Cursor can call. It has no cloud component: hooks POST to
 * 127.0.0.1 with a token, and Notch shows what the tool is doing.
 *
 * Permission requests are held open until the user clicks Approve or Deny in
 * the notch, then the hook response carries that decision back to the tool.
 */

import { execFile, spawn } from 'node:child_process'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type {
  AgentConnection,
  AgentPermission,
  AgentQuestion,
  AgentQuestionOption,
  AgentQuestionResponse,
  AgentQuestionStep,
  AgentQuestionStepAnswer,
  AgentSnapshot,
  AgentState,
  AgentStatus,
  AgentTool
} from '../shared/types'
import {
  normalizeQuestionResponse,
  questionSteps,
  stepAnswerDetailedTexts,
  stepAnswerTexts,
  summarizeQuestionAnswers
} from '../shared/questionAnswers'

const TOOLS: AgentTool[] = ['antigravity', 'claude', 'codex', 'cursor', 'gemini', 'cline', 'copilot', 'deepai', 'grok']
const STATES: AgentState[] = ['working', 'waiting', 'done']
const MAX_BODY = 1024 * 1024
const HOLD_MS = 4 * 60 * 1000
/** A question can sit much longer than a permission check before the tool
 * falls back to asking inside its own window. */
const QUESTION_HOLD_MS = 10 * 60 * 1000
const STATUS_TTL_MS = 5 * 60 * 1000
const MAX_OPTIONS = 6
const TITLE_KEYS = [
  'tool_name',
  'toolName',
  'command',
  'agent_message',
  'description',
  'subagent_type',
  'task',
  'prompt',
  'hook_event_name',
  'hookEventName',
  'source',
  'status',
  'name',
  'title'
]
const DETAIL_KEYS = [
  'tool_input',
  'tool_args',
  'command',
  'prompt',
  'task',
  'description',
  'last_assistant_message',
  'last_agent_message',
  'reason',
  'agent_message',
  'cwd'
]

export const agentStatusEvents = new EventEmitter()

let server: Server | null = null
let port = 0
let token = ''
let error: string | null = null

const statuses = new Map<AgentTool, AgentStatus>()
type HeldKind = 'permission' | 'question'
interface Held {
  kind: HeldKind
  item: AgentPermission
  question: AgentQuestion | null
  rawToolInput?: Record<string, unknown> | null
  hookEventName?: string
  res: ServerResponse
  timer: NodeJS.Timeout
}
const held = new Map<string, Held>()

function clean(value: unknown, max: number): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim().slice(0, max)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function summarize(raw: unknown): { title: string; detail: string } {
  if (!raw || typeof raw !== 'object') return { title: '', detail: '' }
  const row = raw as Record<string, unknown>
  const nestedToolCall = objectFrom(row.tool_call) ?? objectFrom(row.toolCall)
  const nestedPreToolUse = objectFrom(row.preToolUse)
  let title =
    (nestedToolCall?.name !== undefined ? String(nestedToolCall.name) : '') ||
    (nestedPreToolUse?.toolName !== undefined ? String(nestedPreToolUse.toolName) : '')
  const nestedInput = nestedToolCall?.input ?? nestedToolCall?.args
  let detail =
    (nestedInput !== undefined
      ? typeof nestedInput === 'string'
        ? nestedInput
        : JSON.stringify(nestedInput)
      : '') ||
    (nestedPreToolUse?.parameters !== undefined
      ? typeof nestedPreToolUse.parameters === 'string'
        ? nestedPreToolUse.parameters
        : JSON.stringify(nestedPreToolUse.parameters)
      : '')
  if (!title) {
    for (const key of TITLE_KEYS) {
      const value = row[key]
      if (value !== undefined && value !== null && value !== '') {
        title = typeof value === 'object' ? JSON.stringify(value) : String(value)
        break
      }
    }
  }
  if (!detail) {
    for (const key of DETAIL_KEYS) {
      const value = row[key]
      if (value !== undefined && value !== null && value !== '') {
        detail = typeof value === 'object' ? JSON.stringify(value) : String(value)
        break
      }
    }
  }
  return { title: clean(title, 320), detail: clean(detail, 1200) }
}

function emit(): void {
  agentStatusEvents.emit('change', snapshot())
}

export function snapshot(): AgentSnapshot {
  const now = Date.now()
  for (const [tool, status] of statuses) {
    if (now - status.at > STATUS_TTL_MS) statuses.delete(tool)
  }
  const entries = [...held.values()]
  const hookPending = entries.filter((entry) => entry.kind === 'permission').map((entry) => entry.item)
  const hookQuestions = entries
    .filter((entry) => entry.kind === 'question' && entry.question)
    .map((entry) => entry.question as AgentQuestion)
  const hookPendingTools = new Set(hookPending.map((item) => item.tool))
  const hookQuestionTools = new Set(hookQuestions.map((item) => item.tool))
  const nativePending = getNativePermissions().filter((item) => !hookPendingTools.has(item.tool))
  const nativeQs = getNativeQuestions().filter((item) => !hookQuestionTools.has(item.tool))
  return {
    statuses: [...statuses.values()].sort((a, b) => b.at - a.at),
    pending: [...hookPending, ...nativePending].sort((a, b) => a.at - b.at),
    questions: [...hookQuestions, ...nativeQs].sort((a, b) => a.at - b.at),
    port,
    token,
    running: Boolean(server?.listening),
    error
  }
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers['x-notch-token'] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '')
  const given = typeof header === 'string' ? header : ''
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('Too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req)
  if (!text.trim()) return {}
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

function decisionFor(
  tool: AgentTool,
  reply: 'allow' | 'deny',
  title: string,
  message?: string,
  hookEventName?: string
): object {
  if (tool === 'cursor') {
    return {
      continue: true,
      permission: reply,
      user_message: message || `Decided in Notch: ${title || 'tool use'}`,
      agent_message: message || `The user ${reply === 'allow' ? 'approved' : 'denied'} this in Notch.`
    }
  }
  if (tool === 'gemini' || tool === 'antigravity') {
    return {
      decision: reply,
      ...(reply === 'deny' ? { reason: message || `Denied in Notch: ${title || 'tool use'}` } : {})
    }
  }
  if (tool === 'cline') {
    return {
      cancel: reply === 'deny',
      ...(reply === 'deny' ? { errorMessage: message || `Denied in Notch: ${title || 'tool use'}` } : {})
    }
  }
  if (tool === 'codex') {
    if (hookEventName === 'PreToolUse') {
      if (reply === 'allow') return {}
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: message || 'Denied in Notch.'
        }
      }
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: reply,
          ...(reply === 'deny' ? { message: message || 'Denied in Notch.' } : {})
        }
      }
    }
  }
  if (tool === 'claude' && hookEventName === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: reply,
          ...(reply === 'deny' ? { message: message || `Denied in Notch: ${title || 'tool use'}` } : {})
        }
      }
    }
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: reply,
      permissionDecisionReason: message || `Decided in Notch: ${title || 'tool use'}`
    }
  }
}

function questionStepList(question: AgentQuestion): AgentQuestionStep[] {
  return questionSteps(question)
}

function normalizeStepAnswers(
  question: AgentQuestion,
  response: AgentQuestionResponse
): AgentQuestionStepAnswer[] {
  return normalizeQuestionResponse(questionStepList(question), response)
}

function summarizeAnsweredSteps(question: AgentQuestion, answers: AgentQuestionStepAnswer[]): string {
  return summarizeQuestionAnswers(questionStepList(question), answers)
}

/** A session asked the user to pick from options and the answer came from the
 * notch. Hook output cannot select an option, so the answer rides back as the
 * block reason: the tool reads it as the user's reply and moves on. */
export function decisionForQuestion(
  tool: AgentTool,
  question: AgentQuestion,
  stepAnswers: AgentQuestionStepAnswer[],
  hookEventName?: string,
  rawToolInput?: Record<string, unknown> | null
): object {
  const steps = questionStepList(question)
  const rawQuestions =
    rawToolInput && Array.isArray(rawToolInput.questions)
      ? (rawToolInput.questions as Record<string, unknown>[])
      : null
  const answeredSteps = stepAnswers
    .map((stepAnswer, sIdx) => {
      const step = steps[sIdx]
      if (!step) return null
      const detailed = stepAnswerDetailedTexts(step, stepAnswer)
      const plain = stepAnswerTexts(step, stepAnswer)
      if (plain.length === 0) return null
      const answer = detailed.join(' | ')
      const plainAnswer = plain.join(', ')
      const rawKey = typeof rawQuestions?.[sIdx]?.question === 'string' ? rawQuestions[sIdx].question : step.title
      return { title: step.title, rawKey, answer, plainAnswer }
    })
    .filter(
      (entry): entry is { title: string; rawKey: string; answer: string; plainAnswer: string } => Boolean(entry)
    )

  if (tool === 'claude' && hookEventName === 'PermissionRequest' && answeredSteps.length > 0) {
    const answers: Record<string, string> = {}
    for (const entry of answeredSteps) {
      answers[entry.rawKey] = entry.plainAnswer
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedInput: {
            ...(rawToolInput || {
              questions: steps.map((s) => ({
                question: s.title,
                ...(s.detail ? { header: s.detail } : {}),
                options: s.options.map((o) => ({ label: o.label, description: o.description || '' })),
                multiSelect: Boolean(s.multiSelect)
              }))
            }),
            answers
          }
        }
      }
    }
  }

  const text =
    answeredSteps.length <= 1
      ? `In answer to "${answeredSteps[0]?.title || question.title}", the user chose: ${answeredSteps[0]?.answer || ''}. ` +
        "Treat this as the user's answer and continue without asking again."
      : `${answeredSteps.map((s) => `In answer to "${s.title}", the user chose: ${s.answer}.`).join(' ')} ` +
        "Treat these as the user's answers and continue without asking again."
  return decisionFor(tool, 'deny', question.title, text, hookEventName)
}

function optionFrom(value: unknown): AgentQuestionOption | null {
  if (typeof value === 'string') {
    const label = clean(value, 120)
    return label ? { label, description: '' } : null
  }
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const label = clean(row.label ?? row.text ?? row.name ?? row.value ?? row.title, 120)
  if (!label) return null
  return { label, description: clean(row.description ?? row.detail ?? row.hint, 240) }
}

interface ParsedQuestion {
  title: string
  detail: string
  options: AgentQuestionOption[]
  multiSelect: boolean
  steps: AgentQuestionStep[]
}

function objectFrom(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        return null
      }
    }
  }
  return null
}

function arrayFrom(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        return Array.isArray(parsed) ? parsed : null
      } catch {
        return null
      }
    }
  }
  return null
}

const QUESTION_TOOL_NAME_RE =
  /^(?:AskUserQuestion|ask_?user(?:_?question)?|ask_?questions?|ask_?followup_?question|request_?user_?input(?:_?async)?)$/i

function extractHookToolName(body: Record<string, unknown>): string {
  const nestedToolCall = objectFrom(body.tool_call) ?? objectFrom(body.toolCall)
  const preTool = objectFrom(body.preToolUse)
  const raw =
    body.tool_name ??
    body.toolName ??
    nestedToolCall?.name ??
    preTool?.toolName ??
    body.name
  return typeof raw === 'string' ? raw.trim() : ''
}

function isQuestionToolHook(body: Record<string, unknown>): boolean {
  const name = extractHookToolName(body)
  return Boolean(name && QUESTION_TOOL_NAME_RE.test(name))
}

/** Recognise a multiple-choice question in a hook payload across Claude Code,
 * Codex, Anti Gravity, Cursor, Gemini CLI, Cline, and Copilot PreToolUse/BeforeTool shapes.
 * Returns null for plain permissions. */
function parseQuestion(body: Record<string, unknown>): ParsedQuestion | null {
  const nestedToolCall = objectFrom(body.tool_call) ?? objectFrom(body.toolCall)
  const toolCallInput = objectFrom(nestedToolCall?.input) ?? objectFrom(nestedToolCall?.args)
  const clineParams = objectFrom(objectFrom(body.preToolUse)?.parameters)
  const input =
    objectFrom(body.tool_input) ??
    objectFrom(body.tool_args) ??
    toolCallInput ??
    clineParams ??
    objectFrom(body.arguments) ??
    objectFrom(body.input) ??
    body
  const questions = arrayFrom(input.questions)
  if (questions && questions.length > 0) {
    const steps: AgentQuestionStep[] = []
    const extraTitles: string[] = []
    for (const entry of questions.slice(0, 6)) {
      if (!entry || typeof entry !== 'object') continue
      const row = entry as Record<string, unknown>
      const text = clean(row.question ?? row.prompt ?? row.prompt_markdown ?? row.header ?? row.title, 320)
      const header = clean(row.header ?? row.id, 140)
      const rowMulti =
        row.multiSelect === true ||
        row.multi_select === true ||
        row.is_multi_select === true ||
        row.isMultiSelect === true ||
        row.allow_multiple === true ||
        row.multiple === true
      const rowOptions = arrayFrom(row.options ?? row.choices)
      const parsedOptions: AgentQuestionOption[] = []
      if (rowOptions) {
        for (const option of rowOptions.slice(0, MAX_OPTIONS)) {
          const parsed = optionFrom(option)
          if (parsed) parsedOptions.push(parsed)
        }
      }
      if (parsedOptions.length >= 2) {
        steps.push({
          ...(header ? { id: header } : {}),
          title: text || header || 'Pick an option',
          ...(header && text && header !== text ? { detail: header } : {}),
          options: parsedOptions,
          multiSelect: rowMulti
        })
      } else if (text) {
        extraTitles.push(text)
      }
    }
    if (steps.length > 0) {
      const first = steps[0]
      const detailParts = [...steps.slice(1).map((s) => s.title), ...extraTitles].filter(Boolean)
      return {
        title: first.title,
        detail: detailParts.join(' · ') || first.detail || '',
        options: first.options,
        multiSelect: first.multiSelect,
        steps
      }
    }
  }
  for (const key of ['options', 'choices']) {
    const list = arrayFrom(input[key]) ?? arrayFrom(body[key])
    if (!list) continue
    const options: AgentQuestionOption[] = []
    for (const option of list.slice(0, MAX_OPTIONS)) {
      const parsed = optionFrom(option)
      if (parsed) options.push(parsed)
    }
    if (options.length >= 2) {
      const summary = summarize(body)
      const title =
        clean(input.question ?? input.prompt ?? input.title ?? input.header, 320) ||
        summary.title ||
        'Pick an option'
      const multiSelect =
        input.multiSelect === true ||
        input.multi_select === true ||
        input.is_multi_select === true ||
        input.isMultiSelect === true ||
        input.allow_multiple === true ||
        input.multiple === true
      const steps: AgentQuestionStep[] = [
        {
          title,
          ...(summary.detail ? { detail: summary.detail } : {}),
          options,
          multiSelect
        }
      ]
      return { title, detail: summary.detail, options, multiSelect, steps }
    }
  }
  return null
}

function finish(
  id: string,
  reply: 'allow' | 'deny' | null,
  stepAnswers?: AgentQuestionStepAnswer[]
): void {
  const entry = held.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  held.delete(id)
  const { item, res, hookEventName, rawToolInput } = entry
  const answeredQuestion =
    entry.kind === 'question' &&
    entry.question &&
    stepAnswers &&
    stepAnswers.length > 0 &&
    stepAnswers.some((ans) => ans.choices.length > 0 || Boolean(ans.customText))
  if (reply) {
    statuses.set(item.tool, {
      tool: item.tool,
      state: reply === 'allow' ? 'working' : 'done',
      title: reply === 'allow' ? 'Approved in Notch' : 'Denied in Notch',
      detail: item.title,
      at: Date.now()
    })
  }
  if (answeredQuestion) {
    statuses.set(item.tool, {
      tool: item.tool,
      state: 'working',
      title: `Answered in Notch: ${summarizeAnsweredSteps(entry.question!, stepAnswers!)}`,
      detail: entry.question!.title,
      at: Date.now()
    })
  } else if (!reply && statuses.get(item.tool)?.at === item.at) {
    statuses.delete(item.tool)
  }
  if (!res.writableEnded) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    if (entry.kind === 'question' && entry.question) {
      res.end(
        JSON.stringify(
          answeredQuestion
            ? decisionForQuestion(item.tool, entry.question, stepAnswers!, hookEventName, rawToolInput)
            : {}
        )
      )
    } else {
      res.end(JSON.stringify(reply ? decisionFor(item.tool, reply, item.title, undefined, hookEventName) : {}))
    }
  }
  emit()
}

export function decide(id: string, reply: 'allow' | 'deny'): void {
  if (reply !== 'allow' && reply !== 'deny') throw new Error('Invalid decision.')
  const entry = held.get(id)
  if (entry) {
    if (entry.kind === 'question') throw new Error('That question needs a chosen option, not approve or deny.')
    finish(id, reply)
    return
  }
  if (hasNativePermission(id) && decideNativePermission(id, reply)) {
    return
  }
  if (hasNativeQuestion(id)) {
    throw new Error('That question needs a chosen option, not approve or deny.')
  }
  throw new Error('That request is no longer waiting.')
}

/** Send the user's chosen options and/or custom typed text back to the session that is waiting. */
export function decideQuestion(id: string, response: AgentQuestionResponse): void {
  const entry = held.get(id)
  if (entry) {
    if (entry.kind !== 'question' || !entry.question) throw new Error('That request is not a question.')
    const answers = normalizeStepAnswers(entry.question, response)
    finish(id, null, answers)
    return
  }
  const nativeQ = getNativeQuestions().find((q) => q.id === id)
  if (nativeQ) {
    const answers = normalizeStepAnswers(nativeQ, response)
    decideNativeQuestion(id, answers)
    return
  }
  if (hasNativePermission(id)) {
    throw new Error('That request is not a question.')
  }
  throw new Error('That question is no longer waiting.')
}

/** Drop the hold so the tool shows the question in its own window instead. */
export function releaseQuestion(id: string): void {
  const entry = held.get(id)
  if (entry) {
    if (entry.kind !== 'question') throw new Error('That request is not a question.')
    finish(id, null)
    return
  }
  if (hasNativeQuestion(id) && releaseNativeQuestion(id)) {
    return
  }
  if (hasNativePermission(id)) {
    throw new Error('That request is not a question.')
  }
  throw new Error('That question is no longer waiting.')
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (req.method === 'OPTIONS') {
    res.writeHead(405).end()
    return
  }
  if (!authorized(req)) {
    res.writeHead(401).end('Invalid token.')
    return
  }
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const tool = url.searchParams.get('tool') as AgentTool | null
  const kind = url.searchParams.get('kind')
  const knownTool = tool && TOOLS.includes(tool) ? tool : null

  try {
    if (req.method === 'GET' && url.pathname === '/status') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(snapshot()))
      return
    }

    if (req.method === 'POST' && url.pathname === '/decision') {
      const body = await jsonBody(req)
      if (typeof body.id !== 'string') {
        res.writeHead(400).end('Invalid decision.')
        return
      }
      try {
        const rawChoice = Array.isArray(body.choices)
          ? body.choices
          : Array.isArray(body.choice)
            ? body.choice
            : null
        const rawAnswers = Array.isArray(body.answers) ? body.answers : null
        const rawCustomText = typeof body.customText === 'string' ? body.customText : null
        if (body.release === true) {
          releaseQuestion(body.id)
        } else if (rawAnswers) {
          const parsedAnswers: AgentQuestionStepAnswer[] = rawAnswers.map((row) => {
            const entry = row && typeof row === 'object' ? (row as Record<string, unknown>) : {}
            const choices = Array.isArray(entry.choices) ? entry.choices.map(Number) : []
            const customText = typeof entry.customText === 'string' ? entry.customText : undefined
            return customText ? { choices, customText } : { choices }
          })
          decideQuestion(body.id, parsedAnswers)
        } else if (rawCustomText && rawCustomText.trim()) {
          const choices = rawChoice && !Array.isArray(rawChoice[0]) ? rawChoice.map(Number) : []
          decideQuestion(body.id, [{ choices, customText: rawCustomText }])
        } else if (rawChoice) {
          const parsedChoice: number[] | number[][] = Array.isArray(rawChoice[0])
            ? (rawChoice as unknown[][]).map((row) => (Array.isArray(row) ? row.map(Number) : []))
            : rawChoice.map(Number)
          decideQuestion(body.id, parsedChoice)
        } else if (typeof body.reply === 'string' && (body.reply === 'allow' || body.reply === 'deny')) {
          decide(body.id, body.reply)
        } else {
          res.writeHead(400).end('Invalid decision.')
          return
        }
        res.writeHead(204).end()
      } catch (cause) {
        res.writeHead(409).end(cause instanceof Error ? cause.message : 'Request closed.')
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/hook' && knownTool && kind) {
      const body = await jsonBody(req)
      const summary = summarize(body)
      const hookEventName =
        typeof body.hook_event_name === 'string'
          ? body.hook_event_name
          : typeof body.hookEventName === 'string'
            ? body.hookEventName
            : undefined
      // Only parse multiple-choice questions on explicit question hooks, or on
      // permission hooks whose tool name is a known interactive question tool
      // (so ordinary tools whose inputs happen to have `options` are never
      // auto-approved as questions).
      const parsedQuestion =
        kind === 'question' || (kind === 'permission' && isQuestionToolHook(body))
          ? parseQuestion(body)
          : null
      if (parsedQuestion) {
        const id = randomBytes(9).toString('hex')
        const question: AgentQuestion = {
          id,
          tool: knownTool,
          title: parsedQuestion.title,
          detail: parsedQuestion.detail,
          options: parsedQuestion.options,
          multiSelect: parsedQuestion.multiSelect,
          steps: parsedQuestion.steps,
          at: Date.now()
        }
        statuses.set(knownTool, {
          tool: knownTool,
          state: 'waiting',
          title: `${knownTool} asks: ${question.title}`,
          detail: question.detail,
          at: question.at
        })
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        const timer = setTimeout(() => finish(id, null), QUESTION_HOLD_MS)
        timer.unref?.()
        res.on('close', () => {
          if (!res.writableEnded) finish(id, null)
        })
        const rawToolInput =
          objectFrom(body.tool_input ?? body.toolInput ?? body.input ?? body.args) ??
          objectFrom(objectFrom(body.toolCall)?.args)
        held.set(id, {
          kind: 'question',
          item: { id, tool: knownTool, title: question.title, detail: question.detail, at: question.at },
          question,
          rawToolInput,
          hookEventName,
          res,
          timer
        })
        emit()
        return
      }
      if (kind === 'question' && !parsedQuestion) {
        res.writeHead(400).end('The payload carried no options.')
        return
      }
      // Cursor runs this hook for every tool. Reads need no approval, so let them
      // through untouched rather than raising a card (older hook files lack the matcher).
      if (
        kind === 'permission' &&
        knownTool === 'cursor' &&
        typeof body.tool_name === 'string' &&
        CURSOR_READ_ONLY_TOOLS.includes(body.tool_name)
      ) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end('{}')
        return
      }
      if (kind === 'permission') {
        const id = randomBytes(9).toString('hex')
        const item: AgentPermission = {
          id,
          tool: knownTool,
          title: summary.title || `${knownTool} wants to run a tool`,
          detail: summary.detail,
          at: Date.now()
        }
        statuses.set(knownTool, {
          tool: knownTool,
          state: 'waiting',
          title: item.title,
          detail: item.detail,
          at: item.at
        })
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        const timer = setTimeout(() => finish(id, null), HOLD_MS)
        timer.unref?.()
        res.on('close', () => {
          if (!res.writableEnded) finish(id, null)
        })
        held.set(id, { kind: 'permission', item, question: null, hookEventName, res, timer })
        emit()
        return
      }
      if (STATES.includes(kind as AgentState)) {
        const state = kind as AgentState
        const labels: Record<AgentState, string> = {
          working: 'Working',
          waiting: 'Waiting for you',
          done: 'Done'
        }
        statuses.set(knownTool, {
          tool: knownTool,
          state,
          title: summary.title || labels[state],
          detail: summary.detail,
          at: Date.now()
        })
        emit()
        res.writeHead(204).end()
        return
      }
    }

    res.writeHead(404).end('No such hook.')
  } catch {
    if (!res.writableEnded) res.writeHead(400).end('Invalid hook payload.')
  }
}

let hookSyncTimer: NodeJS.Timeout | null = null

export function agentStatusStart(listenPort: number, listenToken: string): void {
  agentStatusStop()
  port = listenPort
  token = listenToken
  error = null
  const next = createServer((req, res) => {
    void handle(req, res)
  })
  next.on('error', (cause: NodeJS.ErrnoException) => {
    error =
      cause.code === 'EADDRINUSE'
        ? `Port ${listenPort} is already in use.`
        : 'The local status bridge could not start.'
    emit()
  })
  server = next
  next.listen(listenPort, '127.0.0.1', () => {
    error = null
    if (Boolean(process.versions.electron) || process.env.NOTCH_NATIVE_POLL === '1') {
      startNativeAgentPrompts(
        () => emit(),
        (status) => {
          statuses.set(status.tool, status)
        }
      )
    }
    if (Boolean(process.versions.electron) && listenPort > 0 && listenToken) {
      void syncInstalledToolHooks(listenPort, listenToken)
      // Pick up tools installed after Notch started, with no restart needed.
      hookSyncTimer = setInterval(() => void syncInstalledToolHooks(listenPort, listenToken), 60_000)
      hookSyncTimer.unref?.()
    }
    emit()
  })
  emit()
}

export function agentStatusStop(): void {
  stopNativeAgentPrompts()
  if (hookSyncTimer) clearInterval(hookSyncTimer)
  hookSyncTimer = null
  for (const id of [...held.keys()]) finish(id, null)
  const old = server
  server = null
  if (old) {
    old.close()
    old.closeAllConnections()
  }
  emit()
}

/** PowerShell statements to read UTF-8 stdin, POST it to Notch as UTF-8 bytes, and write UTF-8 JSON back. */
function hookStatements(kind: 'working' | 'done' | 'permission', url: string, tokenValue: string): string[] {
  const timeout = kind === 'permission' ? 250 : 10
  return [
    '[Console]::InputEncoding=[System.Text.Encoding]::UTF8',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    '$body=[Console]::In.ReadToEnd()',
    '$bytes=[System.Text.Encoding]::UTF8.GetBytes($body)',
    `$headers=@{'X-Notch-Token'='${tokenValue}'}`,
    `try{$reply=Invoke-RestMethod -Uri '${url}' -Method Post -Headers $headers -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec ${timeout};if($reply){$reply|ConvertTo-Json -Compress -Depth 8}else{'{}'}}catch{'{}'}`
  ]
}

/** The PowerShell one-liner a hook runs. Encoded so any shell can launch it. */
function hookCommand(kind: 'working' | 'done' | 'permission', url: string, tokenValue: string): string {
  const script = hookStatements(kind, url, tokenValue).join(';')
  return `powershell -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}

export function setupSnippet(tool: AgentTool, listenPort: number, tokenValue: string): string {
  if (Boolean(process.versions.electron) && listenPort > 0 && tokenValue) {
    void syncInstalledToolHooks(listenPort, tokenValue)
  }
  const base = `http://127.0.0.1:${listenPort}/hook?tool=${tool}`
  const working = hookCommand('working', `${base}&kind=working`, tokenValue)
  const done = hookCommand('done', `${base}&kind=done`, tokenValue)
  const permission = hookCommand('permission', `${base}&kind=permission`, tokenValue)

  if (tool === 'claude') {
    // Merge these `hooks` into ~/.claude/settings.json.
    return JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: working, timeout: 10 }] }],
          PermissionRequest: [{ hooks: [{ type: 'command', command: permission, timeout: 250 }] }],
          Stop: [{ hooks: [{ type: 'command', command: done, timeout: 10 }] }]
        }
      },
      null,
      2
    )
  }
  if (tool === 'codex') {
    // Paste into ~/.codex/config.toml. Codex asks you to trust new hooks once.
    return [
      '[features]',
      'codex_hooks = true',
      'hooks = true',
      '',
      '[[hooks.UserPromptSubmit]]',
      '',
      '[[hooks.UserPromptSubmit.hooks]]',
      'type = "command"',
      `command = '${working}'`,
      'timeout = 10',
      '',
      '[[hooks.PermissionRequest]]',
      'matcher = ".*"',
      '',
      '[[hooks.PermissionRequest.hooks]]',
      'type = "command"',
      `command = '${permission}'`,
      'timeout = 250',
      '',
      '[[hooks.Stop]]',
      '',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      `command = '${done}'`,
      'timeout = 10'
    ].join('\n')
  }
  if (tool === 'antigravity') {
    // Anti Gravity questions & approvals are detected automatically via its local
    // daemon. You can also merge these optional hooks into ~/.gemini/config/hooks.json.
    return JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: working, timeout: 10 }] }],
          PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: permission, timeout: 250 }] }],
          Stop: [{ hooks: [{ type: 'command', command: done, timeout: 10 }] }]
        }
      },
      null,
      2
    )
  }
  if (tool === 'gemini') {
    // Merge these `hooks` into ~/.gemini/settings.json (timeouts in ms).
    return JSON.stringify(
      {
        hooks: {
          BeforeAgent: [{ hooks: [{ name: 'notch-working', type: 'command', command: working, timeout: 10000 }] }],
          BeforeTool: [
            { matcher: '.*', hooks: [{ name: 'notch-permission', type: 'command', command: permission, timeout: 250000 }] }
          ],
          AfterAgent: [{ hooks: [{ name: 'notch-done', type: 'command', command: done, timeout: 10000 }] }]
        }
      },
      null,
      2
    )
  }
  if (tool === 'cline') {
    // On Windows, save each script block as UserPromptSubmit.ps1, PreToolUse.ps1, and TaskComplete.ps1
    // under ~/Documents/Cline/Rules/Hooks/ (or .clinerules/hooks/).
    return [
      '# Cline Windows Hooks — save each block into ~/Documents/Cline/Rules/Hooks/',
      '',
      '# --- UserPromptSubmit.ps1 ---',
      ...hookStatements('working', `${base}&kind=working`, tokenValue),
      '',
      '# --- PreToolUse.ps1 ---',
      ...hookStatements('permission', `${base}&kind=permission`, tokenValue),
      '',
      '# --- TaskComplete.ps1 ---',
      ...hookStatements('done', `${base}&kind=done`, tokenValue)
    ].join('\n')
  }
  if (tool === 'copilot') {
    // Save as .github/hooks/notch.json in your repository (VS Code / Copilot Agent Hooks).
    return JSON.stringify(
      {
        version: 1,
        hooks: {
          UserPromptSubmit: [{ type: 'command', command: working, timeout: 10 }],
          PreToolUse: [{ type: 'command', command: permission, timeout: 250 }],
          Stop: [{ type: 'command', command: done, timeout: 10 }]
        }
      },
      null,
      2
    )
  }
  // Paste into ~/.cursor/hooks.json.
  return JSON.stringify(
    {
      version: 1,
      hooks: {
        sessionStart: [{ command: working }],
        preToolUse: [{ command: permission, timeout: 250, matcher: CURSOR_HOOK_MATCHER }],
        stop: [{ command: done }]
      }
    },
    null,
    2
  )
}

// ---------------------------------------------------------------------------
// Native Local Store & Daemon Poller (Anti Gravity, Codex Rollouts, DeepAI Code)
// ---------------------------------------------------------------------------

const NATIVE_POLL_MS = 1500
const DISMISSED_TTL_MS = 30 * 60 * 1000

interface AgRawOption {
  id?: string
  text?: string
  label?: string
  description?: string
}

interface AgRawQuestion {
  question?: string
  header?: string
  options?: AgRawOption[]
  isMultiSelect?: boolean
  is_multi_select?: boolean
  multiSelect?: boolean
}

interface AgStepDetail {
  cascadeId: string
  stepIndex: number
  trajectoryId: string
  convTitle: string
  kind: 'question' | 'permission'
  question?: AgentQuestion
  rawQuestions?: AgRawQuestion[]
  permission?: AgentPermission
  buildPermissionPayload?: (reply: 'allow' | 'deny') => Record<string, unknown>
}

interface CodexPendingQuestion {
  id: string
  threadId: string
  callId: string
  fnName: string
  question: AgentQuestion
  rawQuestions: {
    id?: string
    header?: string
    question?: string
    options?: { label?: string; text?: string; description?: string }[]
  }[]
}

interface DeepAiPendingItem {
  id: string
  kind: 'permission' | 'question'
  permission?: AgentPermission
  question?: AgentQuestion
}

const nativePermissions = new Map<string, AgentPermission>()
const nativeQuestions = new Map<string, AgentQuestion>()
const agActiveItems = new Map<string, AgStepDetail>()
const codexActiveQuestions = new Map<string, CodexPendingQuestion>()
const codexLiveItems = new Map<string, CodexLiveRequest>()

const CODEX_IPC_PIPE = '\\\\.\\pipe\\codex-ipc'
const CODEX_IPC_CONNECT_MS = 700
const CODEX_IPC_REQUEST_MS = 3500
const CODEX_IPC_SNAPSHOT_MS = 450

interface CodexIpcEnvelope {
  type?: string
  requestId?: string
  method?: string
  resultType?: string
  error?: string
  handledByClientId?: string
  result?: Record<string, unknown>
  params?: Record<string, unknown>
}

interface CodexLiveRequest {
  threadId: string
  requestId: string | number
  method:
    | 'item/commandExecution/requestApproval'
    | 'item/fileChange/requestApproval'
    | 'item/permissions/requestApproval'
    | 'item/tool/requestUserInput'
  kind: 'permission' | 'question'
  title: string
  detail: string
  params: Record<string, unknown>
  steps?: AgentQuestionStep[]
  rawQuestionIds?: string[]
}

function encodeCodexIpcFrame(payload: object): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32LE(json.length, 0)
  return Buffer.concat([header, json])
}

class CodexPipeClient {
  private socket: net.Socket
  private rx: Buffer = Buffer.alloc(0)
  private pendingRequests = new Map<
    string,
    { resolve: (msg: CodexIpcEnvelope) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >()
  private snapshotWaiters = new Map<
    string,
    { resolve: (cs: Record<string, unknown> | null) => void; timer: NodeJS.Timeout }
  >()
  private closed = false

  private constructor(socket: net.Socket) {
    this.socket = socket
    socket.on('data', (chunk) => this.onData(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
    socket.on('error', () => this.failAll(new Error('codex-ipc socket error')))
    socket.on('close', () => {
      this.closed = true
      this.failAll(new Error('codex-ipc socket closed'))
    })
  }

  static connect(): Promise<CodexPipeClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(process.env.NOTCH_CODEX_IPC_PIPE || CODEX_IPC_PIPE)
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(new Error('codex-ipc connect timeout'))
      }, CODEX_IPC_CONNECT_MS)
      timer.unref?.()

      socket.once('connect', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(new CodexPipeClient(socket))
      })
      socket.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        reject(err)
      })
    })
  }

  private failAll(err: Error): void {
    for (const [id, entry] of this.pendingRequests) {
      clearTimeout(entry.timer)
      entry.reject(err)
      this.pendingRequests.delete(id)
    }
    for (const [convId, entry] of this.snapshotWaiters) {
      clearTimeout(entry.timer)
      entry.resolve(null)
      this.snapshotWaiters.delete(convId)
    }
  }

  private onData(chunk: Buffer): void {
    this.rx = Buffer.concat([this.rx, chunk])
    while (this.rx.length >= 4) {
      const len = this.rx.readUInt32LE(0)
      if (len > 32 * 1024 * 1024) {
        this.close()
        return
      }
      if (this.rx.length < 4 + len) break
      const raw = this.rx.subarray(4, 4 + len).toString('utf8')
      this.rx = this.rx.subarray(4 + len)
      let msg: CodexIpcEnvelope
      try {
        msg = JSON.parse(raw) as CodexIpcEnvelope
      } catch {
        continue
      }
      if (msg.type === 'response' && typeof msg.requestId === 'string') {
        const waiter = this.pendingRequests.get(msg.requestId)
        if (waiter) {
          this.pendingRequests.delete(msg.requestId)
          clearTimeout(waiter.timer)
          waiter.resolve(msg)
        }
        continue
      }
      if (msg.method === 'thread-stream-state-changed' && msg.params) {
        const convId = typeof msg.params.conversationId === 'string' ? msg.params.conversationId : ''
        const change =
          msg.params.change && typeof msg.params.change === 'object'
            ? (msg.params.change as Record<string, unknown>)
            : null
        if (
          convId &&
          change?.type === 'snapshot' &&
          change.conversationState &&
          typeof change.conversationState === 'object'
        ) {
          const waiter = this.snapshotWaiters.get(convId)
          if (waiter) {
            this.snapshotWaiters.delete(convId)
            clearTimeout(waiter.timer)
            waiter.resolve(change.conversationState as Record<string, unknown>)
          }
        }
      }
    }
  }

  send(payload: object): void {
    if (this.closed) return
    this.socket.write(encodeCodexIpcFrame(payload))
  }

  request(
    method: string,
    params: Record<string, unknown>,
    opts?: { version?: number; targetClientId?: string; timeoutMs?: number }
  ): Promise<CodexIpcEnvelope> {
    if (this.closed) return Promise.reject(new Error('codex-ipc closed'))
    const requestId = randomUUID()
    const timeoutMs = opts?.timeoutMs ?? CODEX_IPC_REQUEST_MS
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`codex-ipc ${method} timeout`))
      }, timeoutMs)
      timer.unref?.()
      this.pendingRequests.set(requestId, { resolve, reject, timer })
      this.send({
        type: 'request',
        requestId,
        method,
        ...(opts?.version !== undefined ? { version: opts.version } : {}),
        ...(opts?.targetClientId ? { targetClientId: opts.targetClientId } : {}),
        params
      })
    })
  }

  async initialize(): Promise<void> {
    const res = await this.request('initialize', { clientType: 'follower' })
    if (res.resultType !== 'success') {
      throw new Error(res.error || 'codex-ipc initialize failed')
    }
  }

  async discoverOwner(threadId: string): Promise<string | null> {
    const res = await this.request(
      'thread-owner-discovery',
      { hostId: 'local', conversationId: threadId },
      { version: 1, timeoutMs: 1200 }
    )
    if (res.resultType === 'success' && typeof res.handledByClientId === 'string') {
      return res.handledByClientId
    }
    return null
  }

  readSnapshot(threadId: string, ownerId: string): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const prev = this.snapshotWaiters.get(threadId)
      if (prev) {
        clearTimeout(prev.timer)
        prev.resolve(null)
      }
      const unfollow = () => {
        this.send({
          type: 'broadcast',
          method: 'thread-stream-following-changed',
          version: 1,
          targetClientIds: [ownerId],
          params: { conversationId: threadId, hostId: 'local', following: false }
        })
      }
      const timer = setTimeout(() => {
        this.snapshotWaiters.delete(threadId)
        unfollow()
        resolve(null)
      }, CODEX_IPC_SNAPSHOT_MS)
      timer.unref?.()
      this.snapshotWaiters.set(threadId, {
        timer,
        resolve: (cs) => {
          unfollow()
          resolve(cs)
        }
      })
      this.send({
        type: 'broadcast',
        method: 'thread-stream-following-changed',
        version: 1,
        targetClientIds: [ownerId],
        params: { conversationId: threadId, hostId: 'local', following: true }
      })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAll(new Error('codex-ipc closed'))
    this.socket.destroy()
  }
}

async function withCodexPipe<T>(fn: (client: CodexPipeClient) => Promise<T>): Promise<T> {
  const client = await CodexPipeClient.connect()
  try {
    await client.initialize()
    return await fn(client)
  } finally {
    client.close()
  }
}

function parseCodexLiveRequest(threadId: string, req: unknown): CodexLiveRequest | null {
  if (!req || typeof req !== 'object') return null
  const row = req as Record<string, unknown>
  const requestId = row.id
  if (typeof requestId !== 'string' && typeof requestId !== 'number') return null
  const method = row.method
  const params =
    row.params && typeof row.params === 'object' ? (row.params as Record<string, unknown>) : {}

  if (method === 'item/commandExecution/requestApproval') {
    const cmdText = clean(params.command ?? params.parsedCmd, 280)
    const reason = clean(params.reason, 220)
    const cwd = clean(params.cwd, 160)
    return {
      threadId,
      requestId,
      method,
      kind: 'permission',
      title: cmdText || 'Run command in Codex',
      detail: [reason, cwd].filter(Boolean).join(' · ') || 'Codex command approval',
      params
    }
  }
  if (method === 'item/fileChange/requestApproval') {
    return {
      threadId,
      requestId,
      method,
      kind: 'permission',
      title: 'Approve file changes in Codex',
      detail: clean(params.reason ?? params.grantRoot, 280) || 'Codex wants to modify files',
      params
    }
  }
  if (method === 'item/permissions/requestApproval') {
    return {
      threadId,
      requestId,
      method,
      kind: 'permission',
      title: 'Approve permissions in Codex',
      detail:
        clean(params.reason, 240) ||
        clean(JSON.stringify(params.permissions ?? {}), 240) ||
        'Codex permissions request',
      params
    }
  }
  if (method === 'item/tool/requestUserInput') {
    const rawQs = Array.isArray(params.questions) ? (params.questions as Record<string, unknown>[]) : []
    const steps: AgentQuestionStep[] = []
    const rawQuestionIds: string[] = []
    for (let i = 0; i < rawQs.length; i++) {
      const q = rawQs[i]
      if (!q || typeof q !== 'object') continue
      const qId = typeof q.id === 'string' && q.id ? q.id : `q_${i}`
      const rawOpts = Array.isArray(q.options) ? q.options : []
      const options: AgentQuestionOption[] = []
      for (const opt of rawOpts) {
        const parsed = optionFrom(opt)
        if (parsed) options.push(parsed)
      }
      if (options.length < 2) continue
      const title = clean(q.question ?? q.title ?? q.header, 320) || 'Choose an option to continue'
      const header = clean(q.header, 140)
      steps.push({
        id: qId,
        title,
        ...(header && header !== title ? { detail: header } : {}),
        options,
        multiSelect: Boolean(q.multiSelect ?? q.isMultiSelect)
      })
      rawQuestionIds.push(qId)
    }
    if (steps.length === 0) return null
    return {
      threadId,
      requestId,
      method,
      kind: 'question',
      title: steps[0].title,
      detail:
        steps.length > 1
          ? clean(steps.slice(1).map((s) => s.title).join(' · '), 320)
          : steps[0].detail || '',
      params,
      steps,
      rawQuestionIds
    }
  }
  return null
}

async function probeCodexLiveRequests(
  threadIds: string[]
): Promise<{ requests: CodexLiveRequest[]; activeThreadIds: string[] }> {
  if (threadIds.length === 0) return { requests: [], activeThreadIds: [] }
  try {
    return await withCodexPipe(async (client) => {
      const requests: CodexLiveRequest[] = []
      const activeThreadIds: string[] = []
      for (const threadId of threadIds.slice(0, 6)) {
        try {
          const ownerId = await client.discoverOwner(threadId)
          if (!ownerId) continue
          const cs = await client.readSnapshot(threadId, ownerId)
          if (!cs) continue
          const rt =
            cs.threadRuntimeStatus && typeof cs.threadRuntimeStatus === 'object'
              ? (cs.threadRuntimeStatus as Record<string, unknown>)
              : null
          if (rt?.type === 'active') activeThreadIds.push(threadId)
          const rawReqs = Array.isArray(cs.requests) ? cs.requests : []
          for (const rawReq of rawReqs) {
            const parsed = parseCodexLiveRequest(threadId, rawReq)
            if (parsed) requests.push(parsed)
          }
        } catch {
          // Thread owner unavailable or timed out.
        }
      }
      return { requests, activeThreadIds }
    })
  } catch {
    return { requests: [], activeThreadIds: [] }
  }
}

async function resolveCodexExecutable(): Promise<string | null> {
  try {
    const cfg = await fs.readFile(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8')
    const match = cfg.match(/[A-Za-z]:[\\/][^\r\n'"]*OpenAI\.Codex_[^\\/\r\n'"]+[\\/][^'\r\n"]*codex\.exe/i)
    if (match?.[0]) {
      const candidate = match[0].replace(/\\\\/g, '\\')
      const stat = await fs.stat(candidate).catch(() => null)
      if (stat?.isFile()) return candidate
    }
  } catch {
    // Ignore missing config.toml.
  }
  const windowsApps = path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'WindowsApps')
  try {
    const entries = await fs.readdir(windowsApps)
    const pkg = entries.filter((name) => name.startsWith('OpenAI.Codex_')).sort().pop()
    if (pkg) {
      const candidate = path.join(windowsApps, pkg, 'app', 'resources', 'codex.exe')
      const stat = await fs.stat(candidate).catch(() => null)
      if (stat?.isFile()) return candidate
    }
  } catch {
    // Protected folder; fall back to PATH.
  }
  return 'codex.exe'
}

export async function submitCodexAsyncQuestionReply(
  threadId: string,
  callId: string,
  rawQuestions: { question?: string }[],
  chosenLabelsPerStep: string[][]
): Promise<{ ok: boolean; via: 'ipc' | 'cli' | 'none'; error?: string }> {
  const replyPayload = rawQuestions.map((q, idx) => ({
    questionItemId: JSON.stringify(['request_user_input_async', callId, idx]),
    question: clean(q.question, 600),
    answer: (chosenLabelsPerStep[idx] || []).join(', ')
  }))
  const text = `<send_user_message_question_reply>\n${JSON.stringify(replyPayload)}\n</send_user_message_question_reply>`

  let lastError: string | undefined
  try {
    const ipcOutcome = await withCodexPipe(async (client) => {
      const ownerId = await client.discoverOwner(threadId)
      if (!ownerId) return { ok: false as const, error: 'no-owner' }
      const res = await client.request(
        'thread-follower-start-turn',
        {
          conversationId: threadId,
          turnStart: {
            request: {
              threadId,
              turnTrigger: 'send_user_message_async_question',
              clientUserMessageId: randomUUID(),
              input: [{ type: 'text', text, text_elements: [] }]
            },
            context: {
              useAppServerPermissionDefault: true,
              useAppServerServiceTierDefault: true
            }
          }
        },
        { version: 2, targetClientId: ownerId, timeoutMs: 5000 }
      )
      return res.resultType === 'success'
        ? { ok: true as const }
        : { ok: false as const, error: res.error || 'thread-follower-start-turn rejected' }
    })
    if (ipcOutcome.ok) return { ok: true, via: 'ipc' }
    lastError = ipcOutcome.error
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
  }

  if (lastError === 'no-owner' || (lastError && /ENOENT|ECONNREFUSED|timeout/i.test(lastError))) {
    try {
      const exe = await resolveCodexExecutable()
      if (exe) {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(exe, ['exec', 'resume', threadId, text], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          })
          child.once('error', reject)
          child.once('spawn', () => {
            child.unref()
            resolve()
          })
        })
        return { ok: true, via: 'cli' }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  return { ok: false, via: 'none', error: lastError }
}

/** Type a message into a Codex thread that is open in Codex Desktop, the way the
 * app's own composer would. A background `codex exec resume` cannot do this:
 * Codex gives an open thread a single writer and refuses a second one. Returns
 * `no-owner` when no open Desktop window holds the thread, so the caller can use
 * the command line instead. */
export async function sendCodexDesktopMessage(
  threadId: string,
  text: string
): Promise<{ reason: 'sent' | 'no-owner' | 'error'; error?: string }> {
  try {
    return await withCodexPipe(async (client) => {
      const ownerId = await client.discoverOwner(threadId)
      if (!ownerId) return { reason: 'no-owner' as const }
      const res = await client.request(
        'thread-follower-start-turn',
        {
          conversationId: threadId,
          turnStart: {
            request: {
              threadId,
              clientUserMessageId: randomUUID(),
              input: [{ type: 'text', text, text_elements: [] }]
            },
            context: {
              useAppServerPermissionDefault: true,
              useAppServerServiceTierDefault: true
            }
          }
        },
        { version: 2, targetClientId: ownerId, timeoutMs: 8000 }
      )
      return res.resultType === 'success'
        ? { reason: 'sent' as const }
        : { reason: 'error' as const, error: res.error || 'Codex Desktop rejected the message.' }
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/ENOENT|ECONNREFUSED|timeout/i.test(message)) {
      return { reason: 'no-owner' }
    }
    return { reason: 'error', error: message }
  }
}

async function replyCodexLiveApproval(
  threadId: string,
  requestId: string | number,
  method:
    | 'item/commandExecution/requestApproval'
    | 'item/fileChange/requestApproval'
    | 'item/permissions/requestApproval',
  reply: 'allow' | 'deny',
  permissions?: unknown
): Promise<boolean> {
  try {
    return await withCodexPipe(async (client) => {
      const ownerId = await client.discoverOwner(threadId)
      if (!ownerId) return false
      const decision = reply === 'allow' ? 'accept' : 'decline'
      if (method === 'item/commandExecution/requestApproval') {
        const res = await client.request(
          'thread-follower-command-approval-decision',
          { conversationId: threadId, requestId, decision },
          { version: 1, targetClientId: ownerId }
        )
        return res.resultType === 'success'
      }
      if (method === 'item/fileChange/requestApproval') {
        const res = await client.request(
          'thread-follower-file-approval-decision',
          { conversationId: threadId, requestId, decision },
          { version: 1, targetClientId: ownerId }
        )
        return res.resultType === 'success'
      }
      const res = await client.request(
        'thread-follower-permissions-request-approval-response',
        {
          conversationId: threadId,
          requestId,
          response: {
            permissions: reply === 'allow' ? (permissions ?? {}) : {},
            scope: 'turn'
          }
        },
        { version: 1, targetClientId: ownerId }
      )
      return res.resultType === 'success'
    })
  } catch {
    return false
  }
}

async function replyCodexLiveUserInput(
  threadId: string,
  requestId: string | number,
  answers: Record<string, { answers: string[] }>
): Promise<boolean> {
  try {
    return await withCodexPipe(async (client) => {
      const ownerId = await client.discoverOwner(threadId)
      if (!ownerId) return false
      const res = await client.request(
        'thread-follower-submit-user-input',
        { conversationId: threadId, requestId, response: { answers } },
        { version: 1, targetClientId: ownerId }
      )
      return res.resultType === 'success'
    })
  } catch {
    return false
  }
}
const deepAiActiveItems = new Map<string, DeepAiPendingItem>()

const seenAtById = new Map<string, number>()
const dismissedUntil = new Map<string, number>()
let agTargetCache: { at: number; httpPort: number; csrfToken: string } | null = null

const codexTailCache = new Map<string, { mtimeMs: number; size: number; item: CodexPendingQuestion | null }>()

let deepAiDbCache: {
  mtimeMs: number
  walMtimeMs: number
  items: DeepAiPendingItem[]
} | null = null

let pollTimer: NodeJS.Timeout | null = null
let pollInFlight = false
let onNativeChange: (() => void) | null = null
let onNativeStatus: ((status: AgentStatus) => void) | null = null

function isDismissed(key: string): boolean {
  const until = dismissedUntil.get(key)
  if (!until) return false
  if (Date.now() > until) {
    dismissedUntil.delete(key)
    return false
  }
  return true
}

function markDismissed(key: string, ttlMs = DISMISSED_TTL_MS): void {
  dismissedUntil.set(key, Date.now() + ttlMs)
}

function filePathFromUri(uri: unknown): string {
  if (typeof uri !== 'string' || !uri.trim()) return ''
  try {
    if (uri.startsWith('file://')) return fileURLToPath(uri)
  } catch {
    // Fall back to raw string.
  }
  return uri
}

function copyToClipboardAndFocus(text: string | null, processNames: string[]): void {
  if (process.platform !== 'win32') return
  const namesLiteral = processNames.map((n) => `'${n.replace(/'/g, "''")}'`).join(',')
  const parts: string[] = []
  if (text && text.trim()) {
    const encodedText = Buffer.from(text, 'utf8').toString('base64')
    parts.push(
      `$txt = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedText}'))`,
      'Set-Clipboard -Value $txt -ErrorAction SilentlyContinue'
    )
  }
  if (processNames.length > 0) {
    parts.push(
      `$p = Get-Process -Name @(${namesLiteral}) -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1`,
      'if ($p) { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null }'
    )
  }
  if (parts.length === 0) return
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', parts.join('; ')],
    { windowsHide: true, timeout: 4000 },
    () => undefined
  )
}

async function resolveAntiGravityDaemon(): Promise<{ httpPort: number; csrfToken: string } | null> {
  if (agTargetCache && Date.now() - agTargetCache.at < 15_000) {
    return agTargetCache
  }
  const daemonDir = path.join(os.homedir(), '.gemini', 'antigravity', 'daemon')
  let files: string[]
  try {
    files = await fs.readdir(daemonDir)
  } catch {
    return null
  }
  const candidates: { file: string; mtime: number }[] = []
  for (const name of files) {
    if (!/^hub_\d+\.json$/.test(name)) continue
    const full = path.join(daemonDir, name)
    const stat = await fs.stat(full).catch(() => null)
    if (stat?.isFile()) candidates.push({ file: full, mtime: stat.mtimeMs })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  for (const candidate of candidates.slice(0, 6)) {
    try {
      const pidMatch = path.basename(candidate.file).match(/^hub_(\d+)\.json$/)
      if (pidMatch) {
        const pid = Number(pidMatch[1])
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0)
          } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') continue
          }
        }
      }
      const parsed = JSON.parse(await fs.readFile(candidate.file, 'utf8')) as {
        httpPort?: number
        csrfToken?: string
      }
      const httpPort = Number(parsed.httpPort)
      const csrfToken = String(parsed.csrfToken || '')
      if (!Number.isInteger(httpPort) || httpPort <= 0 || !csrfToken) continue
      const res = await fetch(`http://127.0.0.1:${httpPort}/healthz`, {
        signal: AbortSignal.timeout(900)
      }).catch(() => null)
      if (!res) continue
      await res.body?.cancel().catch(() => undefined)
      if (!res.ok) continue
      agTargetCache = { at: Date.now(), httpPort, csrfToken }
      return agTargetCache
    } catch {
      continue
    }
  }
  return null
}

async function callAntiGravityRpc<T>(method: string, payload: Record<string, unknown>): Promise<T | null> {
  const target = await resolveAntiGravityDaemon()
  if (!target) return null
  const response = await fetch(
    `http://127.0.0.1:${target.httpPort}/exa.language_server_pb.LanguageServerService/${method}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': target.csrfToken
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3500)
    }
  )
  if (!response.ok) {
    agTargetCache = null
    return null
  }
  return (await response.json()) as T
}

function parseAntiGravityWaitingStep(
  cascadeId: string,
  fallbackIndex: number,
  step: Record<string, unknown>,
  convTitle: string
): AgStepDetail | null {
  if (!step || step.status !== 'CORTEX_STEP_STATUS_WAITING') return null
  const ri =
    step.requestedInteraction && typeof step.requestedInteraction === 'object'
      ? (step.requestedInteraction as Record<string, unknown>)
      : null
  if (!ri) return null

  const meta =
    step.metadata && typeof step.metadata === 'object'
      ? (step.metadata as Record<string, unknown>)
      : null
  const sourceInfo =
    meta?.sourceTrajectoryStepInfo && typeof meta.sourceTrajectoryStepInfo === 'object'
      ? (meta.sourceTrajectoryStepInfo as Record<string, unknown>)
      : null
  const trajectoryId = typeof sourceInfo?.trajectoryId === 'string' ? sourceInfo.trajectoryId : ''
  const resolvedStepIndex =
    typeof sourceInfo?.stepIndex === 'number' ? sourceInfo.stepIndex : fallbackIndex
  if (isDismissed(`ag:${cascadeId}:${resolvedStepIndex}`)) return null

  const askQuestion =
    ri.askQuestion && typeof ri.askQuestion === 'object'
      ? (ri.askQuestion as { questions?: AgRawQuestion[] })
      : null
  if (askQuestion && Array.isArray(askQuestion.questions) && askQuestion.questions.length > 0) {
    const steps: AgentQuestionStep[] = []
    const validRawQuestions: AgRawQuestion[] = []
    for (const q of askQuestion.questions) {
      if (!q || typeof q !== 'object') continue
      const rawOpts = Array.isArray(q.options) ? q.options : []
      const options: AgentQuestionOption[] = rawOpts
        .slice(0, MAX_OPTIONS)
        .map((opt) => ({
          label: clean(opt?.text ?? opt?.label, 140),
          description: clean(opt?.description, 240)
        }))
        .filter((opt) => Boolean(opt.label))
      if (options.length < 2) continue
      const title = clean(q.question ?? q.header, 320) || 'Choose an option to continue'
      const header = clean(q.header, 140)
      steps.push({
        ...(header ? { id: header } : {}),
        title,
        ...(header && header !== title ? { detail: header } : {}),
        options,
        multiSelect: Boolean(q.isMultiSelect ?? q.is_multi_select ?? q.multiSelect)
      })
      validRawQuestions.push(q)
    }

    if (steps.length > 0) {
      const id = `ag:q:${cascadeId}:${resolvedStepIndex}`
      const at = seenAtById.get(id) ?? Date.now()
      seenAtById.set(id, at)
      const first = steps[0]
      const detailText =
        steps.length > 1
          ? clean(
              steps
                .slice(1)
                .map((s) => s.title)
                .join(' · '),
              320
            )
          : first.detail || convTitle
      return {
        cascadeId,
        stepIndex: resolvedStepIndex,
        trajectoryId,
        convTitle,
        kind: 'question',
        rawQuestions: validRawQuestions,
        question: {
          id,
          tool: 'antigravity',
          title: first.title,
          detail: detailText,
          options: first.options,
          multiSelect: first.multiSelect,
          steps,
          at
        }
      }
    }
  }

  const id = `ag:p:${cascadeId}:${resolvedStepIndex}`
  const at = seenAtById.get(id) ?? Date.now()
  seenAtById.set(id, at)

  let title = 'Anti Gravity needs permission'
  let detailText = convTitle
  let buildPermissionPayload: ((reply: 'allow' | 'deny') => Record<string, unknown>) | undefined

  if (ri.permission && typeof ri.permission === 'object') {
    const perm = ri.permission as Record<string, unknown>
    const res =
      perm.resource && typeof perm.resource === 'object'
        ? (perm.resource as Record<string, unknown>)
        : null
    const targetPath = filePathFromUri(res?.target)
    title =
      clean(perm.actionDescription ?? perm.reason, 320) ||
      (targetPath ? `Access ${path.basename(targetPath)}` : 'Permission required')
    detailText = clean(targetPath || convTitle, 600)
    buildPermissionPayload = (reply) => ({
      permission: {
        allow: reply === 'allow',
        scope: 'PERMISSION_SCOPE_ONCE',
        ...(reply === 'deny' ? { userDenyInstruction: 'Denied in Notch.' } : {})
      }
    })
  } else if (ri.filePermission && typeof ri.filePermission === 'object') {
    const fp = ri.filePermission as Record<string, unknown>
    const targetPath = filePathFromUri(fp.absolutePathUri)
    title = targetPath ? `Access ${path.basename(targetPath)}` : 'File access required'
    detailText = clean(targetPath || fp.blockReason || convTitle, 600)
    buildPermissionPayload = (reply) => ({
      filePermission: {
        allow: reply === 'allow',
        scope: 'PERMISSION_SCOPE_ONCE',
        absolutePathUri: typeof fp.absolutePathUri === 'string' ? fp.absolutePathUri : ''
      }
    })
  } else if (ri.runCommand !== undefined) {
    const rc =
      step.runCommand && typeof step.runCommand === 'object'
        ? (step.runCommand as Record<string, unknown>)
        : null
    const rawCmd =
      typeof rc?.proposedCommandLine === 'string'
        ? rc.proposedCommandLine
        : typeof rc?.commandLine === 'string'
          ? rc.commandLine
          : ''
    const cmd = clean(rawCmd, 320)
    title = cmd ? `Run ${cmd}` : 'Run terminal command'
    detailText = clean(rc?.cwd ?? convTitle, 600)
    buildPermissionPayload = (reply) => ({
      runCommand: {
        confirm: reply === 'allow',
        proposedCommandLine: rawCmd || cmd,
        submittedCommandLine: rawCmd || cmd
      }
    })
  } else {
    const confirmKeys = [
      'mcp',
      'approvalInteraction',
      'openBrowserUrl',
      'runExtensionCode',
      'executeBrowserJavascript',
      'captureBrowserScreenshot',
      'clickBrowserPixel',
      'browserAction',
      'openBrowserSetup',
      'confirmBrowserSetup',
      'sendCommandInput',
      'readUrlContent'
    ]
    const matchedKey = confirmKeys.find((k) => ri[k] !== undefined) || 'approvalInteraction'
    title =
      matchedKey === 'mcp'
        ? 'Allow MCP tool call'
        : `Approve ${matchedKey.replace(/([A-Z])/g, ' $1').toLowerCase()}`
    detailText = clean(convTitle, 600)
    buildPermissionPayload = (reply) => ({
      [matchedKey]: {
        confirm: reply === 'allow'
      }
    })
  }

  return {
    cascadeId,
    stepIndex: resolvedStepIndex,
    trajectoryId,
    convTitle,
    kind: 'permission',
    permission: {
      id,
      tool: 'antigravity',
      title,
      detail: detailText,
      at
    },
    buildPermissionPayload
  }
}

async function pollAntiGravity(): Promise<AgStepDetail[]> {
  const agRoot = path.join(os.homedir(), '.gemini', 'antigravity')
  const summariesPath = path.join(agRoot, 'conversation_summaries.db')
  const convDir = path.join(agRoot, 'conversations')

  const liveProbes = new Map<string, { title: string; stepOffset: number }>()
  const dbCandidates = new Map<string, string>()

  try {
    await fs.access(summariesPath)
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(summariesPath, { readOnly: true })
      const rows = db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, status, not_fully_idle, last_modified_time
           FROM conversation_summaries
           WHERE killed = 0
           ORDER BY last_modified_time DESC
           LIMIT 10`
        )
        .all() as {
        conversation_id: string
        title: string | null
        preview: string | null
        step_count: number | null
        status: string | null
        not_fully_idle: number
        last_modified_time: string | null
      }[]
      for (const row of rows) {
        const modifiedMs = row.last_modified_time ? Date.parse(row.last_modified_time) : 0
        const recent = modifiedMs > 0 && Date.now() - modifiedMs < 30 * 60 * 1000
        const busy = !/IDLE/i.test(String(row.status || '')) || Boolean(row.not_fully_idle)
        const title = clean(row.title || row.preview || 'Anti Gravity session', 140)
        if (busy && liveProbes.size < 4) {
          liveProbes.set(row.conversation_id, {
            title,
            stepOffset: Math.max(0, (Number(row.step_count) || 0) - 6)
          })
        } else if (recent) {
          dbCandidates.set(row.conversation_id, title)
        }
      }
    } finally {
      try {
        db?.close()
      } catch {
        // Ignore close error.
      }
    }
  } catch {
    // Summaries DB not present yet.
  }

  for (const [cid, title] of dbCandidates) {
    if (liveProbes.has(cid)) continue
    const dbFile = path.join(convDir, `${cid}.db`)
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(dbFile, { readOnly: true })
      const rows = db
        .prepare('SELECT idx FROM steps WHERE status = 5 ORDER BY idx DESC LIMIT 1')
        .all() as { idx: number }[]
      if (rows[0] && !isDismissed(`ag:${cid}:${rows[0].idx}`)) {
        liveProbes.set(cid, { title, stepOffset: rows[0].idx })
      }
    } catch {
      // Locked or missing conversation DB.
    } finally {
      try {
        db?.close()
      } catch {
        // Ignore.
      }
    }
  }

  if (liveProbes.size === 0) {
    // Fallback to live language_server memory if conversation_summaries.db hasn't flushed yet.
    const liveSummary = await callAntiGravityRpc<{
      trajectorySummaries?: Record<string, { status?: unknown; stepCount?: unknown; summary?: unknown; lastModifiedTime?: unknown }>
    }>('GetAllCascadeTrajectories', {}).catch(() => null)
    const summaries = liveSummary?.trajectorySummaries
    if (summaries && typeof summaries === 'object') {
      const sorted = Object.entries(summaries)
        .filter(([, info]) => info && typeof info === 'object')
        .sort((a, b) => Date.parse(String(b[1].lastModifiedTime || 0)) - Date.parse(String(a[1].lastModifiedTime || 0)))
      for (const [cid, info] of sorted.slice(0, 6)) {
        const busy = !/IDLE/i.test(String(info.status || ''))
        if (!busy) continue
        liveProbes.set(cid, {
          title: clean(info.summary || 'Anti Gravity session', 140),
          stepOffset: Math.max(0, (Number(info.stepCount) || 0) - 6)
        })
      }
    }
  } else {
    // Refresh stepOffset from live RPC when available so new waiting steps aren't missed during WAL lag.
    const liveSummary = await callAntiGravityRpc<{
      trajectorySummaries?: Record<string, { status?: unknown; stepCount?: unknown }>
    }>('GetAllCascadeTrajectories', {}).catch(() => null)
    const summaries = liveSummary?.trajectorySummaries
    if (summaries && typeof summaries === 'object') {
      for (const [cid, probe] of liveProbes) {
        const info = summaries[cid]
        if (info && typeof info.stepCount === 'number' && info.stepCount > 0) {
          probe.stepOffset = Math.min(probe.stepOffset, Math.max(0, info.stepCount - 6))
        }
      }
    }
  }

  if (liveProbes.size === 0) return []

  const results: AgStepDetail[] = []
  const seenKeys = new Set<string>()
  for (const [cid, probe] of liveProbes) {
    const data = await callAntiGravityRpc<{ steps?: Record<string, unknown>[] }>(
      'GetCascadeTrajectorySteps',
      {
        cascadeId: cid,
        stepOffset: probe.stepOffset
      }
    ).catch(() => null)
    const steps = data?.steps || []
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]
      if (!step || step.status !== 'CORTEX_STEP_STATUS_WAITING') continue
      const parsed = parseAntiGravityWaitingStep(cid, probe.stepOffset + i, step, probe.title)
      if (parsed) {
        const key = `${parsed.cascadeId}:${parsed.stepIndex}`
        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          results.push(parsed)
        }
      }
    }
  }
  return results
}

function codexOptionList(raw: unknown): AgentQuestionOption[] {
  const list = Array.isArray(raw) ? raw : []
  const out: AgentQuestionOption[] = []
  for (const opt of list.slice(0, MAX_OPTIONS)) {
    if (typeof opt === 'string') {
      const label = clean(opt, 140)
      if (label) out.push({ label, description: '' })
    } else if (opt && typeof opt === 'object') {
      const o = opt as Record<string, unknown>
      const label = clean(o.label ?? o.text ?? o.title ?? o.name ?? o.value, 140)
      if (label) out.push({ label, description: clean(o.description, 240) })
    }
  }
  return out
}

/** Read the tail of one Codex rollout and return an unanswered
 * request_user_input question, if the user has not replied since. */
async function codexPendingFromRollout(file: string, threadId: string): Promise<CodexPendingQuestion | null> {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile()) return null
  const cached = codexTailCache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.item

  const handle = await fs.open(file, 'r')
  let tail = ''
  try {
    const length = Math.min(stat.size, 400_000)
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, stat.size - length)
    tail = buf.toString('utf8')
  } finally {
    await handle.close()
  }

  let pendingCall: {
    callId: string
    fnName: string
    timestamp: number
    rawQuestions: Record<string, unknown>[]
  } | null = null

  for (const line of tail.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const payload =
      rec.payload && typeof rec.payload === 'object' ? (rec.payload as Record<string, unknown>) : null
    if (!payload) continue
    const stamp = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) || Date.now() : Date.now()

    if (
      rec.type === 'response_item' &&
      payload.type === 'function_call' &&
      (payload.name === 'request_user_input_async' || payload.name === 'request_user_input') &&
      typeof payload.call_id === 'string' &&
      typeof payload.arguments === 'string'
    ) {
      try {
        const parsedArgs = JSON.parse(payload.arguments) as { questions?: Record<string, unknown>[] }
        if (Array.isArray(parsedArgs.questions) && parsedArgs.questions.length > 0) {
          pendingCall = {
            callId: payload.call_id,
            fnName: String(payload.name),
            timestamp: stamp,
            rawQuestions: parsedArgs.questions
          }
        }
      } catch {
        // Malformed tool arguments.
      }
    } else if (pendingCall && rec.type === 'event_msg' && payload.type === 'item_completed') {
      const item = payload.item && typeof payload.item === 'object' ? (payload.item as Record<string, unknown>) : null
      // The user answering (or typing anything) shows up as a UserMessage.
      if (item?.type === 'UserMessage') pendingCall = null
    }
  }

  let result: CodexPendingQuestion | null = null
  if (pendingCall && Date.now() - pendingCall.timestamp < 24 * 60 * 60 * 1000) {
    const id = `codex:q:${pendingCall.callId}`
    const steps: AgentQuestionStep[] = []
    const validRaw: CodexPendingQuestion['rawQuestions'] = []
    for (const q of pendingCall.rawQuestions) {
      if (!q || typeof q !== 'object') continue
      const options = codexOptionList(q.options ?? q.choices)
      if (options.length < 2) continue
      const title = clean(q.title ?? q.question ?? q.prompt ?? q.header, 320) || 'Choose an option to continue'
      const header = clean(q.header ?? q.id, 140)
      steps.push({
        ...(header ? { id: header } : {}),
        title,
        ...(header && header !== title ? { detail: header } : {}),
        options,
        multiSelect: Boolean(q.multiSelect ?? q.multiple ?? q.allow_multiple ?? q.is_multi_select)
      })
      validRaw.push({
        id: q.id as string | undefined,
        header: q.header as string | undefined,
        question: title,
        options: options.map((o) => ({ label: o.label, description: o.description }))
      })
    }
    if (steps.length > 0) {
      const at = seenAtById.get(id) ?? pendingCall.timestamp
      seenAtById.set(id, at)
      const first = steps[0]
      const detail =
        steps.length > 1
          ? clean(
              steps
                .slice(1)
                .map((s) => s.title)
                .join(' · '),
              320
            )
          : first.detail || ''
      result = {
        id,
        threadId,
        callId: pendingCall.callId,
        fnName: pendingCall.fnName,
        rawQuestions: validRaw,
        question: {
          id,
          tool: 'codex',
          title: first.title,
          detail,
          options: first.options,
          multiSelect: first.multiSelect,
          steps,
          at
        }
      }
    }
  }
  codexTailCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, item: result })
  return result
}

async function pollCodexQuestions(): Promise<{
  items: CodexPendingQuestion[]
  recentThreadIds: string[]
}> {
  const codexHome = path.join(os.homedir(), '.codex')
  let names: string[]
  try {
    names = await fs.readdir(codexHome)
  } catch {
    return { items: [], recentThreadIds: [] }
  }
  const stateName = names
    .filter((n) => /^state_\d+\.sqlite$/.test(n))
    .sort((a, b) => Number(b.match(/\d+/)?.[0] || 0) - Number(a.match(/\d+/)?.[0] || 0))[0]
  if (!stateName) return { items: [], recentThreadIds: [] }

  let rows: { id: string; rollout_path: string | null; updated_at: number }[] = []
  let db: DatabaseSync | null = null
  const nowSec = Math.floor(Date.now() / 1000)
  try {
    db = new DatabaseSync(path.join(codexHome, stateName), { readOnly: true })
    rows = db
      .prepare(
        `select id, rollout_path, updated_at from threads
         where updated_at >= ? and rollout_path is not null
         order by updated_at desc limit 8`
      )
      .all(nowSec - 24 * 60 * 60) as typeof rows
  } catch {
    return { items: [], recentThreadIds: [] }
  } finally {
    try {
      db?.close()
    } catch {
      // Already closed.
    }
  }

  const items: CodexPendingQuestion[] = []
  for (const row of rows) {
    const file = String(row.rollout_path).replace(/^\\\\\?\\/, '')
    try {
      const pending = await codexPendingFromRollout(file, row.id)
      if (pending && !isDismissed(pending.id)) items.push(pending)
    } catch {
      // Unreadable rollout.
    }
  }
  const recentThreadIds = rows
    .filter((row) => row.updated_at >= nowSec - 30 * 60)
    .slice(0, 6)
    .map((row) => row.id)
  return { items, recentThreadIds }
}

interface ClaudePending {
  id: string
  toolUseId: string
  question: AgentQuestion
}

const claudeTailCache = new Map<string, { mtimeMs: number; size: number; item: ClaudePending | null }>()

/** Claude Code records an AskUserQuestion tool_use in its transcript and only
 * writes the matching tool_result once the user has answered, so a trailing
 * tool_use without a result is a question that is still waiting. */
async function claudePendingFromTranscript(file: string): Promise<ClaudePending | null> {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile()) return null
  const cached = claudeTailCache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.item

  const handle = await fs.open(file, 'r')
  let tail = ''
  try {
    const length = Math.min(stat.size, 300_000)
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, stat.size - length)
    tail = buf.toString('utf8')
  } finally {
    await handle.close()
  }

  let pending = null as { toolUseId: string; at: number; questions: Record<string, unknown>[] } | null
  for (const line of tail.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const message =
      rec.message && typeof rec.message === 'object' ? (rec.message as Record<string, unknown>) : null
    const content = Array.isArray(message?.content) ? (message!.content as Record<string, unknown>[]) : []
    const stamp = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) || Date.now() : Date.now()
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && typeof block.id === 'string') {
        const input = objectFrom(block.input)
        const questions = Array.isArray(input?.questions) ? (input!.questions as Record<string, unknown>[]) : []
        if (questions.length > 0) pending = { toolUseId: block.id, at: stamp, questions }
      } else if (block.type === 'tool_result' && pending && block.tool_use_id === pending.toolUseId) {
        pending = null
      }
    }
    // A plain user prompt after the question also means it was moved past.
    if (pending && rec.type === 'user' && typeof message?.content === 'string') pending = null
  }

  let result: ClaudePending | null = null
  if (pending && Date.now() - pending.at < 4 * 60 * 60 * 1000) {
    const id = `claude:q:${pending.toolUseId}`
    const steps: AgentQuestionStep[] = []
    for (const q of pending.questions) {
      if (!q || typeof q !== 'object') continue
      const options = codexOptionList(q.options)
      if (options.length < 2) continue
      const title = clean(q.question ?? q.header, 320) || 'Pick an option'
      const header = clean(q.header, 140)
      steps.push({
        ...(header ? { id: header } : {}),
        title,
        ...(header && header !== title ? { detail: header } : {}),
        options,
        multiSelect: Boolean(q.multiSelect)
      })
    }
    if (steps.length > 0) {
      const at = seenAtById.get(id) ?? pending.at
      seenAtById.set(id, at)
      const first = steps[0]
      result = {
        id,
        toolUseId: pending.toolUseId,
        question: {
          id,
          tool: 'claude',
          title: first.title,
          detail:
            steps.length > 1
              ? clean(
                  steps
                    .slice(1)
                    .map((s) => s.title)
                    .join(' � '),
                  320
                )
              : first.detail || '',
          options: first.options,
          multiSelect: first.multiSelect,
          steps,
          at
        }
      }
    }
  }
  claudeTailCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, item: result })
  return result
}

async function pollClaudeQuestions(): Promise<ClaudePending[]> {
  const root = path.join(os.homedir(), '.claude', 'projects')
  let projects: string[]
  try {
    projects = await fs.readdir(root)
  } catch {
    return []
  }
  const recent: { file: string; mtime: number }[] = []
  for (const project of projects) {
    const dir = path.join(root, project)
    const files = await fs.readdir(dir).catch(() => [] as string[])
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue
      const full = path.join(dir, name)
      const stat = await fs.stat(full).catch(() => null)
      if (stat?.isFile() && Date.now() - stat.mtimeMs < 60 * 60 * 1000) {
        recent.push({ file: full, mtime: stat.mtimeMs })
      }
    }
  }
  recent.sort((a, b) => b.mtime - a.mtime)
  const items: ClaudePending[] = []
  for (const entry of recent.slice(0, 6)) {
    try {
      const pending = await claudePendingFromTranscript(entry.file)
      if (pending && !isDismissed(pending.id)) items.push(pending)
    } catch {
      // Unreadable transcript.
    }
  }
  return items
}

async function pollDeepAiPrompts(): Promise<DeepAiPendingItem[]> {
  const base = process.env.T3CODE_HOME || path.join(os.homedir(), '.deepai-code')
  const dbPath = path.join(base, 'userdata', 'statev2.sqlite')
  const stat = await fs.stat(dbPath).catch(() => null)
  if (!stat?.isFile()) return []
  const walStat = await fs.stat(`${dbPath}-wal`).catch(() => null)
  const walMtimeMs = walStat?.mtimeMs || 0

  if (
    deepAiDbCache &&
    deepAiDbCache.mtimeMs === stat.mtimeMs &&
    deepAiDbCache.walMtimeMs === walMtimeMs
  ) {
    return deepAiDbCache.items.filter((item) => !isDismissed(item.id))
  }

  let db: DatabaseSync | null = null
  const items: DeepAiPendingItem[] = []
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db
      .prepare(
        `SELECT i.item_id, i.thread_id, i.type, i.status, i.payload_json, i.updated_at, t.title as thread_title
         FROM orchestration_v2_projection_turn_items i
         LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = i.thread_id
         WHERE i.type IN ('approval_request', 'user_input_request')
           AND i.status IN ('pending', 'waiting', 'requested', 'open')
         ORDER BY i.updated_at DESC
         LIMIT 10`
      )
      .all() as {
      item_id: string
      thread_id: string
      type: string
      status: string
      payload_json: string
      updated_at: string | null
      thread_title: string | null
    }[]

    for (const row of rows) {
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(row.payload_json || '{}') as Record<string, unknown>
      } catch {
        continue
      }
      const threadTitle = clean(row.thread_title || 'DeepAI Code thread', 140)
      if (row.type === 'approval_request') {
        const id = `deepai:p:${row.item_id}`
        const at = seenAtById.get(id) ?? (row.updated_at ? Date.parse(row.updated_at) || Date.now() : Date.now())
        seenAtById.set(id, at)
        const cmd = clean(payload.command ?? payload.detail ?? payload.title ?? payload.requestKind, 320)
        items.push({
          id,
          kind: 'permission',
          permission: {
            id,
            tool: 'deepai',
            title: cmd || 'Approval requested in DeepAI Code',
            detail: threadTitle,
            at
          }
        })
      } else if (row.type === 'user_input_request') {
        const id = `deepai:q:${row.item_id}`
        const rawQuestions = Array.isArray(payload.questions) ? payload.questions : []
        const steps: AgentQuestionStep[] = []
        for (const qItem of rawQuestions) {
          if (!qItem || typeof qItem !== 'object') continue
          const q = qItem as Record<string, unknown>
          const rawOpts = Array.isArray(q.options) ? q.options : []
          const options: AgentQuestionOption[] = rawOpts
            .slice(0, MAX_OPTIONS)
            .map((opt) => {
              if (!opt || typeof opt !== 'object') return null
              const o = opt as Record<string, unknown>
              const label = clean(o.label ?? o.text ?? o.title, 140)
              if (!label) return null
              return { label, description: clean(o.description, 240) }
            })
            .filter((opt): opt is AgentQuestionOption => Boolean(opt))
          if (options.length < 2) continue
          const title = clean(q.question ?? q.header ?? q.title, 320) || 'Choose an option'
          const header = clean(q.header ?? q.id, 140)
          steps.push({
            ...(header ? { id: header } : {}),
            title,
            ...(header && header !== title ? { detail: header } : {}),
            options,
            multiSelect: Boolean(q.multiSelect ?? q.isMultiSelect ?? q.is_multi_select ?? q.multiple)
          })
        }
        if (steps.length > 0) {
          const at = seenAtById.get(id) ?? (row.updated_at ? Date.parse(row.updated_at) || Date.now() : Date.now())
          seenAtById.set(id, at)
          const first = steps[0]
          const detail =
            steps.length > 1
              ? clean(
                  steps
                    .slice(1)
                    .map((s) => s.title)
                    .join(' · '),
                  320
                )
              : first.detail || threadTitle
          items.push({
            id,
            kind: 'question',
            question: {
              id,
              tool: 'deepai',
              title: first.title,
              detail,
              options: first.options,
              multiSelect: first.multiSelect,
              steps,
              at
            }
          })
        }
      }
    }
  } catch {
    // Ignore locked DB.
  } finally {
    try {
      db?.close()
    } catch {
      // Ignore.
    }
  }

  deepAiDbCache = {
    mtimeMs: stat.mtimeMs,
    walMtimeMs,
    items
  }
  return items.filter((item) => !isDismissed(item.id))
}

interface GrokPendingQuestion {
  id: string
  question: AgentQuestion
}

const grokBlobCache = new Map<string, { mtimeMs: number; size: number; item: GrokPendingQuestion | null }>()

function decodeGrokBase32(value: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let acc = 0
  const out: number[] = []
  for (const char of value.toLowerCase()) {
    const index = alphabet.indexOf(char)
    if (index < 0) continue
    acc = (acc << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out).toString('utf8')
}

async function pollGrokPrompts(): Promise<GrokPendingQuestion[]> {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const dir = path.join(appData, 'Grok Bot', 'sand-client-persistence')
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }

  const results: GrokPendingQuestion[] = []
  const now = Date.now()
  for (const file of files) {
    if (!file.endsWith('.blob')) continue
    const key = decodeGrokBase32(file.slice(0, -'.blob'.length))
    const transcriptMatch = key.match(/\.transcript\.replicas\.([0-9a-f-]+)$/)
    if (!transcriptMatch) continue
    const agentId = transcriptMatch[1]
    const full = path.join(dir, file)
    const stat = await fs.stat(full).catch(() => null)
    if (!stat?.isFile() || now - stat.mtimeMs > 60 * 60 * 1000) continue

    const cached = grokBlobCache.get(full)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      if (cached.item && !isDismissed(cached.item.id)) results.push(cached.item)
      continue
    }

    let item: GrokPendingQuestion | null = null
    try {
      const parsed = JSON.parse(await fs.readFile(full, 'utf8')) as {
        value?: { entries?: Record<string, unknown>[] }
      }
      const entries = Array.isArray(parsed?.value?.entries) ? parsed.value!.entries : []
      let pendingWidget: {
        entryId: string
        at: number
        prompt: string
        options: AgentQuestionOption[]
        multiSelect: boolean
      } | null = null

      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue
        const msg =
          entry.message && typeof entry.message === 'object'
            ? (entry.message as Record<string, unknown>)
            : null
        const widget =
          msg?.type === 'widget' && msg.widget && typeof msg.widget === 'object'
            ? (msg.widget as Record<string, unknown>)
            : null
        if (widget) {
          const answered =
            (typeof entry.respondedValue === 'string' && entry.respondedValue.trim().length > 0) ||
            entry.widgetSkipped === true
          if (!answered) {
            const options = codexOptionList(widget.options)
            if (options.length >= 2) {
              pendingWidget = {
                entryId: String(entry.id || 'w'),
                at: Number(entry.timestampMs) || stat.mtimeMs,
                prompt: clean(widget.prompt ?? widget.question ?? widget.title, 320) || 'Choose an option',
                options,
                multiSelect: Boolean(widget.multiSelect)
              }
            }
          } else {
            pendingWidget = null
          }
        } else if (
          pendingWidget &&
          entry.kind === 'message' &&
          entry.role === 'user' &&
          !entry.fromAgent
        ) {
          pendingWidget = null
        }
      }

      if (pendingWidget && now - pendingWidget.at < 60 * 60 * 1000) {
        const id = `grok:q:${agentId}:${pendingWidget.entryId}`
        const at = seenAtById.get(id) ?? pendingWidget.at
        seenAtById.set(id, at)
        const step: AgentQuestionStep = {
          title: pendingWidget.prompt,
          options: pendingWidget.options,
          multiSelect: pendingWidget.multiSelect
        }
        item = {
          id,
          question: {
            id,
            tool: 'grok',
            title: step.title,
            detail: 'Grok Bot',
            options: step.options,
            multiSelect: step.multiSelect,
            steps: [step],
            at
          }
        }
      }
    } catch {
      // Ignore unreadable blob.
    }

    grokBlobCache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, item })
    if (item && !isDismissed(item.id)) results.push(item)
  }

  return results
}

function stateSignature(): string {
  const pIds = [...nativePermissions.keys()].sort().join(',')
  const qIds = [...nativeQuestions.keys()].sort().join(',')
  return `${pIds}|${qIds}`
}

export async function pollNativeAgentPromptsOnce(): Promise<void> {
  if (pollInFlight) return
  pollInFlight = true
  try {
    const beforeSig = stateSignature()
    const [agItems, codexPoll, deepAiItems, claudeItems, grokItems] = await Promise.all([
      pollAntiGravity(),
      pollCodexQuestions(),
      pollDeepAiPrompts(),
      pollClaudeQuestions(),
      pollGrokPrompts()
    ])
    const codexLive =
      codexPoll.recentThreadIds.length > 0
        ? await probeCodexLiveRequests(codexPoll.recentThreadIds)
        : { requests: [], activeThreadIds: [] }

    nativePermissions.clear()
    nativeQuestions.clear()
    agActiveItems.clear()
    codexActiveQuestions.clear()
    codexLiveItems.clear()
    deepAiActiveItems.clear()

    for (const item of agItems) {
      if (item.kind === 'question' && item.question) {
        agActiveItems.set(item.question.id, item)
        nativeQuestions.set(item.question.id, item.question)
      } else if (item.kind === 'permission' && item.permission) {
        agActiveItems.set(item.permission.id, item)
        nativePermissions.set(item.permission.id, item.permission)
      }
    }

    for (const item of codexPoll.items) {
      codexActiveQuestions.set(item.id, item)
      nativeQuestions.set(item.id, item.question)
    }

    for (const req of codexLive.requests) {
      if (req.kind === 'permission') {
        const id = `codex:ipc:p:${req.threadId}:${String(req.requestId)}`
        if (isDismissed(id)) continue
        const at = seenAtById.get(id) ?? Date.now()
        seenAtById.set(id, at)
        codexLiveItems.set(id, req)
        nativePermissions.set(id, {
          id,
          tool: 'codex',
          title: req.title,
          detail: req.detail,
          at
        })
      } else if (req.kind === 'question' && req.steps && req.steps.length > 0) {
        const id = `codex:ipc:q:${req.threadId}:${String(req.requestId)}`
        if (isDismissed(id)) continue
        const at = seenAtById.get(id) ?? Date.now()
        seenAtById.set(id, at)
        codexLiveItems.set(id, req)
        nativeQuestions.set(id, {
          id,
          tool: 'codex',
          title: req.title,
          detail: req.detail,
          options: req.steps[0].options,
          multiSelect: req.steps[0].multiSelect,
          steps: req.steps,
          at
        })
      }
    }

    // Avoid duplicating a Claude AskUserQuestion card when the live PermissionRequest hook already holds it.
    const hasHeldClaudeQuestion = Array.from(held.values()).some(
      (entry) => entry.kind === 'question' && entry.item.tool === 'claude'
    )
    if (!hasHeldClaudeQuestion) {
      for (const item of claudeItems) {
        nativeQuestions.set(item.id, item.question)
      }
    }

    for (const item of grokItems) {
      nativeQuestions.set(item.id, item.question)
    }

    for (const item of deepAiItems) {
      deepAiActiveItems.set(item.id, item)
      if (item.kind === 'permission' && item.permission) {
        nativePermissions.set(item.id, item.permission)
      } else if (item.kind === 'question' && item.question) {
        nativeQuestions.set(item.id, item.question)
      }
    }

    const afterSig = stateSignature()
    if (beforeSig !== afterSig) {
      onNativeChange?.()
    }
  } finally {
    pollInFlight = false
  }
}

function startNativeAgentPrompts(
  onChange: () => void,
  onStatus: (status: AgentStatus) => void
): void {
  stopNativeAgentPrompts()
  onNativeChange = onChange
  onNativeStatus = onStatus
  void pollNativeAgentPromptsOnce()
  pollTimer = setInterval(() => {
    void pollNativeAgentPromptsOnce()
  }, NATIVE_POLL_MS)
  pollTimer.unref?.()
}

function stopNativeAgentPrompts(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  nativePermissions.clear()
  nativeQuestions.clear()
  agActiveItems.clear()
  codexActiveQuestions.clear()
  codexLiveItems.clear()
  deepAiActiveItems.clear()
}

function getNativePermissions(): AgentPermission[] {
  return [...nativePermissions.values()]
}

function getNativeQuestions(): AgentQuestion[] {
  return [...nativeQuestions.values()]
}

function hasNativePermission(id: string): boolean {
  return nativePermissions.has(id)
}

function hasNativeQuestion(id: string): boolean {
  return nativeQuestions.has(id)
}

/** Send an approval or question answer to Antigravity's language server and check
 * that it landed. The step is hidden while the call is in flight; if the daemon
 * refuses or is unreachable the card comes back, so a lost click is never silent. */
function sendAntiGravityInteraction(detail: AgStepDetail, interaction: Record<string, unknown>): void {
  const key = `ag:${detail.cascadeId}:${detail.stepIndex}`
  markDismissed(key, 15_000)
  const failed = (): void => {
    dismissedUntil.delete(key)
    onNativeStatus?.({
      tool: 'antigravity',
      state: 'waiting',
      title: "Antigravity didn't get that answer",
      detail: 'Answer it in Antigravity, or try again here.',
      at: Date.now()
    })
    onNativeChange?.()
    void pollNativeAgentPromptsOnce()
  }
  callAntiGravityRpc('HandleCascadeUserInteraction', {
    cascadeId: detail.cascadeId,
    interaction: {
      trajectoryId: detail.trajectoryId,
      stepIndex: detail.stepIndex,
      ...interaction
    }
  })
    .then((res) => {
      if (res === null) failed()
    })
    .catch(failed)
}

function decideNativePermission(id: string, reply: 'allow' | 'deny'): boolean {
  const perm = nativePermissions.get(id)
  if (!perm) return false
  nativePermissions.delete(id)

  if (id.startsWith('ag:p:')) {
    const detail = agActiveItems.get(id)
    agActiveItems.delete(id)
    if (detail) {
      const interactionPayload = detail.buildPermissionPayload ? detail.buildPermissionPayload(reply) : {}
      sendAntiGravityInteraction(detail, interactionPayload)
    }
  } else if (id.startsWith('codex:ipc:p:')) {
    const req = codexLiveItems.get(id)
    codexLiveItems.delete(id)
    markDismissed(id, 30_000)
    if (req && req.method !== 'item/tool/requestUserInput') {
      void replyCodexLiveApproval(req.threadId, req.requestId, req.method, reply, req.params.permissions).then((ok) => {
        if (!ok) copyToClipboardAndFocus(null, ['ChatGPT', 'Codex'])
      })
    }
  } else if (id.startsWith('deepai:p:')) {
    deepAiActiveItems.delete(id)
    markDismissed(id)
    copyToClipboardAndFocus(null, ['DeepAI Code', 'deepai-code'])
    // DeepAI Code has no external reply channel, so Notch cannot approve or deny
    // for it. Say so instead of claiming a decision that never reached the agent.
    onNativeStatus?.({
      tool: perm.tool as AgentTool,
      state: 'waiting',
      title: 'Answer in DeepAI Code',
      detail: `${perm.title} (Notch can't ${reply === 'allow' ? 'approve' : 'deny'} for DeepAI Code)`,
      at: Date.now()
    })
    onNativeChange?.()
    return true
  }

  onNativeStatus?.({
    tool: perm.tool as AgentTool,
    state: reply === 'allow' ? 'working' : 'done',
    title: reply === 'allow' ? 'Approved in Notch' : 'Denied in Notch',
    detail: perm.title,
    at: Date.now()
  })
  onNativeChange?.()
  return true
}

function decideNativeQuestion(id: string, stepAnswers: AgentQuestionStepAnswer[]): boolean {
  const question = nativeQuestions.get(id)
  if (!question) return false
  nativeQuestions.delete(id)

  const stepList = questionStepList(question)
  const chosenLabelsPerStep = stepList.map((step, sIdx) => {
    const ans = stepAnswers[sIdx] || { choices: [] }
    return stepAnswerTexts(step, ans)
  })
  const summaryLabels = chosenLabelsPerStep.map((labels) => labels.join(', ')).filter(Boolean).join(' · ')

  if (id.startsWith('ag:q:')) {
    const detail = agActiveItems.get(id)
    agActiveItems.delete(id)
    if (detail && detail.rawQuestions) {
      const responses = detail.rawQuestions.map((q, qIdx) => {
        const ans = stepAnswers[qIdx] || { choices: [] }
        const selectedOptionIds = ans.choices
          .map((optIdx) => String(q.options?.[optIdx]?.id ?? ''))
          .filter(Boolean)
        const writeInResponse = ans.customText?.trim() || ''
        return {
          question: q.question,
          options: q.options,
          ...(q.isMultiSelect || q.is_multi_select || q.multiSelect ? { isMultiSelect: true } : {}),
          selectedOptionIds,
          ...(writeInResponse ? { writeInResponse } : {})
        }
      })
      sendAntiGravityInteraction(detail, { askQuestion: { responses } })
    }
  } else if (id.startsWith('codex:ipc:q:')) {
    const req = codexLiveItems.get(id)
    codexLiveItems.delete(id)
    markDismissed(id, 30_000)
    if (req) {
      const answers: Record<string, { answers: string[] }> = {}
      stepList.forEach((step, idx) => {
        const key = req.rawQuestionIds?.[idx] || step.id || `q_${idx}`
        answers[key] = { answers: chosenLabelsPerStep[idx] || [] }
      })
      void replyCodexLiveUserInput(req.threadId, req.requestId, answers).then((ok) => {
        if (!ok) copyToClipboardAndFocus(summaryLabels, ['ChatGPT', 'Codex'])
      })
    } else {
      copyToClipboardAndFocus(summaryLabels, ['ChatGPT', 'Codex'])
    }
  } else if (id.startsWith('codex:q:')) {
    const item = codexActiveQuestions.get(id)
    codexActiveQuestions.delete(id)
    markDismissed(id, 120_000)
    const fallbackText =
      item && item.rawQuestions.length > 0
        ? item.rawQuestions
            .map((q, idx) => {
              const ans = stepAnswers[idx] || { choices: [] }
              const picked = ans.choices
                .map((i) => clean(q.options?.[i]?.label ?? q.options?.[i]?.text, 140))
                .filter(Boolean)
              if (ans.customText?.trim()) picked.push(ans.customText.trim())
              return picked.join(', ')
            })
            .filter(Boolean)
            .join(' · ')
        : summaryLabels
    if (item) {
      const rawQs: CodexPendingQuestion['rawQuestions'] =
        item.rawQuestions.length > 0
          ? item.rawQuestions
          : stepList.map((s) => ({ question: s.title, options: [] }))
      const labelsPerStep = rawQs.map((q, idx) => {
        const ans = stepAnswers[idx] || { choices: [] }
        const labels = ans.choices
          .map((i) => clean(q.options?.[i]?.label ?? q.options?.[i]?.text, 240))
          .filter(Boolean)
        if (ans.customText?.trim()) labels.push(ans.customText.trim())
        return labels.length > 0 ? labels : chosenLabelsPerStep[idx] || []
      })
      void submitCodexAsyncQuestionReply(item.threadId, item.callId, rawQs, labelsPerStep).then((res) => {
        if (!res.ok) {
          copyToClipboardAndFocus(fallbackText || summaryLabels, ['ChatGPT', 'Codex'])
        }
      })
    } else {
      copyToClipboardAndFocus(fallbackText || summaryLabels, ['ChatGPT', 'Codex'])
    }
  } else if (id.startsWith('claude:q:')) {
    markDismissed(id)
    copyToClipboardAndFocus(summaryLabels, ['Claude'])
  } else if (id.startsWith('grok:q:')) {
    markDismissed(id)
    copyToClipboardAndFocus(summaryLabels, ['Grok Bot', 'Grok'])
  } else if (id.startsWith('deepai:q:')) {
    deepAiActiveItems.delete(id)
    markDismissed(id)
    copyToClipboardAndFocus(summaryLabels, ['DeepAI Code', 'deepai-code'])
  }

  // These apps cannot receive an answer from outside, so the choice was only
  // copied to the clipboard; do not report it as answered.
  const clipboardOnlyApp = id.startsWith('claude:q:')
    ? 'Claude'
    : id.startsWith('grok:q:')
      ? 'Grok Bot'
      : id.startsWith('deepai:q:')
        ? 'DeepAI Code'
        : null
  onNativeStatus?.(
    clipboardOnlyApp
      ? {
          tool: question.tool as AgentTool,
          state: 'waiting',
          title: `Copied "${summaryLabels}". Paste it in ${clipboardOnlyApp}`,
          detail: question.title,
          at: Date.now()
        }
      : {
          tool: question.tool as AgentTool,
          state: 'working',
          title: `Answered in Notch: ${summaryLabels}`,
          detail: question.title,
          at: Date.now()
        }
  )
  onNativeChange?.()
  return true
}

function releaseNativeQuestion(id: string): boolean {
  const question = nativeQuestions.get(id)
  if (!question) return false
  nativeQuestions.delete(id)

  if (id.startsWith('ag:q:')) {
    const detail = agActiveItems.get(id)
    agActiveItems.delete(id)
    if (detail) {
      markDismissed(`ag:${detail.cascadeId}:${detail.stepIndex}`)
      copyToClipboardAndFocus(null, ['Antigravity'])
    }
  } else if (id.startsWith('codex:ipc:q:')) {
    codexLiveItems.delete(id)
    markDismissed(id)
    copyToClipboardAndFocus(null, ['ChatGPT', 'Codex'])
  } else if (id.startsWith('codex:q:')) {
    codexActiveQuestions.delete(id)
    markDismissed(id)
    copyToClipboardAndFocus(null, ['ChatGPT', 'Codex'])
  } else if (id.startsWith('claude:q:')) {
    markDismissed(id)
    copyToClipboardAndFocus(null, ['Claude'])
  } else if (id.startsWith('grok:q:')) {
    markDismissed(id)
    copyToClipboardAndFocus(null, ['Grok Bot', 'Grok'])
  } else if (id.startsWith('deepai:q:')) {
    deepAiActiveItems.delete(id)
    markDismissed(id)
    copyToClipboardAndFocus(null, ['DeepAI Code', 'deepai-code'])
  }

  onNativeChange?.()
  return true
}

/** Return true when a hook entry targets Notch's loopback server (raw or -EncodedCommand UTF-16LE). */
export function isNotchHookEntry(entry: unknown): boolean {
  const raw = JSON.stringify(entry)
  if (!raw) return false
  const matchesNotch = (text: string): boolean =>
    text.includes('127.0.0.1:') &&
    (text.includes('/hook?tool=') || text.includes('/status?tool=') || text.includes('X-Notch-Token'))
  if (matchesNotch(raw)) return true
  const match = raw.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/i)
  if (!match) return false
  try {
    return matchesNotch(Buffer.from(match[1], 'base64').toString('utf16le'))
  } catch {
    return false
  }
}

/** Replace Notch's own hook entries for one event and keep everything the user added. */
function withNotchEntries(existing: unknown, entries: unknown[]): unknown[] {
  const kept = Array.isArray(existing) ? existing.filter((entry) => !isNotchHookEntry(entry)) : []
  return [...kept, ...entries]
}

/** Cursor tools that only read. Notch skips them: no card, no hook process. */
const CURSOR_READ_ONLY_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'ReadLints',
  'ListMCPResources',
  'TodoWrite',
  'CreatePlan',
  'SemanticSearch',
  'WebSearch'
]
const CURSOR_HOOK_MATCHER = `^(?!(${CURSOR_READ_ONLY_TOOLS.join('|')})$)`

/** Automatically wire Notch's local hook endpoints into installed coding tools
 * (Claude Code, Cursor) so the user never has to copy-paste
 * JSON/TOML snippets by hand. Existing user settings are preserved. */
export async function syncInstalledToolHooks(listenPort: number, tokenValue: string): Promise<void> {
  const home = os.homedir()
  const makeCmds = (tool: AgentTool) => {
    const base = `http://127.0.0.1:${listenPort}/hook?tool=${tool}`
    return {
      working: hookCommand('working', `${base}&kind=working`, tokenValue),
      permission: hookCommand('permission', `${base}&kind=permission`, tokenValue),
      done: hookCommand('done', `${base}&kind=done`, tokenValue)
    }
  }

  // 1. Claude Code (~/.claude/settings.json)
  try {
    const claudeDir = path.join(home, '.claude')
    if (await fs.stat(claudeDir).then((s) => s.isDirectory()).catch(() => false)) {
      const settingsPath = path.join(claudeDir, 'settings.json')
      const raw = await fs.readFile(settingsPath, 'utf8').catch(() => '{}')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const hooks =
        parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks)
          ? (parsed.hooks as Record<string, unknown>)
          : {}
      const cmds = makeCmds('claude')
      hooks.UserPromptSubmit = withNotchEntries(hooks.UserPromptSubmit, [
        { hooks: [{ type: 'command', command: cmds.working, timeout: 10 }] }
      ])
      hooks.PermissionRequest = withNotchEntries(hooks.PermissionRequest, [
        { hooks: [{ type: 'command', command: cmds.permission, timeout: 250 }] }
      ])
      // Remove legacy Notch PreToolUse entries (keep any non-Notch user hooks intact).
      if (Array.isArray(hooks.PreToolUse)) {
        const filtered = hooks.PreToolUse.filter((entry) => !isNotchHookEntry(entry))
        if (filtered.length > 0) hooks.PreToolUse = filtered
        else delete hooks.PreToolUse
      }
      hooks.Stop = withNotchEntries(hooks.Stop, [{ hooks: [{ type: 'command', command: cmds.done, timeout: 10 }] }])
      parsed.hooks = hooks
      const nextRaw = JSON.stringify(parsed, null, 2)
      if (nextRaw !== raw.trim()) {
        await fs.writeFile(settingsPath, `${nextRaw}\n`, 'utf8')
      }
    }
  } catch {
    // Ignore read-only or malformed Claude settings.
  }

  // 2. Codex Desktop is answered over its local pipe, not through hooks, so Notch
  // no longer installs any. Remove the entries earlier builds wrote: left in place
  // they can raise a second card for the same approval and trigger Codex's
  // "trust new hooks" review.
  try {
    const hooksPath = path.join(home, '.codex', 'hooks.json')
    const raw = await fs.readFile(hooksPath, 'utf8').catch(() => '')
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const hooks =
        parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks)
          ? (parsed.hooks as Record<string, unknown>)
          : null
      if (hooks) {
        let changed = false
        for (const key of Object.keys(hooks)) {
          if (!Array.isArray(hooks[key])) continue
          const kept = (hooks[key] as unknown[]).filter((entry) => !isNotchHookEntry(entry))
          if (kept.length === (hooks[key] as unknown[]).length) continue
          changed = true
          if (kept.length > 0) hooks[key] = kept
          else delete hooks[key]
        }
        if (changed) {
          const onlyOurs = Object.keys(hooks).length === 0 && parsed.description === 'Notch Codex hooks'
          if (onlyOurs) {
            await fs.unlink(hooksPath)
          } else {
            await fs.writeFile(hooksPath, `${JSON.stringify(parsed, null, 2)}
`, 'utf8')
          }
        }
      }
    }
  } catch {
    // Ignore Codex hook cleanup errors.
  }

  // 3. Cursor (~/.cursor/hooks.json)
  try {
    const cursorDir = path.join(home, '.cursor')
    const cursorAppData = path.join(process.env.APPDATA || '', 'Cursor')
    const hasCursor =
      (await fs.stat(cursorDir).then((s) => s.isDirectory()).catch(() => false)) ||
      (await fs.stat(cursorAppData).then((s) => s.isDirectory()).catch(() => false))
    if (hasCursor) {
      await fs.mkdir(cursorDir, { recursive: true })
      const hooksPath = path.join(cursorDir, 'hooks.json')
      const raw = await fs.readFile(hooksPath, 'utf8').catch(() => '')
      let parsed: Record<string, unknown> = {}
      let readable = true
      if (raw.trim()) {
        try {
          const value: unknown = JSON.parse(raw)
          if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>
          else readable = false
        } catch {
          // The user's own file is not valid JSON; leave it alone rather than overwrite it.
          readable = false
        }
      }
      if (readable) {
        const hooks =
          parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks)
            ? (parsed.hooks as Record<string, unknown>)
            : {}
        const cmds = makeCmds('cursor')
        hooks.sessionStart = withNotchEntries(hooks.sessionStart, [{ command: cmds.working }])
        // One preToolUse hook covers shell, edits, MCP and AskQuestion. A separate
        // beforeShellExecution hook made every command show up twice, so it is removed.
        // Read-only tools are skipped at the source so they never spawn a hook.
        hooks.preToolUse = withNotchEntries(hooks.preToolUse, [
          { command: cmds.permission, timeout: 250, matcher: CURSOR_HOOK_MATCHER }
        ])
        const shellOthers = withNotchEntries(hooks.beforeShellExecution, [])
        if (shellOthers.length > 0) hooks.beforeShellExecution = shellOthers
        else delete hooks.beforeShellExecution
        hooks.stop = withNotchEntries(hooks.stop, [{ command: cmds.done }])
        parsed.version = typeof parsed.version === 'number' ? parsed.version : 1
        parsed.hooks = hooks
        const nextRaw = JSON.stringify(parsed, null, 2)
        if (nextRaw !== raw.trim()) {
          await fs.writeFile(hooksPath, `${nextRaw}
`, 'utf8')
        }
      }
    }
  } catch {
    // Ignore Cursor hook write errors.
  }

  // 4. Gemini CLI is no longer wired up. Remove Notch's own entries from earlier
  // builds so Gemini stops asking for approvals Notch no longer answers.
  try {
    const settingsPath = path.join(home, '.gemini', 'settings.json')
    const raw = await fs.readFile(settingsPath, 'utf8').catch(() => '')
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const hooks =
        parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks)
          ? (parsed.hooks as Record<string, unknown>)
          : null
      if (hooks) {
        let changed = false
        for (const key of ['BeforeAgent', 'BeforeTool', 'AfterAgent']) {
          if (!Array.isArray(hooks[key])) continue
          const kept = (hooks[key] as unknown[]).filter((entry) => !isNotchHookEntry(entry))
          if (kept.length === (hooks[key] as unknown[]).length) continue
          changed = true
          if (kept.length > 0) hooks[key] = kept
          else delete hooks[key]
        }
        if (changed) {
          if (Object.keys(hooks).length === 0) delete parsed.hooks
          await fs.writeFile(settingsPath, `${JSON.stringify(parsed, null, 2)}
`, 'utf8')
        }
      }
    }
  } catch {
    // Ignore Gemini settings errors.
  }
}


// ---------------------------------------------------------------------------
// Connection report: what actually works for each tool on this PC, right now.
// ---------------------------------------------------------------------------

async function pathIsDir(target: string): Promise<boolean> {
  return fs.stat(target).then((s) => s.isDirectory()).catch(() => false)
}

async function hookFileHasNotch(file: string, event: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { hooks?: Record<string, unknown> }
    const entries = parsed.hooks?.[event]
    return Array.isArray(entries) && entries.some((entry) => isNotchHookEntry(entry))
  } catch {
    return false
  }
}

function codexPipeReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(process.env.NOTCH_CODEX_IPC_PIPE || CODEX_IPC_PIPE)
    const done = (ok: boolean): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), CODEX_IPC_CONNECT_MS)
    timer.unref?.()
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** Report, per tool, whether approvals and questions can reach it. Read-only:
 * it never changes a file. The OpenCode row is added by the caller. */
export async function toolConnections(): Promise<AgentConnection[]> {
  const home = os.homedir()
  const bridgeDown = !server || Boolean(error)
  const bridgeNote = error || 'The local bridge is off. Turn on "Coding tool status".'
  const out: AgentConnection[] = []

  // Claude Code
  if (!(await pathIsDir(path.join(home, '.claude')))) {
    out.push({ tool: 'claude', label: 'Claude Code', state: 'missing', detail: 'Not found on this PC.' })
  } else if (bridgeDown) {
    out.push({ tool: 'claude', label: 'Claude Code', state: 'attention', detail: bridgeNote })
  } else if (await hookFileHasNotch(path.join(home, '.claude', 'settings.json'), 'PermissionRequest')) {
    out.push({
      tool: 'claude',
      label: 'Claude Code',
      state: 'ready',
      detail: 'Approvals and questions work. Restart a Claude session that was already open.'
    })
  } else {
    out.push({
      tool: 'claude',
      label: 'Claude Code',
      state: 'attention',
      detail: 'Hooks are not installed yet. Press Reconnect.'
    })
  }

  // Cursor
  const cursorHooks = path.join(home, '.cursor', 'hooks.json')
  const cursorSeen =
    (await pathIsDir(path.join(home, '.cursor'))) || (await pathIsDir(path.join(process.env.APPDATA || '', 'Cursor')))
  if (!cursorSeen) {
    out.push({ tool: 'cursor', label: 'Cursor', state: 'missing', detail: 'Not found on this PC.' })
  } else if (bridgeDown) {
    out.push({ tool: 'cursor', label: 'Cursor', state: 'attention', detail: bridgeNote })
  } else if (await hookFileHasNotch(cursorHooks, 'preToolUse')) {
    out.push({
      tool: 'cursor',
      label: 'Cursor',
      state: 'ready',
      detail: 'Approvals work. Questions come back to Cursor as text. Open a new agent chat after the first setup.'
    })
  } else {
    out.push({
      tool: 'cursor',
      label: 'Cursor',
      state: 'attention',
      detail: 'Hooks are not installed yet. Press Reconnect.'
    })
  }

  // Codex Desktop (answered over its local pipe; no hooks)
  if (!(await pathIsDir(path.join(home, '.codex')))) {
    out.push({ tool: 'codex', label: 'Codex', state: 'missing', detail: 'Not found on this PC.' })
  } else if (await codexPipeReachable()) {
    out.push({
      tool: 'codex',
      label: 'Codex',
      state: 'ready',
      detail: 'Connected to Codex Desktop. Approvals and questions work.'
    })
  } else {
    out.push({
      tool: 'codex',
      label: 'Codex',
      state: 'idle',
      detail: 'Open Codex Desktop to connect.'
    })
  }

  // Antigravity (reads its local server; nothing to install)
  const agRoot = path.join(home, '.gemini', 'antigravity')
  if (!(await pathIsDir(agRoot))) {
    out.push({ tool: 'antigravity', label: 'Anti Gravity', state: 'missing', detail: 'Not found on this PC.' })
  } else if (await resolveAntiGravityDaemon()) {
    out.push({
      tool: 'antigravity',
      label: 'Anti Gravity',
      state: 'ready',
      detail: 'Connected. Approvals and questions work.'
    })
  } else {
    out.push({
      tool: 'antigravity',
      label: 'Anti Gravity',
      state: 'idle',
      detail: 'Open Anti Gravity to connect.'
    })
  }

  // Apps that cannot take an answer from outside
  const deepAiHome = process.env.T3CODE_HOME || path.join(home, '.deepai-code')
  if (await pathIsDir(deepAiHome)) {
    out.push({
      tool: 'deepai',
      label: 'DeepAI Code',
      state: 'limited',
      detail: 'Questions show here, but you answer them inside DeepAI Code.'
    })
  }
  if (await pathIsDir(path.join(process.env.APPDATA || '', 'Grok Bot'))) {
    out.push({
      tool: 'grok',
      label: 'Grok Bot',
      state: 'limited',
      detail: 'Questions show here, but you answer them inside Grok Bot.'
    })
  }
  return out
}
