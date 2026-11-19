import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'

function loadTsModule(relPath) {
  const source = readFileSync(new URL(relPath, import.meta.url), 'utf8')
  const js = stripTypeScriptTypes(source)
  const url = `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  return import(url)
}

test('homeLayout defaults to 6 visible sections and keeps water, posture and phone available to add', async () => {
  const mod = await loadTsModule('../src/shared/homeLayout.ts')
  const normalized = mod.normalizeHomeLayout(undefined)

  assert.deepEqual(mod.shownHomeCards(normalized), [
    'timer',
    'music',
    'tasks',
    'notes',
    'sessions',
    'calendar'
  ])
  assert.deepEqual(mod.hiddenHomeCards(normalized), ['water', 'posture', 'phone'])
  assert.equal(mod.homeGridColumns(6), 3)
})

test('homeLayout switches cleanly between 6, 4 and 2 sections while preserving card priority order', async () => {
  const mod = await loadTsModule('../src/shared/homeLayout.ts')
  const initial = mod.defaultHomeLayout()

  const four = mod.setHomeCardCount(initial, 4)
  assert.deepEqual(mod.shownHomeCards(four), ['timer', 'music', 'tasks', 'notes'])
  assert.equal(mod.homeGridColumns(mod.shownHomeCards(four).length), 2)
  assert.equal(mod.homeSlotLabel(0, 4), 'Row 1 · Left')
  assert.equal(mod.homeSlotLabel(1, 4), 'Row 1 · Right')
  assert.equal(mod.homeSlotLabel(2, 4), 'Row 2 · Left')
  assert.equal(mod.homeSlotLabel(3, 4), 'Row 2 · Right')

  const two = mod.setHomeCardCount(four, 2)
  assert.deepEqual(mod.shownHomeCards(two), ['timer', 'music'])
  assert.equal(mod.homeGridColumns(mod.shownHomeCards(two).length), 2)
  assert.equal(mod.homeSlotLabel(0, 2), 'Row 1 · Left')
  assert.equal(mod.homeSlotLabel(1, 2), 'Row 1 · Right')

  const backToFour = mod.setHomeCardCount(two, 4)
  assert.deepEqual(mod.shownHomeCards(backToFour), ['timer', 'music', 'tasks', 'notes'])
})

test('homeLayout allows adding Water, Posture or Phone and removing any card down to 1', async () => {
  const mod = await loadTsModule('../src/shared/homeLayout.ts')
  let layout = mod.setHomeCardCount(mod.defaultHomeLayout(), 2)
  assert.deepEqual(mod.shownHomeCards(layout), ['timer', 'music'])

  // Add water and posture to make a custom 4-card home layout
  layout = mod.addHomeCard(layout, 'water')
  layout = mod.addHomeCard(layout, 'posture')
  assert.deepEqual(mod.shownHomeCards(layout), ['timer', 'music', 'water', 'posture'])
  assert.ok(!mod.hiddenHomeCards(layout).includes('water'))
  assert.ok(!mod.hiddenHomeCards(layout).includes('posture'))

  // Remove timer, music and posture so only water remains
  layout = mod.removeHomeCard(layout, 'timer')
  assert.ok(layout)
  layout = mod.removeHomeCard(layout, 'music')
  assert.ok(layout)
  layout = mod.removeHomeCard(layout, 'posture')
  assert.ok(layout)
  assert.deepEqual(mod.shownHomeCards(layout), ['water'])
  assert.equal(mod.homeGridColumns(1), 1)
  assert.equal(mod.homeSlotLabel(0, 1), 'Full panel')

  // Removing the last remaining card returns null
  assert.equal(mod.removeHomeCard(layout, 'water'), null)
  assert.equal(mod.toggleHomeCard(layout, 'water'), null)
})

test('homeLayout respects disabled header sections and migrates legacy water-in-music-slot saves', async () => {
  const mod = await loadTsModule('../src/shared/homeLayout.ts')

  // Old save without `hidden` where Music is off and Water is on
  const legacySaved = {
    order: ['timer', 'music', 'tasks', 'notes', 'sessions', 'calendar']
  }
  const available = (id) => id !== 'music'
  const migrated = mod.normalizeHomeLayout(legacySaved, {
    legacyWaterInMusicSlot: true
  })

  // Water sits in Music's old spot on Home while Music is off
  assert.deepEqual(mod.shownHomeCards(migrated, available), [
    'timer',
    'water',
    'tasks',
    'notes',
    'sessions',
    'calendar'
  ])
  // Music is not offered as an available-to-add card while its section is off
  assert.ok(!mod.hiddenHomeCards(migrated, available).includes('music'))
  assert.deepEqual(mod.hiddenHomeCards(migrated, available), ['posture', 'phone'])
})
