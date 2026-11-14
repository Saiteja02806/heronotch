# Notch — Website Copy

Finished, paste-ready copy for every page in the MVP. Voice rules live in
[`BLUEPRINT.md`](./BLUEPRINT.md) §2.4: plain, specific, no hype. Every claim here is true for
v1.0.22 — update the version line when you ship.

Character counts in parentheses are for `title` and `description` tags.

---

## Global

**Wordmark:** `notch` (lowercase, Instrument Serif or the tab glyph + wordmark)

**Tagline (footer, about, OG):**

> The top of your screen, finally useful.

**One-liner (used in the hero sub, OG description, llms.txt):**

> Notch is a free Windows app that folds your music, notes, plans, posture and AI sessions into one
> quiet strip at the top of the screen.

**Nav:** `Tour` · `Features` · `Install` · `Changelog` · `GitHub` · **`Download`**

**Meta line under hero CTAs:**

> v1.0.22 · 128 MB installer · Windows 10/11 · unsigned build · SHA-256 included

**Trust strip (four items):**

| Label | Sub-label |
| --- | --- |
| FREE | No account, no trial |
| LOCAL | Your files stay on your PC |
| QUIET | Never on the taskbar |
| OPEN | Public GitHub releases |

---

## Landing page

### Announcement bar

> **v1.0.22** — Reminders and posture alerts now surface under the notch while you work.
> [Read the notes →](/changelog)

### Hero

**Eyebrow (mono):** `FREE · WINDOWS 10/11 · LOCAL-FIRST`

**H1:**

> The top of your screen, finally useful.

**Sub (max 54ch):**

> Music, notes, plans, posture and your AI sessions — folded into one quiet strip that appears when
> you hover, then gets out of the way.

**Primary CTA:** `Download for Windows`
**Secondary CTA:** `Watch the 60-second tour`

**Under the stage:**

> Hover the notch to unfold it. Press Esc to fold it back.

**Screen-reader / caption for the hero stage:**

> A Windows desktop with a narrow black notch at the top center. Hovering it unfolds into the Notch
> panel showing the current Spotify track, the day's plan, and posture score.

### Tour section

**Kicker:** `THE TOUR`
**H2:**

> Seven things it does, one hover away.

**Intro:**

> Each clip is a single unedited interaction. No mockups.

| Tab | Headline | Caption | What to notice |
| --- | --- | --- | --- |
| Now playing | Music, without leaving the work. | The collapsed bar shows the track and a progress line. Expand for transport, queue and volume. | Controls work on Spotify Desktop with no login at all. |
| Notes | Your Markdown vault, rendered live. | Open any note from your folder. Headings, checkboxes, bold, code and tables render as you type. | Click a `- [ ]` box to tick it. Rename a heading by clicking it. |
| Plan | The day, with reminders that reach you. | Add a task, pick a time, choose a reminder. When it fires, a card unfolds under the notch. | The notice appears even while another app has focus. |
| Posture | A posture coach that stays on-device. | A live score from the webcam, with a threshold and a small ring. | It only rings when someone is actually in frame. |
| Sessions | Your AI work, in one place. | Codex, OpenCode and Anti Gravity sessions with turns, models and tokens. | Reply to a session without switching windows. |
| Focus | Twenty-five minutes, visibly. | A running timer in the collapsed bar, a breathing disc when open. | The timer keeps running when the panel is closed. |
| Styles | Make it yours. | Five accents, several notch shapes, drag-anywhere placement. | It stays flush with the top edge. |

### Feature splits

#### 01 — MUSIC

**H2:** Your music, at the top of the screen.

> If Spotify Desktop is open, Notch picks up the session automatically. The collapsed bar shows what
> is playing and how far along it is. Open it for play, pause, skip, seek and the queue.

- No login required for basic control.
- Optional full connection adds queue, volume, shuffle and repeat.
- Works alongside your code, not on top of it.

*See it in the tour ↑*

#### 02 — NOTES

**H2:** A real Markdown editor, in a notch.

> Point Notch at any folder of Markdown files. It reads the same files you already have — no import,
> no sync, no proprietary format. The editor renders as you type, so headings, checkboxes and code
> look the way they will read.

- Live rendering, not a preview pane.
- Create notes and folders inline. Drag to move.
- Autosave to disk. Your files stay plain `.md`.

#### 03 — PLAN

**H2:** Reminders that actually reach you.

> A day planner with a month calendar, priorities and times. Set a reminder for the task and it fires
> while you are in another app: a small card unfolds under the collapsed notch with the title and
> time.

- Reminders at the time, or 5/10/30/60 minutes before.
- A card under the notch, plus a system notification where Windows allows it.
- Nothing to dismiss if you are mid-flow — it folds away on its own.

#### 04 — POSTURE

**H2:** A posture coach that never leaves your PC.

> Enable the camera and Notch scores your posture from 0 to 100 in real time, right in the panel.
> Set a threshold and it plays a soft two-note chime when you drop below it.

- Frames are processed on-device. Nothing is stored, nothing is uploaded.
- It will not ring at an empty chair.
- Daily good/bad totals, plus a one-time setup that fits the signals to your camera and chair.

#### 05 — SESSIONS

**H2:** Codex, OpenCode and Anti Gravity, side by side.

> Notch reads the local session state of each tool and shows live turns, models, tokens and the
> project folder. Select a session to open its directory, or send a follow-up message from the notch.

- One board for every agent you are running.
- Search, and hide subagent noise by default.
- Sending starts the provider's own CLI — your approval rules still apply.

#### 06 — FOCUS

**H2:** A timer you can see from across the room.

> Start a focus session and the countdown stays in the collapsed bar. Open the panel for a breathing
> disc, presets and a log of finished sessions.

- Focus, short break and long break presets, all adjustable.
- Survives restarts and keeps running when collapsed.
- Notifies you when a session ends.

#### 07 — STYLES

**H2:** Small, quiet, and yours.

> Five accent colours, several notch shapes, and a placement map that lets you put it anywhere along
> the top edge. It sits flush with the screen edge, the way a notch should.

- Collapsed by default. Hover or click to open.
- Adjustable hover delay.
- Never appears on the taskbar, Alt-Tab or Task View.

### Bento — "The quiet details"

**H2:** Details you only notice when they are missing.

| Cell | Title | Copy |
| --- | --- | --- |
| 1 | Off the taskbar | Notch lives in the tray and the top edge only. No taskbar button, no Alt-Tab entry, no Task View tile. |
| 2 | Five accents | Coral, mint, violet, gold and ice — applied across the whole panel. |
| 3 | Drag to place | Drop the notch anywhere along the top edge with a live placement map. |
| 4 | Hover or click | Open on hover with a delay you choose, or click to pin it open. |
| 5 | Your files | Notes are plain Markdown in your folder. State is a JSON file you can read. |
| 6 | Camera off by default | Posture is opt-in. The camera is only requested when you enable it. |

### Install section

**Kicker:** `INSTALL`
**H2:** Running in about a minute.

**Step 1 — Download**
> Grab the installer, or the portable build if you would rather not install anything.

**Step 2 — Run it**
> Windows will warn you because the build is unsigned. Choose **More info → Run anyway**. The hash
> is published so you can confirm the file first.

**Step 3 — Hover the top edge**
> The notch starts collapsed. Hover the top center of your screen, or click the tab.

**Verification snippet:**

```powershell
Get-FileHash .\Notch-Setup.exe -Algorithm SHA256
# compare with SHA256SUMS.txt on the release page
```

**Accordion items**

*Why does Windows warn me?*
> The app is not code-signed. A certificate costs money every year and this is a free project, so
> Windows shows the standard "unknown publisher" prompt. The build comes from a public GitHub Actions
> workflow, and every release publishes a SHA-256 checksum you can verify.

*What is Smart App Control?*
> Smart App Control is a Windows 11 security setting that blocks unsigned apps outright. If it is on,
> the installer may be stopped before it runs. The portable build often works, but if Windows still
> blocks it, turning Smart App Control off is a system-wide security decision that only you should
> make. The app itself is the same either way — it is the signing that is missing.

*Installer or portable?*
> Both contain the same app. The installer adds a Start-menu shortcut and registers an uninstaller.
> The portable build runs from wherever you put it and leaves nothing behind except your settings in
> `%APPDATA%\notch`.

*Does it auto-update?*
> Not yet. The app shows its version, and the site and GitHub releases always carry the latest build.

**Link:** `Read the full install guide →`

### Honest limits

**H2:** What it does not do.

> Every utility has edges. These are ours, before you download.

- **Unsigned.** Windows may warn, and Smart App Control may block it.
- **No auto-update.** Updating means downloading the next release.
- **Windows only.** Built and tested on Windows 10 and 11.
- **Electron.** About 128 MB for the installer, 113 MB portable — the trade for one app instead of six.
- **Spotify queue needs setup.** Basic control works out of the box; queue, volume and shuffle need
  a free Spotify developer app.

### FAQ

**Is it really free?**
> Yes. No account, no trial, no license key, no paid tier.

**Where does my data go?**
> Nowhere. Notes are files in a folder you choose. Settings live in a JSON file on your PC. Posture
> frames are processed in memory and discarded. Spotify tokens stay on the machine.

**Does it need the camera?**
> Only if you turn posture on. The camera is not requested at startup, and the Windows camera light
> stays on while it is in use — that is your confirmation nothing is hidden.

**Will it slow my PC down?**
> It idles quietly with the panel collapsed. Posture is the only continuously active feature, and it
> is off by default. There is no claim of "0% CPU" here — measure it on your own machine.

**Can I use my Obsidian vault?**
> Yes. Point it at the folder. Notch reads and writes plain Markdown, so nothing is converted or
> locked in.

**Which AI tools are supported?**
> Codex, OpenCode and Anti Gravity today. Discovery relies on their local session data, so a provider
> update can temporarily hide sessions.

**Does it show up in Alt-Tab?**
> No. It is a tool window: no taskbar button, no Alt-Tab entry, no Task View tile.

**How do I uninstall?**
> Settings → Apps → Notch. Your notes are untouched. To remove settings and logs as well, delete
> `%APPDATA%\notch`.

### Final CTA

**H2:** Put it at the top of your screen.

> Free, local, and about a minute to install.

**Buttons:** `Download for Windows` · `View on GitHub`

### Footer

**Columns**

- Product: Tour · Features · Install · Changelog · Download
- Project: GitHub · Releases · Issues · Roadmap
- Help: Help center · Privacy · Terms · Contact
- Elsewhere: X · Email

**Fine print:**

> Notch is an independent project, not affiliated with Spotify, OpenAI, Obsidian, or any other
> product it integrates with. Product names are used only to describe compatibility.

> © 2026 Saiteja. Built with Astro. Hosted on Cloudflare.

---

## /download

**Title:** `Download Notch for Windows — free, unsigned, verified` (56)
**Description:** `Download the latest Notch build for Windows 10 and 11. Installer or portable, SHA-256 checksums published, no account required.` (139)

**H1:** Download Notch for Windows.

**Intro:**
> One file, no account. Choose the installer for a Start-menu shortcut, or the portable build if you
> would rather not install anything.

**Version card**

| Field | Value |
| --- | --- |
| Version | 1.0.22 |
| Released | 14 November 2026 |
| Size | 128 MB (installer) · 113 MB (portable) |
| Platform | Windows 10 / 11, 64-bit |
| Checksums | SHA256SUMS.txt |
| Source | GitHub Actions run · commit `c88b06f` |

**Installer card**

> **Installer** — recommended
> Adds a Start-menu shortcut and an uninstaller. Installs per user, no admin prompt.
> `Download installer (128 MB)`

**Portable card**

> **Portable** — nothing installed
> Unzip and run. Good for locked-down PCs and Smart App Control.
> `Download portable (113 MB)`

**Verify your download**

> Every release publishes a checksum. Run this in PowerShell and compare the result with
> `SHA256SUMS.txt`:

```powershell
Get-FileHash .\Notch-Setup.exe -Algorithm SHA256 | Format-List
```

**If Windows warns you**

> 1. SmartScreen shows "Windows protected your PC".
> 2. Choose **More info**.
> 3. Choose **Run anyway**.
>
> This appears because the build is unsigned, not because anything was detected. The same file is
> built by the public workflow linked above.

**If Smart App Control blocks it**

> Smart App Control on Windows 11 refuses unsigned apps. Try the portable build first. If that is
> blocked too, Notch cannot run without changing that setting, and turning it off weakens protection
> for everything on the PC — so decide deliberately. Microsoft documents the setting here.

**After installing**

> - Hover the top center of the screen. The notch unfolds.
> - Press Esc or use the arrow to collapse it.
> - Turn on posture only if you want it; the camera is requested at that moment.
> - Spotify Desktop is picked up automatically. Full control is optional.
> - Set **Launch at login** in Settings if you want it always available.

**Uninstall**

> Settings → Apps → Notch. Notes in your folder are untouched. Delete `%APPDATA%\notch` to remove
> settings, logs and Spotify tokens as well.

---

## /changelog

**Title:** `Notch changelog` (16)
**Description:** `Every Notch release with highlights, installers and checksums.` (63)

**H1:** Changelog

> Every release, newest first. Full notes and assets live on GitHub.

**Entry template**

> ### v1.0.22 · 14 November 2026 `Latest`
> **Reminders and posture alerts now surface under the notch.**
> - Reminder and posture notices unfold a card beneath the collapsed tab, over other apps.
> - Friendly reminder copy ("Today at 2:51 PM") and a 12-second auto-dismiss.
> - Music page no longer looks like setup when credentials are already saved.
>
> [Full notes](…) · [Installer](…) · [Portable](…)

**Footer line:** `All releases on GitHub →`

---

## /help

**Title:** `Notch help — install, Spotify, camera, shortcuts` (49)
**Description:** `Answers for installing Notch, the SmartScreen prompt, Smart App Control, Spotify setup, notes, reminders and the posture camera.` (140)

**H1:** Help

**Groups and questions**

*Install*
- Windows says "unknown publisher". Is that normal? → Yes, the build is unsigned. More info → Run anyway.
- Smart App Control blocked the installer. → Try portable; read the honest explanation.
- How do I update? → Download the next release; no auto-update yet.
- Where are my settings? → `%APPDATA%\notch\notch-state.json`.

*Notch behaviour*
- It won't open on hover. → Check the hover delay in Settings; try clicking the tab; confirm another always-on-top window is not covering the top edge.
- How do I close it? → Esc, or the collapse arrow at the top right.
- Why isn't there a taskbar icon? → By design. Use the tray icon.

*Spotify*
- Do I need a Spotify account? → No, for desktop control. Full queue/volume needs a free developer app.
- Nothing plays but Spotify is open. → Start playback on any device once; Notch reads the active session.
- I saved a Client ID but the page still asks for setup. → Fixed in v1.0.22; update.
- Queue is empty. → The API returns empty without an active device.

*Notes*
- Can I use my Obsidian vault? → Yes, it is just a folder of Markdown.
- Why can't I edit a canvas file? → Canvases can be listed and renamed, not edited in Notch.
- Does it sync? → No. Whatever syncs the folder (OneDrive, iCloud, git) also syncs Notch's edits.

*Planner*
- My reminder didn't appear. → Notch must be running. Check the task has a reminder time and is not completed.
- The notice disappeared quickly. → Reminder notices fold away after 12 seconds by design.

*Posture*
- The score is stuck or empty. → Enable posture, check camera permission, run **Test posture setup** once.
- It rings at an empty chair. → It should not; threshold alerts require a detected pose. Update to v1.0.21+ and report it.
- Does it record me? → No. Frames stay in memory.

*Privacy and uninstall*
- What is stored, and where?
- How do I remove everything?

**Footer:** `Still stuck? hello@heronotch.app · Open an issue on GitHub`

---

## /privacy

**Title:** `Notch privacy — local by default` (34)
**Description:** `What Notch stores on your PC, how the camera and Spotify tokens are handled, and what the website collects.` (107)

**H1:** Local by default.

> Notch has no backend. There is no account, no telemetry endpoint, and no server that could receive
> your data.

**What stays on your PC**

| File | Contents |
| --- | --- |
| `%APPDATA%\notch\notch-state.json` | Settings, tasks, timer state, posture totals. |
| `%APPDATA%\notch\spotify-auth.json` | Spotify access and refresh tokens (PKCE; no client secret). |
| `%APPDATA%\notch\notch.log` | Startup and diagnostic lines. |
| Your notes folder | Plain Markdown files, edited in place. |

**Camera**

> Frames are captured in the app process, scored, and discarded. Nothing is written to disk,
> buffered for later, or sent anywhere. The Windows camera indicator stays lit while the camera is
> in use, and posture is off until you enable it.

**Spotify**

> Desktop control uses the Windows system media session and needs no account. The optional full
> connection uses OAuth PKCE, so no client secret exists. Tokens are stored locally and can be
> removed with **Disconnect**.

**AI sessions**

> Notch reads the local session files those tools already write. Sending a message starts the tool's
> own CLI process; content goes to that provider under their terms, not through Notch.

**This website**

> Cookieless analytics: page views and download events, no identifiers, no cross-site tracking, no
> ads. Downloads are served by GitHub, whose own privacy terms apply.

**Deleting everything**

> Uninstall the app, then delete `%APPDATA%\notch`. Your notes remain until you delete them yourself.

---

## /terms

**Title:** `Notch terms` (12)
**Description:** `Plain-language terms for the free Notch Windows app.` (52)

**H1:** Terms, in plain language.

> Notch is free software provided as-is, without warranty. You may use it personally or at work.
> The source is public; check the license in the repository before redistributing.

> It integrates with third-party products but is not affiliated with or endorsed by them. Those
> products have their own terms.

> Do not use the posture feature as a medical device or a substitute for professional advice. It is
> an awareness aid.

> These terms may change with a release. Continued use means you accept the current version.

---

## /404

**H1:** This page folded away.

> The link is stale or the page moved. Try the tour, or just download the app.

`Back to the top` · `Download Notch`

---

## SEO / social

**Home title:** `Notch — a free Windows notch for music, notes and focus` (57)
**Home description:** `Notch folds music, Markdown notes, plans, posture and AI sessions into one quiet Windows notch at the top of your screen. Free, local, unsigned.` (152)

**OG image text:** `notch` · `The top of your screen, finally useful.` · `Free for Windows`

**llms.txt (first lines)**

```
# Notch
> Free Windows app that puts music, notes, plans, posture and AI sessions in a notch at the top of the screen.
Install: download Notch-Setup.exe from https://github.com/Saiteja02806/heronotch/releases/latest
Requirements: Windows 10/11, unsigned build, ~128 MB installer
Privacy: no account, no backend, camera processed on-device
Price: free
```
