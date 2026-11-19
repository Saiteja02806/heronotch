import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { stripTypeScriptTypes } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

async function loadSource(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  const typeOnly = source.replace(/import type \{[^}]*\} from '[^']*'/g, '')
  return import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(typeOnly)).toString('base64')}`
  )
}

const delivery = await loadSource('../src/main/sessionDelivery.ts')

async function makeHome(prefix) {
  const home = await mkdtemp(path.join(tmpdir(), prefix))
  return { home, done: () => rm(home, { recursive: true, force: true }) }
}

// A message that breaks naive substring matching: quotes, a newline, a
// backslash and a non-ASCII character.
const TRICKY = 'say "hi" to the\npath C:\\temp — ok?'

test('whitespace and JSON escaping never decide whether a message was delivered', () => {
  assert.equal(delivery.normalizeWhitespace('a\r\n  b\tc'), 'a\nb c')
  // A JSON column stores the message escaped; a transcript stores it decoded.
  assert.equal(delivery.containsText(JSON.stringify({ text: TRICKY }), TRICKY), true)
  assert.equal(delivery.containsText('say    "hi"   to the path', 'say "hi" to the path'), true)
  assert.equal(delivery.containsText('unrelated', 'say "hi"'), false)
  assert.equal(delivery.jsonContainsText({ a: { b: ['x', { c: TRICKY }] } }, TRICKY), true)
  assert.equal(delivery.jsonContainsText({ a: 'nope' }, TRICKY), false)
})

test('OpenCode 2.x confirms a user message and ignores assistant text', async () => {
  const { home, done } = await makeHome('notch-delivery-oc-')
  const dir = path.join(home, '.local', 'share', 'opencode')
  await mkdir(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'opencode.db'))
  db.exec(`
    create table session_v2 (id text primary key);
    create table session_message (
      id text primary key, session_id text, type text, seq integer, data text
    );
  `)
  db.prepare('insert into session_v2 (id) values (?)').run('ses_live')
  const insert = db.prepare(
    'insert into session_message (id, session_id, type, seq, data) values (?, ?, ?, ?, ?)'
  )
  insert.run('m1', 'ses_live', 'user', 4, JSON.stringify({ metadata: { displayText: TRICKY } }))
  insert.run('m2', 'ses_live', 'assistant', 6, JSON.stringify({ text: TRICKY }))
  insert.run('m3', 'ses_other', 'user', 1, JSON.stringify({ metadata: { displayText: TRICKY } }))
  db.close()
  try {
    const options = { home, retryMs: 0 }
    assert.equal(
      (await delivery.confirmDeliveredMessage('opencode', 'ses_live', TRICKY, options)).check,
      'confirmed'
    )
    assert.equal(
      (await delivery.confirmDeliveredMessage('opencode', 'ses_live', `${TRICKY} extra`, options)).check,
      'missing'
    )
    const mark = await delivery.captureDeliveryMark('opencode', 'ses_live', { home })
    // Every row already in the session is behind the mark, assistant turns too.
    assert.equal(mark.openCodeSeq, 6)
    assert.ok(mark.startedAt > 0)
    assert.equal(
      (await delivery.confirmDeliveredMessage('opencode', 'ses_live', TRICKY, { ...options, mark })).check,
      'missing'
    )
    assert.equal(await delivery.sessionPresence('opencode', 'ses_live', { home }), 'exists')
    assert.equal(await delivery.sessionPresence('opencode', 'ses_gone', { home }), 'gone')
  } finally {
    await done()
  }
})

test('a Codex rollout confirms only the user turn, and only text written after the mark', async () => {
  const { home, done } = await makeHome('notch-delivery-cx-')
  const rawId = '01a1e8ea-cc6f-7e11-be78-889d5ab49dea'
  const dir = path.join(home, '.codex', 'sessions', '2026', '11', '17')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-11-17T15-21-04-${rawId}.jsonl`)
  const assistant = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: TRICKY }] }
  })
  await writeFile(file, `${assistant}\n`)
  try {
    const options = { home, retryMs: 0 }
    // The assistant quoting the message back is not delivery.
    assert.equal(
      (await delivery.confirmDeliveredMessage('codex', rawId, TRICKY, options)).check,
      'missing'
    )
    const user = JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: TRICKY }] }
    })
    await appendFile(file, `${user}\n`)
    assert.equal(
      (await delivery.confirmDeliveredMessage('codex', rawId, TRICKY, options)).check,
      'confirmed'
    )
    // A mark from before this send means the same text already existed, so it
    // must not confirm a second send on its own.
    const mark = { files: [{ path: file, size: (await import('node:fs')).statSync(file).size }] }
    assert.equal(
      (await delivery.confirmDeliveredMessage('codex', rawId, TRICKY, { ...options, mark })).check,
      'missing'
    )
    await appendFile(file, `${assistant}\n${user}\n`)
    assert.equal(
      (await delivery.confirmDeliveredMessage('codex', rawId, TRICKY, { ...options, mark })).check,
      'confirmed'
    )
    assert.equal(await delivery.sessionPresence('codex', rawId, { home }), 'exists')
    assert.equal(await delivery.sessionPresence('codex', 'not-a-thread', { home }), 'unknown')
    assert.equal(delivery.codexRolloutMatches(path.basename(file), rawId), true)
    assert.equal(delivery.codexRolloutMatches(`rollout-x-${rawId}_other.jsonl`, rawId), false)
  } finally {
    await done()
  }
})

test('a Claude transcript ignores tool results and reads escaped text', async () => {
  const { home, done } = await makeHome('notch-delivery-cl-')
  const rawId = 'f9679b31-6e6a-40f8-bd19-cf4e1114c914'
  const dir = path.join(home, '.claude', 'projects', 'C--Users-chund-project')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${rawId}.jsonl`)
  const toolResult = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: TRICKY }] }
  })
  await writeFile(file, `${toolResult}\n`)
  try {
    const options = { home, retryMs: 0 }
    assert.equal(
      (await delivery.confirmDeliveredMessage('claude', rawId, TRICKY, options)).check,
      'missing'
    )
    const user = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: TRICKY }] }
    })
    await appendFile(file, `${user}\n`)
    assert.equal(
      (await delivery.confirmDeliveredMessage('claude', rawId, TRICKY, options)).check,
      'confirmed'
    )
    assert.equal(await delivery.sessionPresence('claude', rawId, { home }), 'exists')
    assert.equal(await delivery.sessionPresence('claude', 'no-such-session', { home }), 'gone')
  } finally {
    await done()
  }
})

test('a Claude "Not logged in" reply is not a delivered message', async () => {
  const { home, done } = await makeHome('notch-delivery-cl-err-')
  const rawId = '565a6262-6a99-441e-a623-f48ff6c8e646'
  const dir = path.join(home, '.claude', 'projects', 'p')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${rawId}.jsonl`)
  const user = JSON.stringify({ type: 'user', message: { role: 'user', content: 'ping' } })
  const apiError = JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }
  })
  await writeFile(file, `${user}
${apiError}
`)
  try {
    const failed = await delivery.confirmDeliveredMessage('claude', rawId, 'ping', { home, retryMs: 0 })
    assert.equal(failed.check, 'missing')
    assert.match(failed.reason, /Not logged in/)
    // A real answer after the error (a retry that worked) makes it a delivery again.
    const answer = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'PONG' }] }
    })
    await appendFile(file, `${answer}
`)
    assert.equal(
      (await delivery.confirmDeliveredMessage('claude', rawId, 'ping', { home, retryMs: 0 })).check,
      'confirmed'
    )
  } finally {
    await done()
  }
})

test('a Codex usage-limit turn is a message that landed but was not answered', async () => {
  const { home, done } = await makeHome('notch-delivery-cx-err-')
  const rawId = '01a1eef6-65c1-77a2-84c9-1253c507fd48'
  const dir = path.join(home, '.codex', 'sessions', '2026', '11', '18')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-11-18T19-31-27-${rawId}.jsonl`)
  const line = (type, payload) => JSON.stringify({ type, payload })
  await writeFile(
    file,
    [
      line('event_msg', { type: 'task_started', turn_id: 't1' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello codex' }] }),
      line('event_msg', {
        type: 'task_complete',
        last_agent_message: null,
        error: { message: 'You’ve hit your usage limit. Try again later.' }
      })
    ].join('\n') + '\n'
  )
  try {
    const options = { home, retryMs: 0 }
    const failed = await delivery.confirmDeliveredMessage('codex', rawId, 'hello codex', options)
    assert.equal(failed.check, 'missing')
    assert.ok(failed.reason.startsWith(delivery.AGENT_ERROR_PREFIX))
    assert.match(failed.reason, /usage limit/)
    // A later turn that ran normally clears it.
    await appendFile(
      file,
      [
        line('event_msg', { type: 'task_started', turn_id: 't2' }),
        line('event_msg', { type: 'task_complete', last_agent_message: 'done', error: null })
      ].join('\n') + '\n'
    )
    assert.equal((await delivery.confirmDeliveredMessage('codex', rawId, 'hello codex', options)).check, 'confirmed')
  } finally {
    await done()
  }
})

test('Anti Gravity steps confirm the message bytes and honour the step mark', async () => {
  const { home, done } = await makeHome('notch-delivery-ag-')
  const rawId = '49d77866-022b-4b2d-8ee4-89f38cd0380f'
  const dir = path.join(home, '.gemini', 'antigravity', 'conversations')
  await mkdir(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, `${rawId}.db`))
  db.exec('create table steps (idx integer primary key, step_type integer, step_payload blob);')
  const insert = db.prepare('insert into steps (idx, step_type, step_payload) values (?, ?, ?)')
  const payload = Buffer.concat([
    Buffer.from([0x08, 0x0e, 0x12, 0x20]),
    Buffer.from(TRICKY, 'utf8')
  ])
  insert.run(4, 14, payload)
  db.close()
  try {
    const options = { home, retryMs: 0 }
    assert.equal(
      (await delivery.confirmDeliveredMessage('antigravity', rawId, TRICKY, options)).check,
      'confirmed'
    )
    assert.equal(
      (await delivery.confirmDeliveredMessage('antigravity', rawId, 'not there', options)).check,
      'missing'
    )
    const capturedMark = await delivery.captureDeliveryMark('antigravity', rawId, { home })
    assert.equal(capturedMark?.stepIndex, 4)
    assert.equal(
      (
        await delivery.confirmDeliveredMessage('antigravity', rawId, TRICKY, {
          ...options,
          mark: capturedMark
        })
      ).check,
      'missing'
    )
    const logDir = path.join(home, '.gemini', 'antigravity', 'brain', rawId, '.system_generated', 'logs')
    await mkdir(logDir, { recursive: true })
    await writeFile(
      path.join(logDir, 'transcript.jsonl'),
      `${JSON.stringify({ step_index: 5, type: 'SYSTEM_MESSAGE', content: 'queued via agentapi' })}\n`
    )
    assert.equal(
      (
        await delivery.confirmDeliveredMessage('antigravity', rawId, 'queued via agentapi', {
          ...options,
          mark: capturedMark
        })
      ).check,
      'confirmed'
    )
    assert.equal(await delivery.sessionPresence('antigravity', rawId, { home }), 'exists')
    assert.equal(await delivery.sessionPresence('antigravity', 'unknown-id', { home }), 'unknown')
  } finally {
    await done()
  }
})

test('a store that renumbers or shrinks still confirms a delivered message', async () => {
  const { home, done } = await makeHome('notch-delivery-fallback-')
  try {
    // OpenCode row numbered below the previous maximum, but written after the
    // send started: sequence numbers alone must not hide it.
    const ocDir = path.join(home, '.local', 'share', 'opencode')
    await mkdir(ocDir, { recursive: true })
    const db = new DatabaseSync(path.join(ocDir, 'opencode.db'))
    db.exec(`
      create table session_v2 (id text primary key);
      create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, data text);
    `)
    db.prepare('insert into session_v2 (id) values (?)').run('ses_live')
    db.prepare('insert into session_message values (?,?,?,?,?,?)').run(
      'm1',
      'ses_live',
      'user',
      3,
      Date.now(),
      JSON.stringify({ metadata: { displayText: TRICKY } })
    )
    db.close()
    const renumbered = await delivery.confirmDeliveredMessage('opencode', 'ses_live', TRICKY, {
      home,
      retryMs: 0,
      mark: { openCodeSeq: 99, startedAt: Date.now() - 1000 }
    })
    assert.equal(renumbered.check, 'confirmed')

    // A Claude transcript that was compacted after the mark (smaller file) must
    // be read from the start instead of from an offset past its end.
    const rawId = 'f9679b31-6e6a-40f8-bd19-cf4e1114c914'
    const dir = path.join(home, '.claude', 'projects', 'p')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${rawId}.jsonl`)
    await writeFile(
      file,
      `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: TRICKY }] } })}
`
    )
    const compacted = await delivery.confirmDeliveredMessage('claude', rawId, TRICKY, {
      home,
      retryMs: 0,
      mark: { files: [{ path: file, size: 900_000 }] }
    })
    assert.equal(compacted.check, 'confirmed')
  } finally {
    await done()
  }
})
