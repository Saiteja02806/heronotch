// Prints the signature and CPU architectures of every Notch.app under release/.
// Run on a Mac after `npm run dist:mac`.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

if (process.platform !== 'darwin') {
  console.log('verify:mac only runs on macOS.')
  process.exit(0)
}

const root = 'release'
const apps = []
for (const dir of existsSync(root) ? readdirSync(root) : []) {
  const candidate = path.join(root, dir, 'Notch.app')
  if (existsSync(candidate)) apps.push(candidate)
}
if (!apps.length) {
  console.error('No release/*/Notch.app found. Run `npm run dist:mac` first.')
  process.exit(1)
}

let failed = false
for (const app of apps) {
  console.log(`\n== ${app}`)
  const binary = path.join(app, 'Contents', 'MacOS', 'Notch')
  console.log(execFileSync('file', [binary], { encoding: 'utf8' }).trim())
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' })
    // codesign -dv prints its report on stderr.
    const info = spawnSync('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' }).stderr
    console.log(info.trim() || 'signature: ok')
  } catch (error) {
    failed = true
    const detail = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : String(error)
    console.error(`signature check failed: ${detail.trim()}`)
  }
}
process.exit(failed ? 1 : 0)
