import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { stripTypeScriptTypes } from 'node:module'

function toDataModule(source, replacements = {}) {
  let code = source.replace(/import type \{[^}]*\} from '[^']*'\r?\n?/g, '')
  for (const [spec, url] of Object.entries(replacements)) {
    code = code.replaceAll(`'${spec}'`, `'${url}'`)
  }
  return `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(code)).toString('base64')}`
}

test('homeLayout fallback card never duplicates into hiddenHomeCards and survives adding a second card', async () => {
  const mod = await import(
    toDataModule(readFileSync(new URL('../src/shared/homeLayout.ts', import.meta.url), 'utf8'))
  )
  // Layout where `timer` is hidden, `music` is visible, and only `timer` + `posture` are enabled.
  const layout = {
    order: ['music', 'timer', 'posture', 'tasks', 'notes', 'sessions', 'calendar', 'water', 'phone'],
    hidden: ['timer', 'posture', 'water', 'phone']
  }
  const available = (id) => id === 'timer' || id === 'posture'

  assert.deepEqual(mod.shownHomeCards(layout, available), ['timer'])
  assert.deepEqual(mod.hiddenHomeCards(layout, available), ['posture'])
  assert.equal(mod.removeHomeCard(layout, 'timer', available), null)
  assert.equal(mod.toggleHomeCard(layout, 'timer', available), null)

  const added = mod.addHomeCard(layout, 'posture', undefined, available)
  assert.deepEqual(mod.shownHomeCards(added, available), ['timer', 'posture'])
  assert.deepEqual(mod.hiddenHomeCards(added, available), [])

  const toggled = mod.toggleHomeCard(layout, 'posture', available)
  assert.ok(toggled)
  assert.deepEqual(mod.shownHomeCards(toggled, available), ['timer', 'posture'])
})

test('calendar handler PATCH clears old date/dateTime fields, recovers CAS 409 refresh race, and removes Todaywise branding', async () => {
  const handlerSrc = readFileSync(
    new URL('../supabase/functions/notch-calendar/handler.ts', import.meta.url),
    'utf8'
  )
  const mainCalSrc = readFileSync(new URL('../src/main/calendar.ts', import.meta.url), 'utf8')
  assert.equal(/todaywise/i.test(handlerSrc), false, 'handler.ts must not mention Todaywise')
  assert.equal(/todaywise/i.test(mainCalSrc), false, 'calendar.ts must not mention Todaywise')

  const { createCalendarHandler } = await import(toDataModule(handlerSrc))
  const scopes = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
  ].join(' ')
  const json = (data, status = 200) => Response.json(data, { status })

  const grants = new Map()
  const patchBodies = []
  let tokenRefreshCount = 0
  let casSimulated = false
  let winnerCiphertext = ''

  const handler = createCalendarHandler(
    {
      supabaseUrl: 'https://example.test',
      serviceKey: 'test-only',
      googleClientId: 'test-client',
      googleClientSecret: 'test-secret',
      encryptionKey: Buffer.alloc(32, 67).toString('base64')
    },
    async (input, init = {}) => {
      const url = new URL(input)
      const headers = new Headers(init.headers)
      if (url.pathname === '/auth/v1/user') {
        return json({ id: 'alice', identities: [{ provider: 'google', identity_data: { sub: 'alice' } }] })
      }
      if (url.pathname === '/rest/v1/notch_calendar_grants') {
        if (init.method === 'POST') {
          const row = JSON.parse(init.body)
          grants.set(row.user_id, row.encrypted_grant)
          return new Response(null, { status: 201 })
        }
        if (init.method === 'PATCH') {
          // Simulate another concurrent request winning the CAS race: return empty array
          // while updating the stored grant to a fresh encrypted grant.
          casSimulated = true
          const row = JSON.parse(init.body)
          winnerCiphertext = row.encrypted_grant
          grants.set('alice', winnerCiphertext)
          return json([])
        }
        return json(grants.has('alice') ? [{ encrypted_grant: grants.get('alice') }] : [])
      }
      if (url.hostname === 'oauth2.googleapis.com') {
        tokenRefreshCount += 1
        // First connect returns an already-expiring token (expires_in: 1) so next call triggers refresh + CAS.
        return json({
          access_token: tokenRefreshCount === 1 ? 'alice-expiring' : 'alice-fresh',
          expires_in: tokenRefreshCount === 1 ? 1 : 3600,
          scope: scopes
        })
      }
      if (url.hostname === 'openidconnect.googleapis.com') {
        return json({ sub: 'alice' })
      }
      if (url.hostname === 'www.googleapis.com') {
        if (init.method === 'PATCH') {
          const body = JSON.parse(init.body)
          patchBodies.push(body)
          return json({
            id: 'ev1',
            summary: body.summary,
            start: body.start.date ? { date: body.start.date } : { dateTime: body.start.dateTime, timeZone: body.start.timeZone },
            end: body.end.date ? { date: body.end.date } : { dateTime: body.end.dateTime, timeZone: body.end.timeZone },
            etag: '"v2"'
          })
        }
        return json({ items: [] })
      }
      throw new Error(`Unexpected test fetch: ${url}`)
    }
  )

  const call = (body) =>
    handler(
      new Request('http://local.test', {
        method: 'POST',
        headers: { Authorization: 'Bearer alice' },
        body: JSON.stringify(body)
      })
    )

  // Connect with a 1-second token so the very next update triggers refresh + CAS race recovery
  const conn = await call({ action: 'connect', accessToken: 'alice-init', refreshToken: 'ref-1' })
  assert.equal(conn.status, 200)

  // 1) All-day -> timed PATCH must survive CAS 409 race AND emit explicit `date: null`
  const r1 = await call({
    action: 'update',
    calendarId: 'primary',
    draft: {
      id: 'ev1',
      etag: '"v1"',
      title: 'Now Timed',
      description: '',
      location: '',
      allDay: false,
      start: '2026-11-19T10:00:00+05:30',
      end: '2026-11-19T11:00:00+05:30',
      timeZone: 'Asia/Kolkata'
    }
  })
  assert.equal(r1.status, 200)
  assert.equal(casSimulated, true, 'must exercise CAS race recovery path')
  assert.equal(patchBodies[0].start.date, null)
  assert.equal(patchBodies[0].start.dateTime, '2026-11-19T10:00:00+05:30')
  assert.equal(patchBodies[0].end.date, null)

  // 2) Timed -> all-day PATCH must emit explicit `dateTime: null, timeZone: null`
  const r2 = await call({
    action: 'update',
    calendarId: 'primary',
    draft: {
      id: 'ev1',
      etag: '"v2"',
      title: 'Now All Day',
      description: '',
      location: '',
      allDay: true,
      start: '2026-11-19',
      end: '2026-11-20',
      timeZone: 'Asia/Kolkata'
    }
  })
  assert.equal(r2.status, 200)
  assert.equal(patchBodies[1].start.date, '2026-11-19')
  assert.equal(patchBodies[1].start.dateTime, null)
  assert.equal(patchBodies[1].start.timeZone, null)
  assert.equal(patchBodies[1].end.date, '2026-11-20')
  assert.equal(patchBodies[1].end.dateTime, null)
  assert.equal(patchBodies[1].end.timeZone, null)
})

test('agentStatus holds arbitrary tools with options as permissions (not questions) and omits wildcard CORS', async () => {
  const qaUrl = toDataModule(
    readFileSync(new URL('../src/shared/questionAnswers.ts', import.meta.url), 'utf8')
  )
  const mod = await import(
    toDataModule(readFileSync(new URL('../src/main/agentStatus.ts', import.meta.url), 'utf8'), {
      '../shared/questionAnswers': qaUrl
    })
  )
  const token = 'c'.repeat(48)
  const port = 17439
  mod.agentStatusStart(port, token)
  try {
    const base = `http://127.0.0.1:${port}`

    const statusRes = await fetch(`${base}/status`, {
      headers: { 'X-Notch-Token': token }
    })
    assert.equal(statusRes.status, 200)
    assert.equal(statusRes.headers.get('access-control-allow-origin'), null)

    // Non-question tool that happens to carry `options` in tool_input must stay a permission!
    const hold = fetch(`${base}/hook?tool=claude&kind=permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Notch-Token': token },
      body: JSON.stringify({
        hook_event_name: 'PermissionRequest',
        tool_name: 'mcp__deploy__run',
        tool_input: {
          command: 'deploy prod',
          options: [{ label: '--force' }, { label: '--dry-run' }]
        }
      })
    })
    await new Promise((r) => setTimeout(r, 150))
    const snap = mod.snapshot()
    assert.equal(snap.questions.length, 0, 'non-question tool must not be hijacked as a question')
    assert.equal(snap.pending.length, 1, 'non-question tool must remain a pending permission')
    mod.decide(snap.pending[0].id, 'deny')
    const reply = await (await hold).json()
    assert.equal(reply.hookSpecificOutput.decision.behavior, 'deny')
  } finally {
    mod.agentStatusStop()
  }
})

test('license.ts never unlocks an invalid key when offline and state.ts guards flush before load', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notch-hardening-'))
  try {
    // 1) state.ts: flushState before initState must NOT clobber an existing file
    const stateFile = path.join(dir, 'notch-state.json')
    const existing = { settings: { vaultPath: 'C:\\ExistingVault', welcomeSeen: true }, tasks: [] }
    await writeFile(stateFile, JSON.stringify(existing), 'utf8')

    const sectionsUrl = toDataModule(
      readFileSync(new URL('../src/shared/sections.ts', import.meta.url), 'utf8')
    )
    const typesUrl = toDataModule(
      readFileSync(new URL('../src/shared/types.ts', import.meta.url), 'utf8')
    )
    const electronStub = `data:text/javascript;base64,${Buffer.from(
      `export const app = { isPackaged: false, getPath: () => ${JSON.stringify(dir)} }; export const safeStorage = { isEncryptionAvailable: () => false };`
    ).toString('base64')}`

    const stateMod = await import(
      toDataModule(`${readFileSync(new URL('../src/main/state.ts', import.meta.url), 'utf8')}\n// h1`, {
        electron: electronStub,
        '../shared/sections': sectionsUrl,
        '../shared/types': typesUrl
      })
    )
    await stateMod.flushState()
    const stillThere = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(stillThere.settings.vaultPath, 'C:\\ExistingVault')

    // Prototype pollution and corrupt state normalization
    await stateMod.initState()
    const polluted = JSON.parse('{"__proto__":{"polluted":true},"settings":{"agentStatusPort":999999}}')
    stateMod.setState(polluted)
    assert.equal({}.polluted, undefined)

    await writeFile(
      stateFile,
      JSON.stringify({ tasks: null, notes: null, timer: null, posture: null, settings: { agentStatusPort: 99999 } }),
      'utf8'
    )
    const stateMod2 = await import(
      toDataModule(`${readFileSync(new URL('../src/main/state.ts', import.meta.url), 'utf8')}\n// h2`, {
        electron: electronStub,
        '../shared/sections': sectionsUrl,
        '../shared/types': typesUrl
      })
    )
    const recovered = await stateMod2.initState()
    assert.deepEqual(recovered.tasks, [])
    assert.equal(recovered.settings.agentStatusPort, 7432)

    // 2) license.ts: offline validation error must NOT promote invalid key to active,
    //    and packaged builds reject plaintext license records.
    const licDir = path.join(dir, 'lic')
    await mkdir(licDir, { recursive: true })
    const licElectronStub = `data:text/javascript;base64,${Buffer.from(
      `export const app = { isPackaged: true, getPath: () => ${JSON.stringify(licDir)} }; export const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s, 'utf8'), decryptString: (b) => b.toString('utf8') };`
    ).toString('base64')}`
    const licSharedUrl = toDataModule(
      readFileSync(new URL('../src/shared/license.ts', import.meta.url), 'utf8')
    )
    const now = Date.now()
    await writeFile(
      path.join(licDir, 'license.json'),
      JSON.stringify({
        version: 1,
        status: 'invalid',
        encrypted: Buffer.from(
          JSON.stringify({
            licenseKey: 'TEST-REVOKED-KEY',
            instanceId: 'inst-1',
            businessId: null,
            productId: null,
            productName: 'Notch',
            customerEmail: 'user@example.com',
            customerName: 'User',
            status: 'invalid',
            activatedAt: now,
            lastValidatedAt: now
          }),
          'utf8'
        ).toString('base64'),
        activatedAt: now,
        lastValidatedAt: now,
        error: 'Revoked'
      }),
      'utf8'
    )
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error('offline')
    }
    try {
      const licMod = await import(
        toDataModule(`${readFileSync(new URL('../src/main/license.ts', import.meta.url), 'utf8')}\n// h3`, {
          electron: licElectronStub,
          '../shared/license': licSharedUrl
        })
      )
      await licMod.initLicense({
        isDemoMode: false,
        isCapture: false,
        log: () => {},
        onStateChange: () => {}
      })
      const res = await licMod.validateStoredLicense()
      assert.equal(res.status, 'invalid')
      assert.equal(licMod.isLicenseUnlocked(), false)

      // Plaintext record must be rejected when app.isPackaged === true
      await writeFile(
        path.join(licDir, 'license.json'),
        JSON.stringify({
          version: 1,
          status: 'active',
          plain: {
            licenseKey: 'FORGED-PLAIN-KEY',
            instanceId: 'inst-2',
            businessId: null,
            productId: null,
            productName: 'Notch',
            customerEmail: null,
            customerName: null,
            status: 'active',
            activatedAt: now,
            lastValidatedAt: now
          },
          activatedAt: now,
          lastValidatedAt: now,
          error: null
        }),
        'utf8'
      )
      const licMod2 = await import(
        toDataModule(`${readFileSync(new URL('../src/main/license.ts', import.meta.url), 'utf8')}\n// h4`, {
          electron: licElectronStub,
          '../shared/license': licSharedUrl
        })
      )
      const plainState = await licMod2.initLicense({
        isDemoMode: false,
        isCapture: false,
        log: () => {},
        onStateChange: () => {}
      })
      assert.equal(plainState.status, 'unlicensed')
      assert.equal(licMod2.isLicenseUnlocked(), false)
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('obsidian.ts blocks symlink escapes, non-text extensions, reserved names, and supports dotted & case-only renames', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notch-vault-hardening-'))
  const vault = path.join(dir, 'vault')
  const outside = path.join(dir, 'outside')
  await mkdir(vault, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(path.join(outside, 'secret.md'), 'top secret', 'utf8')

  const electronStub = `data:text/javascript;base64,${Buffer.from(
    `export const shell = { openPath: async () => '', trashItem: async () => {}, showItemInFolder: () => {} };`
  ).toString('base64')}`

  const obsMod = await import(
    toDataModule(readFileSync(new URL('../src/main/obsidian.ts', import.meta.url), 'utf8'), {
      electron: electronStub
    })
  )
  try {
    // Dotted filename gets .md appended instead of truncated
    const dotted = await obsMod.createFile(vault, '', 'Release 1.2')
    assert.equal(dotted, 'Release 1.2.md')

    // Case-only rename on Windows NTFS works
    const renamed = await obsMod.renameEntry(vault, 'Release 1.2.md', 'release 1.2.md')
    assert.equal(renamed, 'release 1.2.md')

    // Non-text extensions never produce executable filenames and cannot be opened
    const safeCreated = await obsMod.createFile(vault, '', 'evil.exe')
    assert.equal(safeCreated, 'evil.exe.md')
    const safeRenamed = await obsMod.renameEntry(vault, 'evil.exe.md', 'evil.bat')
    assert.equal(safeRenamed, 'evil.bat.md')
    await writeFile(path.join(vault, 'bin.exe'), 'MZ', 'utf8')
    await assert.rejects(() => obsMod.openFile(vault, 'bin.exe'), /cannot be opened/i)

    // Windows reserved names are rejected
    await assert.rejects(() => obsMod.createFile(vault, '', 'CON'), /valid file name/i)
    await assert.rejects(() => obsMod.createFolder(vault, '', 'NUL'), /valid file name/i)

    // Junction / symlink escape outside vault is blocked
    const linkDir = path.join(vault, 'escape')
    await symlink(outside, linkDir, 'junction')
    await assert.rejects(() => obsMod.openFile(vault, 'escape/secret.md'), /outside the selected vault/i)
    await assert.rejects(() => obsMod.readNote(vault, 'escape/secret.md'), /outside the selected vault/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mediaFollow allows selecting browser YouTube Music while still rejecting plain browser video tabs', async () => {
  const mod = await import(
    toDataModule(readFileSync(new URL('../src/shared/mediaFollow.ts', import.meta.url), 'utf8'))
  )
  assert.equal(mod.normalizeMediaPreference('chrome.exe'), 'chrome.exe')
  assert.equal(mod.normalizeMediaPreference('msedge.exe'), 'msedge.exe')

  const ytVideo = { id: 'chrome.exe', title: 'Tutorial video', artist: 'Creator', album: '', playing: true }
  const ytMusic = { id: 'chrome.exe', title: 'Night Drive', artist: 'Synth', album: 'Midnight EP', playing: true }
  assert.equal(mod.pickMediaSession([ytVideo], 'chrome.exe'), null)
  assert.equal(mod.pickMediaSession([ytVideo, ytMusic], 'chrome.exe')?.title, 'Night Drive')
})

test('production out/ build contains zero demo vault, Todaywise, verify.js, or unconditional notchDemo bridge', () => {
  const mainJs = readFileSync(new URL('../out/main/index.js', import.meta.url), 'utf8')
  const preloadJs = readFileSync(new URL('../out/preload/index.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../out/renderer/index.html', import.meta.url), 'utf8')

  for (const [name, content] of [
    ['out/main/index.js', mainJs],
    ['out/preload/index.js', preloadJs],
    ['out/renderer/index.html', html]
  ]) {
    assert.equal(content.includes('HeroNotchDemoVault'), false, `${name} leaked HeroNotchDemoVault`)
    assert.equal(/todaywise/i.test(content), false, `${name} leaked Todaywise`)
    assert.equal(content.includes('ship-or-die'), false, `${name} leaked ship-or-die`)
    assert.equal(content.includes('verify.js'), false, `${name} leaked verify.js`)
  }
  assert.equal(
    /exposeInMainWorld\(['"]notchDemo['"]/.test(preloadJs),
    false,
    'production preload must not expose window.notchDemo'
  )
  assert.equal(existsSync(new URL('../src/demo-stub/main/index.ts', import.meta.url)), true)
})
