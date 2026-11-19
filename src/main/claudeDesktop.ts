import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface ClaudeLiveSession {
  pid: number
  sessionId: string
  entrypoint: string
  hostSessionId: string | null
  status: string | null
  isDesktop: boolean
  busy: boolean
}

export type ClaudeAutoSubmitStatus =
  | 'sent'
  | 'not-focused'
  | 'lost-focus'
  | 'lost-focus-after-paste'
  | 'send-failed'
  | 'unsupported'

export interface ClaudeAutoSubmitResult {
  status: ClaudeAutoSubmitStatus
  reason?: string
}

/** Check whether a local OS process id is currently alive. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return code === 'EPERM'
  }
}

/** Claude Code v2.1+ writes `~/.claude/sessions/<pid>.json` for every active
 * interactive or Claude Desktop session process, and deletes it on exit.
 * Verify each PID is still alive so a crashed process never leaves a stale lock. */
export async function readLiveClaudeSessions(options?: {
  sessionsDir?: string
  isAlive?: (pid: number) => boolean
}): Promise<Map<string, ClaudeLiveSession>> {
  const dir = options?.sessionsDir || path.join(os.homedir(), '.claude', 'sessions')
  const checkAlive = options?.isAlive ?? isPidAlive
  const live = new Map<string, ClaudeLiveSession>()

  const entries = await fs.readdir(dir).catch(() => [] as string[])
  for (const file of entries) {
    if (!file.endsWith('.json')) continue
    const raw = await fs.readFile(path.join(dir, file), 'utf8').catch(() => '')
    if (!raw.trim()) continue
    try {
      const parsed = JSON.parse(raw) as {
        pid?: unknown
        sessionId?: unknown
        entrypoint?: unknown
        hostSessionId?: unknown
        status?: unknown
      }
      const pid = typeof parsed.pid === 'number' ? parsed.pid : Number.NaN
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : ''
      if (!sessionId || !Number.isInteger(pid) || pid <= 0 || !checkAlive(pid)) continue
      const entrypoint = typeof parsed.entrypoint === 'string' ? parsed.entrypoint.trim() : ''
      const hostSessionId =
        typeof parsed.hostSessionId === 'string' && parsed.hostSessionId.trim()
          ? parsed.hostSessionId.trim()
          : null
      const status =
        typeof parsed.status === 'string' && parsed.status.trim() ? parsed.status.trim() : null
      const isDesktop =
        entrypoint === 'claude-desktop' || (hostSessionId !== null && hostSessionId.startsWith('local_'))
      const busy = Boolean(status && /running|busy|working|streaming|thinking|progress/i.test(status))
      live.set(sessionId, { pid, sessionId, entrypoint, hostSessionId, status, isDesktop, busy })
    } catch {
      // Ignore partial or malformed session files.
    }
  }
  return live
}

/** Look up an active Claude Desktop child process owning `rawId`. */
export async function findLiveClaudeDesktopSession(
  rawId: string,
  options?: { sessionsDir?: string; isAlive?: (pid: number) => boolean }
): Promise<ClaudeLiveSession | null> {
  if (!rawId) return null
  const sessions = await readLiveClaudeSessions(options)
  const hit = sessions.get(rawId)
  return hit && hit.isDesktop ? hit : null
}

/** Parse the structured `RESULT:<status>` line printed by the Windows auto-submit helper. */
export function parseAutoSubmitOutput(stdout: string): ClaudeAutoSubmitResult {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(/RESULT:([a-z-]+)$/i)
    if (!match) continue
    const code = match[1].toLowerCase()
    if (code === 'sent') return { status: 'sent' }
    if (code === 'not-focused') {
      return { status: 'not-focused', reason: 'Claude Desktop did not come to the foreground.' }
    }
    if (code === 'lost-focus') {
      return { status: 'lost-focus', reason: 'Focus moved away from Claude Desktop before pasting.' }
    }
    if (code === 'lost-focus-after-paste') {
      return {
        status: 'lost-focus-after-paste',
        reason: 'Focus moved away from Claude Desktop before pressing Enter.'
      }
    }
    if (code === 'send-failed') {
      return { status: 'send-failed', reason: 'Windows blocked synthetic input to Claude Desktop.' }
    }
  }
  return { status: 'send-failed', reason: 'Could not complete automatic paste in Claude Desktop.' }
}

const WIN32_INPUT_CS = `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class NotchClaudeInput {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

  // The Claude desktop app is an Electron window. The Claude Code CLI is also
  // claude.exe, and a classic console window reports its client process as the
  // owner, so the process name alone would let a terminal running Claude Code
  // pass as the app and receive the paste and Enter.
  public static bool IsClaudeAppWindow(IntPtr hWnd, uint pid) {
    if (hWnd == IntPtr.Zero || pid == 0) return false;
    var cls = new StringBuilder(256);
    if (GetClassName(hWnd, cls, cls.Capacity) == 0) return false;
    if (!string.Equals(cls.ToString(), "Chrome_WidgetWin_1", StringComparison.Ordinal)) return false;
    try {
      using (var p = Process.GetProcessById((int)pid)) {
        return string.Equals(p.ProcessName, "claude", StringComparison.OrdinalIgnoreCase);
      }
    } catch {
      return false;
    }
  }

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion u;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx, dy;
    public uint mouseData, dwFlags, time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg;
    public ushort wParamL, wParamH;
  }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const int SW_RESTORE = 9;

  public static bool IsClaudeForeground(out IntPtr hwnd) {
    hwnd = GetForegroundWindow();
    if (hwnd == IntPtr.Zero || IsIconic(hwnd) || !IsWindowVisible(hwnd)) return false;
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    return IsClaudeAppWindow(hwnd, pid);
  }

  public static void TryRestoreClaude() {
    try {
      foreach (var p in Process.GetProcessesByName("claude")) {
        try {
          IntPtr h = p.MainWindowHandle;
          if (h != IntPtr.Zero && IsClaudeAppWindow(h, (uint)p.Id)) {
            if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
            SetForegroundWindow(h);
            break;
          }
        } finally {
          p.Dispose();
        }
      }
    } catch {}
  }

  public static bool AnyModifierHeld() {
    int[] keys = new[] { 0x10, 0x11, 0x12, 0x5B, 0x5C };
    foreach (int k in keys) {
      if ((GetAsyncKeyState(k) & 0x8000) != 0) return true;
    }
    return false;
  }

  public static uint SendCtrlV() {
    var inputs = new INPUT[4];
    inputs[0].type = INPUT_KEYBOARD; inputs[0].u.ki.wVk = 0x11;
    inputs[1].type = INPUT_KEYBOARD; inputs[1].u.ki.wVk = 0x56;
    inputs[2].type = INPUT_KEYBOARD; inputs[2].u.ki.wVk = 0x56; inputs[2].u.ki.dwFlags = KEYEVENTF_KEYUP;
    inputs[3].type = INPUT_KEYBOARD; inputs[3].u.ki.wVk = 0x11; inputs[3].u.ki.dwFlags = KEYEVENTF_KEYUP;
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  public static uint SendEnter() {
    var inputs = new INPUT[2];
    inputs[0].type = INPUT_KEYBOARD; inputs[0].u.ki.wVk = 0x0D;
    inputs[1].type = INPUT_KEYBOARD; inputs[1].u.ki.wVk = 0x0D; inputs[1].u.ki.dwFlags = KEYEVENTF_KEYUP;
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
`

function buildAutoSubmitPowerShell(timeoutMs: number, settleMs: number): string {
  const csBase64 = Buffer.from(WIN32_INPUT_CS, 'utf8').toString('base64')
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
    `$code = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${csBase64}'))`,
    'Add-Type -TypeDefinition $code',
    `$sw = [Diagnostics.Stopwatch]::StartNew()`,
    '$hwnd = [IntPtr]::Zero',
    '$focused = $false',
    '$triedRestore = $false',
    `while ($sw.ElapsedMilliseconds -lt ${timeoutMs}) {`,
    '  if ([NotchClaudeInput]::IsClaudeForeground([ref]$hwnd)) { $focused = $true; break }',
    '  if (-not $triedRestore -and $sw.ElapsedMilliseconds -ge 600) {',
    '    $triedRestore = $true',
    '    [NotchClaudeInput]::TryRestoreClaude()',
    '  }',
    '  Start-Sleep -Milliseconds 50',
    '}',
    "if (-not $focused) { Write-Output 'RESULT:not-focused'; exit 0 }",
    `Start-Sleep -Milliseconds ${settleMs}`,
    '$modSw = [Diagnostics.Stopwatch]::StartNew()',
    'while ($modSw.ElapsedMilliseconds -lt 700 -and [NotchClaudeInput]::AnyModifierHeld()) {',
    '  Start-Sleep -Milliseconds 40',
    '}',
    "if (-not [NotchClaudeInput]::IsClaudeForeground([ref]$hwnd)) { Write-Output 'RESULT:lost-focus'; exit 0 }",
    // Best-effort UI Automation composer focus assist: if Claude is already open
    // on the same chat and focus was elsewhere (e.g. transcript text), focus the
    // bottom-most editable textbox before pasting.
    'try {',
    '  $focusedEl = [System.Windows.Automation.AutomationElement]::FocusedElement',
    '  $isEdit = $false',
    '  if ($null -ne $focusedEl) {',
    '    $ct = $focusedEl.Current.ControlType',
    '    if ($ct -eq [System.Windows.Automation.ControlType]::Edit -and $focusedEl.Current.IsEnabled -and -not $focusedEl.Current.IsOffscreen) {',
    '      $vp = $null',
    '      if ($focusedEl.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {',
    '        $isEdit = -not $vp.Current.IsReadOnly',
    '      } else {',
    '        $isEdit = $true',
    '      }',
    '    }',
    '  }',
    '  if (-not $isEdit -and $hwnd -ne [IntPtr]::Zero) {',
    '    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)',
    '    if ($null -ne $root) {',
    '      $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)',
    '      $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)',
    '      $best = $null',
    '      $bestBottom = -1.0',
    '      for ($i = 0; $i -lt $edits.Count; $i++) {',
    '        $el = $edits.Item($i)',
    '        if (-not $el.Current.IsEnabled -or $el.Current.IsOffscreen -or -not $el.Current.IsKeyboardFocusable) { continue }',
    '        $vp = $null',
    '        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp) -and $vp.Current.IsReadOnly) { continue }',
    '        $rect = $el.Current.BoundingRectangle',
    '        if ([double]::IsInfinity($rect.Width) -or [double]::IsNaN($rect.Width)) { continue }',
    '        if ($rect.Width -lt 180 -or $rect.Height -lt 18 -or $rect.Height -gt 400) { continue }',
    '        if ($rect.Bottom -gt $bestBottom) { $bestBottom = $rect.Bottom; $best = $el }',
    '      }',
    '      if ($null -ne $best -and [NotchClaudeInput]::IsClaudeForeground([ref]$hwnd)) {',
    '        $best.SetFocus()',
    '        Start-Sleep -Milliseconds 120',
    '      }',
    '    }',
    '  }',
    '} catch {}',
    "if (-not [NotchClaudeInput]::IsClaudeForeground([ref]$hwnd)) { Write-Output 'RESULT:lost-focus'; exit 0 }",
    '$sentV = [NotchClaudeInput]::SendCtrlV()',
    "if ($sentV -ne 4) { Write-Output 'RESULT:send-failed'; exit 0 }",
    'Start-Sleep -Milliseconds 200',
    "if (-not [NotchClaudeInput]::IsClaudeForeground([ref]$hwnd)) { Write-Output 'RESULT:lost-focus-after-paste'; exit 0 }",
    '$sentEnter = [NotchClaudeInput]::SendEnter()',
    "if ($sentEnter -ne 2) { Write-Output 'RESULT:send-failed'; exit 0 }",
    "Write-Output 'RESULT:sent'"
  ].join('\n')
}

/** After opening a live Claude Desktop chat via deep link with the message on
 * the clipboard, wait for Claude Desktop to own foreground focus, optionally
 * focus the chat composer via UIA, and send Ctrl+V + Enter strictly while
 * Claude remains the foreground process. */
export async function autoSubmitInClaudeApp(options?: {
  timeoutMs?: number
  settleMs?: number
}): Promise<ClaudeAutoSubmitResult> {
  if (process.platform !== 'win32') {
    return { status: 'unsupported', reason: 'Automatic paste is only supported on Windows.' }
  }
  const timeoutMs = Math.max(500, Math.min(10_000, options?.timeoutMs ?? 3500))
  const settleMs = Math.max(100, Math.min(3000, options?.settleMs ?? 500))
  const encoded = Buffer.from(buildAutoSubmitPowerShell(timeoutMs, settleMs), 'utf16le').toString('base64')

  return new Promise<ClaudeAutoSubmitResult>((resolve) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, timeout: timeoutMs + settleMs + 8000, maxBuffer: 512_000 },
        (_error, stdout) => {
          resolve(parseAutoSubmitOutput(typeof stdout === 'string' ? stdout : ''))
        }
      )
    } catch {
      resolve({ status: 'send-failed', reason: 'Could not start the Windows paste helper.' })
    }
  })
}
