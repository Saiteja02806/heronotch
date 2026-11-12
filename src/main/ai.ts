import { net } from 'electron'
import type { AiChatMessage } from '../shared/types'
import { getState } from './state'

const ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions'
const ROLES = new Set(['system', 'user', 'assistant'])

function describeError(status: number, body: string): string {
  let detail = ''
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string }
    detail = parsed?.error?.message || parsed?.message || ''
  } catch {
    // The body is not JSON; fall through to the status-based message.
  }
  if (status === 401 || status === 403) {
    return 'NVIDIA rejected the request. Check the API key, or choose a different model in Settings → AI.'
  }
  if (status === 404 || status === 410) {
    return 'That model is not available on NVIDIA any more. Choose another model in Settings → AI.'
  }
  if (status === 429) {
    return 'NVIDIA is rate-limiting this key. Try again in a moment.'
  }
  return detail || `NVIDIA API error ${status}.`
}

export async function chat(messages: AiChatMessage[], modelOverride?: string): Promise<string> {
  const state = getState()
  const apiKey = state.settings.aiApiKey.trim()
  if (!apiKey) throw new Error('Add your NVIDIA API key in Settings → AI.')

  const model = (modelOverride || state.settings.aiModel || '').trim()
  if (!model) throw new Error('Choose a model in Settings → AI.')

  const safe = messages
    .filter(
      (message) =>
        message &&
        ROLES.has(message.role) &&
        typeof message.content === 'string' &&
        message.content.trim().length > 0
    )
    .slice(-20)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 24000) }))
  if (!safe.length) throw new Error('There is nothing to send.')

  const response = await net.fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: safe,
      temperature: 0.6,
      top_p: 0.9,
      max_tokens: 1600
    })
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(describeError(response.status, body))
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const text = data.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('NVIDIA returned an empty response.')
  return text
}
