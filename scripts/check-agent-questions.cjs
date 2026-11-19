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
  const token = 'b'.repeat(48)
  const port = 17433
  mod.agentStatusStart(port, token)
  try {
    const base = `http://127.0.0.1:${port}`
    const post = (path, body = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Notch-Token': token },
        body: JSON.stringify(body)
      })

    // A real Claude Code AskUserQuestion PreToolUse payload.
    const askUser = {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Which database should the project use?',
            header: 'Database',
            multiSelect: false,
            options: [
              { label: 'Postgres', description: 'Full relational database, needs a server' },
              { label: 'SQLite', description: 'Zero setup, single file' },
              { label: 'DynamoDB', description: 'Serverless key-value on AWS' },
              { label: 'Let Claude decide', description: '' }
            ]
          }
        ]
      }
    }

    // It rides the ordinary permission hook — no settings change needed.
    const hold = post('/hook?tool=claude&kind=permission', askUser)
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(mod.snapshot().pending.length, 0, 'a question is not an approve/deny item')
    const questions = mod.snapshot().questions
    assert.equal(questions.length, 1, 'the question is held')
    const question = questions[0]
    assert.equal(question.tool, 'claude')
    assert.equal(question.title, 'Which database should the project use?')
    assert.equal(question.multiSelect, false)
    assert.equal(question.options.length, 4)
    assert.equal(question.options[1].label, 'SQLite')
    assert.equal(question.options[1].description, 'Zero setup, single file')

    // The user taps "SQLite" in the notch; the held hook reply carries the answer.
    const decideRes = await post('/decision', { id: question.id, choice: [1] })
    assert.equal(decideRes.status, 204)
    const reply = await (await hold).json()
    assert.equal(reply.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.equal(reply.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(reply.hookSpecificOutput.permissionDecisionReason, /SQLite/)
    assert.match(reply.hookSpecificOutput.permissionDecisionReason, /Zero setup/)
    assert.equal(mod.snapshot().questions.length, 0)
    const answered = mod.snapshot().statuses.find((s) => s.tool === 'claude')
    assert.match(answered.title, /Answered in Notch: SQLite/)

    // An explicit question hook with generic string options also works.
    const genericHold = post('/hook?tool=codex&kind=question', {
      title: 'Pick a color',
      options: ['red', 'green', 'blue']
    })
    await new Promise((r) => setTimeout(r, 150))
    const generic = mod.snapshot().questions[0]
    assert.equal(generic.options.length, 3)
    assert.equal(generic.options[0].label, 'red')
    await post('/decision', { id: generic.id, choice: [2] })
    const genericReply = await (await genericHold).json()
    assert.equal(genericReply.hookSpecificOutput.decision.behavior, 'deny')
    assert.match(genericReply.hookSpecificOutput.decision.message, /blue/)

    // Multi-select: several options in one answer, joined in order.
    const multiHold = post('/hook?tool=claude&kind=permission', {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Which extras to include?',
            multiSelect: true,
            options: [
              { label: 'Linting', description: '' },
              { label: 'CI', description: '' },
              { label: 'Docker', description: '' }
            ]
          }
        ]
      }
    })
    await new Promise((r) => setTimeout(r, 150))
    const multi = mod.snapshot().questions[0]
    assert.equal(multi.multiSelect, true)
    await post('/decision', { id: multi.id, choice: [0, 2] })
    const multiReply = await (await multiHold).json()
    assert.match(multiReply.hookSpecificOutput.permissionDecisionReason, /Linting/)
    assert.doesNotMatch(multiReply.hookSpecificOutput.permissionDecisionReason, /CI/)
    assert.match(multiReply.hookSpecificOutput.permissionDecisionReason, /Docker/)

    // Releasing the hold answers with {} so the tool asks in its own window.
    const skipHold = post('/hook?tool=claude&kind=permission', askUser)
    await new Promise((r) => setTimeout(r, 150))
    const skip = mod.snapshot().questions[0]
    await post('/decision', { id: skip.id, release: true })
    const skipReply = await (await skipHold).json()
    assert.deepEqual(skipReply, {}, 'release answers with an empty object')
    assert.equal(mod.snapshot().questions.length, 0)

    // Approve/deny permissions are untouched by the question flow.
    const permHold = post('/hook?tool=claude&kind=permission', { tool_name: 'Write', file_path: 'x.ts' })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(mod.snapshot().pending.length, 1)
    const permId = mod.snapshot().pending[0].id
    mod.decide(permId, 'allow')
    const permReply = await (await permHold).json()
    assert.equal(permReply.hookSpecificOutput.permissionDecision, 'allow')

    // Bad answers are rejected while the question is still held.
    const badHold = post('/hook?tool=claude&kind=permission', askUser)
    await new Promise((r) => setTimeout(r, 150))
    const bad = mod.snapshot().questions[0]
    assert.equal((await post('/decision', { id: bad.id, choice: [99] })).status, 409)
    assert.equal(mod.snapshot().questions.length, 1, 'the question stays held after a bad choice')
    assert.equal((await post('/decision', { id: bad.id, reply: 'allow' })).status, 409)
    mod.decideQuestion(bad.id, [1])
    const badReply = await (await badHold).json()
    assert.match(badReply.hookSpecificOutput.permissionDecisionReason, /SQLite/)

    // Codex request_user_input payload with JSON-encoded arguments.
    const codexAskHold = post('/hook?tool=codex&kind=permission', {
      name: 'request_user_input_async',
      arguments: JSON.stringify({
        questions: [
          {
            title: 'Which test runner should Codex use?',
            options: ['Vitest', 'Node test runner']
          }
        ]
      })
    })
    await new Promise((r) => setTimeout(r, 150))
    const codexQ = mod.snapshot().questions[0]
    assert.equal(codexQ.tool, 'codex')
    assert.equal(codexQ.options.length, 2)
    await post('/decision', { id: codexQ.id, choice: [0] })
    const codexAskReply = await (await codexAskHold).json()
    assert.equal(codexAskReply.hookSpecificOutput.hookEventName, 'PermissionRequest')
    assert.equal(codexAskReply.hookSpecificOutput.decision.behavior, 'deny')
    assert.match(codexAskReply.hookSpecificOutput.decision.message, /Vitest/)

    // Cursor preToolUse AskQuestion payload shape (prompt + allow_multiple).
    const cursorAskHold = post('/hook?tool=cursor&kind=permission', {
      tool_name: 'ask_question',
      tool_input: {
        title: 'Build checks',
        questions: [
          {
            id: 'q1',
            prompt: 'Which checks should Cursor run?',
            allow_multiple: true,
            options: [
              { id: 'o1', label: 'Typecheck' },
              { id: 'o2', label: 'Lint' }
            ]
          }
        ]
      }
    })
    await new Promise((r) => setTimeout(r, 150))
    const cursorQ = mod.snapshot().questions[0]
    assert.equal(cursorQ.tool, 'cursor')
    assert.equal(cursorQ.title, 'Which checks should Cursor run?')
    assert.equal(cursorQ.multiSelect, true)
    assert.equal(cursorQ.options.length, 2)
    await post('/decision', { id: cursorQ.id, choice: [0, 1] })
    const cursorAskReply = await (await cursorAskHold).json()
    assert.equal(cursorAskReply.permission, 'deny')
    assert.match(cursorAskReply.user_message, /Typecheck \| Lint/)

    // Gemini CLI BeforeTool question shape.
    const geminiAskHold = post('/hook?tool=gemini&kind=permission', {
      tool_name: 'ask_user',
      tool_input: {
        question: 'Which build mode should Gemini use?',
        options: ['Production', 'Development']
      }
    })
    await new Promise((r) => setTimeout(r, 150))
    const geminiQ = mod.snapshot().questions[0]
    assert.equal(geminiQ.tool, 'gemini')
    assert.equal(geminiQ.title, 'Which build mode should Gemini use?')
    await post('/decision', { id: geminiQ.id, choice: [0] })
    const geminiAskReply = await (await geminiAskHold).json()
    assert.equal(geminiAskReply.decision, 'deny')
    assert.match(geminiAskReply.reason, /Production/)

    // Cline ask_followup_question via VS Code extension PreToolUse shape (stringified parameters + stringified options).
    const clineAskHold = post('/hook?tool=cline&kind=permission', {
      preToolUse: {
        toolName: 'ask_followup_question',
        parameters: JSON.stringify({
          question: 'Which framework should Cline scaffold?',
          options: JSON.stringify(['Next.js', 'Vite React'])
        })
      }
    })
    await new Promise((r) => setTimeout(r, 150))
    const clineQ = mod.snapshot().questions[0]
    assert.equal(clineQ.tool, 'cline')
    assert.equal(clineQ.title, 'Which framework should Cline scaffold?')
    assert.equal(clineQ.options[1].label, 'Vite React')
    await post('/decision', { id: clineQ.id, choice: [1] })
    const clineAskReply = await (await clineAskHold).json()
    assert.equal(clineAskReply.cancel, true)
    assert.match(clineAskReply.errorMessage, /Vite React/)

    // Copilot PreToolUse question shape (tool_args).
    const copilotAskHold = post('/hook?tool=copilot&kind=permission', {
      toolName: 'ask_questions',
      tool_args: {
        questions: [
          {
            question: 'Deploy target?',
            options: ['Staging', 'Production']
          }
        ]
      }
    })
    await new Promise((r) => setTimeout(r, 150))
    const copilotQ = mod.snapshot().questions[0]
    assert.equal(copilotQ.tool, 'copilot')
    await post('/decision', { id: copilotQ.id, choice: [0] })
    const copilotAskReply = await (await copilotAskHold).json()
    assert.equal(copilotAskReply.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(copilotAskReply.hookSpecificOutput.permissionDecisionReason, /Staging/)

    // Anti Gravity PreToolUse ask_question payload shape (toolCall.args + is_multi_select).
    const agAskHold = post('/hook?tool=antigravity&kind=permission', {
      hookEventName: 'PreToolUse',
      toolCall: {
        id: 'tc_ag_1',
        name: 'ask_question',
        args: {
          questions: [
            {
              question: 'Which Notch mode do you prefer?',
              is_multi_select: false,
              options: ['(Recommended) Compact pill', 'Micro notch']
            },
            {
              question: 'Which providers should be enabled?',
              is_multi_select: true,
              options: ['Anti Gravity', 'Codex', 'Claude Code']
            }
          ]
        }
      }
    })
    await new Promise((r) => setTimeout(r, 150))
    const agQ = mod.snapshot().questions[0]
    assert.equal(agQ.tool, 'antigravity')
    assert.equal(agQ.title, 'Which Notch mode do you prefer?')
    assert.equal(agQ.steps.length, 2, 'multi-step question preserves all steps')
    assert.equal(agQ.steps[0].multiSelect, false)
    assert.equal(agQ.steps[0].options.length, 2)
    assert.equal(agQ.steps[1].title, 'Which providers should be enabled?')
    assert.equal(agQ.steps[1].multiSelect, true)
    assert.equal(agQ.steps[1].options.length, 3)
    await post('/decision', { id: agQ.id, choices: [[0], [0, 1]] })
    const agAskReply = await (await agAskHold).json()
    assert.equal(agAskReply.decision, 'deny')
    assert.match(agAskReply.reason, /Which Notch mode do you prefer\?/)
    assert.match(agAskReply.reason, /Compact pill/)
    assert.match(agAskReply.reason, /Which providers should be enabled\?/)
    assert.match(agAskReply.reason, /Anti Gravity \| Codex/)
    const agStatus = mod.snapshot().statuses.find((s) => s.tool === 'antigravity')
    assert.match(agStatus.title, /Answered in Notch: .*Compact pill · Anti Gravity \| Codex/)

    // OpenCode /question client: 404 fallback returns [] and /question endpoints parse + reply/reject.
    const http = require('node:http')
    const ocSource = stripTypeScriptTypes(fs.readFileSync('src/main/openCodeApprovals.ts', 'utf8'))
    const ocMod = await import('data:text/javascript;base64,' + Buffer.from(ocSource).toString('base64'))
    let ocMode = '404'
    let lastAnswers = null
    let rejectedId = null
    const ocServer = http.createServer((req, res) => {
      if (req.url === '/question' && req.method === 'GET') {
        if (ocMode === '404') {
          res.writeHead(404).end('Not found')
          return
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify([
            {
              id: 'q-oc-1',
              sessionID: 'ses_1',
              questions: [
                {
                  question: 'Which package manager?',
                  multiple: true,
                  options: [
                    { label: 'npm', description: 'Built-in' },
                    { label: 'pnpm', description: 'Workspace fast' }
                  ]
                }
              ]
            }
          ])
        )
        return
      }
      if (req.url === '/question/q-oc-1/reply' && req.method === 'POST') {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          lastAnswers = JSON.parse(Buffer.concat(chunks).toString('utf8')).answers
          res.setHeader('Content-Type', 'application/json')
          res.end('true')
        })
        return
      }
      if (req.url === '/question/q-oc-1/reject' && req.method === 'POST') {
        rejectedId = 'q-oc-1'
        res.setHeader('Content-Type', 'application/json')
        res.end('true')
        return
      }
      res.writeHead(404).end()
    })
    await new Promise((r) => ocServer.listen(17434, '127.0.0.1', r))
    try {
      const client = ocMod.approvalClient(17434)
      assert.deepEqual(await client.listQuestions(), [], 'missing /question returns [] cleanly')
      ocMode = 'live'
      const ocQuestions = await client.listQuestions()
      assert.equal(ocQuestions.length, 1)
      assert.equal(ocQuestions[0].multiSelect, true)
      assert.equal(ocQuestions[0].title, 'Which package manager?')
      await client.replyQuestion('q-oc-1', [['npm', 'pnpm']])
      assert.deepEqual(lastAnswers, [['npm', 'pnpm']])
      await client.rejectQuestion('q-oc-1')
      assert.equal(rejectedId, 'q-oc-1')
    } finally {
      ocServer.close()
    }

    // Aborting a held question cleans up both questions and its waiting status.
    const ac = new AbortController()
    const abortedHold = fetch(base + '/hook?tool=claude&kind=permission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Notch-Token': token },
      signal: ac.signal,
      body: JSON.stringify(askUser)
    }).catch(() => {})
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(mod.snapshot().questions.length, 1)
    ac.abort()
    await abortedHold
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(mod.snapshot().questions.length, 0)
    assert.equal(
      mod.snapshot().statuses.some((s) => s.tool === 'claude' && s.state === 'waiting'),
      false,
      'aborted question clears its waiting status'
    )

    // Claude PermissionRequest multi-step AskUserQuestion returns native updatedInput.answers.
    const claudePrMultiHold = post('/hook?tool=claude&kind=permission', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Which database should we use?',
            multiSelect: false,
            options: [
              { label: 'Postgres', description: 'Managed SQL' },
              { label: 'SQLite', description: 'Local file' }
            ]
          },
          {
            question: 'Which extras to include?',
            multiSelect: true,
            options: [
              { label: 'Linting', description: '' },
              { label: 'CI', description: '' },
              { label: 'Docker', description: '' }
            ]
          }
        ]
      }
    })
    await new Promise((r) => setTimeout(r, 150))
    const claudePrMultiQ = mod.snapshot().questions[0]
    assert.equal(claudePrMultiQ.tool, 'claude')
    assert.equal(claudePrMultiQ.steps.length, 2)
    await post('/decision', { id: claudePrMultiQ.id, choices: [[0], [0, 2]] })
    const claudePrMultiReply = await (await claudePrMultiHold).json()
    assert.equal(claudePrMultiReply.hookSpecificOutput.hookEventName, 'PermissionRequest')
    assert.equal(claudePrMultiReply.hookSpecificOutput.decision.behavior, 'allow')
    assert.equal(claudePrMultiReply.hookSpecificOutput.decision.updatedInput.questions.length, 2)
    assert.deepEqual(claudePrMultiReply.hookSpecificOutput.decision.updatedInput.answers, {
      'Which database should we use?': 'Postgres',
      'Which extras to include?': 'Linting, Docker'
    })

    // Codex async multi-step question submission over named-pipe IPC.
    if (process.platform === 'win32') {
      const net = require('node:net')
      const testPipe = `\\\\.\\pipe\\notch-codex-ipc-test-${process.pid}`
      const seenMessages = []
      const encodeFrame = (payload) => {
        const json = Buffer.from(JSON.stringify(payload), 'utf8')
        const header = Buffer.allocUnsafe(4)
        header.writeUInt32LE(json.length, 0)
        return Buffer.concat([header, json])
      }
      const pipeServer = net.createServer((socket) => {
        let rx = Buffer.alloc(0)
        socket.on('data', (chunk) => {
          rx = Buffer.concat([rx, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
          while (rx.length >= 4) {
            const len = rx.readUInt32LE(0)
            if (rx.length < 4 + len) break
            const msg = JSON.parse(rx.subarray(4, 4 + len).toString('utf8'))
            rx = rx.subarray(4 + len)
            seenMessages.push(msg)
            if (msg.method === 'initialize') {
              socket.write(encodeFrame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: {} }))
            } else if (msg.method === 'thread-owner-discovery') {
              socket.write(
                encodeFrame({
                  type: 'response',
                  requestId: msg.requestId,
                  resultType: 'success',
                  handledByClientId: 'codex-desktop-client-1',
                  result: {}
                })
              )
            } else if (msg.method === 'thread-follower-start-turn') {
              socket.write(
                encodeFrame({
                  type: 'response',
                  requestId: msg.requestId,
                  resultType: 'success',
                  result: { started: true }
                })
              )
            }
          }
        })
      })
      await new Promise((resolve) => pipeServer.listen(testPipe, resolve))
      const prevPipe = process.env.NOTCH_CODEX_IPC_PIPE
      process.env.NOTCH_CODEX_IPC_PIPE = testPipe
      try {
        const ipcRes = await mod.submitCodexAsyncQuestionReply(
          'thread-uuid-123',
          'call_abc_123',
          [
            { question: 'Step 1 — Feature?' },
            { question: 'Step 2 — Focus?' },
            { question: 'Step 3 — Done?' }
          ],
          [['Google Calendar'], ['Work cleanly'], ['Sounds great']]
        )
        assert.deepEqual(ipcRes, { ok: true, via: 'ipc' })
        const startTurn = seenMessages.find((m) => m.method === 'thread-follower-start-turn')
        assert(startTurn, 'expected thread-follower-start-turn IPC call')
        assert.equal(startTurn.targetClientId, 'codex-desktop-client-1')
        const req = startTurn.params.turnStart.request
        assert.equal(req.threadId, 'thread-uuid-123')
        assert.equal(req.turnTrigger, 'send_user_message_async_question')
        const rawText = req.input[0].text
        const match = rawText.match(/<send_user_message_question_reply>\n([\s\S]*)\n<\/send_user_message_question_reply>/)
        assert(match, 'expected <send_user_message_question_reply> block')
        assert.deepEqual(JSON.parse(match[1]), [
          {
            questionItemId: JSON.stringify(['request_user_input_async', 'call_abc_123', 0]),
            question: 'Step 1 — Feature?',
            answer: 'Google Calendar'
          },
          {
            questionItemId: JSON.stringify(['request_user_input_async', 'call_abc_123', 1]),
            question: 'Step 2 — Focus?',
            answer: 'Work cleanly'
          },
          {
            questionItemId: JSON.stringify(['request_user_input_async', 'call_abc_123', 2]),
            question: 'Step 3 — Done?',
            answer: 'Sounds great'
          }
        ])
      } finally {
        if (prevPipe === undefined) delete process.env.NOTCH_CODEX_IPC_PIPE
        else process.env.NOTCH_CODEX_IPC_PIPE = prevPipe
        pipeServer.close()
      }
    }

    // OpenCode v2 authenticated /api/permission/request, /api/form, /api/session endpoints + service.json discovery.
    const os = require('node:os')
    const path = require('node:path')
    const svcTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-oc-v2-'))
    const svcFile = path.join(svcTmpDir, 'service.json')
    const expectedAuth = 'Basic ' + Buffer.from('opencode:secret-oc-pw').toString('base64')
    fs.writeFileSync(
      svcFile,
      JSON.stringify({ url: 'http://127.0.0.1:17435', pid: process.pid, version: '2.3.0', password: 'secret-oc-pw' })
    )
    let v2PermReply = null
    let v2FormReply = null
    let v2FormCancelled = false
    const ocV2Server = http.createServer((req, res) => {
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ _tag: 'UnauthorizedError' }))
        return
      }
      if (req.url === '/api/info' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ version: '2.3.0', pid: process.pid }))
        return
      }
      if (req.url === '/api/session?limit=12' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: 'ses_v2_1', time: { busy: 20, idle: 10, updated: 20 } }] }))
        return
      }
      if (req.url === '/api/permission/request' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ data: [] }))
        return
      }
      if (req.url === '/api/session/ses_v2_1/permission' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            data: v2PermReply
              ? []
              : [
                  {
                    id: 'per_v2_1',
                    sessionID: 'ses_v2_1',
                    action: 'bash',
                    resources: ['npm test'],
                    metadata: { cwd: 'C:/repo' }
                  }
                ]
          })
        )
        return
      }
      if (req.url === '/api/session/ses_v2_1/permission/per_v2_1/reply' && req.method === 'POST') {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          v2PermReply = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          res.writeHead(204).end()
        })
        return
      }
      if (req.url === '/api/form' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ data: [] }))
        return
      }
      if (req.url === '/api/session/ses_v2_1/form' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            data:
              v2FormReply || v2FormCancelled
                ? []
                : [
                    {
                      id: 'frm_v2_1',
                      sessionID: 'ses_v2_1',
                      title: 'Questions',
                      fields: [
                        {
                          key: 'q0',
                          title: 'Platforms',
                          description: 'Which platforms does Notch support?',
                          type: 'multiselect',
                          options: [
                            { value: 'macos', label: 'macOS', description: 'Apple' },
                            { value: 'windows', label: 'Windows', description: 'PC' }
                          ]
                        },
                        {
                          key: 'q1',
                          title: 'Pricing',
                          description: 'Which pricing model?',
                          type: 'string',
                          options: [
                            { value: 'one_time', label: 'One-time purchase', description: 'Single fee' },
                            { value: 'sub', label: 'Subscription', description: 'Recurring' }
                          ]
                        }
                      ]
                    }
                  ]
          })
        )
        return
      }
      if (req.url === '/api/session/ses_v2_1/form/frm_v2_1/reply' && req.method === 'POST') {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          v2FormReply = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          res.writeHead(204).end()
        })
        return
      }
      if (req.url === '/api/session/ses_v2_1/form/frm_v2_1' && req.method === 'DELETE') {
        v2FormCancelled = true
        res.writeHead(204).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html></html>')
    })
    await new Promise((r) => ocV2Server.listen(17435, '127.0.0.1', r))
    const prevSvc = process.env.NOTCH_OPENCODE_SERVICE_FILE
    process.env.NOTCH_OPENCODE_SERVICE_FILE = svcFile
    try {
      const ocV2Mod = await import(
        'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(fs.readFileSync('src/main/openCodeApprovals.ts', 'utf8'))).toString('base64')
      )
      assert.equal(await ocV2Mod.detectOpenCodePort(), 17435)
      const clientV2 = ocV2Mod.approvalClient(17435)
      const v2Perms = await clientV2.list()
      assert.equal(v2Perms.length, 1)
      assert.equal(v2Perms[0].operation, 'bash')
      await clientV2.decide(v2Perms[0].fingerprint, 'once')
      assert.deepEqual(v2PermReply, { decision: 'once' })

      const v2Forms = await clientV2.listQuestions()
      assert.equal(v2Forms.length, 1)
      assert.equal(v2Forms[0].steps.length, 2)
      assert.equal(v2Forms[0].steps[0].multiSelect, true)
      assert.equal(v2Forms[0].steps[0].title, 'Which platforms does Notch support?')
      await clientV2.replyQuestion('frm_v2_1', [['macOS', 'Windows'], ['One-time purchase']])
      assert.deepEqual(v2FormReply, { answer: { q0: ['macos', 'windows'], q1: 'one_time' } })

      v2FormReply = null
      await clientV2.listQuestions()
      await clientV2.rejectQuestion('frm_v2_1')
      assert.equal(v2FormCancelled, true)
    } finally {
      if (prevSvc === undefined) delete process.env.NOTCH_OPENCODE_SERVICE_FILE
      else process.env.NOTCH_OPENCODE_SERVICE_FILE = prevSvc
      ocV2Server.close()
      fs.rmSync(svcTmpDir, { recursive: true, force: true })
    }

    // Out-of-range options are clamped away; a single-select keeps one choice.
    console.log('PASS questions: AskUserQuestion detection on the permission hook, parsed options,')
    console.log('     answered hook reply carries the choice, multi-select joins, release, plain')
    console.log('     permissions still approve/deny, bad choices rejected while held.')
  } finally {
    mod.agentStatusStop()
  }
  console.log('PASS bridge stopped cleanly.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
