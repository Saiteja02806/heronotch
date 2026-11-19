import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isMac, isWin } from './platform'

// A macOS app started from Finder, the Dock or as a login item inherits a
// minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so CLIs installed by Homebrew,
// npm, nvm or vendor installers (codex, opencode, claude, node) are invisible
// to spawn(). Ask the user's login shell for its PATH once and merge it in.

const MARKER = '__NOTCH_PATH__'
let ready: Promise<void> | null = null

/** Folders commonly holding user-installed CLIs on macOS, checked even if the shell lookup fails. */
function wellKnownDirs(): string[] {
  const home = os.homedir()
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.opencode', 'bin'),
    path.join(home, 'Library', 'pnpm')
  ]
}

async function nvmBinDirs(): Promise<string[]> {
  const base = path.join(os.homedir(), '.nvm', 'versions', 'node')
  try {
    const versions = (await fs.readdir(base)).sort().reverse()
    return versions.map((version) => path.join(base, version, 'bin'))
  } catch {
    return []
  }
}

function loginShellPath(): Promise<string | null> {
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  return new Promise((resolve) => {
    execFile(
      shell,
      // -i -l loads the same rc files as Terminal. The markers keep any text
      // the rc files print from being mistaken for the PATH.
      ['-ilc', `printf '%s' "${MARKER}$PATH${MARKER}"`],
      { timeout: 5000, maxBuffer: 1024 * 1024, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } },
      (error, stdout) => {
        if (error && !stdout) {
          resolve(null)
          return
        }
        const match = String(stdout).match(new RegExp(`${MARKER}(.*?)${MARKER}`, 's'))
        resolve(match?.[1]?.trim() || null)
      }
    )
  })
}

function mergePath(...parts: (string | null | undefined)[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    for (const entry of (part || '').split(path.delimiter)) {
      if (!entry || seen.has(entry)) continue
      seen.add(entry)
      out.push(entry)
    }
  }
  return out.join(path.delimiter)
}

/**
 * Resolves once process.env.PATH includes the login shell's PATH (macOS only;
 * resolves immediately elsewhere). Safe to call many times.
 */
export function ensureLoginShellPath(): Promise<void> {
  if (!isMac) return Promise.resolve()
  if (!ready) {
    ready = (async () => {
      const [shellPath, nvm] = await Promise.all([loginShellPath(), nvmBinDirs()])
      process.env.PATH = mergePath(
        shellPath,
        process.env.PATH,
        wellKnownDirs().join(path.delimiter),
        nvm.join(path.delimiter)
      )
    })().catch(() => undefined)
  }
  return ready
}

/** Finds an executable on PATH (after the login-shell merge on macOS). Returns null when absent. */
export async function findCommandOnPath(name: string): Promise<string | null> {
  if (isWin) return null
  await ensureLoginShellPath()
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      await fs.access(candidate, fs.constants.X_OK)
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {
      // Not in this folder.
    }
  }
  return null
}
