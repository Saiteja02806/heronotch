import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ForegroundSample } from '../shared/presence'

/**
 * Watches the foreground window on Windows. A window that covers the display
 * the notch lives on counts as fullscreen, which is how borderless games and
 * full-screen video present themselves. Notch's own window is reported as
 * `own`.
 *
 * The polling loop runs in one long-lived PowerShell host, but every tick is a
 * single call into a small compiled C# sampler instead of a PowerShell object
 * pipeline. The old loop built a fresh Process object (and a fresh hashtable,
 * then a JSON document) 1.25 times a second, which cost real CPU on a laptop
 * and kept the .NET GC in the shell busy all day. The sampler keeps the same
 * `{process, fullscreen, own, browserOpen}` contract.
 */

export interface TargetSize {
  width: number
  height: number
  centerX?: number
  centerY?: number
}

const SAMPLE_MS = 800
/** A browser opened or closed; it is not something that happens between frames. */
const BROWSER_RECHECK_MS = 5000

export function buildScript(target: TargetSize, watchBrowser: boolean): string {
  const width = Math.max(1, Math.round(target.width))
  const height = Math.max(1, Math.round(target.height))
  const hasCenter = typeof target.centerX === 'number' && typeof target.centerY === 'number'
  const centerX = hasCenter ? Math.round(target.centerX!) : 0
  const centerY = hasCenter ? Math.round(target.centerY!) : 0
  const browserSetup = watchBrowser
    ? `
$browserNames = @('chrome','msedge','firefox','brave','opera','opera_gx','vivaldi','Arc','zen','waterfox','librewolf','chromium')
# Include other installed browsers registered with Windows, as well as portable copies above.
$clientRoots = 'HKCU:\\SOFTWARE\\Clients\\StartMenuInternet','HKLM:\\SOFTWARE\\Clients\\StartMenuInternet','HKLM:\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet'
foreach ($client in (Get-ChildItem $clientRoots -ErrorAction SilentlyContinue)) {
  $commandKey = Get-Item -LiteralPath ($client.PSPath + '\\shell\\open\\command') -ErrorAction SilentlyContinue
  if ($commandKey -and ($commandKey.GetValue('') -match '^\\s*"?([^"]+?\\.exe)(?:"|\\s|$)')) {
    $browserNames += [IO.Path]::GetFileNameWithoutExtension($Matches[1])
  }
}
[NotchFore]::SetBrowsers(@($browserNames | Sort-Object -Unique))
`
    : '[NotchFore]::SetBrowsers(@())'
  return `
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public class NotchFore {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
  }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

  static readonly HashSet<string> ignoredClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "NotifyIconOverflowWindow",
    "TopLevelWindowForOverflowXamlWindow",
    "MultitaskingViewFrame",
    "TaskListThumbnailWnd",
    "ForegroundStaging",
    "XamlExplorerHostWindow",
    "EdgeUiInputTopWndClass",
    "EdgeUiInputWndClass",
    "Shell_LightDismissOverlay"
  };

  static readonly HashSet<string> ignoredShellProcesses = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
    "StartMenuExperienceHost",
    "SearchHost",
    "SearchApp",
    "ShellExperienceHost",
    "TextInputHost",
    "LockApp",
    "CredentialUIBroker",
    "ScreenClippingHost",
    "SnippingTool"
  };

  static int targetWidth = 1920;
  static int targetHeight = 1080;
  static bool hasTargetCenter = false;
  static POINT targetCenter;
  static int notchPid = 0;
  static HashSet<string> browsers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  static Dictionary<uint, string> nameCache = new Dictionary<uint, string>();
  static bool browserOpen = false;
  static long browserCheckedTicks = 0;
  static readonly long browserRecheckTicks = (${BROWSER_RECHECK_MS}L * Stopwatch.Frequency) / 1000L;

  public static void Configure(int width, int height, bool hasCenter, int cx, int cy, int pid) {
    targetWidth = width;
    targetHeight = height;
    hasTargetCenter = hasCenter;
    targetCenter.X = cx;
    targetCenter.Y = cy;
    notchPid = pid;
    // Physical pixels keep the comparison honest on a second monitor with a
    // different scale factor than the primary one.
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
    catch { try { SetProcessDPIAware(); } catch {} }
  }

  public static void SetBrowsers(string[] names) {
    var next = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    if (names != null) {
      foreach (var name in names) {
        if (!string.IsNullOrEmpty(name)) next.Add(name);
      }
    }
    browsers = next;
    browserOpen = false;
    browserCheckedTicks = 0;
  }

  static string NameOf(uint pid) {
    string cached;
    if (nameCache.TryGetValue(pid, out cached)) return cached;
    string name = "";
    try {
      using (var proc = Process.GetProcessById((int)pid)) {
        name = proc.ProcessName;
      }
    } catch {}
    // Bounded: a long session cannot grow this without limit.
    if (nameCache.Count > 256) nameCache.Clear();
    nameCache[pid] = name;
    return name;
  }

  static bool HasWindowedBrowser() {
    if (browsers.Count == 0) return false;
    // Stopwatch.GetTimestamp() avoids the 24.8-day Environment.TickCount wraparound.
    var now = Stopwatch.GetTimestamp();
    if (browserCheckedTicks != 0 && (now - browserCheckedTicks) < browserRecheckTicks) return browserOpen;
    browserCheckedTicks = now;
    var open = false;
    try {
      foreach (var process in Process.GetProcesses()) {
        try {
          if (process.MainWindowHandle == IntPtr.Zero) continue;
          if (browsers.Contains(process.ProcessName)) { open = true; break; }
        } catch {} finally { process.Dispose(); }
      }
    } catch {}
    browserOpen = open;
    return open;
  }

  public static string Sample() {
    return SampleWindow(GetForegroundWindow());
  }

  public static string SampleWindow(IntPtr hwnd) {
    try {
      bool browser = HasWindowedBrowser();
      if (hwnd == IntPtr.Zero) {
        return Build("", false, false, browser);
      }
      RECT rect;
      if (!GetWindowRect(hwnd, out rect)) {
        return Build("", false, false, browser);
      }
      uint pid = 0;
      GetWindowThreadProcessId(hwnd, out pid);
      string name = pid == 0 ? "" : NameOf(pid);
      bool own = pid != 0 && pid == (uint)notchPid;
      if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) {
        return Build(name, false, own, browser);
      }
      int cloaked = 0;
      try {
        if (DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0) {
          return Build(name, false, own, browser);
        }
      } catch {}
      var classBuf = new StringBuilder(128);
      GetClassName(hwnd, classBuf, 128);
      string cls = classBuf.ToString();
      // Clicking the desktop (Progman/WorkerW) or opening full-screen Windows
      // shell overlays (Start, Search, Alt-Tab, Quick Settings) gives an un-zoomed
      // screen-sized window; never treat Windows shell surfaces as fullscreen apps.
      bool shellSurface = ignoredClasses.Contains(cls) || ignoredShellProcesses.Contains(name);
      // A maximized window or a normal resizable desktop window (even when stretched
      // to fill an auto-hide-taskbar workArea) keeps WS_CAPTION + WS_THICKFRAME.
      // Real fullscreen apps (F11 browser, video, borderless games) strip that chrome.
      bool zoomed = IsZoomed(hwnd);
      int style = GetWindowLong(hwnd, -16);
      const int WS_CAPTION = 0x00C00000;
      const int WS_THICKFRAME = 0x00040000;
      bool hasWindowChrome = (style & (WS_CAPTION | WS_THICKFRAME)) == (WS_CAPTION | WS_THICKFRAME);

      IntPtr targetMon = hasTargetCenter ? MonitorFromPoint(targetCenter, 2) : IntPtr.Zero;
      IntPtr fgMon = MonitorFromWindow(hwnd, 2);
      bool sameMonitor = true;
      if (hasTargetCenter && targetMon != IntPtr.Zero && fgMon != IntPtr.Zero && targetMon != fgMon) {
        sameMonitor = false;
      }

      RECT monRect;
      monRect.Left = 0; monRect.Top = 0; monRect.Right = targetWidth; monRect.Bottom = targetHeight;
      bool haveMonRect = false;
      IntPtr checkMon = targetMon != IntPtr.Zero ? targetMon : fgMon;
      if (checkMon != IntPtr.Zero) {
        MONITORINFO mi = new MONITORINFO();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (GetMonitorInfo(checkMon, ref mi) && (mi.rcMonitor.Right - mi.rcMonitor.Left) > 0 && (mi.rcMonitor.Bottom - mi.rcMonitor.Top) > 0) {
          monRect = mi.rcMonitor;
          haveMonRect = true;
        }
      }

      RECT vis = rect;
      try {
        RECT ext;
        if (DwmGetWindowAttribute(hwnd, 9, out ext, Marshal.SizeOf(typeof(RECT))) == 0
          && ext.Right > ext.Left && ext.Bottom > ext.Top) {
          vis = ext;
        }
      } catch {}

      int width = vis.Right - vis.Left;
      int height = vis.Bottom - vis.Top;
      int monW = haveMonRect ? (monRect.Right - monRect.Left) : targetWidth;
      int monH = haveMonRect ? (monRect.Bottom - monRect.Top) : targetHeight;
      bool coversEdges = haveMonRect
        ? (vis.Left <= monRect.Left + 2 && vis.Top <= monRect.Top + 2 && vis.Right >= monRect.Right - 2 && vis.Bottom >= monRect.Bottom - 2)
        : (width >= targetWidth - 12 && height >= targetHeight - 12);
      bool covers = !shellSurface
        && sameMonitor
        && !zoomed
        && !hasWindowChrome
        && coversEdges
        && width <= monW + 48
        && height <= monH + 48;
      return Build(name, covers && !own, own, browser);
    } catch {
      return Build("", false, false, false);
    }
  }

  static string Build(string name, bool fullscreen, bool own, bool browser) {
    var json = new StringBuilder(96);
    json.Append("{\\"process\\":\\"");
    AppendEscaped(json, name);
    json.Append("\\",\\"fullscreen\\":").Append(fullscreen ? "true" : "false");
    json.Append(",\\"own\\":").Append(own ? "true" : "false");
    json.Append(",\\"browserOpen\\":").Append(browser ? "true" : "false").Append('}');
    return json.ToString();
  }

  static void AppendEscaped(StringBuilder target, string value) {
    if (string.IsNullOrEmpty(value)) return;
    foreach (char c in value) {
      if (c == '"' || c == '\\\\') target.Append('\\\\').Append(c);
      else if (c < ' ') target.Append(' ');
      else target.Append(c);
    }
  }
}
"@
[NotchFore]::Configure(${width}, ${height}, ${hasCenter ? '$true' : '$false'}, ${centerX}, ${centerY}, ${process.pid})
${browserSetup}
# Thread.Sleep keeps the loop out of the PowerShell pipeline entirely.
while ($true) {
  try {
    if (-not (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue)) { break }
    [Console]::Out.WriteLine([NotchFore]::Sample())
    [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine('{"process":"","fullscreen":false,"own":false,"browserOpen":false}')
    [Console]::Out.Flush()
  }
  [System.Threading.Thread]::Sleep(${SAMPLE_MS})
}
`
}

export function resolveForegroundExe(
  resourcesPath = process.resourcesPath || '',
  cwd = process.cwd(),
  fileExists: (file: string) => boolean = existsSync
): string {
  const relFallback =
    typeof __dirname === 'string' ? path.resolve(__dirname, '../../resources/notch-foreground.exe') : ''
  const candidates = [
    resourcesPath
      ? path.join(resourcesPath, 'app.asar.unpacked', 'resources', 'notch-foreground.exe')
      : '',
    resourcesPath ? path.join(resourcesPath, 'notch-foreground.exe') : '',
    resourcesPath ? path.join(resourcesPath, 'resources', 'notch-foreground.exe') : '',
    cwd ? path.join(cwd, 'resources', 'notch-foreground.exe') : '',
    relFallback
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (!/[\\/]app\.asar([\\/]|$)/i.test(candidate) && fileExists(candidate)) {
      return candidate
    }
  }
  return ''
}

export function buildForegroundExeArgs(target: TargetSize, browserOnly: boolean, parentPid = process.pid): string[] {
  const width = Math.max(1, Math.round(target.width))
  const height = Math.max(1, Math.round(target.height))
  const args = [
    '--width',
    String(width),
    '--height',
    String(height),
    '--pid',
    String(parentPid),
    '--exit-with-parent',
    '--interval',
    String(SAMPLE_MS)
  ]
  if (typeof target.centerX === 'number' && typeof target.centerY === 'number') {
    args.push('--cx', String(Math.round(target.centerX)), '--cy', String(Math.round(target.centerY)))
  }
  if (browserOnly) args.push('--watch-browser')
  return args
}

let child: ChildProcess | null = null
let restartTimer: ReturnType<typeof setTimeout> | null = null
let consecutiveFailures = 0
let forcePowerShell = false
let stopped = false
let listener: ((sample: ForegroundSample) => void) | null = null
let target: TargetSize | null = null
let watchBrowser = false

function clearRestartTimer(): void {
  if (!restartTimer) return
  clearTimeout(restartTimer)
  restartTimer = null
}

export function startForegroundWatch(
  onSample: (sample: ForegroundSample) => void,
  nextTarget?: TargetSize,
  browserOnly = watchBrowser
): void {
  listener = onSample
  if (nextTarget) target = nextTarget
  watchBrowser = browserOnly
  if (process.platform !== 'win32' || child) return
  stopped = false
  clearRestartTimer()
  const effectiveTarget = target || { width: 1920, height: 1080 }
  const helperExe = forcePowerShell ? '' : resolveForegroundExe()
  const startedAt = Date.now()
  try {
    child = helperExe
      ? spawn(helperExe, buildForegroundExeArgs(effectiveTarget, watchBrowser), {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      : spawn(
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
            buildScript(effectiveTarget, watchBrowser)
          ],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        )
  } catch {
    child = null
    if (helperExe) {
      forcePowerShell = true
      startForegroundWatch(onSample)
    }
    return
  }
  const spawned = child
  let buffer = ''
  let sawSample = false
  spawned.stderr?.on('data', () => undefined)
  spawned.stdout?.setEncoding('utf8')
  spawned.stdout?.on('data', (chunk: string) => {
    if (child !== spawned) return
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('{')) {
        try {
          const parsed = JSON.parse(line) as ForegroundSample
          if (!sawSample) {
            sawSample = true
            consecutiveFailures = 0
          }
          onSample({
            process: String(parsed.process || ''),
            fullscreen: Boolean(parsed.fullscreen),
            own: Boolean(parsed.own),
            browserOpen: parsed.browserOpen === true
          })
        } catch {
          // Ignore a partial line.
        }
      }
      newline = buffer.indexOf('\n')
    }
  })
  const restart = (): void => {
    if (child !== spawned) return
    child = null
    if (stopped) return
    const ranShort = !sawSample || Date.now() - startedAt < 5_000
    consecutiveFailures = ranShort ? consecutiveFailures + 1 : 0
    if (helperExe && consecutiveFailures >= 3) {
      forcePowerShell = true
      consecutiveFailures = 0
    }
    if (consecutiveFailures >= 6) return
    const delay = Math.min(30_000, 3_000 * Math.pow(2, Math.max(0, consecutiveFailures - 1)))
    clearRestartTimer()
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (!stopped && !child) startForegroundWatch(onSample)
    }, delay)
    restartTimer.unref?.()
  }
  spawned.once('error', restart)
  spawned.once('exit', restart)
}

/** Point the watcher at another display without losing the listener. */
export function setForegroundTarget(next: TargetSize, browserOnly = watchBrowser): void {
  if (!next || next.width <= 0 || next.height <= 0) return
  if (
    target &&
    watchBrowser === browserOnly &&
    Math.abs(target.width - next.width) < 2 &&
    Math.abs(target.height - next.height) < 2 &&
    target.centerX === next.centerX &&
    target.centerY === next.centerY
  ) {
    return
  }
  target = next
  watchBrowser = browserOnly
  if (!listener || stopped) return
  const current = listener
  const previous = child
  child = null
  clearRestartTimer()
  previous?.kill()
  startForegroundWatch(current)
}

export function stopForegroundWatch(): void {
  stopped = true
  clearRestartTimer()
  child?.kill()
  child = null
}

export function pauseForegroundWatch(): void {
  stopped = true
  clearRestartTimer()
  child?.kill()
  child = null
}

export function resumeForegroundWatch(): void {
  if (!listener) return
  stopped = false
  consecutiveFailures = 0
  startForegroundWatch(listener)
}
