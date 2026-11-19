import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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

// Every reader resolves its store from APPDATA at call time, so a temporary
// application-data folder is enough to exercise the editor shapes.
const appData = await mkdtemp(path.join(tmpdir(), 'notch-editor-sessions-'))
const realAppData = process.env.APPDATA
process.env.APPDATA = appData
const scanners = await loadSource('../src/main/sessionScanners.ts')

test.after(async () => {
  process.env.APPDATA = realAppData
  await rm(appData, { recursive: true, force: true })
})

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value))
}

async function scanWith(root) {
  process.env.APPDATA = root
  try {
    return await scanners.scanEditorSessions()
  } finally {
    process.env.APPDATA = appData
  }
}

async function makeCursor(root, { composers, headers, cloud }) {
  const globalDir = path.join(root, 'Cursor', 'User', 'globalStorage')
  await mkdir(globalDir, { recursive: true })
  const db = new DatabaseSync(path.join(globalDir, 'state.vscdb'))
  db.exec('create table cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)')
  db.exec(
    'create table composerHeaders (composerId TEXT, isArchived INTEGER, isSubagent INTEGER, subagentTypeName TEXT)'
  )
  for (const [key, value] of Object.entries(composers)) {
    db.prepare('insert into cursorDiskKV (key, value) values (?, ?)').run(key, JSON.stringify(value))
  }
  for (const header of headers) {
    db.prepare('insert into composerHeaders values (?, ?, ?, ?)').run(
      header.composerId,
      header.isArchived ?? 0,
      header.isSubagent ?? 0,
      header.subagentTypeName ?? ''
    )
  }
  db.close()

  const search = new DatabaseSync(path.join(globalDir, 'conversation-search.db'))
  search.exec(
    'create table conversations (id TEXT, title TEXT, updated_at INTEGER, is_archived INTEGER, source TEXT)'
  )
  for (const row of cloud) {
    search.prepare('insert into conversations values (?, ?, ?, ?, ?)').run(
      row.id,
      row.title,
      row.updated_at,
      0,
      row.source ?? 'cloud-cache'
    )
  }
  search.close()
}

test('Cursor composers keep their real title, folder and timestamp', async () => {
  const root = path.join(appData, 'cursor-root')
  await makeCursor(root, {
    composers: {
      'composerData:aaa': {
        composerId: 'aaa',
        name: 'Fix the glow recording',
        createdAt: 1760000000000,
        lastUpdatedAt: 1763000000000,
        workspaceIdentifier: { uri: { fsPath: 'c:\\projects\\notch' } }
      },
      'composerData:bbb': {
        composerId: 'bbb',
        name: 'Archived chat',
        lastUpdatedAt: 1763000000000
      },
      'composerData:draft-1': { composerId: 'draft-1', name: '' }
    },
    headers: [
      { composerId: 'aaa' },
      { composerId: 'bbb', isArchived: 1 },
      { composerId: 'sub-1', isSubagent: 1, subagentTypeName: 'review' },
      { composerId: 'draft-1' }
    ],
    cloud: [
      { id: 'bc-cloud', title: 'Cloud planning chat', updated_at: 1762000000000 },
      { id: 'bc-untitled', title: '', updated_at: 1762000000000 }
    ]
  })

  const rows = (await scanWith(root)).filter((row) => row.provider === 'cursor')
  const byId = new Map(rows.map((row) => [row.rawId, row]))

  assert.equal(byId.get('aaa')?.title, 'Fix the glow recording')
  assert.equal(byId.get('aaa')?.project, 'notch')
  assert.equal(byId.get('aaa')?.updatedAt, 1763000000000)
  assert.ok(!byId.has('bbb'), 'an archived composer must not be listed')
  assert.ok(!byId.has('draft-1'), 'a nameless draft must not be listed')
  assert.equal(byId.get('bc-cloud')?.title, 'Cloud planning chat')
  assert.equal(byId.get('bc-cloud')?.detail, 'Cloud')
  assert.ok(!byId.has('bc-untitled'), 'an untitled cloud row adds nothing')
})

test('VS Code chats come from workspaceStorage/chatSessions with their folder', async () => {
  const root = path.join(appData, 'vscode-root')
  const workspace = path.join(root, 'Code', 'User', 'workspaceStorage', 'ws1')
  await writeJson(path.join(workspace, 'workspace.json'), { folder: 'file:///c%3A/projects%2Fdemo' })
  await writeJson(path.join(workspace, 'chatSessions', 's1.json'), {
    sessionId: 's1',
    customTitle: 'Write the release notes',
    lastMessageDate: 1765000000000,
    requests: [{ message: { text: 'first prompt' } }]
  })
  await writeJson(path.join(workspace, 'chatSessions', 's2.json'), {
    sessionId: 's2',
    creationDate: 1764000000000,
    requests: [{ message: { text: 'Explain the build pipeline' } }]
  })

  const rows = (await scanWith(root)).filter((row) => row.provider === 'vscode')
  const byId = new Map(rows.map((row) => [row.rawId, row]))

  assert.equal(byId.get('s1')?.title, 'Write the release notes')
  assert.equal(byId.get('s1')?.project, 'demo')
  assert.equal(byId.get('s1')?.updatedAt, 1765000000000)
  assert.equal(byId.get('s2')?.title, 'Explain the build pipeline')
  assert.equal(rows[0].rawId, 's1', 'newest chat first')
})

test('Trae, Qoder and Kiro read the same store shape under their own provider', async () => {
  const root = path.join(appData, 'forks-root')
  for (const [dir, provider] of [
    ['Trae', 'trae'],
    ['Qoder', 'qoder'],
    ['Kiro', 'kiro']
  ]) {
    const store = path.join(root, dir, 'User', 'workspaceStorage', 'ws', 'chatSessions')
    await writeJson(path.join(store, 'chat.json'), {
      sessionId: `${provider}-1`,
      customTitle: `${provider} session`,
      lastMessageDate: 1766000000000
    })
  }

  const rows = await scanWith(root)
  const providers = new Set(rows.map((row) => row.provider))
  for (const provider of ['trae', 'qoder', 'kiro']) assert.ok(providers.has(provider), provider)
  assert.equal(rows.find((row) => row.rawId === 'trae-1')?.origin, 'Trae')
})

test('a corrupt or unknown store contributes nothing instead of throwing', async () => {
  const root = path.join(appData, 'broken-root')
  const workspace = path.join(root, 'Code', 'User', 'workspaceStorage', 'ws')
  await mkdir(path.join(workspace, 'chatSessions'), { recursive: true })
  await writeFile(path.join(workspace, 'chatSessions', 'bad.json'), '{not json')
  await writeFile(path.join(workspace, 'workspace.json'), 'nope')
  await mkdir(path.join(root, 'Cursor', 'User', 'globalStorage'), { recursive: true })
  const db = new DatabaseSync(path.join(root, 'Cursor', 'User', 'globalStorage', 'state.vscdb'))
  db.exec('create table unrelated (x TEXT)')
  db.close()

  const rows = await scanWith(root)
  assert.equal(rows.filter((row) => row.provider === 'vscode').length, 0)
  assert.equal(rows.filter((row) => row.provider === 'cursor').length, 0)
})
