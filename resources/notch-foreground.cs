using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

// Notch foreground window watcher.
// Pre-compiled so Windows Smart App Control and Microsoft Store MSIX packages
// never rely on PowerShell Add-Type compiling unsigned DLLs into %TEMP%.
//
// Rebuild with:
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe -nologo -optimize+ -t:exe -out:resources\notch-foreground.exe resources\notch-foreground.cs

public static class NotchFore {
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

  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

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

  static readonly string[] defaultBrowsers = new[] {
    "chrome", "msedge", "firefox", "brave", "opera", "opera_gx",
    "vivaldi", "Arc", "zen", "waterfox", "librewolf", "chromium"
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
  static readonly long browserRecheckTicks = (5000L * Stopwatch.Frequency) / 1000L;

  public static void Configure(int width, int height, bool hasCenter, int cx, int cy, int pid) {
    targetWidth = width;
    targetHeight = height;
    hasTargetCenter = hasCenter;
    targetCenter.X = cx;
    targetCenter.Y = cy;
    notchPid = pid;
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
    catch { try { SetProcessDPIAware(); } catch {} }
  }

  public static void LoadBrowsers(bool watchBrowser) {
    var next = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    if (watchBrowser) {
      foreach (var b in defaultBrowsers) next.Add(b);
      AddBrowsersFromRoot(Registry.CurrentUser, @"SOFTWARE\Clients\StartMenuInternet", next);
      AddBrowsersFromRoot(Registry.LocalMachine, @"SOFTWARE\Clients\StartMenuInternet", next);
      AddBrowsersFromRoot(Registry.LocalMachine, @"SOFTWARE\WOW6432Node\Clients\StartMenuInternet", next);
    }
    browsers = next;
    browserOpen = false;
    browserCheckedTicks = 0;
  }

  static void AddBrowsersFromRoot(RegistryKey root, string subKey, HashSet<string> targetSet) {
    try {
      using (var clients = root.OpenSubKey(subKey)) {
        if (clients == null) return;
        foreach (var childName in clients.GetSubKeyNames()) {
          try {
            using (var cmdKey = clients.OpenSubKey(childName + @"\shell\open\command")) {
              if (cmdKey == null) continue;
              var val = cmdKey.GetValue("") as string;
              if (string.IsNullOrEmpty(val)) continue;
              var match = Regex.Match(val, @"^\s*""?([^""]+?\.exe)(?:""|\s|$)", RegexOptions.IgnoreCase);
              if (match.Success) {
                var exeName = Path.GetFileNameWithoutExtension(match.Groups[1].Value);
                if (!string.IsNullOrEmpty(exeName)) targetSet.Add(exeName);
              }
            }
          } catch {}
        }
      }
    } catch {}
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
    if (nameCache.Count > 256) nameCache.Clear();
    nameCache[pid] = name;
    return name;
  }

  static bool HasWindowedBrowser() {
    if (browsers.Count == 0) return false;
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
      bool shellSurface = ignoredClasses.Contains(cls) || ignoredShellProcesses.Contains(name);
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
    json.Append("{\"process\":\"");
    AppendEscaped(json, name);
    json.Append("\",\"fullscreen\":").Append(fullscreen ? "true" : "false");
    json.Append(",\"own\":").Append(own ? "true" : "false");
    json.Append(",\"browserOpen\":").Append(browser ? "true" : "false").Append('}');
    return json.ToString();
  }

  static void AppendEscaped(StringBuilder target, string value) {
    if (string.IsNullOrEmpty(value)) return;
    foreach (char c in value) {
      if (c == '"' || c == '\\') target.Append('\\').Append(c);
      else if (c < ' ') target.Append(' ');
      else target.Append(c);
    }
  }

  public static int Main(string[] args) {
    int width = 1920;
    int height = 1080;
    bool hasCenter = false;
    int cx = 0;
    int cy = 0;
    int pid = 0;
    bool watchBrowser = false;
    bool exitWithParent = false;
    bool probe = false;
    int intervalMs = 800;

    for (int i = 0; i < args.Length; i++) {
      var arg = args[i];
      if (arg == "--watch-browser") { watchBrowser = true; continue; }
      if (arg == "--exit-with-parent") { exitWithParent = true; continue; }
      if (arg == "--probe") { probe = true; continue; }
      if (i + 1 >= args.Length) continue;
      int parsed;
      if (arg == "--width" && int.TryParse(args[++i], out parsed) && parsed > 0) width = parsed;
      else if (arg == "--height" && int.TryParse(args[++i], out parsed) && parsed > 0) height = parsed;
      else if (arg == "--cx" && int.TryParse(args[++i], out parsed)) { cx = parsed; hasCenter = true; }
      else if (arg == "--cy" && int.TryParse(args[++i], out parsed)) { cy = parsed; hasCenter = true; }
      else if (arg == "--pid" && int.TryParse(args[++i], out parsed) && parsed > 0) pid = parsed;
      else if (arg == "--interval" && int.TryParse(args[++i], out parsed) && parsed >= 100) intervalMs = parsed;
    }

    Console.OutputEncoding = Encoding.UTF8;
    Configure(width, height, hasCenter, cx, cy, pid);
    LoadBrowsers(watchBrowser);

    if (probe) {
      Console.Out.WriteLine("READY");
      Console.Out.Flush();
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        long handle;
        if (long.TryParse(line.Trim(), out handle)) {
          Console.Out.WriteLine(SampleWindow(new IntPtr(handle)));
        } else {
          Console.Out.WriteLine("{\"process\":\"\",\"fullscreen\":false,\"own\":false,\"browserOpen\":false}");
        }
        Console.Out.Flush();
      }
      return 0;
    }

    while (true) {
      if (exitWithParent && pid > 0) {
        try {
          using (var parent = Process.GetProcessById(pid)) {
            if (parent.HasExited) return 0;
          }
        } catch {
          return 0;
        }
      }
      try {
        Console.Out.WriteLine(Sample());
        Console.Out.Flush();
      } catch {
        Console.Out.WriteLine("{\"process\":\"\",\"fullscreen\":false,\"own\":false,\"browserOpen\":false}");
        Console.Out.Flush();
      }
      Thread.Sleep(intervalMs);
    }
  }
}
