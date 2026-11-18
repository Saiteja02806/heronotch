import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

function toDataUrl(source) {
  const js = stripTypeScriptTypes(source, { mode: 'strip' })
  return `data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`
}

const agentToolsSrc = readFileSync(new URL('../src/shared/agentTools.ts', import.meta.url), 'utf8')
const agentToolsUrl = toDataUrl(agentToolsSrc)
const agentTools = await import(agentToolsUrl)

const sessionActivitySrc = readFileSync(new URL('../src/main/sessionActivity.ts', import.meta.url), 'utf8').replace(
  /from ['"]\.\.\/shared\/agentTools['"]/,
  `from '${agentToolsUrl}'`
)
const sessionActivity = await import(toDataUrl(sessionActivitySrc))

const sessionScannersSrc = readFileSync(new URL('../src/main/sessionScanners.ts', import.meta.url), 'utf8')
const { scanEditorSessions } = await import(toDataUrl(sessionScannersSrc))

function makeSession(overrides = {}) {
  return {
    id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    rawId: 'raw',
    provider: 'antigravity',
    title: 'Sample chat',
    project: 'notch',
    directory: 'C:/repo/notch',
    model: null,
    detail: null,
    updatedAt: 1_000_000,
    active: false,
    subagent: false,
    origin: null,
    ...overrides
  }
}

function makeApp(provider, processCount) {
  return {
    provider,
    label: provider,
    running: processCount > 0,
    state: processCount > 0 ? 'open' : 'closed',
    processCount,
    windowedCount: processCount > 0 ? 1 : 0,
    windowTitle: null,
    sessions: 1
  }
}

test('countActiveAgents counts active non-subagent chats and filters stale hooks', () => {
  const now = 10_000_000
  const sessions = {
    scannedAt: now - 2_000,
    sessions: [
      makeSession({ id: 'ag-1', provider: 'antigravity', active: true, updatedAt: now - 1_000 }),
      makeSession({ id: 'ag-2', provider: 'antigravity', active: true, updatedAt: now - 3_000 }),
      makeSession({ id: 'ag-sub', provider: 'antigravity', active: true, subagent: true, updatedAt: now - 500 }),
      makeSession({ id: 'cl-idle', provider: 'claude', active: false, updatedAt: now - 10_000 })
    ],
    apps: [makeApp('antigravity', 4), makeApp('claude', 0), makeApp('codex', 0), makeApp('cursor', 0)]
  }
  const agentSnapshot = {
    port: 7432,
    token: 't',
    running: true,
    pending: [],
    questions: [],
    statuses: [
      { tool: 'claude', state: 'working', title: 'Tool use', at: now - 90_000 },
      { tool: 'codex', state: 'working', title: 'Exec', at: now - 90_000 },
      { tool: 'cursor', state: 'working', title: 'Prompt', at: now - 90_000 }
    ]
  }
  assert.equal(
    agentTools.countActiveAgents({ sessions, agentSnapshot, questions: [], openCodePending: [], now }),
    2
  )
})

test('countActiveAgents honors closed desktop app, newer idle turn, grace window, and TTL', () => {
  const now = 20_000_000
  const apps = [makeApp('antigravity', 2), makeApp('cursor', 0)]

  // Cursor desktop is closed (processCount === 0 while Antigravity > 0): fresh hook is ignored.
  assert.equal(
    agentTools.countActiveAgents({
      now,
      sessions: { scannedAt: now - 1_000, sessions: [], apps },
      agentSnapshot: {
        port: 1,
        token: 't',
        running: true,
        pending: [],
        questions: [],
        statuses: [{ tool: 'cursor', state: 'working', title: 'Just started', at: now - 1_000 }]
      }
    }),
    0
  )

  // Windsurf absent from apps list while another app has processCount > 0 also means Windsurf is closed.
  assert.equal(
    agentTools.countActiveAgents({
      now,
      sessions: { scannedAt: now - 1_000, sessions: [], apps },
      agentSnapshot: {
        port: 1,
        token: 't',
        running: true,
        pending: [],
        questions: [],
        statuses: [{ tool: 'windsurf', state: 'working', title: 'Editing', at: now - 1_000 }]
      }
    }),
    0
  )

  // Scanned provider hook within 15s grace is kept if no newer idle session exists.
  assert.equal(
    agentTools.countActiveAgents({
      now,
      sessions: { scannedAt: now - 1_000, sessions: [], apps },
      agentSnapshot: {
        port: 1,
        token: 't',
        running: true,
        pending: [],
        questions: [],
        statuses: [{ tool: 'claude', state: 'working', title: 'Running tool', at: now - 5_000 }]
      }
    }),
    1
  )

  // Newer idle non-subagent session overrides a working hook even inside the 15s grace window.
  assert.equal(
    agentTools.countActiveAgents({
      now,
      sessions: {
        scannedAt: now - 1_000,
        sessions: [makeSession({ provider: 'claude', active: false, updatedAt: now - 2_000 })],
        apps
      },
      agentSnapshot: {
        port: 1,
        token: 't',
        running: true,
        pending: [],
        questions: [],
        statuses: [{ tool: 'claude', state: 'working', title: 'Running tool', at: now - 5_000 }]
      }
    }),
    0
  )

  // Un-scanned hook tool (gemini) counts inside 2m TTL, expires beyond 2m, and doesn't double-count pending/questions.
  assert.equal(
    agentTools.countActiveAgents({
      now,
      sessions: { scannedAt: now - 1_000, sessions: [], apps },
      agentSnapshot: {
        port: 1,
        token: 't',
        running: true,
        pending: [],
        questions: [],
        statuses: [{ tool: 'gemini', state: 'working', title: 'Thinking', at: now - 60_000 }]
      }
    }),
    1
  )
  assert.equal(
    agentTools.countActiveAgents({
      now,
      sessions: { scannedAt: now - 1_000, sessions: [], apps },
      agentSnapshot: {
        port: 1,
        token: 't',
        running: true,
        pending: [],
        questions: [],
        statuses: [{ tool: 'gemini', state: 'working', title: 'Stale', at: now - 125_000 }]
      }
    }),
    0
  )

  // Pending permission / question keeps count at 1 without double counting alongside active status.
  assert.equal(
    agentTools.countActiveAgents({
      now,
      sessions: { scannedAt: now - 1_000, sessions: [], apps },
      agentSnapshot: {
        port: 1,
        token: 't',
        running: true,
        pending: [{ id: 'p1', tool: 'claude', title: 'Bash', detail: '', at: now - 5_000 }],
        questions: [],
        statuses: [{ tool: 'claude', state: 'waiting', title: 'Bash', at: now - 5_000 }]
      },
      questions: [{ id: 'q1', tool: 'codex', title: 'Pick', detail: '', options: [], at: now - 5_000 }]
    }),
    2
  )

  // When sessions scan errored, fresh hook statuses still fall back cleanly to the 2m TTL.
  assert.equal(
    agentTools.countActiveAgents({
      now,
      sessions: { scannedAt: now, sessions: [], apps: [], error: 'sqlite busy' },
      agentSnapshot: {
        port: 1,
        token: 't',
        running: true,
        pending: [],
        questions: [],
        statuses: [{ tool: 'codex', state: 'working', title: 'Exec', at: now - 30_000 }]
      }
    }),
    1
  )
})

test('Codex rollout tail overrides live mtime and stale inProgress turns', () => {
  const now = 50_000_000
  const finishedTail = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } })
  ].join('\n')
  assert.equal(sessionActivity.parseCodexRolloutTail(finishedTail), 'closed')
  assert.equal(
    sessionActivity.isCodexSessionActive({
      status: 'inProgress',
      updatedAt: now - 2_000,
      rolloutSignal: 'closed',
      rolloutAgeMs: 1_500,
      now
    }),
    false
  )

  const openTail = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call' } })
  ].join('\n')
  assert.equal(sessionActivity.parseCodexRolloutTail(openTail), 'open')
  assert.equal(
    sessionActivity.isCodexSessionActive({
      status: 'completed',
      updatedAt: now - 25_000,
      rolloutSignal: 'open',
      rolloutAgeMs: 5_000,
      now
    }),
    true
  )
  assert.equal(
    sessionActivity.isCodexSessionActive({
      status: 'inProgress',
      updatedAt: now - 45 * 60_000,
      rolloutSignal: 'unknown',
      rolloutAgeMs: 45 * 60_000,
      now
    }),
    false
  )
})

test('Claude tail analysis distinguishes live turns from completed turns and renames', () => {
  const now = 80_000_000
  const endTurnTail = [
    JSON.stringify({ type: 'user', timestamp: new Date(now - 5_000).toISOString() }),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(now - 2_000).toISOString(),
      message: { stop_reason: 'end_turn' }
    }),
    JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', timestamp: new Date(now - 1_500).toISOString() }),
    JSON.stringify({ type: 'cost-state', totalCostUsd: 0.01 }),
    JSON.stringify({ type: 'custom-title', customTitle: 'Renamed thread' })
  ].join('\n')

  const endSummary = sessionActivity.analyzeClaudeTail(endTurnTail)
  assert.equal(endSummary.turnSignal, 'closed')
  assert.equal(endSummary.updatedAt, now - 1_500)
  assert.equal(
    sessionActivity.isClaudeSessionActive({
      subagent: false,
      turnSignal: endSummary.turnSignal,
      updatedAt: endSummary.updatedAt,
      mtime: now - 500,
      now
    }),
    false
  )

  const toolUseTail = [
    JSON.stringify({ type: 'user', timestamp: new Date(now - 5_000).toISOString() }),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(now - 3_000).toISOString(),
      message: { stop_reason: 'tool_use' }
    })
  ].join('\n')
  const toolSummary = sessionActivity.analyzeClaudeTail(toolUseTail)
  assert.equal(toolSummary.turnSignal, 'open')
  assert.equal(
    sessionActivity.isClaudeSessionActive({
      subagent: false,
      turnSignal: toolSummary.turnSignal,
      updatedAt: toolSummary.updatedAt,
      mtime: now - 3_000,
      now
    }),
    true
  )
  assert.equal(
    sessionActivity.isClaudeSessionActive({
      subagent: true,
      turnSignal: toolSummary.turnSignal,
      updatedAt: toolSummary.updatedAt,
      mtime: now - 3_000,
      now
    }),
    false
  )
  assert.equal(
    sessionActivity.isClaudeSessionActive({
      subagent: false,
      turnSignal: toolSummary.turnSignal,
      updatedAt: now - 120_000,
      mtime: now - 120_000,
      now
    }),
    false
  )
})

test('OpenCode, Antigravity, DeepAI, prioritizeAndCapSessions, and clearClosedDesktopActivity behave accurately', () => {
  const now = 90_000_000
  // Brand-new empty OpenCode session must not count as active.
  assert.equal(
    sessionActivity.isOpenCodeSessionActive({ timeBusy: null, timeIdle: null, updatedAt: now - 1_000, now }),
    false
  )
  assert.equal(
    sessionActivity.isOpenCodeSessionActive({ timeBusy: now - 2_000, timeIdle: null, updatedAt: now - 2_000, now }),
    true
  )
  assert.equal(
    sessionActivity.isOpenCodeSessionActive({
      timeBusy: now - 5_000,
      timeIdle: now - 2_000,
      updatedAt: now - 2_000,
      now
    }),
    false
  )

  // Antigravity: IDLE, empty, UNSPECIFIED, and >30m are never active; RUNNING/BUSY/CANCELING within 30m are.
  assert.equal(
    sessionActivity.isAntigravitySessionActive({ status: 'CASCADE_RUN_STATUS_IDLE', updatedAt: now - 1_000, now }),
    false
  )
  assert.equal(
    sessionActivity.isAntigravitySessionActive({
      status: 'CASCADE_RUN_STATUS_UNSPECIFIED',
      updatedAt: now - 1_000,
      now
    }),
    false
  )
  assert.equal(
    sessionActivity.isAntigravitySessionActive({ status: 'CASCADE_RUN_STATUS_RUNNING', updatedAt: now - 1_000, now }),
    true
  )
  assert.equal(
    sessionActivity.isAntigravitySessionActive({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      updatedAt: now - 40 * 60_000,
      now
    }),
    false
  )

  // DeepAI recency guard.
  assert.equal(
    sessionActivity.isDeepAiSessionActive({ status: 'running', updatedAt: now - 40 * 60_000, now }),
    false
  )
  assert.equal(sessionActivity.isDeepAiSessionActive({ status: 'streaming', updatedAt: now - 1_000, now }), true)

  // Prioritize active main chats before slicing per provider.
  const crowded = [
    ...Array.from({ length: 12 }, (_, i) =>
      makeSession({ id: `sub-${i}`, provider: 'antigravity', subagent: true, active: false, updatedAt: now - i * 100 })
    ),
    makeSession({ id: 'active-main', provider: 'antigravity', active: true, subagent: false, updatedAt: now - 60_000 })
  ]
  const capped = sessionActivity.prioritizeAndCapSessions(crowded, 10)
  assert.equal(capped.length, 10)
  assert.equal(capped[0].id, 'active-main')

  // Closed desktop app loses phantom active flag while CLI tools keep active.
  const cleaned = sessionActivity.clearClosedDesktopActivity(
    [
      makeSession({ id: 'cursor-1', provider: 'cursor', active: true }),
      makeSession({ id: 'claude-1', provider: 'claude', active: true })
    ],
    new Set(['antigravity']),
    true
  )
  assert.equal(cleaned.find((s) => s.id === 'cursor-1').active, false)
  assert.equal(cleaned.find((s) => s.id === 'claude-1').active, true)
})

test('Antigravity SQLite query & Grok recency & UNC path strip match production contracts', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'notch-active-test-'))
  const dbPath = path.join(dir, 'conversation_summaries.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`create table conversation_summaries (
      conversation_id text primary key,
      title text,
      preview text,
      step_count integer,
      last_modified_time integer,
      workspace_uris text,
      status text,
      agent_name text,
      nesting_depth integer,
      not_fully_idle integer,
      killed integer
    )`)
    const nowSec = Math.floor(Date.now() / 1000)
    const stmt = db.prepare(
      `insert into conversation_summaries values (?, ?, '', 1, ?, '', ?, '', ?, ?, ?)`
    )
    for (let i = 0; i < 25; i++) {
      stmt.run(`sub-${i}`, `Sub ${i}`, nowSec - i, 'CASCADE_RUN_STATUS_IDLE', 1, 0, 0)
    }
    stmt.run('main-running', 'Main active', nowSec - 100, 'CASCADE_RUN_STATUS_RUNNING', 0, 0, 0)
    stmt.run('idle-dirty', 'Idle with flag', nowSec - 5, 'CASCADE_RUN_STATUS_IDLE', 0, 1, 0)

    const rows = db
      .prepare(
        `select conversation_id, status, nesting_depth, not_fully_idle
         from conversation_summaries
         where killed = 0
         order by (coalesce(nesting_depth, 0) = 0 and upper(coalesce(status, '')) in ('CASCADE_RUN_STATUS_RUNNING', 'CASCADE_RUN_STATUS_BUSY', 'CASCADE_RUN_STATUS_CANCELING')) desc,
                  last_modified_time desc
         limit 30`
      )
      .all()
    assert.equal(rows[0].conversation_id, 'main-running')
    const dirtyRow = rows.find((r) => r.conversation_id === 'idle-dirty')
    assert.equal(
      sessionActivity.isAntigravitySessionActive({ status: dirtyRow.status, updatedAt: Date.now() }),
      false
    )

    // Verify scanGrok recency gate via base32-encoded APPDATA .blob fixture.
    function encodeBase32(text) {
      const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
      let bits = 0
      let acc = 0
      let out = ''
      for (const byte of Buffer.from(text, 'utf8')) {
        acc = (acc << 8) | byte
        bits += 8
        while (bits >= 5) {
          out += alphabet[(acc >>> (bits - 5)) & 31]
          bits -= 5
        }
      }
      if (bits > 0) out += alphabet[(acc << (5 - bits)) & 31]
      return out
    }

    const homeDir = path.join(dir, 'home')
    const appDataDir = path.join(dir, 'appdata')
    const grokDir = path.join(appDataDir, 'Grok Bot', 'sand-client-persistence')
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(grokDir, { recursive: true })
    const blobName = `${encodeBase32('sand.client.slice.account.u1.roster.last-roster')}.blob`
    writeFileSync(
      path.join(grokDir, blobName),
      JSON.stringify({
        value: {
          rows: [
            { id: 'fresh', title: 'Fresh Grok', awaitingUserResponse: true, lastActivityAt: Date.now() - 5_000 },
            { id: 'stale', title: 'Stale Grok', awaitingUserResponse: true, lastActivityAt: Date.now() - 45 * 60_000 }
          ]
        }
      })
    )
    const prevEnv = {
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      USERPROFILE: process.env.USERPROFILE
    }
    process.env.APPDATA = appDataDir
    process.env.LOCALAPPDATA = path.join(dir, 'localappdata')
    process.env.USERPROFILE = homeDir
    try {
      const scanned = await scanEditorSessions()
      const fresh = scanned.find((s) => s.rawId === 'fresh')
      const stale = scanned.find((s) => s.rawId === 'stale')
      assert.equal(fresh?.active, true)
      assert.equal(stale?.active, false)
    } finally {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }

  // Verify sessions.ts strips \\?\ UNC prefix cleanly and CollapsedBar preserves contract.
  const sessionsSrc = readFileSync(new URL('../src/main/sessions.ts', import.meta.url), 'utf8')
  const cleanMatch = sessionsSrc.match(/const cleaned = String\(rolloutPath\)\.replace\(([^,]+), ''\)/)
  assert.ok(cleanMatch, 'readCodexRolloutState should strip UNC prefix')
  assert.equal(
    '\\\\?\\C:\\Users\\test\\rollout.jsonl'.replace(new RegExp(cleanMatch[1].slice(1, -1)), ''),
    'C:\\Users\\test\\rollout.jsonl'
  )

  const collapsedSrc = readFileSync(new URL('../src/renderer/src/components/CollapsedBar.tsx', import.meta.url), 'utf8')
  assert.match(collapsedSrc, /const showSessions = detailed && agentCount > 0/)
  assert.match(collapsedSrc, /countActiveAgents\(/)
  assert.match(collapsedSrc, /active coding/)
})
