import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { stripTypeScriptTypes } from 'node:module'

async function loadSource(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  return import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`
  )
}

const { SendQueue, MAX_QUEUED_PER_SESSION } = await loadSource('../src/main/sendQueue.ts')

test('messages for one session are delivered strictly in order', () => {
  const queue = new SendQueue()
  assert.equal(queue.push('s1', 'first', 1), 1)
  assert.equal(queue.push('s1', 'second', 2), 2)
  assert.equal(queue.push('s1', 'third', 3), 3)
  assert.equal(queue.take('s1')?.message, 'first')
  assert.equal(queue.take('s1')?.message, 'second')
  assert.equal(queue.take('s1')?.message, 'third')
  assert.equal(queue.take('s1'), undefined)
  assert.equal(queue.size('s1'), 0)
})

test('each session keeps its own queue', () => {
  const queue = new SendQueue()
  queue.push('s1', 'for one')
  queue.push('s2', 'for two')
  assert.deepEqual([...queue.counts()], [
    ['s1', 1],
    ['s2', 1]
  ])
  assert.equal(queue.take('s2')?.message, 'for two')
  assert.equal(queue.size('s1'), 1, 'the other session is untouched')
})

test('a session cannot be flooded', () => {
  const queue = new SendQueue()
  for (let i = 0; i < MAX_QUEUED_PER_SESSION; i += 1) {
    assert.equal(queue.push('s1', `m${i}`), i + 1)
  }
  assert.equal(queue.push('s1', 'one too many'), 0)
  assert.equal(queue.size('s1'), MAX_QUEUED_PER_SESSION)
})

test('peek never removes, take always does', () => {
  const queue = new SendQueue()
  queue.push('s1', 'only')
  assert.equal(queue.peek('s1')?.message, 'only')
  assert.equal(queue.size('s1'), 1)
  queue.take('s1')
  assert.equal(queue.peek('s1'), undefined)
})

test('a vanished session can be dropped with its messages', () => {
  const queue = new SendQueue()
  queue.push('s1', 'a')
  queue.push('s1', 'b')
  queue.push('s2', 'c')
  const dropped = queue.drop('s1')
  assert.deepEqual(
    dropped.map((entry) => entry.message),
    ['a', 'b']
  )
  assert.equal(queue.size('s1'), 0)
  assert.equal(queue.size('s2'), 1)
  assert.deepEqual(queue.sessions(), ['s2'])
})

test('AppContext onSendResult ignores queued status so queued sends never show a failure toast', () => {
  const appCtx = readFileSync(new URL('../src/renderer/src/state/AppContext.tsx', import.meta.url), 'utf8')
  const start = appCtx.indexOf('window.notch.sessions.onSendResult')
  assert.ok(start > 0, 'AppContext must subscribe to onSendResult')
  const block = appCtx.slice(start, start + 700)
  assert.match(block, /if\s*\(\s*result\.status\s*===\s*'queued'\s*\)\s*return/)
  assert.match(block, /if\s*\(\s*result\.status\s*===\s*'delivered'\s*\)\s*return/)
  assert.match(block, /if\s*\(\s*result\.status\s*===\s*'unconfirmed'\s*\)\s*(?:return|\{[\s\S]*?return[\s\S]*?\})/)
})
