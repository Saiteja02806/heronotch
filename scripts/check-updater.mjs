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

const errorsMod = await loadTs('../src/shared/errors.ts')
const updates = await loadTs('../src/shared/updates.ts', {
  './errors': `const plainErrorMessage = ${errorsMod.plainErrorMessage.toString()};`
})

test('compareVersions and isNewerVersion handle tags, patch rolls, and prereleases', () => {
  assert.equal(updates.compareVersions('v1.0.23', '1.0.22'), 1)
  assert.equal(updates.compareVersions('1.0.22', 'v1.0.22'), 0)
  assert.equal(updates.compareVersions('1.0.9', '1.0.22'), -1)
  assert.equal(updates.compareVersions('1.1.0', '1.0.99'), 1)
  assert.equal(updates.compareVersions('1.0.23', '1.0.23-beta.1'), 1)
  assert.equal(updates.compareVersions('1.0.23-beta.2', '1.0.23-beta.1'), 1)
  assert.equal(updates.isNewerVersion('v1.0.23', '1.0.22'), true)
  assert.equal(updates.isNewerVersion('1.0.22', '1.0.22'), false)
  assert.equal(updates.isNewerVersion('1.0.21', '1.0.22'), false)
})

test('cleanReleaseNotes strips HTML and markdown into readable lines', () => {
  const html = '<h3>What changed</h3><ul><li><strong>Faster</strong> Settings</li><li>Bug &amp; crash fix</li></ul>'
  assert.equal(updates.cleanReleaseNotes(html), 'What changed\n• Faster Settings\n• Bug & crash fix')

  const md = '## Release v1.0.23\n- Added **in-app updates** in [Settings](https://example.com)\n- Fixed `tray` icon'
  assert.equal(updates.cleanReleaseNotes(md), 'Release v1.0.23\n- Added in-app updates in Settings\n- Fixed tray icon')

  assert.equal(updates.cleanReleaseNotes([{ note: 'First fix' }, { note: 'Second fix' }]), 'First fix\n\nSecond fix')
  assert.equal(updates.cleanReleaseNotes(''), null)
})

test('selectGitHubReleaseAsset picks the right Windows binary per install kind', () => {
  const assets = [
    { name: 'Notch-Setup.exe', browser_download_url: 'https://github.com/Saiteja02806/heronotch/releases/download/v1.0.23/Notch-Setup.exe' },
    { name: 'Notch-Setup-1.0.23.exe', browser_download_url: 'https://github.com/Saiteja02806/heronotch/releases/download/v1.0.23/Notch-Setup-1.0.23.exe' },
    { name: 'Notch-Portable-1.0.23.exe', browser_download_url: 'https://github.com/Saiteja02806/heronotch/releases/download/v1.0.23/Notch-Portable-1.0.23.exe' },
    { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/Saiteja02806/heronotch/releases/download/v1.0.23/SHA256SUMS.txt' }
  ]

  assert.equal(
    updates.selectGitHubReleaseAsset(assets, 'nsis', 'https://github.com/fallback'),
    'https://github.com/Saiteja02806/heronotch/releases/download/v1.0.23/Notch-Setup-1.0.23.exe'
  )
  assert.equal(
    updates.selectGitHubReleaseAsset(assets, 'portable', 'https://github.com/fallback'),
    'https://github.com/Saiteja02806/heronotch/releases/download/v1.0.23/Notch-Portable-1.0.23.exe'
  )
  assert.equal(
    updates.selectGitHubReleaseAsset(assets, 'source', 'https://github.com/fallback'),
    'https://github.com/fallback'
  )
  assert.equal(
    updates.selectGitHubReleaseAsset(
      [{ name: 'Notch-Portable-1.0.23.exe', browser_download_url: 'http://insecure.example.com/evil.exe' }],
      'portable',
      'https://github.com/fallback'
    ),
    'https://github.com/fallback'
  )
})

test('isMissingManifestError and friendlyUpdaterError classify common failures', () => {
  assert.equal(updates.isMissingManifestError(new Error('HttpError: 404 Not Found')), true)
  assert.equal(updates.isMissingManifestError(new Error('Cannot find latest.yml in the latest release artifacts')), true)
  assert.equal(updates.isMissingManifestError(new Error('ENOTFOUND github.com')), false)

  assert.match(updates.friendlyUpdaterError(new Error('getaddrinfo ENOTFOUND github.com')), /internet connection/i)
  assert.match(updates.friendlyUpdaterError(new Error('ERR_UPDATER_INVALID_SIGNATURE')), /signature/i)
  assert.match(updates.friendlyUpdaterError(new Error('ETIMEDOUT')), /timed out/i)
})
