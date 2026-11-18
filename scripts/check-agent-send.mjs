import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

async function loadSource(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  const typeOnly = source.replace(/import type \{[^}]*\} from '[^']*'/g, '')
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(typeOnly)).toString('base64')}`)
}

const agent = await loadSource('../src/main/antiGravityAgent.ts')

// The exact stdout shape the agent CLI printed when the daemon had restarted.
const transportOutput = `
{
  "response": {},
  "error": "rpc error: code = Unavailable desc = connection error: desc = \\"transport: Error while dialing: dial tcp 127.0.0.1:55737: connectex: No connection could be made because the target machine actively refused it.\\""
}
`

async function hubDirectory(records) {
  const base = await mkdtemp(path.join(tmpdir(), 'notch-ag-daemon-'))
  for (const [name, body] of Object.entries(records)) {
    await writeFile(path.join(base, name), JSON.stringify(body))
  }
  return base
}

test('a stale daemon record never wins over the live language server', async () => {
  // 55737 is a twelve-day-old record whose port was re-used by something else.
  const base = await hubDirectory({
    'hub_55737.json': { pid: 38524, httpsPort: 55736, httpPort: 55737, lsVersion: '2.29.0', csrfToken: 'old' },
    'hub_55607.json': { pid: 17208, httpsPort: 55606, httpPort: 55607, lsVersion: '2.32.1', csrfToken: 'live' }
  })
  try {
    const probed = []
    const target = await agent.findAntiGravityTarget({
      base,
      livePids: async () => new Set([17208]),
      portOpen: async (port) => (probed.push(port), port === 55607),
      health: async () => true
    })
    assert.deepEqual(target, {
      address: '127.0.0.1:55607',
      csrfToken: 'live',
      version: '2.32.1',
      pid: 17208
    })
    assert.deepEqual(probed, [55607], 'only the live pid is port-checked')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a live pid that answers HTTP but is not the language server is rejected', async () => {
  const base = await hubDirectory({
    'hub_50001.json': { pid: 111, httpPort: 50001, lsVersion: '2.32.1', csrfToken: 'a' },
    'hub_50002.json': { pid: 222, httpPort: 50002, lsVersion: '2.32.1', csrfToken: 'b' }
  })
  try {
    const target = await agent.findAntiGravityTarget({
      base,
      // 111 is a live process that once held the port, 222 is the daemon.
      livePids: async () => new Set([222]),
      portOpen: async () => true,
      health: async () => true
    })
    assert.equal(target?.address, '127.0.0.1:50002')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an open port with no health answer is not treated as the daemon', async () => {
  const base = await hubDirectory({
    'hub_50003.json': { pid: 333, httpPort: 50003, lsVersion: '2.32.1', csrfToken: 'c' }
  })
  try {
    const target = await agent.findAntiGravityTarget({
      base,
      livePids: async () => new Set([333]),
      portOpen: async () => true,
      health: async () => false
    })
    assert.equal(target, null)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('no daemon records means no target rather than a guessed port', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'notch-ag-empty-'))
  try {
    assert.equal(await agent.findAntiGravityTarget({ base }), null)
    assert.equal(
      await agent.findAntiGravityTarget({ base: path.join(base, 'missing') }),
      null
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the CLI failure is reported as an action, not as a gRPC blob', () => {
  const message = agent.describeAgentFailure('antigravity', transportOutput, 1)
  assert.match(message, /Anti Gravity/)
  assert.match(message, /Open Anti Gravity/)
  assert.doesNotMatch(message, /rpc error|dial tcp|55737|\{/)
})

test('other agent errors keep their own text and lose only the rpc envelope', () => {
  const raw = '{"response":{},"error":"rpc error: code = Internal desc = session aborted"}'
  assert.equal(agent.describeAgentFailure('antigravity', raw, 1), 'session aborted')
  assert.equal(agent.describeAgentFailure('antigravity', '{"error":"Unauthenticated: bad csrf token"}', 1).includes('signature'), true)
  assert.match(agent.describeAgentFailure('codex', 'config.toml line 4 is invalid', 2), /config\.toml/)
  assert.equal(agent.describeAgentFailure('claude', '', 3), 'Agent command exited with code 3.')
})

test('failure JSON is found on stdout even when the exit code is zero', () => {
  assert.equal(agent.jsonFailure(transportOutput), 'rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:55737: connectex: No connection could be made because the target machine actively refused it."')
  assert.equal(agent.jsonFailure('{"response":{"ok":true},"error":""}'), null)
  assert.equal(agent.jsonFailure('not json at all'), null)
  assert.equal(
    agent.jsonFailure('{"response":{},"error":"session aborted"}\nexit status 1'),
    'session aborted'
  )
  assert.equal(agent.transportFailure(transportOutput), true)
})

test('a deleted conversation is described as one, whatever the CLI calls it', () => {
  const codex =
    'Error: thread/resume: thread/resume failed: no rollout found for thread id 01a1e8ea-cc6f-7e11-be78-889d5ab49dea (code -32600)'
  assert.equal(agent.sessionGone(codex), true)
  assert.match(agent.describeAgentFailure('codex', codex, 1), /no longer in Codex/)
  const claude = 'No conversation found with session ID: f9679b31-6e6a-40f8-bd19-cf4e1114c914'
  assert.equal(agent.sessionGone(claude), true)
  assert.match(agent.describeAgentFailure('claude', claude, 1), /no longer in Claude Code/)
  assert.equal(agent.sessionGone('Error: model overloaded'), false)
  assert.equal(agent.describeAgentFailure('claude', 'Error: model overloaded', 1), 'Error: model overloaded')
})
