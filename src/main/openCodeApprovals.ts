import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentQuestionOption, AgentQuestionStep, OpenCodeQuestion, PendingApproval } from '../shared/types'

interface OpenCodeServiceInfo {
  port: number
  baseUrl: string
  authHeader?: string
}

interface V2FormOption {
  value?: unknown
  label?: unknown
  description?: unknown
}

interface V2FormField {
  key?: unknown
  type?: unknown
  title?: unknown
  description?: unknown
  options?: unknown
}

interface V2FormInfo {
  id?: unknown
  sessionID?: unknown
  title?: unknown
  fields?: unknown
}

interface ParsedV2Form {
  id: string
  sessionID: string
  question: OpenCodeQuestion
  fieldMap: {
    key: string
    type: 'string' | 'multiselect' | 'boolean'
    options: { value: unknown; label: string }[]
  }[]
}

function opencodeServicePath(): string {
  if (process.env.NOTCH_OPENCODE_SERVICE_FILE) {
    return process.env.NOTCH_OPENCODE_SERVICE_FILE
  }
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')
  return path.join(stateHome, 'opencode', 'service.json')
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

export async function readOpenCodeService(): Promise<OpenCodeServiceInfo | null> {
  try {
    const raw = await fs.readFile(opencodeServicePath(), 'utf8')
    const parsed = JSON.parse(raw) as {
      url?: unknown
      password?: unknown
      auth?: { username?: unknown; password?: unknown }
    }
    if (typeof parsed.url !== 'string' || !parsed.url) return null
    const url = new URL(parsed.url)
    const host = url.hostname.toLowerCase()
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return null
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    const password =
      typeof parsed.password === 'string'
        ? parsed.password
        : typeof parsed.auth?.password === 'string'
          ? parsed.auth.password
          : ''
    const username =
      typeof parsed.auth?.username === 'string' && parsed.auth.username
        ? parsed.auth.username
        : 'opencode'
    return {
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      ...(password ? { authHeader: basicAuthHeader(username, password) } : {})
    }
  } catch {
    return null
  }
}

async function probeOpenCodePort(port: number, authHeader?: string): Promise<boolean> {
  const base = `http://127.0.0.1:${port}`
  // OpenCode 2.3.x exposes authenticated JSON metadata at /api/info.
  try {
    const res = await fetch(`${base}/api/info`, {
      redirect: 'error',
      headers: authHeader ? { authorization: authHeader } : {},
      signal: AbortSignal.timeout(900)
    })
    const ct = res.headers.get('content-type') || ''
    if (res.ok && ct.includes('application/json')) {
      const info = (await res.json()) as unknown
      if (info && typeof info === 'object' && ('version' in info || 'pid' in info || 'urls' in info)) {
        return true
      }
    }
    await res.body?.cancel().catch(() => undefined)
  } catch {
    // Fall through to legacy /permission probe.
  }

  // Legacy OpenCode servers expose an unauthenticated JSON array at /permission.
  try {
    const res = await fetch(`${base}/permission`, {
      redirect: 'error',
      signal: AbortSignal.timeout(900)
    })
    const ct = res.headers.get('content-type') || ''
    if (res.ok && ct.includes('application/json') && Array.isArray(await res.json())) {
      return true
    }
    await res.body?.cancel().catch(() => undefined)
  } catch {
    // Not the API port.
  }
  return false
}

/** Find the local port of a running OpenCode server without asking the user.
 * Checks OpenCode's service.json discovery record first, then scans loopback
 * listeners owned by OpenCode processes for either v2 /api/info or v1 /permission. */
export async function detectOpenCodePort(): Promise<number | null> {
  const svc = await readOpenCodeService()
  if (svc && (await probeOpenCodePort(svc.port, svc.authHeader))) {
    return svc.port
  }

  if (process.platform !== 'win32') return null
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ids=(Get-Process | Where-Object { $_.Name -match 'opencode' }).Id; if($ids){ Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess -and ($_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1' -or $_.LocalAddress -eq '0.0.0.0') } | Select-Object -ExpandProperty LocalPort -Unique }"
      ],
      { windowsHide: true, timeout: 6000 },
      async (error, stdout) => {
        if (error) return resolve(null)
        const ports = String(stdout)
          .split(/\s+/)
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0 && n < 65536)
        for (const port of ports) {
          const header = svc?.port === port ? svc.authHeader : undefined
          if (await probeOpenCodePort(port, header)) return resolve(port)
        }
        resolve(null)
      }
    )
  })
}

function parseV2Form(raw: unknown): ParsedV2Form | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as V2FormInfo
  const id = typeof r.id === 'string' ? r.id : ''
  const sessionID = typeof r.sessionID === 'string' ? r.sessionID : ''
  const fields = Array.isArray(r.fields) ? (r.fields as V2FormField[]) : []
  if (!id || !sessionID || fields.length === 0) return null

  const steps: AgentQuestionStep[] = []
  const fieldMap: ParsedV2Form['fieldMap'] = []

  for (const field of fields) {
    if (!field || typeof field !== 'object') continue
    const key = typeof field.key === 'string' ? field.key.trim() : ''
    const type = field.type
    if (!key) continue

    const stepTitle = String(field.description ?? field.title ?? r.title ?? 'Pick an option').trim()
    const stepHeader = String(field.title ?? '').trim()

    if (type === 'boolean') {
      steps.push({
        id: key,
        title: stepTitle || 'Confirm action',
        ...(stepHeader && stepHeader !== stepTitle ? { detail: stepHeader } : {}),
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' }
        ],
        multiSelect: false
      })
      fieldMap.push({
        key,
        type: 'boolean',
        options: [
          { value: true, label: 'Yes' },
          { value: false, label: 'No' }
        ]
      })
      continue
    }

    if (type !== 'string' && type !== 'multiselect') continue
    const rawOpts = Array.isArray(field.options) ? (field.options as V2FormOption[]) : []
    const stepOptions: AgentQuestionOption[] = []
    const optMap: { value: unknown; label: string }[] = []
    for (const opt of rawOpts.slice(0, 6)) {
      if (!opt || typeof opt !== 'object') continue
      const label = String(opt.label ?? opt.value ?? '').trim()
      if (!label) continue
      stepOptions.push({
        label,
        description: String(opt.description ?? '').trim()
      })
      optMap.push({
        value: opt.value ?? label,
        label
      })
    }
    if (stepOptions.length < 2) continue

    steps.push({
      id: key,
      title: stepTitle || 'Pick an option',
      ...(stepHeader && stepHeader !== stepTitle ? { detail: stepHeader } : {}),
      options: stepOptions,
      multiSelect: type === 'multiselect'
    })
    fieldMap.push({ key, type, options: optMap })
  }

  if (steps.length === 0) return null
  const firstStep = steps[0]
  const detail =
    steps.length > 1
      ? steps
          .slice(1)
          .map((s) => s.title)
          .filter(Boolean)
          .join(' · ')
      : firstStep.detail || ''
  return {
    id,
    sessionID,
    question: {
      id,
      sessionID,
      title: firstStep.title,
      detail,
      options: firstStep.options,
      multiSelect: firstStep.multiSelect,
      steps
    },
    fieldMap
  }
}

export function approvalClient(port: number, clientOptions?: { authHeader?: string }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid OpenCode port.')
  const base = 'http://127.0.0.1:' + port
  let cachedV2Mode: boolean | null = null
  const v2FormCache = new Map<string, ParsedV2Form>()

  async function resolveAuthHeader(): Promise<string | undefined> {
    if (clientOptions?.authHeader) return clientOptions.authHeader
    const svc = await readOpenCodeService()
    return svc?.port === port ? svc.authHeader : undefined
  }

  async function rawFetch(reqPath: string, body?: object, methodOverride?: string): Promise<Response> {
    const authHeader = await resolveAuthHeader()
    const method = methodOverride || (body ? 'POST' : 'GET')
    const headers: Record<string, string> = {}
    if (authHeader) headers.authorization = authHeader
    if (body) headers['Content-Type'] = 'application/json'
    return fetch(base + reqPath, {
      method,
      redirect: 'error',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3500)
    })
  }

  async function requestJson(reqPath: string, body?: object, methodOverride?: string): Promise<unknown> {
    const response = await rawFetch(reqPath, body, methodOverride)
    if (!response.ok) throw new Error('OpenCode returned ' + response.status + '.')
    const text = await response.text()
    if (!text.trim()) return true
    return JSON.parse(text) as unknown
  }

  async function isV2Server(): Promise<boolean> {
    if (cachedV2Mode !== null) return cachedV2Mode
    const authHeader = await resolveAuthHeader()
    if (authHeader) {
      cachedV2Mode = true
      return true
    }
    try {
      const res = await rawFetch('/api/info')
      const ct = res.headers.get('content-type') || ''
      if (res.ok && ct.includes('application/json')) {
        await res.body?.cancel().catch(() => undefined)
        cachedV2Mode = true
        return true
      }
      await res.body?.cancel().catch(() => undefined)
    } catch {
      // Ignore probe error.
    }
    try {
      const res = await rawFetch('/api/permission/request')
      const ct = res.headers.get('content-type') || ''
      if ((res.ok && ct.includes('application/json')) || res.status === 401) {
        await res.body?.cancel().catch(() => undefined)
        cachedV2Mode = true
        return true
      }
      await res.body?.cancel().catch(() => undefined)
    } catch {
      // Ignore.
    }
    cachedV2Mode = false
    return false
  }

  async function listV2SessionIds(): Promise<string[]> {
    try {
      const res = await rawFetch('/api/session?limit=12')
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        return []
      }
      const parsed = (await res.json()) as {
        data?: { id?: unknown; time?: { busy?: unknown; idle?: unknown; updated?: unknown; archived?: unknown } }[]
      }
      const rows = Array.isArray(parsed?.data) ? parsed.data : []
      return rows
        .filter((s) => typeof s?.id === 'string' && !s.time?.archived)
        .sort((a, b) => {
          const aBusy = Number(a.time?.busy || 0) > Number(a.time?.idle || 0) ? 1 : 0
          const bBusy = Number(b.time?.busy || 0) > Number(b.time?.idle || 0) ? 1 : 0
          if (aBusy !== bBusy) return bBusy - aBusy
          return Number(b.time?.updated || 0) - Number(a.time?.updated || 0)
        })
        .slice(0, 8)
        .map((s) => String(s.id))
    } catch {
      return []
    }
  }

  async function unwrapV2Data(reqPath: string): Promise<unknown[]> {
    try {
      const res = await rawFetch(reqPath)
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        return []
      }
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('application/json')) {
        await res.body?.cancel().catch(() => undefined)
        return []
      }
      const parsed = (await res.json()) as { data?: unknown } | unknown[]
      if (Array.isArray(parsed)) return parsed
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.data)) return parsed.data
      return []
    } catch {
      return []
    }
  }

  async function listV2PermissionsRaw(): Promise<PendingApproval[]> {
    const globalCheck = await rawFetch('/api/permission/request')
    if (globalCheck.status === 401) {
      await globalCheck.body?.cancel().catch(() => undefined)
      throw new Error('OpenCode returned 401.')
    }
    const globalRows: unknown[] = []
    if (globalCheck.ok && (globalCheck.headers.get('content-type') || '').includes('application/json')) {
      const body = (await globalCheck.json()) as { data?: unknown }
      if (Array.isArray(body?.data)) globalRows.push(...body.data)
    } else {
      await globalCheck.body?.cancel().catch(() => undefined)
    }

    const sessionIds = await listV2SessionIds()
    const perSession = await Promise.all(
      sessionIds.map((id) => unwrapV2Data(`/api/session/${encodeURIComponent(id)}/permission`))
    )
    // Global requests can outlive their session (deleted/closed); replying to those 404s,
    // so only surface requests whose session still exists.
    const liveSessions = new Set(sessionIds)
    const globalChecked: unknown[] = []
    for (const raw of globalRows) {
      const sid = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).sessionID : null
      if (typeof sid !== 'string') continue
      if (liveSessions.has(sid)) {
        globalChecked.push(raw)
        continue
      }
      try {
        const res = await rawFetch(`/api/session/${encodeURIComponent(sid)}`)
        await res.body?.cancel().catch(() => undefined)
        if (res.ok) globalChecked.push(raw)
      } catch {
        // Unreachable session: skip.
      }
    }
    const seen = new Set<string>()
    const out: PendingApproval[] = []
    for (const raw of [...globalChecked, ...perSession.flat()]) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>
      const id = typeof row.id === 'string' ? row.id : ''
      const sessionID = typeof row.sessionID === 'string' ? row.sessionID : ''
      const operation =
        typeof row.action === 'string'
          ? row.action
          : typeof row.permission === 'string'
            ? row.permission
            : ''
      if (!id || !sessionID || !operation || seen.has(id)) continue
      seen.add(id)
      const patterns = Array.isArray(row.resources)
        ? row.resources
        : Array.isArray(row.patterns)
          ? row.patterns
          : []
      const metadata =
        row.metadata ?? (typeof row.message === 'string' && row.message ? { message: row.message } : undefined)
      out.push({
        id,
        session: sessionID,
        operation,
        details: JSON.stringify({ patterns, metadata }, null, 2),
        fingerprint: createHash('sha256').update(JSON.stringify(row)).digest('hex')
      })
    }
    return out
  }

  async function list(): Promise<PendingApproval[]> {
    if (await isV2Server()) {
      return listV2PermissionsRaw()
    }
    const rows: unknown = await requestJson('/permission')
    if (!Array.isArray(rows)) throw new Error('Unsupported OpenCode permission response.')
    return rows.map((row) => {
      if (
        typeof row?.id !== 'string' ||
        typeof row.sessionID !== 'string' ||
        typeof row.permission !== 'string' ||
        !Array.isArray(row.patterns)
      ) {
        throw new Error('Unsupported OpenCode request.')
      }
      return {
        id: row.id,
        session: row.sessionID,
        operation: row.permission,
        details: JSON.stringify({ patterns: row.patterns, metadata: row.metadata }, null, 2),
        fingerprint: createHash('sha256').update(JSON.stringify(row)).digest('hex')
      }
    })
  }

  async function decide(fingerprint: string, reply: 'once' | 'reject'): Promise<void> {
    if (reply !== 'once' && reply !== 'reject') throw new Error('Invalid decision.')
    const pending = (await list()).find((row) => row.fingerprint === fingerprint)
    if (!pending) throw new Error('This request has changed or closed.')
    if (await isV2Server()) {
      const res = await rawFetch(
        `/api/session/${encodeURIComponent(pending.session)}/permission/${encodeURIComponent(pending.id)}/reply`,
        { decision: reply },
        'POST'
      )
      await res.body?.cancel().catch(() => undefined)
      // 404 = the request/session already closed; nothing left to decide.
      if (res.status === 404) return
      if (!res.ok) throw new Error(`OpenCode returned ${res.status}.`)
      return
    }
    if ((await requestJson('/permission/' + encodeURIComponent(pending.id) + '/reply', { reply })) !== true) {
      throw new Error('OpenCode did not confirm the decision.')
    }
  }

  async function fetchV2Forms(): Promise<ParsedV2Form[]> {
    const [globalRows, sessionIds] = await Promise.all([unwrapV2Data('/api/form'), listV2SessionIds()])
    const perSession = await Promise.all(
      sessionIds.map((id) => unwrapV2Data(`/api/session/${encodeURIComponent(id)}/form`))
    )
    const seen = new Set<string>()
    const out: ParsedV2Form[] = []
    for (const raw of [...globalRows, ...perSession.flat()]) {
      const parsed = parseV2Form(raw)
      if (!parsed || seen.has(parsed.id)) continue
      seen.add(parsed.id)
      v2FormCache.set(parsed.id, parsed)
      out.push(parsed)
    }
    return out
  }

  async function listQuestions(): Promise<OpenCodeQuestion[]> {
    if (await isV2Server()) {
      const forms = await fetchV2Forms()
      return forms.map((f) => f.question)
    }

    // Legacy OpenCode v1 servers expose /question; treat HTML or 404 cleanly.
    let rows: unknown
    try {
      const response = await rawFetch('/question')
      const ct = response.headers.get('content-type') || ''
      if (!response.ok || !ct.includes('application/json')) {
        await response.body?.cancel().catch(() => undefined)
        return []
      }
      rows = await response.json()
    } catch {
      return []
    }
    if (!Array.isArray(rows)) return []
    const out: OpenCodeQuestion[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const id = typeof r.id === 'string' ? r.id : ''
      const sessionID = typeof r.sessionID === 'string' ? r.sessionID : ''
      const questions = Array.isArray(r.questions) ? r.questions : []
      if (!id || questions.length === 0) continue
      const steps: AgentQuestionStep[] = []
      for (const qItem of questions) {
        if (!qItem || typeof qItem !== 'object') continue
        const q = qItem as Record<string, unknown>
        const rawOptions = Array.isArray(q.options) ? q.options : []
        const stepOptions: AgentQuestionOption[] = rawOptions
          .slice(0, 6)
          .map((opt) => {
            if (typeof opt === 'string') return { label: opt.trim(), description: '' }
            if (!opt || typeof opt !== 'object') return null
            const o = opt as Record<string, unknown>
            const label = String(o.label ?? o.text ?? o.name ?? '').trim()
            if (!label) return null
            return { label, description: String(o.description ?? '').trim() }
          })
          .filter((opt): opt is AgentQuestionOption => Boolean(opt && opt.label))
        if (stepOptions.length < 2) continue
        const stepTitle = String(q.question ?? q.header ?? 'Pick an option').trim()
        const stepHeader = String(q.header ?? '').trim()
        steps.push({
          ...(typeof q.id === 'string' && q.id.trim() ? { id: q.id.trim() } : stepHeader ? { id: stepHeader } : {}),
          title: stepTitle || 'Pick an option',
          ...(stepHeader && stepHeader !== stepTitle ? { detail: stepHeader } : {}),
          options: stepOptions,
          multiSelect: q.multiple === true || q.multiSelect === true || q.is_multi_select === true || q.isMultiSelect === true
        })
      }
      if (steps.length === 0) continue
      const firstStep = steps[0]
      const detail =
        steps.length > 1
          ? steps
              .slice(1)
              .map((s) => s.title)
              .filter(Boolean)
              .join(' · ')
          : firstStep.detail || ''
      out.push({
        id,
        sessionID,
        title: firstStep.title,
        detail,
        options: firstStep.options,
        multiSelect: firstStep.multiSelect,
        steps
      })
    }
    return out
  }

  async function resolveV2Form(id: string): Promise<ParsedV2Form | null> {
    const cached = v2FormCache.get(id)
    if (cached) return cached
    const forms = await fetchV2Forms()
    return forms.find((f) => f.id === id) || null
  }

  async function replyQuestion(id: string, answers: string[][]): Promise<void> {
    if (!id) throw new Error('Missing OpenCode question id.')
    if (await isV2Server()) {
      const form = await resolveV2Form(id)
      if (!form) throw new Error('OpenCode form is no longer pending.')
      const answer: Record<string, unknown> = {}
      form.fieldMap.forEach((field, idx) => {
        const chosenLabels = answers[idx] || []
        const mappedValues = chosenLabels.map((label) => {
          const hit = field.options.find((opt) => opt.label === label)
          return hit ? hit.value : label
        })
        if (field.type === 'multiselect') {
          answer[field.key] = mappedValues.map(String)
        } else if (field.type === 'boolean') {
          const first = mappedValues[0]
          answer[field.key] = typeof first === 'boolean' ? first : /^(yes|true|allow|1)$/i.test(String(first || ''))
        } else {
          answer[field.key] = String(mappedValues[0] ?? '')
        }
      })
      const res = await rawFetch(
        `/api/session/${encodeURIComponent(form.sessionID)}/form/${encodeURIComponent(form.id)}/reply`,
        { answer },
        'POST'
      )
      await res.body?.cancel().catch(() => undefined)
      if (!res.ok) throw new Error(`OpenCode returned ${res.status}.`)
      v2FormCache.delete(id)
      return
    }
    await requestJson('/question/' + encodeURIComponent(id) + '/reply', { answers })
  }

  async function rejectQuestion(id: string): Promise<void> {
    if (!id) throw new Error('Missing OpenCode question id.')
    if (await isV2Server()) {
      const form = await resolveV2Form(id)
      if (!form) throw new Error('OpenCode form is no longer pending.')
      const res = await rawFetch(
        `/api/session/${encodeURIComponent(form.sessionID)}/form/${encodeURIComponent(form.id)}`,
        undefined,
        'DELETE'
      )
      await res.body?.cancel().catch(() => undefined)
      if (!res.ok) throw new Error(`OpenCode returned ${res.status}.`)
      v2FormCache.delete(id)
      return
    }
    await requestJson('/question/' + encodeURIComponent(id) + '/reject', {})
  }

  return { list, decide, listQuestions, replyQuestion, rejectQuestion }
}
