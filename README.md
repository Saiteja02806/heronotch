# Notch

A personal dashboard that lives at the top of your screen — built for Windows with Electron, React and TypeScript.

Hover the top-center notch and it unfolds into a full workspace: your Obsidian vault, Spotify controls, a focus timer, live coding sessions, a private posture coach, tasks, calendar reminders, and the settings that make it yours. The notch always starts tucked away. Use the **Collapse** arrow at the top right (or `Esc`) to fold it back into a slim now-playing / countdown / session bar.

## What it does

- **Focus mode** — when the notch opens, the primary display is covered by a blurred, dimmed snapshot of your current desktop. The notch stays sharp on top. Click anywhere on the blurred area (or press `Esc`) to close it and return to the desktop.
- **Notch-first interaction** — a plain black notch tab sits flush with the top edge, empty like a hardware notch; a tiny play indicator appears only while music runs. Hover it, click it, or press `Ctrl Shift Space`. It starts collapsed, uses a full-screen focus layer while open, and can be pinned when you want it to stay. The notch can be placed anywhere on the screen from **Settings → Notch → Placement**.
- **Obsidian, directly** — choose any local vault. Browse every folder and file, search by name or content, read, create, rename, rewrite, and move notes to the trash. Edits auto-save after 750ms, with a Markdown preview and one-click "open in Obsidian". No plugin, no sync account.
- **Spotify, with no setup for the basics** — if Spotify Desktop is open, Notch controls it through the Windows media session: current track, play/pause, previous/next and seek work immediately. A full optional Spotify Web API connection adds **next track**, the queue, volume, shuffle and repeat. Uses PKCE, so no client secret is stored.
- **Focus timer** — Focus / Short / Long presets with customizable lengths, a breathing coral timer disc, paused/running state that survives restarts, completed-session logging, and a system notification when a session ends.
- **Coding sessions, with a reply box** — reads the local session state of **Codex**, **OpenCode** and **Anti Gravity**, plus their running processes. See live turns, recent conversations, models/tokens, and open a session's project from the notch. Click **Message** on a session to send a follow-up without switching apps. Provider logos make each session instantly identifiable. The board has search, hides subagent noise by default, and the dashboard gets a live session card.
- **Posture coach** — an always-on local webcam posture score from 0 to 100, adaptive seat setup, slouch alerts, daily good/bad posture totals, and a clear on/off switch. While enabled it keeps watching even when the notch is collapsed. Frames are processed on-device and never stored or uploaded.
- **Tasks & calendar** — a day planner with month calendar, priorities, times, notes, and reminders (`at time`, `5/10/30/60 min before`). Reminders trigger real Windows notifications and keep the task state in sync.
- **Personalization** - five accent themes, a live notch preview, your name in the header, hover/click opening, hover delay, a drag-anywhere placement map for the collapsed notch, pin behavior, launch at login, notification control, and keyboard shortcuts.
- **Fast** — everything is local: `json` state, local Markdown, local session databases, local posture inference, no backend.

## Quick start

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
npm start
```

Windows portable app:

```bash
npm run dist
```

This writes `release/Notch-Portable-1.0.0.exe` — a single-file full build you can run without installing.

A classic NSIS installer is also available:

```bash
npm run dist:installer
```

It writes `release/Notch-Setup-1.0.0.exe`. On locked-down machines, Windows Application Control can block the temporary unsigned uninstaller used during packaging; use the portable build in that case. `npm run pack` creates an unpacked build in `release/win-unpacked/` for testing.

> Electron downloads its native binary on first run. On first launch, grant notification permission if Windows asks.

## Releasing for the website

Two workflows exist and they publish the same two downloads.

**1. Unsigned release (current, free)** — `.github/workflows/release-unsigned.yml`

Push a `v*` tag, or run the workflow manually and pass the tag:

```text
GitHub Actions → Release (unsigned) → Run workflow
```

It builds the portable and NSIS downloads on a Windows runner, writes
`SHA256SUMS.txt`, and publishes a GitHub Release. Nothing is signed, so Windows
SmartScreen warns on first run and PCs with Smart App Control enabled cannot run
it at all. The user-facing copy for that release lives in
[docs/INSTALL.md](docs/INSTALL.md); keep the two in sync.

**2. Signed release** — `.github/workflows/release.yml`

The upgrade path once a code-signing certificate exists. It signs every `.exe`,
`.dll` and `.node` with the SSL.com certificate, fails if anything is unsigned,
and publishes `Notch-Setup-*.exe`, `Notch-Portable-*.exe` and `SHA256SUMS.txt`.
See [docs/RELEASE-SIGNING.md](docs/RELEASE-SIGNING.md) for certificate choices for
India, the required secrets, and how to validate a build on a clean Windows VM.

Builds have to run on GitHub Actions rather than a local PC: electron-builder
builds a temporary unsigned installer while generating the NSIS uninstaller, and
Smart App Control blocks that step.

Local builds are unsigned too, so on a PC with Smart App Control the packaged
executable is refused before it starts. The app now detects that case on a
renderer failure and explains it instead of leaving an invisible notch.

Smart App Control accepts a validly signed app even before it has reputation.
SmartScreen still shows an "unrecognized app" prompt on early downloads until
the certificate builds reputation; that is normal for direct downloads and is
not something the installer can avoid.

## Running on a PC with Smart App Control

Smart App Control has no per-app allow list, and it evaluates every DLL a program
loads. On such a PC the packaged `Notch.exe` cannot start, but Electron's own
binary is allowed, so running the same code from source works.

On a machine set up that way:

| Shortcut | Where | Purpose |
| --- | --- | --- |
| `Notch` | Desktop | Starts the latest `out/` build |
| `Notch` | Start menu | Same, searchable |
| `Notch` | Startup folder | Starts at sign-in, so the notch is always there |

Each one runs `node_modules/electron/dist/electron.exe` with the project folder
as its argument. That path stays valid across `npm install`, so updates do not
break it.

- Rebuild after changing source: `npm run build`, then relaunch the shortcut.
- If the shortcut opens nothing, check `%APPDATA%\notch\notch.log` and run
  `npm install` followed by `npm run build`.
- To stop it starting at sign-in, delete
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Notch.lnk`.

## Using the notch

| Action | Shortcut |
| --- | --- |
| Toggle the notch | `Ctrl` + `Shift` + `Space` |
| Collapse / close | `Esc` or the **Collapse** arrow |
| Switch sections | `1` – `7` |
| Open notes search | `Ctrl` + `K` inside Notes |
| Save note now | `Ctrl` + `S` |
| Bold / italic in the note editor | `Ctrl` + `B` / `Ctrl` + `I` |

The notch always launches collapsed. By default it opens on hover after the delay set in **Settings → Notch** (140ms by default); switch **Open with** to **Click** if you would rather it only opens when you click the tab. While open, it covers the primary display with a blurred snapshot of the desktop so your attention lands on the notch. Click the blurred area, use the **Collapse** arrow in the header, or press `Esc` to close it. `Esc` works even when the notch never took focus, which is the normal case for a hover-open. The notch background is refreshed while collapsed, so the blur reflects the desktop you were just using.

Right-click the system tray icon for **Open**, **Collapse**, and **Quit**. Quit from Settings or the tray when you want to stop the app.

The collapsed bar is not locked to the top centre. Open **Settings → Notch → Placement**, then drag the small notch on the screen map to any spot — corners, edges or the middle. The position is saved in normalised coordinates, so it survives restarts and adapts to different display sizes. **Preview** collapses the notch immediately so you can see the result. **Reset** returns it to the top centre.

## Notes folder

1. Open **Notes** (or the Notes card on the home view).
2. Choose **Open folder** and select the folder that holds your Markdown notes.
3. Notch reads the folder's structure directly. It ignores `.obsidian`, `.trash`, `.git` and other hidden folders.
4. Markdown and text files are editable in the built-in editor; other files are listed and can be opened in the default app or revealed in Explorer.
5. The folder is watched for changes, so edits made in another editor appear in the file tree automatically. If a note is open and you have no unsaved changes, external edits are pulled into the editor too.
6. Use **Expand all** in the tree toolbar to open every folder at once; folder rows show their note count. Notes, folders and files can be created, renamed and moved to trash from the tree.
7. Drag a note or folder onto another folder to move it there. While dragging, the tree header becomes **Move to root folder**: drop on it to pull the item back out of its folder. A file name that already exists in the target folder is refused instead of overwritten.

Notes are read and written on the local filesystem by the Electron main process. Paths are validated to stay inside the selected folder, and deletions use the system trash (not a permanent delete). Auto-save runs after 750ms, `Ctrl+S` saves immediately, and the note is flushed synchronously when you leave the page or quit the app. There is no sync or account layer.

If the folder moves or is deleted, choose it again in **Settings → Notes**.

## Spotify

There are two levels of connection:

**Desktop session — nothing to set up.** Open Spotify on this computer. Notch reads the Windows system media session and controls the current track, play/pause, previous/next and seek. The dashboard and Music page show the live track and progress. This works without a Client ID, login, or developer app.

**Full connection — optional.** Spotify's official Web API is required for the **next track, queue, volume, shuffle, repeat** and device details. Windows does not expose the queue through its media session, so there is no local workaround. Other Spotify integrations ship their own developer Client ID; for a personal build you can register one app once:

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app.
2. In the app's **Redirect URIs**, add exactly:

   ```
   http://127.0.0.1:43821/callback
   ```

   If you change the loopback port in **Settings → Spotify**, use that port instead.
3. Copy the app's **Client ID**.
4. In **Settings → Spotify**, open **Unlock queue & full controls**, paste the Client ID, save and connect.
5. Your browser opens Spotify's consent screen. After approving, the tab says *Connected*.

Notes:

- Playback control requires **Spotify Premium**. Free accounts can still read metadata where Spotify permits it.
- If Spotify has no active device, start playback in the desktop app first.
- The access/refresh tokens are stored locally at `%APPDATA%\notch\spotify-auth.json`. Revoke access from your Spotify account settings at any time.
- The redirect URI is loopback-only. Notch starts a temporary localhost server during sign-in and closes it immediately after the callback.
- **Disconnect** removes local API tokens and falls back to the desktop session.

## Coding sessions

The **Sessions** page is a local activity board, not a cloud service. On Windows it discovers:

- **Codex** — `~/.codex/state_*.sqlite` threads and `thread_history_*.sqlite` turn status. Live turns are shown with a `LIVE` badge; clean thread names come from `session_index.jsonl`.
- **OpenCode** — `~/.local/share/opencode/opencode.db` (`session_v2` and `project` tables), including busy/idle timestamps, model and token counts.
- **Anti Gravity** — `~/.gemini/antigravity/conversation_summaries.db` conversations, statuses, workspaces and step counts.

A Windows `tasklist` process scan identifies whether the desktop apps are actually running. Session databases are opened **read-only**. Nothing is written back to Codex, OpenCode or Anti Gravity except a message you explicitly send. No session data leaves the machine.

The board refreshes every 15 seconds and has a manual refresh button. Folder buttons open the project directory in Explorer. A session is marked `live` when the app itself reports a busy/in-progress turn; other detected conversations are listed as recent. Subagents are hidden behind the **Subagents** filter so the main conversation board stays readable.

### Sending a message from the notch

Each top-level session row has a **Message** button. The composer writes to the existing local session through that provider's own local interface:

- **OpenCode** — `opencode run --session <id>` against the running OpenCode service.
- **Codex** — `codex exec resume <thread-id> "<message>"`, using the newest Codex CLI installed by the desktop app so current `config.toml` keys are understood.
- **Anti Gravity** — the official local `agentapi send-message <conversation-id> "<message>"` language-server command.

The message is sent as a normal follow-up. The agent's permissions and approvals still apply inside its own app; Notch does not silently auto-approve tool access. The composer confirms when the command starts, then a global notification reports whether the CLI finished or failed — even if you switch tabs.

> **Open Codex threads are locked.** While a Codex thread is open in ChatGPT, Codex holds a writer lock and does not expose its app-server to other processes. Notch detects that before spawning anything and offers **Copy & open ChatGPT** rather than claiming the message was sent. Close the thread (or use the ChatGPT composer) to deliver there.

> The provider must be installed and running. Anti Gravity's local agent service is only available while its language server is running. Subagent conversations are read-only in this view.

> These tools change their local storage formats over time. Notch fails quietly if a database is missing or locked and still shows the other providers.

## Posture coach

The **Posture** tab turns the webcam into a private posture coach. It is **off by default** and only starts when you press **Turn on posture coach**.

- A local pose model scores your alignment from 0 to 100 in real time. It combines head height, shoulder level, head centring, head tilt, **forward-head depth**, screen proximity, and torso lean when the waist is visible.
- **Test posture setup** is a guided 8-second measurement. It checks that your head and shoulders are visible, then captures the **best-aligned frames** rather than averaging everything (averaging can bake a slouch into the baseline). It warns you if you moved or looked tilted during the capture, and automatically chooses **upper-body** or **full-torso** scoring. Laptop cameras are fully supported; waist visibility is optional.
- Live frames are filtered for implausible poses and scored from the median of a short window, so a single noisy frame cannot swing the score.
- If the camera stops delivering frames, the score is cleared after a short watchdog instead of freezing at its last value. The posture display cannot keep showing an old 100 from a stale frame.
- Forward-head depth is weighted more heavily than the side-to-side signals, because leaning into the screen is the most common real-world slouch.
- Depth and proximity tracking are what catch a forward slouch toward the screen, where head and shoulder x/y position barely changes. Re-run **Test posture setup** once after updating so those signals are matched to your camera and chair.
- The setup screen shows live coverage for head, shoulders and waist so you know exactly what the camera can see.
- The slouch threshold, notification toggle and camera mode live in the same panel.
- Alerts fire after a few seconds of slouching, with a 45-second cool-down.
- Good vs. slouching time is tracked for the day and resets at midnight.
- **Always watching while on:** the posture coach runs continuously whenever it is enabled, including while the notch is collapsed and while you use other apps. The camera and the Windows camera indicator stay on for that entire time. Turning the coach off releases the camera and its LED. Windows does not allow software to switch off the LED while the camera is streaming.

Privacy:

- Pose inference runs in the Notch renderer with MediaPipe. Camera frames are never saved, uploaded, or sent to a server.
- The first enable downloads the pose model/WASM from `cdn.jsdelivr.net` and `storage.googleapis.com`. After that, Chromium caches them. Posture detection itself is local.
- Notch does not store images or video. Only a calibration baseline, score totals and settings are persisted.
- Windows camera permission must be enabled for Notch. The first use may trigger a camera permission request.

> The score is a behavioural nudge, not a medical measurement. Different chairs, camera angles and body types may need their own calibration.

## Reminders and data

All app data is stored locally at:

```
%APPDATA%\notch\notch-state.json
```

Spotify tokens live separately in `%APPDATA%\notch\spotify-auth.json`.

Reminders are scheduled inside the app process and fire as Windows notifications. For reminders to work reliably, leave Notch running (enable **Launch at login** in Settings). If the app was closed when a reminder was due, it will still surface reminders from the last 12 hours when it next opens.

## Project structure

```
src/
├─ main/            Electron main process
│  ├─ index.ts      window, tray, shortcuts, IPC, reminders
│  ├─ state.ts      persisted app state
│  ├─ obsidian.ts   vault filesystem API + watcher
│  ├─ spotify.ts    PKCE flow + Spotify Web API client
│  ├─ localMedia.ts Windows media-session fallback for Spotify
│  ├─ backdrop.ts   local desktop snapshot for focus mode
│  └─ sessions.ts   Codex/OpenCode/Anti Gravity discovery
├─ preload/         typed contextBridge API
├─ renderer/        React UI
│  ├─ src/App.tsx   notch shell + hover/collapse behavior
│  ├─ src/pages/    dashboard, notes, music, planner, sessions, posture, settings
│  ├─ src/state/    app state + media/session/posture providers
│  ├─ src/components/
│  └─ src/styles.css
└─ shared/          types shared across processes
```

## Development notes

- `NOTCH_STATE_PATH` overrides the state file location (useful for testing).
- `NOTCH_DEMO_MEDIA=1` serves a fake Now Playing session so the player UI can be developed without Spotify credentials. It has no effect on normal launches.
- `npm run typecheck` checks both the Node and renderer TypeScript projects.
- The app is Windows-first (top-edge docking, tray, Windows notifications), but the Electron shell is portable.

## Known limits

- The notch is a frameless always-on-top window, not a macOS hardware cutout. It docks to the primary display; multi-monitor blur overlays are not exposed yet.
- The focus backdrop is a local screen snapshot taken while the notch is collapsed (via the built-in Windows screenshot API). If screen capture is unavailable or blocked by policy, the notch falls back to a dark translucent focus layer. The snapshot never leaves the machine.
- Obsidian is accessed as plain Markdown files. Canvas files can be listed/renamed but not edited in the notch editor.
- Text editing targets Markdown and `.txt`; attachments open externally.
- Hover expansion depends on the window having a small visible surface at the top. Full-screen exclusive games may hide or fight with always-on-top windows.
- Reminders require the app to be running and Windows notifications enabled.
- Coding-session discovery is Windows-focused and depends on the private local databases and CLIs of each tool. If a provider changes its schema or command shape, that provider simply shows no sessions or reports the send error until support is updated. Session lists still work if process detection is unavailable.
- Sending a message starts the provider's own local CLI process. It does not bypass that provider's approval policy or sandbox. Anti Gravity messaging needs its language server running; Codex/OpenCode messaging needs their CLI/auth available.
- Basic Spotify control needs Spotify Desktop open and uses the Windows media session. Queue / next track / volume / shuffle / repeat require the optional Web API connection; the local session does not expose the queue.
- The posture model downloads on first enable, so that one action needs an internet connection. Detection afterwards is local. Camera quality, lighting and framing affect the score. The camera LED is hardware-controlled and cannot be turned off while streaming; the coach runs continuously while enabled, so turn it off to release the camera.
- The focus backdrop is a snapshot of the primary display taken while the notch is collapsed. If desktop capture is unavailable, it falls back to a dark gradient; other monitors are not blurred.

## License

MIT — see [LICENSE](LICENSE).
