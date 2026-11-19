import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'

async function loadSource(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  const typeOnly = source.replace(/import type \{[^}]*\} from '[^']*'/g, '')
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(typeOnly)).toString('base64')}`)
}

const qa = await loadSource('../src/shared/questionAnswers.ts')

const singleStep = [
  {
    id: 'db',
    title: 'Which database should we use?',
    options: [
      { label: 'PostgreSQL', description: 'Managed relational DB' },
      { label: 'MySQL', description: 'Standard SQL' },
      { label: 'MongoDB', description: 'Document store' },
      { label: 'DynamoDB', description: 'Key-value cloud store' }
    ],
    multiSelect: false
  }
]

const multiStep = [
  singleStep[0],
  {
    id: 'features',
    title: 'Which features should be enabled?',
    options: [
      { label: 'Auth', description: 'OAuth login' },
      { label: 'Caching', description: 'Edge cache' }
    ],
    multiSelect: true
  },
  {
    id: 'confirm',
    title: 'Apply migration immediately?',
    options: [
      { label: 'Yes', description: '' },
      { label: 'No', description: '' }
    ],
    multiSelect: false,
    allowCustom: false
  }
]

test('normalizeQuestionResponse supports legacy index arrays and single-select custom text', () => {
  assert.deepEqual(qa.normalizeQuestionResponse(singleStep, [1]), [{ choices: [1] }])
  assert.deepEqual(qa.normalizeQuestionResponse(singleStep, [[2]]), [{ choices: [2] }])
  assert.deepEqual(
    qa.normalizeQuestionResponse(singleStep, [{ choices: [], customText: '  SQLite with WAL mode  ' }]),
    [{ choices: [], customText: 'SQLite with WAL mode' }]
  )
  // Single-select custom text takes precedence over any stray preset index.
  assert.deepEqual(
    qa.normalizeQuestionResponse(singleStep, [{ choices: [0], customText: 'DuckDB' }]),
    [{ choices: [], customText: 'DuckDB' }]
  )
})

test('normalizeQuestionResponse supports multi-select combining preset options and custom text', () => {
  const answers = qa.normalizeQuestionResponse(multiStep, [
    { choices: [], customText: 'SQLite' },
    { choices: [0], customText: 'Rate limiting' },
    { choices: [0] }
  ])
  assert.deepEqual(answers, [
    { choices: [], customText: 'SQLite' },
    { choices: [0], customText: 'Rate limiting' },
    { choices: [0] }
  ])
  assert.deepEqual(qa.stepAnswerTexts(multiStep[0], answers[0]), ['SQLite'])
  assert.deepEqual(qa.stepAnswerTexts(multiStep[1], answers[1]), ['Auth', 'Rate limiting'])
  assert.deepEqual(qa.stepAnswerDetailedTexts(multiStep[1], answers[1]), [
    'Auth (OAuth login)',
    'Rate limiting'
  ])
  assert.equal(
    qa.summarizeQuestionAnswers(multiStep, answers),
    'SQLite · Auth | Rate limiting · Yes'
  )
})

test('normalizeQuestionResponse rejects empty answers and custom text when allowCustom is false', () => {
  assert.throws(
    () => qa.normalizeQuestionResponse(singleStep, [{ choices: [], customText: '   ' }]),
    /Pick an option or type an answer/
  )
  assert.throws(
    () =>
      qa.normalizeQuestionResponse(multiStep, [
        { choices: [0] },
        { choices: [1] },
        { choices: [], customText: 'Maybe later' }
      ]),
    /Pick one of the listed options/
  )
})

test('all coding providers and both question UIs wire custom answers cleanly', () => {
  const agentStatusSrc = readFileSync(new URL('../src/main/agentStatus.ts', import.meta.url), 'utf8')
  // Anti Gravity write-in protobuf field
  assert.match(agentStatusSrc, /writeInResponse/)
  // Claude PermissionRequest + PreToolUse & Cursor/Gemini/Cline use stepAnswerTexts / stepAnswerDetailedTexts
  assert.match(agentStatusSrc, /stepAnswerTexts\(step, stepAnswer\)/)
  assert.match(agentStatusSrc, /stepAnswerDetailedTexts\(step, stepAnswer\)/)
  // HTTP /decision endpoint accepts structured answers and customText
  assert.match(agentStatusSrc, /Array\.isArray\(body\.answers\)/)
  assert.match(agentStatusSrc, /typeof body\.customText === 'string'/)

  const openCodeSrc = readFileSync(new URL('../src/main/openCodeApprovals.ts', import.meta.url), 'utf8')
  assert.match(openCodeSrc, /allowCustom: false/)

  const appCtxSrc = readFileSync(new URL('../src/renderer/src/state/AppContext.tsx', import.meta.url), 'utf8')
  assert.match(appCtxSrc, /normalizeQuestionResponse\(stepList, response\)/)
  assert.match(appCtxSrc, /stepAnswerTexts\(step, normalized\[sIdx\]/)

  const collapsedSrc = readFileSync(
    new URL('../src/renderer/src/components/CollapsedQuestion.tsx', import.meta.url),
    'utf8'
  )
  assert.match(collapsedSrc, /Type your own answer/)
  assert.match(collapsedSrc, /data-demo-question-row=\{index\}/)
  assert.match(collapsedSrc, /data-demo-question-send="true"/)

  const expandedSrc = readFileSync(
    new URL('../src/renderer/src/components/AgentStatus.tsx', import.meta.url),
    'utf8'
  )
  assert.match(expandedSrc, /Type your own answer/)
})
