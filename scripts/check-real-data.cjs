// Executes source functions in memory. No application build, real state writes,
// account calls, or playback commands. Only filesystem/IPC infrastructure is faked.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { stripTypeScriptTypes } = require('node:module')
const { test } = require('node:test')
const root = path.resolve(__dirname, '..')

function sourceModule(file, bindings, names) {
  const source = stripTypeScriptTypes(readFileSync(path.join(root, file), 'utf8'))
    .replace(/^import\s[\s\S]*?\sfrom\s['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .replace(/^export /gm, '')
  return new Function(...Object.keys(bindings), `${source}\nreturn {${names.join(',')}}`)(...Object.values(bindings))
}

const follow = sourceModule('src/shared/mediaFollow.ts', {}, [
  'unavailablePlayback', 'playbackHeading', 'retainPlayback', 'playbackMatchesPreference', 'playbackSessionId'
])
const sections = sourceModule('src/shared/sections.ts', {}, ['normalizeSectionPrefs', 'sectionsEqual'])
const constants = sourceModule('src/shared/types.ts', {}, ['WATER_GLASS_ML', 'WATER_GOAL_MAX', 'WATER_GOAL_MIN'])

function stateStore(files = new Map()) {
  const file = path.join('fixture', 'notch-state.json')
  const fs = {
    readFile: async name => {
      if (!files.has(name)) throw new Error('ENOENT')
      return files.get(name)
    },
    mkdir: async () => {},
    writeFile: async (name, value) => { files.set(name, value) },
    rename: async (from, to) => {
      if (!files.has(from)) throw new Error('ENOENT')
      files.set(to, files.get(from)); files.delete(from)
    },
    unlink: async name => { files.delete(name) }
  }
  return { file, files, ...sourceModule('src/main/state.ts', {
    ...sections, ...constants, EventEmitter, path, fs,
    app: { getPath: () => 'fixture' }, process: { env: {} },
    setTimeout: () => 1, clearTimeout: () => {},
    mkdirSync: () => {}, writeFileSync: (name, value) => { files.set(name, value) }
  }, ['initState', 'getState', 'setState', 'updateTask', 'persistNow']) }
}

const live = {
  localSessionId: 'TestPlayerA', connected: true, playing: true,
  track: { id: 'local-A', name: 'Real track A', artists: 'Artist A', album: 'Album A',
    image: null, duration: 120000, progress: 5000, url: '' },
  device: { id: 'TestPlayerA', name: 'Player A', active: true, type: 'Computer', volume: 50 },
  controls: { next: true, previous: true, seek: true },
  shuffle: false, repeat: 'off', volume: 50, fetchedAt: 1000, source: 'local', queueAvailable: false
}

// Extract the actual refresh callback, including its stale-response guards.
function refreshFixture(initial = live) {
  const source = readFileSync(path.join(root, 'src/renderer/src/state/MediaContext.tsx'), 'utf8')
  const match = source.match(/const refreshPlayer = useCallback\(\s*([\s\S]*?),\s*\[applyPlayback, showToast\]\s*\)/)
  assert(match, 'Actual refreshPlayer callback and dependency boundary must exist')
  const callback = match[1]
  const state = { playback: structuredClone(initial), error: null, toasts: [] }
  const playbackRef = { current: state.playback }
  const env = {
    ...follow, polling: { current: false }, actionPending: { current: false },
    pollSuppressUntil: { current: 0 }, pollVersion: { current: 0 },
    selection: { current: { preference: 'TestPlayerA', version: 0 } }, playbackRef,
    applyPlayback: value => { state.playback = playbackRef.current = value },
    setError: value => { state.error = value }, showToast: (...args) => state.toasts.push(args),
    window: { notch: { spotify: { player: async () => { throw new Error('Media unavailable') } } } }
  }
  const refresh = new Function(...Object.keys(env), `return (${stripTypeScriptTypes(callback)})`)(...Object.values(env))
  return { state, env, refresh }
}

test('fresh install starts and persists with no invented tasks', async () => {
  const store = stateStore()
  assert.deepEqual((await store.initState()).tasks, [])
  assert.deepEqual(JSON.parse(store.files.get(store.file)).tasks, [])
})

test('saved tasks, editing and reload survive the empty-default change', async () => {
  const store = stateStore()
  const task = { id: 'owned-A', title: 'User task A', date: '2026-11-15', done: false, createdAt: 1, priority: 'high' }
  store.files.set(store.file, JSON.stringify({ tasks: [task], settings: { mediaSource: 'TestPlayerB' } }))
  assert.deepEqual((await store.initState()).tasks, [task])
  store.updateTask(task.id, { done: true })
  await store.persistNow()
  const reloaded = await stateStore(store.files).initState()
  assert.deepEqual(reloaded.tasks, [{ ...task, done: true }])
  assert.equal(reloaded.settings.mediaSource, 'TestPlayerB')
})

test('explicitly empty saved tasks remain empty', async () => {
  const store = stateStore()
  store.files.set(store.file, JSON.stringify({ tasks: [] }))
  assert.deepEqual((await store.initState()).tasks, [])
})

test('real refresh failure marks previous media unavailable and recovery restores live data', async () => {
  const fixture = refreshFixture()
  await fixture.refresh(true)
  const failed = fixture.state.playback
  assert.equal(failed.connected, false)
  assert.equal(failed.playing, false)
  assert.equal(failed.device, null)
  assert.equal(failed.source, 'none')
  assert.deepEqual(failed.track, live.track)
  assert.deepEqual(failed.controls, { next: false, previous: false, seek: false })
  assert.equal(follow.playbackHeading(failed), 'Last played')
  assert.equal(fixture.state.error, 'Media unavailable')
  assert.equal(fixture.state.toasts.length, 0)
  fixture.env.window.notch.spotify.player = async () => ({ ...live, track: { ...live.track, name: 'Recovered track' } })
  await fixture.refresh()
  assert.equal(fixture.state.playback.track.name, 'Recovered track')
  assert.equal(fixture.state.playback.playing, true)
  assert.equal(fixture.state.error, null)
})

test('late failure from player A cannot replace selected player B', async () => {
  const fixture = refreshFixture()
  let reject
  fixture.env.window.notch.spotify.player = () => new Promise((_, fail) => { reject = fail })
  const pending = fixture.refresh()
  fixture.env.selection.current = { preference: 'TestPlayerB', version: 1 }
  const next = { ...live, localSessionId: 'TestPlayerB', track: { ...live.track, name: 'Real track B' } }
  fixture.env.applyPlayback(next)
  reject(new Error('Late A failure'))
  await pending
  assert.equal(fixture.state.playback, next)
  assert.equal(fixture.state.error, null)
})

test('no-data failure stays empty and explicit refresh reports its error', async () => {
  const fixture = refreshFixture(null)
  await fixture.refresh()
  assert.equal(fixture.state.playback, null)
  assert.equal(follow.playbackHeading(fixture.state.playback), 'Nothing playing')
  assert.equal(fixture.state.toasts.length, 1)
})

test('headings distinguish live, paused and remembered tracks without mutating history', () => {
  assert.equal(follow.playbackHeading(live), 'Now playing')
  assert.equal(follow.playbackHeading({ ...live, playing: false }), 'Paused')
  assert.equal(follow.playbackHeading(follow.unavailablePlayback(live)), 'Last played')
  assert.equal(follow.playbackHeading({ ...live, track: null }), 'Nothing playing')
  assert.equal(live.playing, true)
})
