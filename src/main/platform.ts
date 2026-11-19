import os from 'node:os'
import path from 'node:path'

// Platform switches used across the main process. Windows behavior is the
// original code path; macOS gets its own branch next to it, never in place of it.
export const isWin = process.platform === 'win32'
export const isMac = process.platform === 'darwin'

/** Per-user application data folder: %APPDATA% on Windows, ~/Library/Application Support on macOS. */
export function appSupportDir(): string {
  if (isMac) return path.join(os.homedir(), 'Library', 'Application Support')
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
}

/** Per-user local data folder: %LOCALAPPDATA% on Windows, ~/Library/Application Support on macOS. */
export function localAppDataDir(): string {
  if (isMac) return path.join(os.homedir(), 'Library', 'Application Support')
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
}
