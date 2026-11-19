import { execFile } from 'node:child_process'

// macOS replacement for the Windows media-session (SMTC) PowerShell scripts in
// localMedia.ts. Spotify's AppleScript dictionary gives the current track,
// state and position, and accepts play/pause/next/previous/seek.
//
// Permissions: the first time Notch reads or controls Spotify, macOS asks the
// user to allow "Notch to control Spotify" (Automation). A refusal surfaces as
// AppleScript error -1743; see AUTOMATION_DENIED below.
//
// Units match the Windows monitor: position and end in milliseconds, status
// "Playing" or "Paused".

/**
 * One JSON object per line on stdout, about every 1.1 s, for as long as the
 * process lives. `Application('Spotify').running()` does not launch Spotify or
 * send it any Apple Event, so nothing is read (and no permission prompt
 * appears) until Spotify is actually open.
 */
export const MAC_MONITOR_SCRIPT = `
ObjC.import('Foundation')
const out = $.NSFileHandle.fileHandleWithStandardOutput
function emit(value) {
  out.writeData($(JSON.stringify(value) + '\\n').dataUsingEncoding($.NSUTF8StringEncoding))
}
function sample() {
  let spotify
  try {
    spotify = Application('Spotify')
  } catch (error) {
    return { available: false, error: 'not-installed' }
  }
  if (!spotify.running()) return { available: false, error: 'not-running' }
  try {
    const state = spotify.playerState()
    if (state === 'stopped') return { available: false, error: 'stopped' }
    const track = spotify.currentTrack
    let art = null
    try { art = track.artworkUrl() || null } catch (error) {}
    return {
      available: true,
      source: 'com.spotify.client',
      title: track.name(),
      artist: track.artist(),
      album: track.album(),
      status: state === 'playing' ? 'Playing' : 'Paused',
      position: Math.round(Number(spotify.playerPosition()) * 1000),
      end: Number(track.duration()),
      canNext: true,
      canPrevious: true,
      canSeek: true,
      art: art
    }
  } catch (error) {
    return { available: false, error: String(error) }
  }
}
function run(argv) {
  const once = argv && argv[0] === '--once'
  while (true) {
    emit(sample())
    if (once) return
    delay(1.1)
  }
}
`

/** True when an osascript error or a monitor sample means the Automation permission was refused. */
export function isAutomationDenied(text: string | null | undefined): boolean {
  return Boolean(text && /-1743|not authori[sz]ed|not allowed to send apple events/i.test(text))
}

export const AUTOMATION_DENIED_MESSAGE =
  'macOS blocked Notch from controlling Spotify. Allow it in System Settings › Privacy & Security › Automation › Notch › Spotify.'

export type MacControl =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'seek'; position: number }

function controlAppleScript(action: MacControl): string {
  switch (action.type) {
    case 'play':
      return 'tell application "Spotify" to play'
    case 'pause':
      return 'tell application "Spotify" to pause'
    case 'next':
      return 'tell application "Spotify" to next track'
    case 'previous':
      return 'tell application "Spotify" to previous track'
    case 'seek': {
      // Spotify takes seconds; the app passes milliseconds.
      const seconds = Math.max(0, Math.round(Number(action.position) || 0)) / 1000
      return `tell application "Spotify" to set player position to ${seconds.toFixed(3)}`
    }
  }
}

/** Runs one control command. Resolves { ok, denied } and never throws. */
export function runMacControl(action: MacControl): Promise<{ ok: boolean; denied: boolean }> {
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', controlAppleScript(action)],
      { timeout: 6000 },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, denied: false })
          return
        }
        resolve({ ok: false, denied: isAutomationDenied(`${stderr} ${error.message}`) })
      }
    )
  })
}

/** Reads the current Spotify state once (same JSON as a monitor line), or null on failure. */
export function readMacSnapshotOnce(): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', MAC_MONITOR_SCRIPT, '--once'],
      { timeout: 6000, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(String(stdout).trim().split('\n').pop() || 'null'))
        } catch {
          resolve(null)
        }
      }
    )
  })
}
