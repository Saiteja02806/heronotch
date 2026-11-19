const fs = require('node:fs')
const { stripTypeScriptTypes } = require('node:module')
const assert = require('node:assert/strict')

async function main() {
  const qaSource = stripTypeScriptTypes(fs.readFileSync('src/shared/questionAnswers.ts', 'utf8'))
  const qaUrl = 'data:text/javascript;base64,' + Buffer.from(qaSource).toString('base64')
  const source = stripTypeScriptTypes(fs.readFileSync('src/main/agentStatus.ts', 'utf8')).replaceAll(
    "'../shared/questionAnswers'",
    `'${qaUrl}'`
  )
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

    const claudePrAllowHold = post('/hook?tool=claude&kind=permission', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    })
    await new Promise((r) => setTimeout(r, 150))
    mod.decide(mod.snapshot().pending[0].id, 'allow')
    const claudePrAllow = await (await claudePrAllowHold).json()
    assert.equal(claudePrAllow.hookSpecificOutput.hookEventName, 'PermissionRequest')
    assert.equal(claudePrAllow.hookSpecificOutput.decision.behavior, 'allow')

    const claudePrDenyHold = post('/hook?tool=claude&kind=permission', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' }
    })
    await new Promise((r) => setTimeout(r, 150))
    mod.decide(mod.snapshot().pending[0].id, 'deny')
    const claudePrDeny = await (await claudePrDenyHold).json()
    assert.equal(claudePrDeny.hookSpecificOutput.hookEventName, 'PermissionRequest')
    assert.equal(claudePrDeny.hookSpecificOutput.decision.behavior, 'deny')

    const cursorShellHold = post('/hook?tool=cursor&kind=permission', {
      hook_event_name: 'beforeShellExecution',
      command: 'pnpm test'
    })
    await new Promise((r) => setTimeout(r, 150))
    mod.decide(mod.snapshot().pending[0].id, 'allow')
    const cursorShellReply = await (await cursorShellHold).json()
    assert.equal(cursorShellReply.continue, true)
    assert.equal(cursorShellReply.permission, 'allow')

    const geminiAllowHold = post('/hook?tool=gemini&kind=permission', {
      hook_event_name: 'BeforeTool',
      tool_name: 'read_file'
    })
    await new Promise((r) => setTimeout(r, 150))
    mod.decide(mod.snapshot().pending[0].id, 'allow')
    const geminiAllowReply = await (await geminiAllowHold).json()
    assert.equal(geminiAllowReply.decision, 'allow')

    const codexHold = post('/hook?tool=codex&kind=permission', { tool_name: 'Bash' })
    await new Promise((r) => setTimeout(r, 150))
    const codexId = mod.snapshot().pending[0].id
    mod.decide(codexId, 'allow')
    const codexReply = await (await codexHold).json()
    assert.equal(codexReply.hookSpecificOutput.decision.behavior, 'allow')

    const geminiHold = post('/hook?tool=gemini&kind=permission', { tool_name: 'write_file' })
    await new Promise((r) => setTimeout(r, 150))
    mod.decide(mod.snapshot().pending[0].id, 'deny')
    const geminiReply = await (await geminiHold).json()
    assert.equal(geminiReply.decision, 'deny')
    assert.match(geminiReply.reason, /Denied in Notch/)

    const clineHold = post('/hook?tool=cline&kind=permission', {
      preToolUse: { toolName: 'run_commands', parameters: JSON.stringify({ command: 'npm test' }) }
    })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(mod.snapshot().pending[0].title, 'run_commands')
    mod.decide(mod.snapshot().pending[0].id, 'allow')
    const clineReply = await (await clineHold).json()
    assert.equal(clineReply.cancel, false)

    const copilotHold = post('/hook?tool=copilot&kind=permission', {
      toolName: 'bash',
      tool_args: { command: 'git status' }
    })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(mod.snapshot().pending[0].title, 'bash')
    mod.decide(mod.snapshot().pending[0].id, 'allow')
    const copilotReply = await (await copilotHold).json()
    assert.equal(copilotReply.hookSpecificOutput.permissionDecision, 'allow')

    const status = await (await fetch(base + '/status', { headers: { 'X-Notch-Token': token } })).json()
    assert(status.running && status.statuses.length === 6)
    const claudeSnippet = mod.setupSnippet('claude', port, token)
    const codexSnippet = mod.setupSnippet('codex', port, token)
    const clineSnippet = mod.setupSnippet('cline', port, token)
    assert(claudeSnippet.includes('UserPromptSubmit'))
    assert(claudeSnippet.includes('PermissionRequest'))
    assert(!claudeSnippet.includes('PreToolUse'))
    assert.equal(mod.isNotchHookEntry(JSON.parse(claudeSnippet).hooks.PermissionRequest[0]), true)
    assert.equal(
      mod.isNotchHookEntry({ hooks: [{ type: 'command', command: 'echo custom-user-hook' }] }),
      false
    )
    assert(mod.setupSnippet('cursor', port, token).includes('preToolUse'))
    assert(mod.setupSnippet('gemini', port, token).includes('BeforeTool'))
    assert(clineSnippet.includes('PreToolUse'))
    assert(clineSnippet.includes('UserPromptSubmit.ps1'))
    assert(clineSnippet.includes('TaskComplete.ps1'))
    assert(!clineSnippet.includes('# powershell '))
    assert(codexSnippet.includes('[features]'))
    assert(codexSnippet.includes('hooks = true'))
    assert(codexSnippet.includes('[[hooks.UserPromptSubmit]]'))
    assert(codexSnippet.includes('[[hooks.PermissionRequest]]'))
    assert(codexSnippet.includes('[[hooks.Stop]]'))
    assert(mod.setupSnippet('copilot', port, token).includes('PreToolUse'))

    // Verify the generated PowerShell hook preserves UTF-8 across stdin -> loopback POST -> stdout.
    const { spawn } = require('node:child_process')
    const parsedClaude = JSON.parse(claudeSnippet)
    const cmdLine = parsedClaude.hooks.UserPromptSubmit[0].hooks[0].command
    const b64 = cmdLine.split('-EncodedCommand ')[1]
    assert(b64, 'expected -EncodedCommand in generated hook')
    const psResult = await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', b64], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('powershell hook timed out'))
      }, 8000)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', (err) => { clearTimeout(timer); reject(err) })
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
      child.stdin.end(Buffer.from(JSON.stringify({ tool_name: 'Write', prompt: 'Plan — résumé' }), 'utf8'))
    })
    assert.equal(psResult.code, 0, `powershell hook exited ${psResult.code}: ${psResult.stderr}`)
    assert.equal(mod.snapshot().statuses.find((s) => s.tool === 'claude').detail, 'Plan — résumé')

    // Also verify the Cline Windows .ps1 block executes directly under PowerShell with UTF-8.
    const clineMatch = clineSnippet.match(/# --- UserPromptSubmit\.ps1 ---\n([\s\S]*?)\n\n# --- PreToolUse\.ps1 ---/)
    assert(clineMatch && clineMatch[1], 'expected runnable UserPromptSubmit.ps1 script in cline snippet')
    const clinePs = await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', clineMatch[1].replace(/\n/g, ';')], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let stderr = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('cline hook timed out')) }, 8000)
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', (err) => { clearTimeout(timer); reject(err) })
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }) })
      child.stdin.end(Buffer.from(JSON.stringify({ tool_name: 'edit_file', task: 'UTF-8 café' }), 'utf8'))
    })
    assert.equal(clinePs.code, 0, `cline powershell hook exited ${clinePs.code}: ${clinePs.stderr}`)
    assert.equal(mod.snapshot().statuses.find((s) => s.tool === 'cline').detail, 'UTF-8 café')
    console.log('PASS local hook bridge: token, status events, held permissions, per-tool decisions, setup snippets, UTF-8 PowerShell + Cline hooks.')
  } finally {
    mod.agentStatusStop()
  }
  console.log('PASS bridge stopped cleanly.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
