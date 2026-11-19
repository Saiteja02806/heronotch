import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { stripTypeScriptTypes } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

function toDataModule(source, replacements = {}) {
  let code = source.replace(/import type \{[^}]*\} from '[^']*'\r?\n?/g, '')
  for (const [spec, url] of Object.entries(replacements)) {
    code = code.replaceAll(`'${spec}'`, `'${url}'`)
  }
  return `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(code)).toString('base64')}`
}

test('renderer HTML removes verify.js phone-home and ship-or-die origins', () => {
  const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
  assert.equal(html.includes('ship-or-die.com'), false)
  assert.equal(html.includes('verify.js'), false)
})

test('resolveMediaArtDll never returns an app.asar archive path and prefers app.asar.unpacked', async () => {
  const mediaFollowUrl = toDataModule(
    readFileSync(new URL('../src/shared/mediaFollow.ts', import.meta.url), 'utf8')
  )
  const stubStateUrl = 'data:text/javascript,export function getState(){return{settings:{mediaSource:"auto"}}}'
  const localMediaUrl = toDataModule(
    readFileSync(new URL('../src/main/localMedia.ts', import.meta.url), 'utf8'),
    {
      '../shared/mediaFollow': mediaFollowUrl,
      './state': stubStateUrl
    }
  )
  const { resolveMediaArtDll } = await import(localMediaUrl)

  const asarApp = 'C:\\Program Files\\Notch\\resources\\app.asar'
  const unpackedDll = 'C:\\Program Files\\Notch\\resources\\app.asar.unpacked\\resources\\notch-media-art.dll'
  const insideAsarDll = 'C:\\Program Files\\Notch\\resources\\app.asar\\resources\\notch-media-art.dll'

  // Simulate Electron where fs.existsSync returns true for BOTH paths inside/outside app.asar.
  const picked = resolveMediaArtDll(
    asarApp,
    'C:\\Program Files\\Notch\\resources',
    (candidate) => candidate === insideAsarDll || candidate === unpackedDll
  )
  assert.equal(picked, unpackedDll)

  // If only the virtual app.asar path appears to exist, never return it to .NET Assembly.LoadFrom.
  const rejected = resolveMediaArtDll(
    asarApp,
    'C:\\Program Files\\Notch\\resources',
    (candidate) => candidate === insideAsarDll
  )
  assert.equal(rejected, '')
})

test('focus backdrop never blacks out the screen with opaque #000000', () => {
  const liquid = readFileSync(new URL('../src/renderer/src/liquid.css', import.meta.url), 'utf8')
  const focusBlock = liquid.slice(liquid.indexOf('.focus-backdrop {'), liquid.indexOf('.focus-backdrop-image'))
  assert.equal(focusBlock.includes('#000000'), false)
  assert.match(focusBlock, /rgba\(\s*[34],\s*[45],\s*[67],\s*0\.\d+\s*\)/)
})

test('readOpenCodeReply reads OpenCode 2.x session_message and session_v2 tables', async () => {
  const deliveryUrl = toDataModule(
    readFileSync(new URL('../src/main/sessionDelivery.ts', import.meta.url), 'utf8')
  )
  const watchUrl = toDataModule(
    readFileSync(new URL('../src/main/sessionWatch.ts', import.meta.url), 'utf8'),
    { './sessionDelivery': deliveryUrl }
  )
  const watch = await import(watchUrl)
  const dir = await mkdtemp(path.join(tmpdir(), 'notch-watch-oc2-'))
  const dbPath = path.join(dir, 'opencode.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    create table session_v2 (id text primary key, time_busy integer, time_idle integer);
    create table session_message (
      id text primary key, session_id text, type text, seq integer,
      time_created integer, time_updated integer, data text
    );
  `)
  db.prepare('insert into session_v2 (id, time_busy, time_idle) values (?, ?, ?)').run('ses_2x', 1000, 1200)
  db.prepare(
    'insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)'
  ).run('m1', 'ses_2x', 'user', 1, 1000, 1000, JSON.stringify({ text: 'hello' }))
  db.prepare(
    'insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)'
  ).run('m2', 'ses_2x', 'assistant', 2, 1100, 1200, JSON.stringify({ content: [{ type: 'text', text: 'reply' }] }))
  db.close()

  try {
    const result = await watch.readOpenCodeReply(dbPath, 'ses_2x')
    assert.equal(result.ok, true)
    assert.equal(result.cursor.busy, false)
    assert.equal(result.cursor.evidence, 'assistant')
    assert.ok(result.cursor.token.startsWith('oc:1200:'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('spotify fetch helper attaches an AbortSignal timeout and maps TimeoutError cleanly', () => {
  const spotifySrc = readFileSync(new URL('../src/main/spotify.ts', import.meta.url), 'utf8')
  assert.match(spotifySrc, /fetchSpotifyWithTimeout/)
  assert.match(spotifySrc, /AbortSignal\.timeout/)
  assert.equal(spotifySrc.includes('await fetch(\'https://'), false)
})

test('packaged win-unpacked resolves real unpacked notch-media-art.dll and contains no verify.js', async () => {
  const winUnpacked = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', 'release', 'win-unpacked')
  if (!existsSync(winUnpacked)) return

  const mediaFollowUrl = toDataModule(
    readFileSync(new URL('../src/shared/mediaFollow.ts', import.meta.url), 'utf8')
  )
  const stubStateUrl = 'data:text/javascript,export function getState(){return{settings:{mediaSource:"auto"}}}'
  const localMediaUrl = toDataModule(
    readFileSync(new URL('../src/main/localMedia.ts', import.meta.url), 'utf8'),
    { '../shared/mediaFollow': mediaFollowUrl, './state': stubStateUrl }
  )
  const { resolveMediaArtDll } = await import(localMediaUrl)

  const asarPath = path.join(winUnpacked, 'resources', 'app.asar')
  const resourcesPath = path.join(winUnpacked, 'resources')
  const resolved = resolveMediaArtDll(asarPath, resourcesPath)
  assert.equal(
    resolved,
    path.join(resourcesPath, 'app.asar.unpacked', 'resources', 'notch-media-art.dll')
  )
  assert.equal(existsSync(resolved), true)

  const builtHtml = readFileSync(new URL('../out/renderer/index.html', import.meta.url), 'utf8')
  assert.equal(builtHtml.includes('ship-or-die'), false)
  assert.equal(builtHtml.includes('verify.js'), false)
})

test('agent UI and session queue safeguards remain intact', () => {
  const collapsedBar = readFileSync(new URL('../src/renderer/src/components/CollapsedBar.tsx', import.meta.url), 'utf8')
  assert.match(collapsedBar, /const showSessions = detailed && agentCount > 0/)

  const agentStatus = readFileSync(new URL('../src/renderer/src/components/AgentStatus.tsx', import.meta.url), 'utf8')
  assert.match(agentStatus, /pending\.length === 0 && questions\.length === 0/)

  const appCtx = readFileSync(new URL('../src/renderer/src/state/AppContext.tsx', import.meta.url), 'utf8')
  assert.match(appCtx, /openCodeBootstrapped\.current/)

  const sessionsSrc = readFileSync(new URL('../src/main/sessions.ts', import.meta.url), 'utf8')
  assert.match(sessionsSrc, /idx_thread_turns_page|order by rollout_ordinal desc limit 1/)
  assert.match(sessionsSrc, /findCommandOnPath/)
  assert.match(sessionsSrc, /killProcessTree/)
  assert.match(sessionsSrc, /resolveNodeCmdEntry/)
})

test('welcomeSeen defaults false on fresh state, persists true, and ignores corrupt values', async () => {
  const sectionsUrl = toDataModule(
    readFileSync(new URL('../src/shared/sections.ts', import.meta.url), 'utf8')
  )
  const typesUrl = toDataModule(
    readFileSync(new URL('../src/shared/types.ts', import.meta.url), 'utf8')
  )
  const stateSource = readFileSync(new URL('../src/main/state.ts', import.meta.url), 'utf8')

  const loadStateMod = async (userDir, tag) => {
    const electronStub = `data:text/javascript;base64,${Buffer.from(`export const app = { getPath: () => ${JSON.stringify(userDir)} }`).toString('base64')}`
    const modUrl = toDataModule(`${stateSource}\n// ${tag}`, {
      electron: electronStub,
      '../shared/sections': sectionsUrl,
      '../shared/types': typesUrl
    })
    return import(modUrl)
  }

  const freshDir = await mkdtemp(path.join(tmpdir(), 'notch-welcome-fresh-'))
  try {
    const modFresh = await loadStateMod(freshDir, 'fresh')
    const initial = await modFresh.initState()
    assert.equal(initial.settings.welcomeSeen, false)
    assert.equal(initial.settings.launchAtLogin, true)

    modFresh.setState({ settings: { welcomeSeen: true } })
    await modFresh.flushState()

    const persisted = JSON.parse(readFileSync(path.join(freshDir, 'notch-state.json'), 'utf8'))
    assert.equal(persisted.settings.welcomeSeen, true)

    const modReload = await loadStateMod(freshDir, 'reload')
    const reloaded = await modReload.initState()
    assert.equal(reloaded.settings.welcomeSeen, true)

    await writeFile(
      path.join(freshDir, 'notch-state.json'),
      JSON.stringify({ settings: { welcomeSeen: 'corrupt', launchAtLogin: false } }),
      'utf8'
    )
    const modCorrupt = await loadStateMod(freshDir, 'corrupt')
    const normalized = await modCorrupt.initState()
    assert.equal(normalized.settings.welcomeSeen, false)
    assert.equal(normalized.settings.launchAtLogin, false)
  } finally {
    await rm(freshDir, { recursive: true, force: true })
  }

  const demoPath = new URL('../demo/main/index.ts', import.meta.url)
  if (existsSync(demoPath)) {
    const demoSrc = readFileSync(demoPath, 'utf8')
    assert.match(demoSrc, /welcomeSeen:\s*true/)
  }
})

test('welcome animation is finite, leaves idle pill blank, and respects reduce-motion', () => {
  const collapsedBar = readFileSync(new URL('../src/renderer/src/components/CollapsedBar.tsx', import.meta.url), 'utf8')
  assert.match(collapsedBar, /is-welcome/)
  assert.equal(collapsedBar.includes('idle-dot'), false)

  const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
  const start = css.indexOf('.collapsed-bar.is-welcome')
  const end = css.indexOf('/* Stay invisible', start)
  assert.ok(start > 0 && end > start)
  const block = css.slice(start, end)
  assert.match(block, /notch-welcome-pop/)
  assert.match(block, /notch-welcome-glow/)
  assert.match(block, /translateX\(var\(--tab-tx, -50%\)\)/)
  assert.equal(/\binfinite\b/.test(block), false)
  assert.match(block, /prefers-reduced-motion:\s*reduce/)
  assert.match(block, /html\.reduce-motion/)
})

test('resolveForegroundExe prefers app.asar.unpacked and rejects virtual app.asar paths', async () => {
  const foreUrl = toDataModule(
    readFileSync(new URL('../src/main/foreground.ts', import.meta.url), 'utf8')
  )
  const { resolveForegroundExe } = await import(foreUrl)

  const unpackedExe = 'C:\\Program Files\\Notch\\resources\\app.asar.unpacked\\resources\\notch-foreground.exe'
  const asarExe = 'C:\\Program Files\\Notch\\resources\\app.asar\\resources\\notch-foreground.exe'

  const resolved = resolveForegroundExe(
    'C:\\Program Files\\Notch\\resources',
    'C:\\Program Files\\Notch\\resources\\app.asar',
    (candidate) => candidate === unpackedExe || candidate === asarExe
  )
  assert.equal(resolved, unpackedExe)

  const rejected = resolveForegroundExe(
    '',
    'C:\\Program Files\\Notch\\resources\\app.asar',
    (candidate) => candidate === asarExe
  )
  assert.equal(rejected, '')
})



