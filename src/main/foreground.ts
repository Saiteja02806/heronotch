import { spawn, type ChildProcess } from 'node:child_process'
import type { ForegroundSample } from '../shared/presence'

/**
 * Watches the foreground window on Windows. A window that covers the primary
 * display counts as fullscreen, which is how borderless games and full-screen
 * video present themselves. Notch's own window is reported as `own`.
 */

const SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class NotchFore {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
Add-Type -AssemblyName System.Windows.Forms
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
    \$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    \$width = \$rect.Right - \$rect.Left
    \$height = \$rect.Bottom - \$rect.Top
    \$covers = \$width -ge (\$screen.Width - 12) -and \$height -ge (\$screen.Height - 12)
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

let child: ChildProcess | null = null
let buffer = ''
let stopped = false
let listener: ((sample: ForegroundSample) => void) | null = null

export function startForegroundWatch(onSample: (sample: ForegroundSample) => void): void {
  listener = onSample
  if (process.platform !== 'win32' || child) return
  stopped = false
  try {
    child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', SCRIPT],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch {
    child = null
    return
  }
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
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
  child.on('exit', () => {
    child = null
    if (!stopped) setTimeout(() => startForegroundWatch(onSample), 3000)
  })
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
