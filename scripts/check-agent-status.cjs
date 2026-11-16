const fs = require('node:fs')
const { stripTypeScriptTypes } = require('node:module')
const assert = require('node:assert/strict')

async function main() {
  const source = stripTypeScriptTypes(fs.readFileSync('src/main/agentStatus.ts', 'utf8'))
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  const token = 'a'.repeat(48)
  const port = 17432
  mod.agentStatusStart(port, token)
  try {
    const base = `http://127.0.0.1:${port}`
    const post = (path, body = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Notch-Token': token },
        body: JSON.stringify(body)
      })

    assert.equal((await fetch(base + '/status')).status, 401, 'token is required')

    assert.equal(
      (await post('/hook?tool=claude&kind=working', { tool_name: 'Bash', command: 'npm test' })).status,
      204
    )
    assert.equal(mod.snapshot().statuses[0].state, 'working')
    assert.equal(mod.snapshot().statuses[0].title, 'Bash')

    assert.equal((await post('/hook?tool=codex&kind=done', { status: 'completed' })).status, 204)
    assert.equal(mod.snapshot().statuses.find((s) => s.tool === 'codex').state, 'done')

    const cursorHold = post('/hook?tool=cursor&kind=permission', {
      tool_name: 'Shell',
      command: 'rm -rf build'
    })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(mod.snapshot().pending.length, 1, 'a permission request is held')
    const cursorId = mod.snapshot().pending[0].id
    mod.decide(cursorId, 'allow')
    const cursorReply = await (await cursorHold).json()
    assert.equal(cursorReply.permission, 'allow')
    assert.equal(mod.snapshot().pending.length, 0)
    assert.equal(mod.snapshot().statuses.find((s) => s.tool === 'cursor').state, 'working')

    const claudeHold = post('/hook?tool=claude&kind=permission', { tool_name: 'Write' })
    await new Promise((r) => setTimeout(r, 150))
    const claudeId = mod.snapshot().pending[0].id
    mod.decide(claudeId, 'deny')
    const claudeReply = await (await claudeHold).json()
    assert.equal(claudeReply.hookSpecificOutput.permissionDecision, 'deny')

    const codexHold = post('/hook?tool=codex&kind=permission', { tool_name: 'Bash' })
    await new Promise((r) => setTimeout(r, 150))
    const codexId = mod.snapshot().pending[0].id
    mod.decide(codexId, 'allow')
    const codexReply = await (await codexHold).json()
    assert.equal(codexReply.hookSpecificOutput.decision.behavior, 'allow')

    const status = await (await fetch(base + '/status', { headers: { 'X-Notch-Token': token } })).json()
    assert(status.running && status.statuses.length === 3)
    assert(mod.setupSnippet('claude', port, token).includes('UserPromptSubmit'))
    console.log('PASS local hook bridge: token, status events, held permissions, per-tool decisions, setup snippets.')
  } finally {
    mod.agentStatusStop()
  }
  console.log('PASS bridge stopped cleanly.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
