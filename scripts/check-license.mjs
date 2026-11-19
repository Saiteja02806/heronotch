import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'

function loadTs(relativePath, stubs = {}) {
  let source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  source = source.replace(/import type \{[^}]*\} from '[^']*'\r?\n?/g, '')
  for (const [specifier, code] of Object.entries(stubs)) {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    source = source.replace(new RegExp(`import \\{([^}]+)\\} from '${escaped}'`, 'g'), code)
  }
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`)
}

const license = await loadTs('../src/shared/license.ts')
const errorsMod = await loadTs('../src/shared/errors.ts')
const updates = await loadTs('../src/shared/updates.ts', {
  './errors': `const plainErrorMessage = ${errorsMod.plainErrorMessage.toString()};`
})

test('maskLicenseKey hides middle key characters while preserving prefix and tail', () => {
  assert.equal(license.maskLicenseKey('2b1f8e2d-c41e-4e8f-b2d3-d9fd61c38f43'), '2b1f-••••-••••-8f43')
  assert.equal(license.maskLicenseKey('short12'), '*****12')
  assert.equal(license.maskLicenseKey('  '), '')
})

test('Dodo license response parsers extract activation details and validity', () => {
  const act = license.parseDodoActivateResponse({
    id: 'lki_abc123',
    license_key_id: 'lic_999',
    business_id: 'bus_notch',
    name: 'Workstation',
    customer: { email: 'buyer@example.com', name: 'Asha' },
    product: { product_id: 'pdt_early', name: 'Hero Notch Early Bird' }
  })
  assert.deepEqual(act, {
    instanceId: 'lki_abc123',
    licenseKeyId: 'lic_999',
    businessId: 'bus_notch',
    productId: 'pdt_early',
    productName: 'Hero Notch Early Bird',
    customerEmail: 'buyer@example.com',
    customerName: 'Asha',
    name: 'Workstation'
  })

  assert.equal(license.parseDodoActivateResponse({ foo: 'bar' }), null)
  assert.equal(license.parseDodoValidateResponse({ valid: true }), true)
  assert.equal(license.parseDodoValidateResponse({ valid: false }), false)
  assert.equal(license.parseDodoValidateResponse({}), null)
})

test('validateDodoProductMatch enforces configured business and product IDs cleanly', () => {
  assert.deepEqual(
    license.validateDodoProductMatch({ businessId: 'bus_a', productId: 'pdt_1' }, '', []),
    { ok: true }
  )
  assert.equal(
    license.validateDodoProductMatch({ businessId: 'bus_other', productId: 'pdt_1' }, 'bus_notch', []).ok,
    false
  )
  assert.equal(
    license.validateDodoProductMatch({ businessId: null, productId: 'pdt_1' }, 'bus_notch', []).ok,
    false
  )
  assert.equal(
    license.validateDodoProductMatch(
      { businessId: 'bus_notch', productId: 'pdt_wrong' },
      'bus_notch',
      ['pdt_early', 'pdt_std']
    ).ok,
    false
  )
  assert.equal(
    license.validateDodoProductMatch(
      { businessId: 'bus_notch', productId: 'pdt_std' },
      'bus_notch',
      ['pdt_early', 'pdt_std']
    ).ok,
    true
  )
})

test('offline grace window expires accurately after 14 days', () => {
  const now = Date.UTC(2026, 10, 18, 12, 0, 0)
  const thirteenDaysAgo = now - 13 * 24 * 60 * 60 * 1000
  const fifteenDaysAgo = now - 15 * 24 * 60 * 60 * 1000

  assert.equal(license.isWithinOfflineGrace(thirteenDaysAgo, now), true)
  assert.equal(license.offlineGraceRemainingDays(thirteenDaysAgo, now), 1)
  assert.equal(license.isWithinOfflineGrace(fifteenDaysAgo, now), false)
  assert.equal(license.offlineGraceRemainingDays(fifteenDaysAgo, now), 0)
  assert.equal(license.isWithinOfflineGrace(null, now), false)
})

test('Store installKind disables GitHub release asset lookups cleanly', () => {
  const updaterSrc = readFileSync(new URL('../src/main/updater.ts', import.meta.url), 'utf8')
  assert.match(updaterSrc, /if \(input\.isWindowsStore\) return 'store'/)
  assert.match(updaterSrc, /state\.installKind === 'store'/)
  assert.equal(typeof updates.compareVersions, 'function')
})
