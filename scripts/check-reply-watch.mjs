import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { stripTypeScriptTypes } from 'node:module'

function toDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

function readSource(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  return stripTypeScriptTypes(source.replace(/import type \{[^}]*\} from '[^']*'/g, ''))
}

// sessionWatch imports sessionDelivery; point that import at an inlined copy.
const deliveryUrl = toDataUrl(readSource('../src/main/sessionDelivery.ts'))
const watchSource = readSource('../src/main/sessionWatch.ts').replace(
  /from '\.\/sessionDelivery'/,
  `from '${deliveryUrl}'`
)
const watch = await import(toDataUrl(watchSource))

const line = (record) => JSON.stringify(record)

test('a Claude reply counts only when it chains back to the message Notch sent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'notch-reply-'))
  const rawId = '83ec2e35-782e-423e-92a1-059d89fc020d'
  const dir = path.join(root, 'proj')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${rawId}.jsonl`)
  const message = 'hi from the notch'
  try {
    // Notch's message, written by the command line (no parent we care about).
    await writeFile(
      file,
      [
        line({ type: 'user', uuid: 'u-notch', parentUuid: 'old', message: { role: 'user', content: message } }),
        // The Claude app keeps working in the same chat and answers something else.
        line({ type: 'assistant', uuid: 'a-app', parentUuid: 'u-app', message: { role: 'assistant', content: [] } })
      ].join('\n') + '\n'
    )
    const foreign = await watch.readClaudeReply(root, rawId, message)
    assert.equal(foreign.ok, true)
    assert.equal(foreign.cursor.token, '', 'an assistant line from another writer is not an answer')
    assert.equal(foreign.cursor.evidence, 'none')

    // The old behaviour (no message) would have called that a reply.
    const unmatched = await watch.readClaudeReply(root, rawId)
    assert.notEqual(unmatched.cursor.token, '')

    // An API failure chained to the message is still not an answer.
    await appendFile(
      file,
      line({
        type: 'assistant',
        uuid: 'a-err',
        parentUuid: 'u-notch',
        isApiErrorMessage: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Not logged in' }] }
      }) + '\n'
    )
    assert.equal((await watch.readClaudeReply(root, rawId, message)).cursor.token, '')

    // A real answer, possibly through a tool round trip, is.
    await appendFile(
      file,
      [
        line({ type: 'assistant', uuid: 'a-tool', parentUuid: 'u-notch', message: { role: 'assistant', content: [] } }),
        line({
          type: 'user',
          uuid: 'u-result',
          parentUuid: 'a-tool',
          message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }
        }),
        line({ type: 'assistant', uuid: 'a-final', parentUuid: 'u-result', message: { role: 'assistant', content: [] } })
      ].join('\n') + '\n'
    )
    const answered = await watch.readClaudeReply(root, rawId, message)
    assert.match(answered.cursor.token, /^claude:proj:\d+\|$/)
    assert.equal(answered.cursor.evidence, 'assistant')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resending the same text starts a fresh chain at the newest copy', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'notch-reply-'))
  const rawId = '565a6262-6a99-441e-a623-f48ff6c8e646'
  const dir = path.join(root, 'proj')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${rawId}.jsonl`)
  try {
    await writeFile(
      file,
      [
        line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'ping' } }),
        line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [] } }),
        line({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: 'ping' } })
      ].join('\n') + '\n'
    )
    // Only the first ping was answered; the second has no reply yet.
    assert.equal((await watch.readClaudeReply(root, rawId, 'ping')).cursor.token, '')
    await appendFile(
      file,
      line({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { role: 'assistant', content: [] } }) + '\n'
    )
    assert.notEqual((await watch.readClaudeReply(root, rawId, 'ping')).cursor.token, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
