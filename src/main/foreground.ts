import { spawn, type ChildProcess } from 'node:child_process'
import type { ForegroundSample } from '../shared/presence'

/**
 * Watches the foreground window on Windows. A window that covers the display
 * the notch lives on counts as fullscreen, which is how borderless games and
 * full-screen video present themselves. Notch's own window is reported as
 * `own`.
 */

export interface TargetSize {
  width: number
  height: number
}

function buildScript(target: TargetSize): string {
  const width = Math.max(1, Math.round(target.width))
  const height = Math.max(1, Math.round(target.height))
  return `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class NotchFore {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
# Physical pixels keep the comparison honest on a second monitor with a
# different scale factor than the primary one.
try { [void][NotchFore]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch { try { [void][NotchFore]::SetProcessDPIAware() } catch {} }
$targetWidth = ${width}
$targetHeight = ${height}
\$notchPid = ${process.pid}
while (\$true) {
  try {
    \$hwnd = [NotchFore]::GetForegroundWindow()
    \$rect = New-Object NotchFore+RECT
    [void][NotchFore]::GetWindowRect(\$hwnd, [ref]\$rect)
    \$procId = [uint32]0
    [void][NotchFore]::GetWindowThreadProcessId(\$hwnd, [ref]\$procId)
    \$name = ''
    try { \$name = [string](Get-Process -Id \$procId -ErrorAction Stop).ProcessName } catch {}
    \$width = \$rect.Right - \$rect.Left
    \$height = \$rect.Bottom - \$rect.Top
    # A maximized window is not fullscreen. Windows 11 draws it a few pixels
    # past the screen edge, which used to look like a fullscreen app and made
    # the tab blink away over a maximized browser.
    \$zoomed = [NotchFore]::IsZoomed(\$hwnd)
    \$covers = (-not \$zoomed) -and \$width -ge (\$targetWidth - 12) -and \$height -ge (\$targetHeight - 12) -and \$width -le (\$targetWidth + 48) -and \$height -le (\$targetHeight + 48)
    \$own = (\$procId -eq \$notchPid)
    \$result = [ordered]@{ process = \$name; fullscreen = [bool](\$covers -and -not \$own); own = [bool]\$own }
    [Console]::Out.WriteLine((ConvertTo-Json \$result -Compress))
    [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine('{"process":"","fullscreen":false,"own":false}')
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 800
}
`
}

let child: ChildProcess | null = null
let buffer = ''
let stopped = false
let listener: ((sample: ForegroundSample) => void) | null = null
let target: TargetSize | null = null

export function startForegroundWatch(
  onSample: (sample: ForegroundSample) => void,
  nextTarget?: TargetSize
): void {
  listener = onSample
  if (nextTarget) target = nextTarget
  if (process.platform !== 'win32' || child) return
  stopped = false
  try {
    child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-Command',
        buildScript(target || { width: 1920, height: 1080 })
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch {
    child = null
    return
  }
  const spawned = child
  spawned.stdout?.setEncoding('utf8')
  spawned.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('{')) {
        try {
          const parsed = JSON.parse(line) as ForegroundSample
          onSample({
            process: String(parsed.process || ''),
            fullscreen: Boolean(parsed.fullscreen),
            own: Boolean(parsed.own)
          })
        } catch {
          // Ignore a partial line.
        }
      }
      newline = buffer.indexOf('\n')
    }
  })
  spawned.on('exit', () => {
    if (child !== spawned) return
    child = null
    if (!stopped) setTimeout(() => {
      if (!stopped && !child) startForegroundWatch(onSample)
    }, 3000)
  })
}

/** Point the watcher at another display without losing the listener. */
export function setForegroundTarget(next: TargetSize): void {
  if (!next || next.width <= 0 || next.height <= 0) return
  if (target && Math.abs(target.width - next.width) < 2 && Math.abs(target.height - next.height) < 2) {
    return
  }
  target = next
  if (!listener || stopped) return
  const current = listener
  const previous = child
  child = null
  previous?.kill()
  startForegroundWatch(current)
}

export function stopForegroundWatch(): void {
  stopped = true
  child?.kill()
  child = null
}

export function pauseForegroundWatch(): void {
  stopped = true
  child?.kill()
  child = null
}

export function resumeForegroundWatch(): void {
  if (!listener) return
  stopped = false
  startForegroundWatch(listener)
}
