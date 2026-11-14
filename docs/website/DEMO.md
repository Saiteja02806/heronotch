# Notch — Demo Production Guide

How to capture, edit and ship the demos that carry the website. The site's whole pitch is "watch it
work", so these assets matter more than any copy.

Read [`BLUEPRINT.md`](./BLUEPRINT.md) §5 for how they are used and [`COPY.md`](./COPY.md) for the
captions.

---

## 1. Asset list

| Asset | Length | Format | Weight budget | Used on |
| --- | --- | --- | --- | --- |
| `hero-tour` | 30–45 s | MP4 H.264 + WebM | ≤ 8 MB | Hero stage |
| `clip-music` | 8–12 s | both | ≤ 1.5 MB | Tour tab |
| `clip-notes` | 8–12 s | both | ≤ 1.5 MB | Tour tab |
| `clip-plan` | 8–12 s | both | ≤ 1.5 MB | Tour tab |
| `clip-posture` | 8–12 s | both | ≤ 1.5 MB | Tour tab |
| `clip-sessions` | 8–12 s | both | ≤ 1.5 MB | Tour tab |
| `clip-focus` | 8–12 s | both | ≤ 1.5 MB | Tour tab |
| `clip-styles` | 8–12 s | both | ≤ 1.5 MB | Tour tab |
| Poster per clip | — | JPG 1280×800 | ≤ 120 KB | Before play, reduced motion |
| Captions per clip | — | WebVTT | ~1 KB | Accessibility |
| Stills | — | PNG @2× | ≤ 400 KB | Feature splits, OG |

Everything is silent. No music, no voice-over, no mouse clicks in the audio track.

---

## 2. Capture setup

### Screen

- 1920×1080 recording, display scaling 100% for the capture session (Notch's own layout is verified
  at 125%, so do a sanity pass there too before you ship).
- Clean desktop: no personal files, no browser tabs, no notifications from other apps.
- Use a dedicated Windows user or a VM if you can. A fresh profile avoids leaked names in the
  Spotify widget, Codex sessions, or the calendar.
- Wallpaper: one dark, low-detail image. Ship it with the project so the clips match.

### App state

Reset to a known-good state before each clip:

```powershell
# back up first
Copy-Item "$env:APPDATA\notch\notch-state.json" "$env:APPDATA\notch\notch-state.json.bak"
```

Seed content that reads well on video:

- 4–6 tasks with human titles ("Review the release notes", "Ship v1.0.22"), one reminder 20 s out.
- 3 notes: one with headings and checkboxes, one with a code block, one short.
- Spotify playing a track with a legible title and cover art.
- Two AI sessions with realistic titles; hide anything with a real client name.
- Posture enabled, threshold ~60, and a person actually seated in frame for the posture clip.

### Notch settings for capture

| Setting | Value | Why |
| --- | --- | --- |
| Style | `notch-micro` or the smallest style | Reads as a real notch in a small frame |
| Accent | Coral | Matches the site |
| Hover delay | 120–160 ms | Feels instant without flicker |
| Open trigger | Hover | The signature interaction |
| Pin on open | Off | Lets the panel auto-collapse for the transitions |
| Launch at login | Off | Avoids interference |
| Notifications | On | Needed for the reminder clip |

### Cursor

- Use a high-contrast cursor, no cursor trail, no click ripples.
- Move in straight lines with a short ease at the end; pause ~200 ms before every click.
- Never let the cursor sit still in the middle of the panel — park it at the edge of frame.

---

## 3. Per-clip shot lists

Each clip is **one** interaction, start to finish, with a beat of stillness at both ends (0.4 s in,
0.6 s out) so the loop is not jarring.

### 3.1 `hero-tour` (30–45 s)

The only clip with multiple beats. Hold each beat long enough to read.

| Time | Beat | Notes |
| --- | --- | --- |
| 0.0–2.0 | Desktop, notch collapsed | Track title visible in the bar. Cursor enters from the right. |
| 2.0–4.0 | Hover → unfold | Let the spring finish. Do not move during the animation. |
| 4.0–9.0 | Music | Hover the transport, press pause then play. Show the progress line moving. |
| 9.0–15.0 | Notes | Switch to Notes, open a note with checkboxes, tick one, click a heading and rename it. |
| 15.0–21.0 | Plan | Add a task, set the reminder to "at time" 15 s out, submit. Cut forward to the notice unfolding under the collapsed notch. |
| 21.0–26.0 | Posture | Expand, show the score and the threshold ring. Do not fake a low score. |
| 26.0–31.0 | Sessions | Open the board, scroll two rows, hover **Message**. |
| 31.0–36.0 | Focus | Start a focus session; show the countdown in the collapsed bar. |
| 36.0–41.0 | Styles | Open Appearance, click two accents, show the notch preview change. |
| 41.0–45.0 | Collapse | Press Esc. Hold on the collapsed bar. End card fades in. |

End card (rendered in the site, not baked into the video, if possible): `notch` · *The top of your
screen, finally useful.* · `Free for Windows`.

### 3.2 Feature clips

| Clip | Action | Frame check |
| --- | --- | --- |
| `music` | Expand → press next → drag the progress bar → collapse | Track title legible at 1× |
| `notes` | Expand → Notes → type `## Today` → tick a box → bold a word | No IME popups, no spellcheck squiggles (disable spellcheck for capture) |
| `plan` | Expand → Plan → create a task with a reminder → cut to the notice under the collapsed tab | Notice text readable, no personal task names |
| `posture` | Expand → Posture → sit upright → slouch slowly → chime + ring | Do not stage a fake score; the ring must move with the real value |
| `sessions` | Expand → Sessions → open a session → click **Message** → type → send | Provider logos visible, no private repo names |
| `focus` | Expand → Focus → start 25 min → collapse → hold on the countdown | Timer digits crisp; avoid the seconds flicker by capturing at 60 fps |
| `styles` | Expand → Appearance → cycle accents → switch style → collapse | Show the bar change while collapsed |

---

## 4. Recording

### Tooling

Pick one, in order of preference:

1. **OBS Studio** — free, reliable, 60 fps, lossless or high-bitrate local recording.
   - Output: `1920x1080`, `60 fps`, CQP 18, MKV then remux to MP4.
   - Capture the whole display so the notch sits at the real top edge. Do **not** crop the notch out
     of the window during capture; crop in the edit.
2. **Windows Game Bar** (`Win+G`) — fine for quick pickups, 30 fps max, lower quality.
3. **ShareX** — good for stills and short GIFs, not for the hero.

Avoid capturing through the CDP/dev instance if you can; a normal launch is what users see. If you do
use a remote-debugging instance for deterministic clicks, note that the window must not appear in
Alt-Tab for realism — it already will not.

### Determinism tips

- Record each beat separately and assemble; a single 45 s take will have a stumble.
- Pre-seed the reminder exactly 15–20 seconds after submit so the wait is short and the cut is clean.
- Disable Windows notifications from other apps during capture (`Focus assist → Alarms only`).
- Hide the taskbar clock and tray tooltips if they distract; do not hide the taskbar entirely — the
  "no taskbar button" claim is more convincing with a visible taskbar.
- Re-run the capture if a single frame shows a personal name.

---

## 5. Editing

### Timeline

- Cut on the action, not on the animation end. Let the unfold finish in one continuous shot.
- Speed up waits: the reminder countdown between "create task" and "notice appears" compresses to a
  short dissolve, never more than 1 s of dead time.
- No zoom punches, no whooshes, no cursor highlights. The product is the motion.

### Crop and framing

- Deliver 16:10 for feature clips (1280×800) and 16:9 for the hero (1920×1080).
- Keep the notch **at the top edge of the frame** with ~64 px of headroom cropped off the desktop so
  the bar reads clearly. The tab must be at least 120 px wide in the final frame.
- Bake a 1 px `#232527` border into the frame? **No** — the site's `Video.astro` draws the border so
  it stays crisp on every display.

### Grading

- Slight lift in the shadows so the near-black panel does not crush to pure black on cheap laptop
  screens.
- Do not add a vignette; the CSS stage already provides depth.
- Keep the coral accent accurate — compare against `#ff6f61` with an eyedropper after export.

### Encoding

```bash
# H.264 MP4 (primary)
ffmpeg -i capture.mov \
  -vf "scale=1920:-2:flags=lanczos,fps=30" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 23 -preset slow \
  -movflags +faststart -an hero-tour.mp4

# VP9 WebM (fallback, smaller)
ffmpeg -i capture.mov \
  -vf "scale=1920:-2:flags=lanczos,fps=30" \
  -c:v libvpx-vp9 -crf 34 -b:v 0 -row-mt 1 -an hero-tour.webm

# Poster at the first readable frame
ffmpeg -ss 2.4 -i hero-tour.mp4 -frames:v 1 -q:v 3 hero-tour.jpg
```

Rules:

- 30 fps is enough for UI; use 60 only for the focus timer digits.
- `-an` always. Silent files are smaller and the site never plays audio.
- `+faststart` so the first frame paints before the file finishes downloading.
- Verify with `ffprobe` that duration, resolution and bitrate match the budget table.

---

## 6. Captions

Every clip needs a WebVTT track, even though it is silent — they carry the action description for
screen readers and users who cannot see motion.

```
WEBVTT

00:00:00.400 --> 00:00:02.600
A narrow black notch sits at the top center of a Windows desktop.
The collapsed bar shows the current track.

00:00:02.600 --> 00:00:05.200
The cursor hovers the notch. The panel unfolds into the music player.

00:00:05.200 --> 00:00:09.000
The track is paused, then resumed. The progress bar moves forward.
```

Keep each cue to two lines. Describe the action in present tense. Never write "click here".

---

## 7. Stills

Capture at 2× device pixel ratio so the site can serve a crisp 1×.

| Still | Frame | Notes |
| --- | --- | --- |
| `hero@2x` | Collapsed bar + open panel | The OG image base |
| `music@2x` | Player with queue visible | No personal track history |
| `notes@2x` | Editor mid-render | Show checkboxes and a heading |
| `plan@2x` | Planner with 4–5 tasks | Generic titles |
| `notice@2x` | The reminder card under the collapsed tab | The signature detail shot |
| `posture@2x` | Score, threshold and ring | Person not identifiable — crop the camera preview out |
| `sessions@2x` | Two provider sessions | No repo names |
| `styles@2x` | Appearance panel + preview | — |

Export PNG, then run through `sharp`/`squoosh` to AVIF + WebP. Keep PNG only as the OG fallback.

---

## 8. Optional: the in-page simulator (week 2+)

The interactive "try it" is worth 2–3 days only after the videos exist. It reuses the screenshots as
static layers.

### Contract

- A single React island, `TourIsland.tsx`, hydrated with `client:visible`.
- Stage: 1200×700 desktop, dark wallpaper, faux taskbar strip at the bottom.
- Collapsed tab: 122×38, radius 0 0 14px 14px, `#050607`, 1 px `#232527` border, 1 px coral dot.
- Hover (`pointer: fine`) or click unfolds to 900×520 with a 420 ms spring.
- Tabs switch image layers; only the active layer is loaded at full size.
- `Escape` folds. `aria-expanded` on the tab button. Focus is trapped only while pinned open.
- `prefers-reduced-motion` or `pointer: coarse` → render `hero@2x` with a caption and no interaction.
- Total JS ≤ 40 KB gzipped for the island including the spring library; prefer CSS transitions if
  that budget is tight.

### Do not

- Reimplement the real app UI in HTML. Fake controls that do not work read as broken.
- Auto-animate on scroll. The user must initiate.
- Load all seven screenshots up front.

---

## 9. Checklist before hand-off to the site build

- [ ] Every clip is silent, ≤ budget, `+faststart`, and plays in Chrome, Edge and Safari.
- [ ] Poster exists for every clip and is the same aspect ratio.
- [ ] WebVTT track exists for every clip and passes a caption validator.
- [ ] No personal names, emails, repo names, or real client data in any frame.
- [ ] Notch is at the true top edge in every frame; the tab is legible at 1× and on a 13" laptop.
- [ ] Coral matches `#ff6f61`; near-black is not crushed.
- [ ] Hero tell a complete story without audio.
- [ ] Stills exported at 2×, compressed to AVIF/WebP, PNG kept only for OG.
- [ ] File names match the tree in `BLUEPRINT.md` §7.3 exactly.
- [ ] A `mediainfo` dump is stored next to the assets so the site build can verify budgets in CI.
