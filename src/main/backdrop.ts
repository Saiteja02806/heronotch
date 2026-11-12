import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let cachedBackdrop: string | null = null
let cachedAt = 0
let inFlight: Promise<string | null> | null = null
let suspended = false

export function getCachedBackdrop(): string | null {
  return cachedBackdrop
}

export function getCachedAt(): number {
  return cachedAt
}

function escapePowerShell(value: string): string {
  return value.replace(/'/g, "''")
}

async function capture(): Promise<string | null> {
  const file = path.join(os.tmpdir(), `notch-backdrop-${process.pid}.png`)
  const escapedFile = escapePowerShell(file)
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$source=New-Object System.Drawing.Bitmap($bounds.Width,$bounds.Height)',
    '$graphics=[System.Drawing.Graphics]::FromImage($source)',
    '$graphics.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size)',
    '$maxWidth=1280.0',
    '$scale=[Math]::Min(1.0,$maxWidth/[double]$bounds.Width)',
    '$width=[int]($bounds.Width*$scale)',
    '$height=[int]($bounds.Height*$scale)',
    '$target=New-Object System.Drawing.Bitmap($width,$height)',
    '$targetGraphics=[System.Drawing.Graphics]::FromImage($target)',
    '$targetGraphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '$targetGraphics.DrawImage($source,0,0,$width,$height)',
    `$target.Save('${escapedFile}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$targetGraphics.Dispose()',
    '$target.Dispose()',
    '$graphics.Dispose()',
    '$source.Dispose()'
  ].join(';\n')

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
        { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 },
        (error) => (error ? reject(error) : resolve())
      )
    })
    const buffer = await fs.readFile(file)
    if (!buffer.length) return null
    const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`
    if (suspended) return null
    cachedBackdrop = dataUrl
    cachedAt = Date.now()
    return dataUrl
  } catch {
    return null
  } finally {
    await fs.unlink(file).catch(() => undefined)
  }
}

export function captureDesktopBackdrop(): Promise<string | null> {
  if (inFlight) return inFlight
  inFlight = capture().finally(() => {
    inFlight = null
  })
  return inFlight
}

export function refreshBackdrop(): void {
  if (suspended || inFlight) return
  void captureDesktopBackdrop()
}

export function suspendBackdropCapture(): void {
  suspended = true
}

export function resumeBackdropCapture(): void {
  suspended = false
}

export function scheduleBackdropRefresh(): void {
  if (!app.isReady()) return
  setTimeout(() => {
    refreshBackdrop()
  }, 900)
}
