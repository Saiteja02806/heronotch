# Notch for macOS: port specification

Hand-off document for the IDE/agent running on the Mac. It was written from a
read-through of the Windows codebase (Notch 1.0.22, Electron 45, electron-vite,
electron-builder 26). Nothing here has been run on a Mac. Every item marked
**[verify]** is an assumption about macOS/Electron behavior that must be
confirmed on a real machine before it is relied on.

## 0. Ground rules

1. **Do not break Windows.** Keep every Windows code path as it is. Add macOS
   behavior behind `process.platform === 'darwin'` (or a small helper such as
   `src/main/platform.ts` exporting `isMac`, `isWin`). The Windows build must
   still produce the same artifacts.
2. **No Apple Developer account.** The Mac build is unsigned or ad-hoc signed
   and not notarized. That drives several decisions (section 2): no auto-update,
   a Gatekeeper workaround for users, and permission grants that can reset.
3. **Degrade, don't crash.** Any feature without a macOS implementation yet must
   return an empty or "unavailable" result and hide its UI. It must not spawn a
   Windows binary or throw.
4. **Keep the shared contracts.** The renderer talks to the main process through
   `src/preload/index.ts` and the IPC handlers in `src/main/index.ts`. Do not
   change those shapes. Replace what sits behind them.
5. After each phase run `npm run typecheck` and the relevant `scripts/check-*`
   scripts. Some of those scripts may assume Windows. If so, skip that part on
   macOS rather than deleting it.

Suggested branch: `macos-port`. Suggested order: Phase A to F in section 9.

## 1. Scope

**In the first macOS release (v1):**
- Notch window docked at the top of the screen, hover or click to open, panel,
  tray (menu bar) icon, global shortcuts.
- Notes (Obsidian-style vault), tasks, timer, water, posture (camera), planner,
  Google Calendar, phone transfer, settings, themes.
- Spotify, via the Spotify Web API (already cross-platform) **plus** local
  control of the Spotify and Apple Music apps through AppleScript.
- Coding-agent status through hooks (Claude Code, Codex, Cursor, Gemini), because
  that path is an HTTP server on loopback plus config-file edits.
- Manual update check that links to the GitHub Release.

**Deferred (v1.1+):**
- Reading "now playing" from browsers (YouTube Music in Chrome, etc.). macOS has
  no supported public API for this. Skip it.
- Sending messages into other apps' sessions (`sessions:send`) for every
  provider. Do Claude Code and Codex first (they use CLIs).
- Window-title-based detection of generic Electron or JVM hosts. It needs the
  Screen Recording permission on macOS. Use app-bundle names instead.

**Out of scope (Windows-only, hide on macOS):** Microsoft Store/appx, NSIS and
portable installers, Smart App Control status, `notch-foreground.exe`,
`notch-media-art.dll`, `StartupTask`.

## 2. Distribution without an Apple Developer account

| Topic | Decision |
| --- | --- |
| Signing | Build unsigned, then **ad-hoc sign** (`codesign --sign -`). Apple Silicon refuses to run a modified arm64 binary that has no signature, which shows up as "app is damaged". electron-builder may ad-hoc sign by itself; confirm with `codesign -dv --verbose=4 Notch.app` and add the step below if it is missing **[verify]**. |
| Notarization | None (needs the paid account). |
| Gatekeeper | First launch is blocked. Users must do one of: (a) System Settings > Privacy & Security > scroll to the Notch message > **Open Anyway** (macOS 15 Sequoia and later removed the old right-click > Open shortcut); (b) run `xattr -dr com.apple.quarantine /Applications/Notch.app`. Document this in the README and on the download page, with a screenshot. |
| Optional improvement | Create a free **self-signed code-signing certificate** in Keychain Access (Certificate Assistant > Create a Certificate > Code Signing) and sign every release with the same one. It still triggers Gatekeeper, but macOS then sees the same app identity across versions, so Camera, Automation and Screen Recording permission grants survive updates. With plain ad-hoc signing the identity changes every build, and users may be asked for permissions again after each update **[verify]**. |
| Auto-update | **Disabled on macOS.** `electron-updater` on macOS requires a properly signed app. Use the existing "manual update" path (GitHub Releases API, open the download link). See section 4.5. |
| Architectures | Build **two DMGs**: `arm64` (Apple Silicon, primary) and `x64` (Intel). The app has no native Node modules, so cross-arch builds are straightforward. A `universal` build also works but doubles the download size and forces the Swift helpers to be `lipo`-merged. Name them `Notch-<version>-arm64.dmg` and `Notch-<version>-x64.dmg`. |
| Minimum macOS | Check the Electron 45 release notes for its supported macOS floor and set `mac.minimumSystemVersion` to match **[verify]**. |
| Distribution | GitHub Releases next to the Windows files. A Homebrew cask is possible later, but unsigned apps need `--no-quarantine`, so skip it for v1. |

## 3. Build system changes

### 3.1 `package.json`

Add a `mac` block under `build` (do not touch `win`, `nsis`, `portable`, `appx`):

```jsonc
"mac": {
  "category": "public.app-category.productivity",
  "target": [
    { "target": "dmg", "arch": ["arm64", "x64"] },
    { "target": "zip", "arch": ["arm64", "x64"] }
  ],
  "icon": "build/icon.icns",
  "identity": null,                       // no Apple certificate
  "hardenedRuntime": false,               // only meaningful with a real identity
  "gatekeeperAssess": false,
  "extendInfo": {
    "LSUIElement": true,                  // no Dock icon, no app-switcher entry
    "NSCameraUsageDescription": "Notch uses the camera for posture reminders. Video never leaves your Mac.",
    "NSAppleEventsUsageDescription": "Notch controls Spotify and Music to play, pause and skip.",
    "NSLocalNetworkUsageDescription": "Notch shares files with your phone over your local network."
  },
  "artifactName": "Notch-${version}-${arch}.${ext}",
  "extraResources": [
    { "from": "resources/mac", "to": "mac", "filter": ["**/*"] }   // compiled Swift helpers, see section 5
  ]
},
"dmg": { "title": "Notch ${version}" }
```

Also:
- `files` is `["out/**/*", "resources/**/*"]`. That would pack the Windows-only
  `resources/notch-foreground.exe`, `notch-media-art.dll` and `.cs` sources into
  the Mac app. Exclude them with `"!resources/*.exe"`, `"!resources/*.dll"`,
  `"!resources/*.cs"` (or use a per-platform `files` under `mac`). Leave the
  Windows `asarUnpack` entries alone.
- `description` currently says "for Windows". Update it to "for Windows and macOS".
- Scripts to add (keep the existing ones):
  - `"dist:mac": "npm run build && electron-builder --mac --arm64 --x64"`
  - `"dist:mac:arm64": "npm run build && electron-builder --mac --arm64"`
  - `"verify:mac": "node scripts/verify-mac.mjs"` (optional: runs `codesign -dv`
    and `file` on the produced app and prints the architectures)
- `publish` block (GitHub) stays. Run builds with `--publish never` and upload
  files manually or from CI, since there is no signed update feed.

### 3.2 Files to create

| File | Notes |
| --- | --- |
| `build/icon.icns` | Generate from a 1024x1024 PNG via `iconutil` (iconset with 16 to 512 at 1x and 2x). Source: `resources/icon.png`. |
| `resources/trayTemplate.png` and `resources/trayTemplate@2x.png` | 16x16 and 32x32, **black glyph with transparent background**. macOS tints "template" images to match the menu bar. The existing `resources/tray.png` is a coloured Windows icon and will look wrong. |
| `build/entitlements.mac.plist` | Not needed while `identity` is null (entitlements only apply under hardened runtime). Add it only if you later get a real certificate. |
| `scripts/adhoc-sign-mac.cjs` | electron-builder `afterPack` hook, only if the app is not already ad-hoc signed: on `electronPlatformName === 'darwin'` run `codesign --force --deep --sign - "<appOutDir>/Notch.app"`. Reference it from `build.afterPack`. |

### 3.3 Continuous integration (optional but recommended)

A new workflow `.github/workflows/release-mac.yml` (leave the Windows workflows
untouched):

- `runs-on: macos-latest` (Apple Silicon runner). It can also produce the x64
  build because there are no native modules, but compile the Swift helpers once
  per arch (section 5).
- Steps: checkout, `actions/setup-node` (Node 22, as in the Windows workflow),
  `npm ci`, `npm run typecheck`, compile Swift helpers, `npm run dist:mac` with
  `CSC_IDENTITY_AUTO_DISCOVERY=false`, upload `release/*.dmg` and `release/*.zip`
  as artifacts and attach them to the tag's release.
- No secrets are needed for this workflow.
- `release-unsigned.yml` triggers on tags. Decide whether the Mac job runs on the
  same tags. Do not let a Mac failure block the Windows release.

## 4. Main-process changes (`src/main/`)

Priorities: **P0** = the app is unusable without it. **P1** = needed for v1
features. **P2** = polish or later.

### 4.1 P0: Click-through region (`applyWindowShape`, `index.ts:538`)

**Windows behavior.** The collapsed window is the size of the whole display
(`refreshCollapsedLayout`, `index.ts:357` returns `display.bounds`). It is made
click-through everywhere except the tab by `BrowserWindow.setShape(rects)`.

**Why macOS breaks.** `setShape` is documented as Windows/Linux only
**[verify]**. Here it is wrapped in `try/catch`, so on macOS it silently does
nothing, and a transparent full-screen window would then **swallow every click
on the desktop**. This is the most dangerous issue in the port.

**What to do on macOS.** Replace shaping with mouse-event toggling:
- Keep the window display-sized, but call
  `mainWindow.setIgnoreMouseEvents(true, { forward: true })` while the pointer is
  outside every interactive rectangle, and `setIgnoreMouseEvents(false)` while
  it is inside one. `forward: true` lets the renderer still receive `mousemove`.
- The interactive rectangles already exist in main: `collapsedShape` (the tab)
  when collapsed, and `expandedShape` (panel rects reported by the renderer) when
  expanded. Reuse those values. They are in window-local coordinates.
- Drive the toggle from main with a small timer (about 16 to 30 ms) using
  `screen.getCursorScreenPoint()` while the window is visible, converted to
  window space, hit-tested against the current rectangles (with the same margins
  as `tabHit`). The timer only runs while the window is visible and not hidden.
  Alternatively let the renderer report `pointerenter` and `pointerleave` on the
  interactive elements via IPC. Pick the simpler one that tests well.
- When the notch is expanded with focus mode on, the rectangle is the whole
  screen (the backdrop takes clicks), so ignore-mouse stays off.
- Wrap this in a function `applyInputRegion()` that calls `setShape` on Windows
  and the new logic on macOS, so the call sites (`applyWindowShape` is called
  from several places) do not change.

**Acceptance:** with the notch collapsed, clicking a menu-bar item or a window
anywhere except the tab works. Hovering the tab still opens the notch.

### 4.2 P0: Window creation, placement and notch geometry (`createWindow`, `index.ts:~760`)

1. **Menu bar overlap.** The layout uses `display.workArea`
   (`refreshCollapsedLayout`), which on macOS **excludes the menu bar** and, on a
   notched MacBook, the area beside the notch. The tab would sit below the menu
   bar instead of in it. Use `display.bounds` for the vertical anchor on macOS so
   the tab sits at the very top edge, and set `y` so the tab overlaps the menu
   bar (that is what a "notch" app does). Also macOS clamps frameless windows
   below the menu bar unless the window is created with `enableLargerThanScreen:
   true` (or `type: 'panel'`) **[verify]**.
2. **Window type.** Add `type: 'panel'` on macOS (an NSPanel: it does not
   activate the app when clicked and floats over full-screen apps). Keep
   `type: 'toolbar'` for Windows. Remove nothing else.
3. **Always on top and Spaces.** The code already calls
   `setAlwaysOnTop(true, 'screen-saver')` and
   `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
   (`index.ts:833`). On macOS pass `skipTransformProcessType: true` to the latter
   to avoid a Dock icon flicker **[verify]**. Re-check that the window stays above
   full-screen apps and across Spaces.
4. **Dock and app switcher.** `LSUIElement` (section 3.1) hides the app from the
   Dock. Also call `app.dock?.hide()` very early in startup on macOS. This also
   makes the app an "accessory" app, which is what lets it float over full-screen
   Spaces. `setSkipTaskbar` and `app.setAppUserModelId` are no-ops on macOS and
   can stay.
5. **Real notch.** MacBooks with a physical notch have a camera housing in the
   top centre of the built-in display. Electron does not report its size.
   Approach for v1: use the existing `notch-wide`/`notch-micro`/`pill` styles
   (`shared/notchLayout.ts` `TAB_SPECS`), default the built-in display on macOS to
   a style that wraps a fixed-size housing (around 200 to 210 px wide by about
   32 to 38 px tall in points; the real value differs per model, so make it a small
   table keyed by display size **[verify]**), and leave external displays on the
   pill style (`effectiveNotchStyle` in `notchDisplay.ts` already does this for
   non-primary displays). A precise value can be read later with a Swift helper
   (`NSScreen.safeAreaInsets` and `auxiliaryTopLeftArea`).
6. **Global shortcuts.** `CommandOrControl+Shift+Space` and
   `CommandOrControl+Alt+Space` (`registerGlobalShortcuts`, `index.ts:1837`) map
   to Cmd on macOS. Confirm neither conflicts with a system shortcut. The global
   `Escape` registration while expanded works without extra permissions.
7. **Application menu.** The code does not call `Menu.setApplicationMenu`, so the
   default menu (with the Edit role) exists. Keep it so Cmd+C/V/X/A/Z work in
   text fields. Do not set the menu to `null` on macOS.
8. **Window close.** `window-all-closed` (`index.ts:2127`) only quits when
   `quitting` is set, which is correct for a menu-bar app on macOS.
9. **Screen change events.** Check display add/remove and resolution changes
   (the code listens through `screen`) and `powerMonitor` suspend/resume and
   `lock-screen` (`index.ts:2057` to `2080`) behave the same.

### 4.3 P0: Tray / menu bar icon (`createTray`, `index.ts:1065`)

- Load `trayTemplate.png` and call `icon.setTemplateImage(true)` on macOS.
- On macOS, when a context menu is set with `tray.setContextMenu`, a left click
  opens the menu and the `click` handler does not fire as it does on Windows
  **[verify]**. Choose: menu-only on macOS (simplest), or do not call
  `setContextMenu` and use `tray.on('click')` for toggle plus `tray.on('right-click')`
  with `tray.popUpContextMenu(menu)`.
- `tray.setToolTip` is harmless.

### 4.4 P0: Guard every Windows-only call so macOS never executes it

Each of these either already has a `process.platform !== 'win32'` guard (fine,
verify it returns a safe value) or does **not** and will run `powershell.exe`,
`where.exe`, `taskkill` or `cmd.exe` on a Mac:

| Location | What it does | macOS action |
| --- | --- | --- |
| `index.ts:156` `syncStoreStartupTask` | Microsoft Store startup task | Guarded. Leave. |
| `index.ts:177` `syncLoginItem` | `app.setLoginItemSettings({ openAtLogin, path: PORTABLE_EXECUTABLE_FILE \|\| execPath })` | Works on macOS. For packaged macOS builds just pass `openAtLogin` (no `path`). Note that a login item for an unsigned app may prompt the user in System Settings > Login Items **[verify]**. |
| `index.ts:615` `readSmartAppControlState` | `reg.exe` | Guarded. Hide the Smart App Control row in Settings on macOS. |
| `index.ts:1596` to `1629` Spotify paths | Windows install paths, `WindowsApps` | See 4.8. |
| `index.ts:1823` `sessions:focus-codex` | PowerShell `AppActivate` | Not guarded. On macOS use `osascript -e 'tell application "ChatGPT" to activate'` (or `open -a ChatGPT`), resolve `false` on failure. |
| `foreground.ts:373` | spawns helper exe or PowerShell | Guarded. See 5.1 for the macOS replacement. |
| `localMedia.ts:505` | PowerShell media monitor | Guarded. See 5.2. |
| `openCodeApprovals.ts:139` | `Get-NetTCPConnection` | Guarded. See 4.7. |
| `agentStatus.ts:905` `hookCommand` | writes `powershell -EncodedCommand` into other tools' config | **Not guarded. Critical.** See 4.6. |
| `agentStatus.ts:1699` `copyToClipboardAndFocus` | PowerShell clipboard and `AppActivate` | Guarded (returns on non-Windows), so nothing happens. Implement macOS: `clipboard.writeText(text)` from Electron (cross-platform) and `osascript` activate. |
| `agentStatus.ts:1499` | `WindowsApps` path for the Codex binary | Not meaningful on macOS. See 4.7. |
| `antiGravityAgent.ts:36` `languageServerPids` | `powershell Get-Process -Name language_server` | **Not guarded.** Use `pgrep -x language_server` (fall back to `pgrep -f language_server`), parse PIDs, resolve an empty set on error. |
| `sessions.ts:224` `probeProcesses` | PowerShell `Get-Process` | **Not guarded.** See 4.7. |
| `sessions.ts:831` `findCommandOnPath` | `where.exe`, returns `null` off Windows | Guarded but returns `null`, so no CLI is ever found on macOS. See 4.7. |
| `sessions.ts:1105` `probeLock` | PowerShell byte-range lock probe on Codex thread locks | **Not guarded.** See 4.7. |
| `sessions.ts:1221` `killProcessTree` | `taskkill` on Windows, else `target.kill()` | Fine on macOS, but child processes survive. Prefer `spawn(..., { detached: true })` and `process.kill(-pid)` to kill the group. |
| `sessions.ts:1236` `resolveNodeCmdEntry` and `1523` `cmd.exe` | npm `.cmd` shim handling | Skip on macOS (executables run directly). Make sure the code path does not reach `cmd.exe`. |

Rule of thumb: grep the whole of `src/main` for `powershell`, `\.exe`, `cmd\.exe`,
`where\.exe`, `taskkill`, `reg\.exe`, `windowsHide`, `APPDATA`, `LOCALAPPDATA`,
`USERPROFILE`, `ProgramFiles` and check every hit.

### 4.5 P1: Updates (`updater.ts`, `shared/updates.ts`, `UpdatesCard.tsx`)

- `detectInstallKind` (`updater.ts:40`) returns `'nsis'` for any packaged,
  non-portable, non-Store build. On macOS that would try `electron-updater`,
  which cannot work for an unsigned app. Add a macOS case that returns a manual
  kind, for example `'mac'` (add it to `UpdateInstallKind`) or reuse `'portable'`
  behavior. It must follow the existing GitHub Releases API path
  (`checkGitHubReleaseApi`) and never `getAutoUpdater()`.
- `selectGitHubReleaseAsset` (`shared/updates.ts:166`) matches only
  `Notch-Portable-*.exe` and `Notch-Setup-*.exe`. Add: for the mac kind, prefer
  `Notch-<version>-<arch>.dmg` where `<arch>` is `process.arch` (`arm64` or
  `x64`), falling back to the release page.
- `updater.ts:107,125,143` stub URLs end in `.exe`. Only matter for dev stubs.
- `UpdatesCard.tsx`: add the macOS wording (for example "Download the new .dmg
  from GitHub Releases. Your data in ~/Library/Application Support/Notch stays
  intact."). Remove "Windows installer" and `%APPDATA%` text on macOS.
- Update `scripts/check-updater.mjs` for the new kind.
- `app.getPath('userData')` on macOS is `~/Library/Application Support/<productName>`
  (confirm the folder name is `Notch`). Check `state.ts` and any code that
  assumes `%APPDATA%\notch`.

### 4.6 P1: Agent hooks (`agentStatus.ts`)

Notch installs "hooks" into Claude Code, Codex, Cursor and Gemini so those tools
call Notch's loopback HTTP server (`/hook?tool=<tool>&kind=<working|done|permission>`,
header `X-Notch-Token`). `syncInstalledToolHooks` (`agentStatus.ts:3174`) edits
`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.cursor/hooks.json` and
`~/.gemini/settings.json`. These paths are the same on macOS.

The **command string** is Windows-only: `hookCommand` (`agentStatus.ts:903`)
builds `powershell -NoProfile -EncodedCommand <base64 UTF-16LE>`, which does not
exist on macOS. Implement a POSIX branch that builds a `curl` one-liner with the
same semantics as `hookStatements` (`agentStatus.ts:890`):

- Read the hook's JSON from stdin and POST it as-is to
  `http://127.0.0.1:<port>/hook?tool=<tool>&kind=<kind>`.
- Header `X-Notch-Token: <token>`, `Content-Type: application/json; charset=utf-8`.
- Timeout: 10 s for `working`/`done`, **250 ms for `permission`** (see the
  `timeout` in `hookStatements`; for curl use `--max-time` with fractional
  seconds, for example `--max-time 0.25`).
- Print the server's JSON reply to stdout. On **any** failure print `{}` and exit
  0, so a stopped Notch never blocks or errors the user's coding tool. Shape:
  `curl -sS --max-time N -X POST -H 'X-Notch-Token: T' -H 'Content-Type: application/json; charset=utf-8' --data-binary @- 'URL' || echo '{}'`.
  Test that the fallback `{}` is printed when the port is closed.
- Quote safely for `/bin/sh -c` (single quotes, escape embedded quotes). The URL
  and token are generated by Notch, but do not rely on that.
- `isNotchHookEntry` (`agentStatus.ts:3138`) already recognises any entry whose
  JSON contains `127.0.0.1:`, so a curl command is detected and de-duplicated
  correctly. Keep `127.0.0.1:` literally in the command.
- `setupSnippet` (`agentStatus.ts:908`) shows these commands to the user and
  must show the curl form on macOS.
- The token ends up on the command line (visible to `ps`), exactly as on Windows.
  That is acceptable for a loopback-only server, but do not log it.

Paths to review for macOS equivalents: `agentStatus.ts:2629`, `3261`, `3410`,
`3480` (Cursor and Grok config under `%APPDATA%`; on macOS this is
`~/Library/Application Support/Cursor`, `~/Library/Application Support/Grok Bot`
**[verify]**), `shared/agentTools.ts:98` (the Grok path string shown to the user).

### 4.7 P1: Coding-session discovery and delivery (`sessions.ts`, `sessionScanners.ts`, `agentStatus.ts`, `openCodeApprovals.ts`)

**Process presence (`probeProcesses`, `sessions.ts:218`).** Currently one
PowerShell call returns `pid \t name \t mainWindowTitle` for every process, and
`providerForProcess(name)` / `providerForTitle(title)` map them to providers
(`claude`, `codex`, `cursor`, `vscode`, `jetbrains`, and so on). A running
process with a visible window counts as "open".

macOS replacement:
- List processes with `ps -axo pid=,comm=` (on macOS `comm` is the full
  executable path, for example `/Applications/Cursor.app/Contents/MacOS/Cursor`).
  Derive the app name from the `.app` bundle folder.
- Normalise names so the existing matchers work: today they compare against
  `claude.exe`, `cursor.exe`, `zed.exe`, `copilot.exe`, `chatgpt.exe`. Introduce
  a `normalizeProcessName()` that strips `.exe` and `.app` and lowercases, and
  change those equality checks to compare the normalised form. Keep behavior
  identical for Windows names.
- "Has a window" (the `Title` field, used to tell an open app from a leftover
  daemon): on macOS use `NSWorkspace.runningApplications` filtered by
  `activationPolicy == .regular` (a GUI app in the Dock sense), via
  `osascript -l JavaScript` with `ObjC.import('AppKit')`, or a tiny Swift helper.
  This needs **no permission**. Do **not** read window titles through System Events
  (it triggers an Automation prompt) and do not use `CGWindowListCopyWindowInfo`
  names (they need Screen Recording).
- Keep the 20-second process cache (`PROCESS_CACHE_MS`).
- Consider the app names on macOS: "Claude", "ChatGPT" (Codex), "Cursor",
  "Windsurf", "Zed", "Visual Studio Code" (process "Electron" or "Code"), JetBrains
  IDEs ("IntelliJ IDEA", "PyCharm", ...), "Antigravity", "Trae", "Kiro", "Qoder".
  Confirm each on a Mac **[verify]**.

**CLI discovery (`findCommandOnPath`, `findClaudeCli`, `findCodexCli`, `findOpenCodeCli`).**
All return `null` or look in Windows folders. For macOS:
- A GUI app launched from Finder gets a **minimal PATH**
  (`/usr/bin:/bin:/usr/sbin:/sbin`), so `claude`, `codex` and `node` installed by
  Homebrew, npm, nvm or the vendor installers are not found. At startup on macOS,
  resolve the user's login-shell PATH (`/bin/zsh -ilc 'echo $PATH'`, with a
  timeout, or the `fix-path` package) and apply it to `process.env.PATH` before any
  `spawn`.
- Implement `findCommandOnPath` on macOS with `command -v <name>` through the
  login shell, or by scanning PATH plus these known folders: `~/.local/bin`,
  `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`,
  `~/.bun/bin`, `~/.cargo/bin`, `~/.nvm/versions/node/*/bin`.
- `findClaudeCli` candidates become `~/.local/bin/claude` (no `.exe`/`.cmd`) and
  the PATH lookup.
- `findCodexCli`: the Windows search is `%LOCALAPPDATA%\OpenAI\Codex\bin\...`. Find
  where the macOS Codex/ChatGPT app and CLI live (likely inside
  `/Applications/ChatGPT.app` or `/Applications/Codex.app`, or `codex` on PATH)
  **[verify]**; fall back to PATH.
- `findOpenCodeCli`: `%APPDATA%\ai.opencode.desktop\cli\<ver>\opencode-cli.exe`
  becomes something like `~/Library/Application Support/ai.opencode.desktop/cli/...`
  **[verify]**, then PATH.
- Process spawning for sends (`deliverSessionMessage`, `sessions.ts:1374`): skip
  the `.cmd`/`cmd.exe` branches on macOS, spawn the binary directly, pass the
  message by stdin or after `--` exactly as today.

**Codex "thread is open" lock (`probeLock`, `sessions.ts:1105`).** On Windows the
code takes a byte-range lock on `~/.codex/thread-writer-locks/<id>.lock` to see
whether Codex holds it. There is no .NET on macOS. Options, in order of
preference: (1) use `lsof -t <file>` (non-empty output means some process has it
open) **[verify]** that it reflects Codex's lock on macOS; (2) if it cannot be
determined, return "unknown" and let the existing send path fail safe. Note the
risk: wrongly saying "free" lets Notch write into a thread that Codex has open.

**OpenCode port discovery (`detectOpenCodePort`, `openCodeApprovals.ts:133`).**
After the service-file check, Windows uses `Get-NetTCPConnection`. macOS: find
OpenCode PIDs with `pgrep -f opencode`, then
`lsof -nP -iTCP -sTCP:LISTEN -a -p <pid,pid,...> -Fn` and parse ports, then reuse
the existing `probeOpenCodePort` loop.

**Anti Gravity.** The daemon files under `~/.gemini/antigravity/daemon` are
home-relative and already cross-platform. Only `languageServerPids` (4.4) needs a
macOS implementation.

**Scanners (`sessionScanners.ts`).** `sessionScanners.ts:21` takes
`process.env.APPDATA`; `:628` reads Zed's `%LOCALAPPDATA%\Zed\threads\threads.db`.
Introduce one helper `appSupportDir()` that returns `%APPDATA%` on Windows and
`~/Library/Application Support` on macOS, and `localAppDataDir()` (same folder on
macOS), and use it everywhere `APPDATA` / `LOCALAPPDATA` appears (list in the
grep above: `agentStatus.ts`, `sessions.ts`, `sessionScanners.ts`,
`localMedia.ts:320`, `index.ts`). Confirm each tool's real macOS data folder
(Cursor, Zed, OpenCode, Grok, Codex) **[verify]**.

**Project folders.** `baseName` (`sessions.ts:117`) handles `\\?\` prefixes and
both slash types; fine on macOS.

### 4.8 P1: Spotify (`index.ts:1591` to `1835`)

The Web API path (`spotify.ts`, OAuth with a loopback redirect port) is
cross-platform. Only the desktop-app launch is Windows-specific:
- `spotifyStoreExe`, `findSpotifyDesktopExe`: macOS candidates are
  `/Applications/Spotify.app` and `~/Applications/Spotify.app` (use
  `fs.existsSync` on the bundle folder). Skip the Windows paths on macOS.
- `spotifyDesktopAvailable` already falls back to
  `app.getApplicationNameForProtocol('spotify:')`, which works on macOS.
- `openSpotifyApp`: `shell.openExternal('spotify:...')` works on macOS when the
  app is installed. Replace the `spawn(exe)` fallback with
  `shell.openPath('/Applications/Spotify.app')` or `open -a Spotify`.
- User-facing strings say "this PC" (`spotifyDeviceMessage`). Make them
  platform-aware ("this Mac").

### 4.9 P1: Backdrop for focus mode (`backdrop.ts`)

`desktopCapturer.getSources({ types: ['screen'] })` needs the **Screen
Recording** permission on macOS. Without it the result is empty or only the
wallpaper. The code already returns `null` on failure, so the app survives, but:
- Check `systemPreferences.getMediaAccessStatus('screen')` before capturing.
- If not granted, do not request it automatically. Fall back to a solid dim
  backdrop (the renderer already handles a missing image) and add a Settings row
  "Blurred desktop in focus mode (needs Screen Recording permission)" with a
  button that opens
  `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`
  via `shell.openExternal`.
- Do not poll in a loop that could trigger the system prompt repeatedly.

### 4.10 P1: Camera / posture

`PostureContext.tsx:773` uses `navigator.mediaDevices.getUserMedia`. On macOS add
`NSCameraUsageDescription` (section 3.1) and, in main, call
`systemPreferences.askForMediaAccess('camera')` before first use (and check
`getMediaAccessStatus('camera')`). Handle "denied" with a clear message that
points to System Settings > Privacy & Security > Camera. MediaPipe runs from
local WASM files and needs no network. Confirm WASM/WebGL work under the packaged
app **[verify]**. Update the strings that mention "Windows camera" (PosturePage).

### 4.11 P2: Other main-process items

- `license.ts:258` builds a device name `"<hostname> (win32)"` with a default
  `'Windows PC'`. Use a platform-aware label ("Mac"). Check whether the license
  server needs a platform field.
- `phoneTransfer.ts` starts a local HTTP server on the LAN. macOS will show an
  "accept incoming connections" firewall prompt for unsigned apps, and macOS 15+
  asks for Local Network permission (`NSLocalNetworkUsageDescription`, section
  3.1) **[verify]**. Document it.
- `obsidian.ts:182` `shell.showItemInFolder` works on macOS (Finder). Rename UI
  text "Reveal in Explorer" / "Show in Explorer" (`NotesPage.tsx:1484`,
  `SettingsPage.tsx:1224`) to "Reveal in Finder" on macOS.
- Notifications: `Notification` works on macOS. The first notification asks for
  permission. `app.setAppUserModelId` is Windows only and is harmless.
- `calendar.ts` (Google Calendar OAuth through loopback) should be
  cross-platform; verify the redirect flow opens the default browser.
- Single-instance lock, `second-instance`, `window-all-closed`, and
  `before-quit` handling should be re-tested with the Dock hidden.

## 5. New native helpers (Swift)

The Windows build ships two native binaries. macOS needs equivalents because
there is no PowerShell or WinRT. Create `native/mac/` with Swift sources and a
build script `scripts/build-mac-helpers.sh` that compiles each helper for both
architectures and writes them to `resources/mac/<name>-arm64` and
`resources/mac/<name>-x64`:

```sh
swiftc -O -target arm64-apple-macos12  src.swift -o resources/mac/notch-foreground-arm64
swiftc -O -target x86_64-apple-macos12 src.swift -o resources/mac/notch-foreground-x64
```

At runtime pick the helper that matches `process.arch`. Resolve the path with
`process.resourcesPath` + `mac/...` (it is shipped through `extraResources`,
which lives outside the asar, so it is executable). Ad-hoc sign the helpers too
(`codesign --force --sign -`). If a helper is missing, the feature must report
"unavailable" and not crash.

### 5.1 `notch-foreground` (replaces `notch-foreground.exe`, used by `foreground.ts`)

**Contract to keep.** `foreground.ts` spawns a long-lived child, passes
`--width --height --pid --exit-with-parent --interval --cx --cy [--watch-browser]`
(`buildForegroundExeArgs`, `foreground.ts:338`), and reads **one JSON object per
line** on stdout, parsed into `ForegroundSample`
(`shared/presence.ts`):

```json
{"process":"safari","fullscreen":false,"own":false,"browserOpen":true}
```

- `process`: lowercased name of the frontmost app, no `.app`/`.exe`. The
  "never show over these apps" list (`neverOver`) is compared after stripping
  `.exe` (`presence.ts:cleanName`), so use names like `zoom.us`, `keynote`,
  `safari`.
- `fullscreen`: true when the frontmost app has a window that covers the whole
  target display, or the display is in a full-screen Space. Suggested method:
  `CGWindowListCopyWindowInfo(.optionOnScreenOnly)` for the frontmost app's PID,
  find a window at layer 0 whose bounds equal the display bounds (no permission
  needed for bounds and owner PID); also consider that the menu bar is hidden
  (`NSApplication.shared.presentationOptions` is not available for other apps, so
  rely on bounds) **[verify]**. `--cx/--cy/--width/--height` identify which
  display to compare against (physical pixels on Windows; use points on macOS and
  document the difference). `foreground.ts` already requires two consecutive
  fullscreen samples before auto-hide.
- `own`: the frontmost app is Notch (compare PIDs with `--pid`).
- `browserOpen`: with `--watch-browser`, true if any browser (Safari, Chrome,
  Arc, Edge, Brave, Firefox, Opera, Vivaldi) is running with a regular activation
  policy and at least one on-screen window. Re-check about every 5 s (the TS code
  uses `BROWSER_RECHECK_MS = 5000`).
- Exit when the `--pid` parent is gone (`--exit-with-parent`).
- Sampling interval: `--interval` (800 ms in TS). Prefer polling at that rate to
  keep the helper simple.
- Required TS changes in `foreground.ts`: remove the `process.platform !== 'win32'`
  early return for macOS, add a `resolveForegroundHelper()` that returns the mac
  binary path, and keep all Windows code intact. `index.ts` calls
  `displayPhysicalSize` (`notchDisplay.ts:58`) to build the target; on macOS pass
  display points instead of physical pixels and document that.

### 5.2 `notch-media` (replaces the WinRT PowerShell monitor in `localMedia.ts`)

**Contract to keep.** The rest of the app consumes only the exported functions
of `localMedia.ts`: `startLocalMediaMonitor`, `pauseLocalMediaMonitor`,
`resumeLocalMediaMonitor`, `stopLocalMediaMonitor`, `listMediaSources`,
`currentMediaId`, `isLocalAvailable`, `getLocalStatus`, `getLocalPlayback`,
`performLocalAction`. Internally the monitor emits one JSON line every ~1.5 s:

```json
{"sessions":[{"id":"com.spotify.client","title":"...","artist":"...","album":"...",
  "status":"Playing","position":12345,"end":201000,
  "canNext":true,"canPrevious":true,"canSeek":true,"current":true,"art":null}]}
```

Units: `position` and `end` are **milliseconds** (the Windows code converts ticks
to ms; verify against `handleMonitorLine` and `getLocalPlayback`). `status` is
`"Playing"` or another word such as `"Paused"` (the TS compares `=== 'Playing'`).
Control commands arrive over stdin with a `cmdId` and the reply carries the same
`cmdId` (`pendingControls`, `parseControlPayload` at `localMedia.ts:406`).

Recommended macOS design:
- **Read state** without polling or permissions by listening to the distributed
  notifications the players publish:
  - Spotify: `com.spotify.client.PlaybackStateChanged` (userInfo includes
    `Player State`, `Name`, `Artist`, `Album`, `Duration` in ms, `Playback Position`
    in seconds) **[verify]**.
  - Music.app: `com.apple.Music.playerInfo` (or `com.apple.iTunes.playerInfo`)
    **[verify]**.
  Combine with a one-time AppleScript read at startup and when the app launches.
- **Control** (play, pause, next, previous, seek) with AppleScript:
  `tell application "Spotify" to playpause`, `next track`, `previous track`,
  `set player position to N` (seconds). The first call triggers the **Automation**
  permission prompt for each target app; handle "not authorized" (AppleScript
  error -1743) with a clear message and a button that opens
  `x-apple.systempreferences:com.apple.preference.security?Privacy_Automation`.
- **Simpler fallback (acceptable for v1):** no Swift helper. Keep a long-lived
  `osascript -l JavaScript` process or spawn `osascript` every ~1.5 s that returns
  JSON for Spotify and Music (guard with `application("Spotify").running()` so it
  never launches the app by accident). Measure CPU; if it is noticeable, move to
  the notification-based helper.
- **Ids.** `shared/mediaFollow.ts` decides what the notch follows from the session
  `id`: `/spotify/i` is Spotify; YouTube Music is matched by name or by a browser id
  with an album. Use ids `com.spotify.client` (matches `/spotify/i`) and
  `com.apple.Music`. Apple Music is **not** a followed app today (`MusicApp` is
  `'spotify' | 'youtube-music'`). To support it, extend `MusicApp`,
  `MUSIC_APP_LABELS`, `musicAppFor`, `pickMediaSession` and the picker. `KNOWN_PLAYERS`
  already has an Apple Music label.
- **Album art.** Spotify exposes an `artwork url` (remote). The existing
  `remoteArtFile` (`localMedia.ts:271`) already downloads remote art and caches it,
  so return `art: null` and let that path fill it in. For Music.app, export
  `artworks` data to a temp file in `mediaArtDir()` and return its path.
- Update the strings that say "Windows media session" (`MusicPage.tsx`,
  `SettingsPage.tsx`, `MediaContext.tsx` comments) to platform-neutral wording.
- `scripts/check-media-live.cjs` is Windows-specific. Add a macOS counterpart or
  skip it on macOS.

## 6. Renderer and shared code

- `styles.css:19` font stack `'Inter Variable', 'Segoe UI Variable', 'Segoe UI',
  system-ui, sans-serif`: add `-apple-system, 'SF Pro Text'` before `system-ui`.
  Check the scrollbar styles (comment at `styles.css:6665`) and the dark
  `color-scheme` handling look right in macOS WebKit-style scrollbars.
- Keyboard shortcuts in `NotesPage.tsx` already accept `metaKey`. Update the
  tooltips ("Bold (Ctrl+B)") to show Cmd on macOS. `App.tsx:335` ignores
  `ctrlKey || metaKey` combos; confirm that is intended.
- Strings to make platform-neutral or conditional on platform (expose
  `process.platform` through preload as `window.notchPlatform`): "Windows
  alerts", "Windows camera", "Windows player", "this PC", "Show in Explorer",
  "Portable build... .exe", "Windows installer". Files: `SettingsPage.tsx`,
  `MusicPage.tsx`, `PosturePage.tsx`, `UpdatesCard.tsx`, `MediaContext.tsx`.
- Hide Windows-only settings on macOS: Smart App Control, Microsoft Store row,
  "Launch at login" may stay (it works).
- The hover-open behavior depends on pointer events reaching the window. After
  section 4.1, verify `onMouseEnter`/hover delays, `nudgePointerHover`
  (`index.ts:513`) and the focus handling when the window is a non-activating
  panel (typing in Notes needs the window to become key: call
  `mainWindow.focus()` when the panel opens by user action, as `openFromUserAction`
  does).

## 7. macOS permissions summary (for the README and first-run UI)

| Feature | Permission | How requested |
| --- | --- | --- |
| Posture detection | Camera | `askForMediaAccess('camera')` plus `NSCameraUsageDescription` |
| Blurred desktop in focus mode | Screen Recording | Only after the user presses a button; deep link into System Settings |
| Spotify / Music control | Automation (per app) | First AppleScript call prompts; handle -1743 |
| Phone transfer on Wi-Fi | Local Network (macOS 15+) and a firewall prompt | `NSLocalNetworkUsageDescription` |
| Notifications | Notifications | First `Notification.show()` |
| Launch at login | Login Items | `setLoginItemSettings` |

Because the app is ad-hoc signed, a grant can reset after an update (section 2).
The permission screens should work when re-shown.

## 8. Testing checklist (on a real Mac)

Run on Apple Silicon and, if possible, an Intel Mac, on both a notched MacBook
and an external display, with light and dark appearance:

1. DMG installs by drag to Applications, the Gatekeeper "Open Anyway" steps work,
   and `xattr -dr com.apple.quarantine` works.
2. Launch: no Dock icon, tray icon in the menu bar (correct in light and dark
   menu bars), notch tab visible at the top.
3. **Clicks pass through** everywhere except the tab (4.1). Menu bar items,
   desktop icons and window title bars all work.
4. Hover and click open, panel animates, Esc and shortcuts close, text input works
   (Notes), Cmd+C/V/A/Z work.
5. Appears over full-screen apps and on every Space. Auto-hides when a full-screen
   video or app is frontmost (after 5.1).
6. Spotify and Music: play, pause, skip, seek, artwork, "not running" states,
   Automation permission denied path (5.2).
7. Camera posture: permission prompt, denied path, stop releases the camera.
8. Focus-mode backdrop with and without Screen Recording permission.
9. Hooks: with Claude Code installed, `~/.claude/settings.json` gets the curl
   hooks, a Claude Code turn updates Notch status, a stopped Notch does not
   delay or break Claude Code (4.6).
10. Sessions: Claude Code and Codex are detected, CLI found from a Finder-launched
    app (not just from a terminal) (4.7).
11. Update check shows the right `.dmg` for the Mac's architecture (4.5).
12. Sleep/wake, lock/unlock, display plug/unplug, resolution change keep the
    notch placed correctly.
13. `npm run typecheck` passes; Windows packaging scripts still work
    (`npm run dist:win`) on a Windows machine or the existing CI.

## 9. Suggested implementation order

| Phase | Work | Result |
| --- | --- | --- |
| A | Section 3: mac build config, icons, `dist:mac`, exclude Windows files | An unsigned DMG that builds |
| B | 4.4 guards, 4.1 click-through, 4.2 window/notch, 4.3 tray | The app launches, sits at the top and does not block the desktop |
| C | 4.5 updater, section 6 strings and fonts, 4.8 Spotify launch, 4.10 camera, 4.9 backdrop | Notes, tasks, timer, posture, Spotify Web API working |
| D | 4.6 hook command for macOS | Coding-agent status working |
| E | 5.2 media helper (or osascript fallback) | Spotify / Music local control |
| F | 5.1 foreground helper, then 4.7 session discovery and sends | Full-screen auto-hide, sessions and send |
| G | 3.3 CI workflow, README macOS section, install guide with Gatekeeper steps | Releasable v1 |

Ship v1 after phase D or E if F is not ready. Each phase should leave the app in
a state where unavailable features are hidden, not broken.

## 10. Files most likely to change

`package.json`, `.github/workflows/release-mac.yml` (new), `build/icon.icns` (new),
`resources/trayTemplate*.png` (new), `native/mac/*` and `scripts/build-mac-helpers.sh`
(new), `src/main/index.ts`, `src/main/foreground.ts`, `src/main/localMedia.ts`,
`src/main/sessions.ts`, `src/main/sessionScanners.ts`, `src/main/agentStatus.ts`,
`src/main/antiGravityAgent.ts`, `src/main/openCodeApprovals.ts`, `src/main/updater.ts`,
`src/main/backdrop.ts`, `src/main/notchDisplay.ts`, `src/main/license.ts`,
`src/shared/updates.ts`, `src/shared/mediaFollow.ts`, `src/shared/agentTools.ts`,
`src/shared/notchLayout.ts` (only if the macOS notch needs its own metrics),
`src/preload/index.ts` (expose the platform), and the renderer files listed in
section 6, plus `README.md` and `docs/INSTALL.md` (macOS install and Gatekeeper
instructions).
