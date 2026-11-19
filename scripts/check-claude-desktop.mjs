import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

async function loadSource(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  const typeOnly = source.replace(/import type \{[^}]*\} from '[^']*'/g, '')
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(typeOnly)).toString('base64')}`)
}

const claudeDesktop = await loadSource('../src/main/claudeDesktop.ts')

test('readLiveClaudeSessions detects live Claude Desktop sessions and ignores dead PIDs and key files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notch-claude-live-'))
  try {
    await writeFile(
      path.join(dir, '3024.json'),
      JSON.stringify({
        pid: 3024,
        sessionId: '0e819051-7786-404c-b9e4-1d2e04ae4ac9',
        entrypoint: 'claude-desktop',
        hostSessionId: 'local_2b9cc217-5b2e-47fc-bc7d-97408655cc79',
        status: 'idle'
      })
    )
    await writeFile(
      path.join(dir, '4040.json'),
      JSON.stringify({
        pid: 4040,
        sessionId: '11111111-2222-3333-4444-555555555555',
        entrypoint: 'claude-desktop',
        hostSessionId: 'local_dead-pid-session',
        status: 'running'
      })
    )
    await writeFile(
      path.join(dir, '5050.json'),
      JSON.stringify({
        pid: 5050,
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        entrypoint: 'cli',
        status: 'running'
      })
    )
    await writeFile(path.join(dir, '3024.deadbeef.key'), 'secret-key-bytes')
    await writeFile(path.join(dir, 'broken.json'), '{not-valid-json')

    const alivePids = new Set([3024, 5050])
    const sessions = await claudeDesktop.readLiveClaudeSessions({
      sessionsDir: dir,
      isAlive: (pid) => alivePids.has(pid)
    })

    assert.equal(sessions.size, 2)
    const desktop = sessions.get('0e819051-7786-404c-b9e4-1d2e04ae4ac9')
    assert.deepEqual(desktop, {
      pid: 3024,
      sessionId: '0e819051-7786-404c-b9e4-1d2e04ae4ac9',
      entrypoint: 'claude-desktop',
      hostSessionId: 'local_2b9cc217-5b2e-47fc-bc7d-97408655cc79',
      status: 'idle',
      isDesktop: true,
      busy: false
    })

    const deadHit = await claudeDesktop.findLiveClaudeDesktopSession(
      '11111111-2222-3333-4444-555555555555',
      { sessionsDir: dir, isAlive: (pid) => alivePids.has(pid) }
    )
    assert.equal(deadHit, null, 'crashed/stale PIDs must not be treated as live in Claude Desktop')

    const cliHit = await claudeDesktop.findLiveClaudeDesktopSession(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      { sessionsDir: dir, isAlive: (pid) => alivePids.has(pid) }
    )
    assert.equal(cliHit, null, 'standalone terminal CLI sessions are not Claude Desktop sessions')

    const desktopHit = await claudeDesktop.findLiveClaudeDesktopSession(
      '0e819051-7786-404c-b9e4-1d2e04ae4ac9',
      { sessionsDir: dir, isAlive: (pid) => alivePids.has(pid) }
    )
    assert.equal(desktopHit?.hostSessionId, 'local_2b9cc217-5b2e-47fc-bc7d-97408655cc79')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readLiveClaudeSessions marks busy status accurately and handles missing directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notch-claude-busy-'))
  try {
    await writeFile(
      path.join(dir, '9001.json'),
      JSON.stringify({
        pid: 9001,
        sessionId: '22222222-3333-4444-5555-666666666666',
        entrypoint: 'claude-desktop',
        hostSessionId: 'local_busy-session',
        status: 'running'
      })
    )
    const hit = await claudeDesktop.findLiveClaudeDesktopSession(
      '22222222-3333-4444-5555-666666666666',
      { sessionsDir: dir, isAlive: () => true }
    )
    assert.equal(hit?.busy, true)
    assert.equal(
      await claudeDesktop.findLiveClaudeDesktopSession('missing', {
        sessionsDir: path.join(dir, 'does-not-exist'),
        isAlive: () => true
      }),
      null
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parseAutoSubmitOutput handles CLIXML noise and fails closed on unknown output', () => {
  assert.deepEqual(
    claudeDesktop.parseAutoSubmitOutput('#< CLIXML\n<Objs></Objs>\nRESULT:sent\n'),
    { status: 'sent' }
  )
  assert.equal(claudeDesktop.parseAutoSubmitOutput('RESULT:not-focused').status, 'not-focused')
  assert.equal(claudeDesktop.parseAutoSubmitOutput('RESULT:lost-focus').status, 'lost-focus')
  assert.equal(
    claudeDesktop.parseAutoSubmitOutput('RESULT:lost-focus-after-paste').status,
    'lost-focus-after-paste'
  )
  assert.equal(claudeDesktop.parseAutoSubmitOutput('RESULT:send-failed').status, 'send-failed')
  assert.equal(claudeDesktop.parseAutoSubmitOutput('').status, 'send-failed')
  assert.equal(claudeDesktop.parseAutoSubmitOutput('unexpected error text').status, 'send-failed')
})

test('sessions.ts uses live-process two-tier Claude delivery and generalized trackDesktopDelivery', () => {
  const sessionsSrc = readFileSync(new URL('../src/main/sessions.ts', import.meta.url), 'utf8')
  assert.match(sessionsSrc, /inspectClaudeDesktopState\(session\.rawId\)/)
  assert.match(sessionsSrc, /sendViaClaudeDesktop\(session, message, desktopState\)/)
  assert.match(sessionsSrc, /confirmDeliveredMessage\(session\.provider, session\.rawId, message/)
  assert.doesNotMatch(sessionsSrc, /function claudeOwnedByApp\(/, 'unloaded sidebar chats should not be forced to manual handoff')

  const sessionsPageSrc = readFileSync(
    new URL('../src/renderer/src/pages/SessionsPage.tsx', import.meta.url),
    'utf8'
  )
  assert.match(sessionsPageSrc, /setSendNote\(result\.error \|\| 'Not visible in the session yet'\)/)

  const appCtxSrc = readFileSync(
    new URL('../src/renderer/src/state/AppContext.tsx', import.meta.url),
    'utf8'
  )
  assert.match(appCtxSrc, /result\.code === 'claude-open-in-app'/)
  assert.match(appCtxSrc, /if \(result\.status === 'queued'\) return/)
})
