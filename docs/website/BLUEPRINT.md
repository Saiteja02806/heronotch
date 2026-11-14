# Notch — Website Blueprint

The complete plan for the public site that ships **Notch for Windows**: positioning, visual style,
page-by-page structure, demo system, download flow, tech stack, SEO, and launch checklist.

> Scope: a new, separate project (suggested repo `notch-site`). The desktop app repo stays clean.
> Companion docs: [`COPY.md`](./COPY.md) (finished copy) and [`DEMO.md`](./DEMO.md) (video + simulator).

---

## 0. Decisions up front

| Question | Decision |
| --- | --- |
| Goal | Get a Windows user from "what is this?" to a running app in under 2 minutes. |
| Product price | Free. No account, no trial, no checkout. |
| Conversion action | Download the installer (or portable build) from GitHub Releases. |
| Site type | Static marketing site + download hub + changelog/help. |
| Stack | **Astro 5 + TypeScript + Tailwind CSS v4**, deployed on **Cloudflare Pages**. |
| JS budget | Landing page ships under ~60 KB of JS (only the demo island is interactive). |
| Visual direction | **"Quiet Instrument"** — warm paper, ink, coral signal, Instrument Serif display, real product screenshots inside a dark desktop stage. |
| Primary navigation | Tour · Features · Install · Changelog · GitHub · Download |
| Demo | One 30-second hero tour + seven 8–12 second feature clips + optional notch simulator. |
| Trust strategy | Be explicit that the build is unsigned, show SHA-256, link GitHub Actions, explain SmartScreen and Smart App Control. |
| Name | Keep **Notch** as the product wordmark. Use `heronotch.app` (or `notchforwindows.com`) as the domain to avoid fighting the generic word. |

The one-sentence pitch:

> **Notch is the free Windows app that turns the top of your screen into a quiet command center —
> music, notes, plans, posture, and your AI sessions, one hover away.**

---

## 1. Research: what the two references get right

### 1.1 BuildNotch — `buildnotch.app`

**What it is:** a paid ($3 launch) Windows notch utility. Single long landing page.

**Structure observed**

1. Sticky nav: logo, Demo / Features / Pricing / FAQ, light-dark toggle, "Get for Windows".
2. Hero: benefit headline, subhead, two CTAs, launch-price line, **autoplaying demo reel**.
3. Numbered benefit chapters (01–04) with muted looping clips: music, AI apps, focus timer, projects.
4. "Everything you need, one hover away" — six 3D widget renders with short benefit copy.
5. Testimonial wall from X (avatars, handles, quotes, dates, links).
6. Pricing card with urgency (24 of 50 left), feature list, Polar checkout.
7. "Good to know before you install" FAQ **including the SmartScreen warning**, then a post-purchase modal.
8. Footer with changelog, a "Windows notch apps" guide, compare, contact, cookie settings, launch badges.

**Why it works**

- The product is shown constantly, in motion, at real size. Copy never carries the demo alone.
- The nav CTA is the price ("Get for Windows") and the version ("New · 1.3.0") is visible.
- Honesty about SmartScreen removes the biggest purchase objection *before* checkout.
- Repeated "one hover away" phrase makes the interaction memorable.

**What not to copy**

- 3D icon renders would fight Notch's real, dark, typographic UI.
- Paid urgency ("24 of 50") is irrelevant for a free app.
- The light + pixel-font + green palette is their brand, not ours.

### 1.2 Notchy — `notchy.dev`

**What it is:** a mature paid macOS notch app. Next.js + Tailwind, extensive content and SEO.

**Structure observed**

1. Nav: logo, Features, Face Unlock, Pricing, Compare, Help, "Try Free".
2. Hero: "Dynamic Island for your Mac", **interactive "Try it on this Mac" stage** with tabs
   (Now Playing, Notifications, Live Activities, HUDs, Timer…), notch/pill shape toggle.
3. Live product stats: installs, rating, active this week, languages, idle CPU.
4. Tabbed tour with a wallpaper-backed device stage and a caption per feature.
5. Use-case groups (Deep work, Music, Building, Everyday) with feature pills and deep links.
6. Full feature list (78), expandable; reviews with distribution; comparison table; savings calculator.
7. Pricing, FAQ, performance benchmark, localization, AI-tracker hub, journal/blog, supporters, share.
8. Hundreds of `/alternatives/*` and per-feature SEO pages, plus `llms.txt` and `llms-full.txt`.

**Why it works**

- The hero *is* the product: you can click through the notch UI before downloading.
- Trust is quantified (installs, ratings, CPU) and repeated in different formats.
- Every feature has a dedicated page; the site ranks for "notch app" intents.
- Light/dark tokens are carefully tuned (`#f4f4f2` paper / `#0e1114` ink, sage accent).

**What not to copy**

- 78-feature walls and 263 comparison pages require a content team; start with depth on six features.
- Benchmark claims only if reproducible — Notch is Electron, so never claim "0% CPU".
- The Apple-native aesthetic (SF fonts, liquid glass) would misrepresent a Windows utility.

### 1.3 What this means for Notch

Notch's unfair advantages are **free**, **local-first**, **Windows**, and **breadth in one quiet
surface** (music + notes + planning + posture + AI sessions). The site should feel like a
well-made desktop instrument, not a SaaS landing page. Show the real UI, keep the copy plain,
and make the unsigned-build reality impossible to misunderstand.

---

## 2. Positioning

### 2.1 Audience

- Windows developers and makers who already keep Spotify, a Markdown vault, a task list, and an
  AI coding tool open all day.
- People who like the macOS notch idea but will not buy a Mac app or a $25 utility.
- Privacy-sensitive users: no account, no cloud, camera processed on-device.

### 2.2 Positioning statement

> For Windows users who live at the top of their screen, **Notch** is a free, local-first command
> center that folds music, notes, plans, posture, and AI sessions into one hover — instead of six
> apps, a paid license, and a cloud account.

### 2.3 Proof points (use these, not adjectives)

- Free, no account, no subscription.
- 100% local state (`json`), plain Markdown files, no backend.
- Posture frames are processed on-device and never stored.
- Never appears on the taskbar, Alt-Tab, or Task View.
- Reminders reach you while you are in another app (notice card under the collapsed notch).
- Works with Spotify Desktop with zero setup; optional Web API adds queue/volume.
- Reads Codex, OpenCode and Anti Gravity sessions and can send a follow-up message.
- Five accent themes, multiple notch styles, drag-anywhere placement.

### 2.4 Voice

Plain, specific, quietly confident. Short sentences. No "revolutionary", "supercharge",
"10x your productivity". Name the action ("hover the top edge", "press Esc") instead of the vibe.
Be honest about limits; that is the brand.

---

## 3. Visual system — "Quiet Instrument"

The app already has a strong identity: near-black surfaces, warm ivory type, **Instrument Serif**
headlines, **Inter** UI, **JetBrains Mono** labels, coral accent, hairline borders. The site should
extend that system rather than invent a second one.

### 3.1 Concept

A warm-paper editorial page wrapped around a **dark stage** where the product lives. The page feels
printed and calm; the screenshots feel like a precision instrument. The only saturated color is the
coral signal (plus tiny mint/violet/gold chips for the theme picker).

### 3.2 Color tokens

```css
:root {
  /* paper theme (default) */
  --paper:        #f4f1ea;
  --paper-2:      #ece8df;
  --ink:          #0b0c0d;
  --ink-2:        #1a1b1c;
  --muted:        #6f706b;
  --muted-2:      #9a9a94;
  --line:         #dcd8ce;
  --line-strong:  #c9c4b8;

  /* signal */
  --coral:        #ff6f61;
  --coral-deep:   #c44a3f;
  --coral-soft:   #ffb4ab;
  --mint:         #a8e36b;
  --violet:       #b79bff;
  --gold:         #f6c85f;

  /* dark stage */
  --night:        #050607;
  --night-2:      #0d0f10;
  --night-3:      #141618;
  --night-line:   #232527;
  --night-ink:    #f2f0e9;
  --night-muted:  #8b8c87;

  /* type */
  --serif: 'Instrument Serif', Georgia, 'Times New Roman', serif;
  --sans:  'Inter', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
  --mono:  'JetBrains Mono', 'Cascadia Code', ui-monospace, monospace;
}
```

Rules:
- Paper background for 80% of the page. Dark stage only for the hero device and the demo tour.
- Coral is reserved for the primary CTA, the live notch indicator, and one highlight per section.
- Never place body text on coral. Use ink on paper or ivory on night.
- Borders are 1 px, `rgba(11,12,13,.12)` on paper; `rgba(255,255,255,.09)` on night.

### 3.3 Type scale

| Role | Family | Size / line | Notes |
| --- | --- | --- | --- |
| Display XL | Instrument Serif 400 | clamp(44px, 7.2vw, 92px) / 0.95 | hero, tight tracking −0.02em |
| Display L | Instrument Serif 400 | clamp(34px, 4.6vw, 60px) / 1.0 | section titles |
| Heading | Inter 600 | 20–24px / 1.25 | cards, FAQ |
| Body L | Inter 400 | 18px / 1.65 | hero sub, intro |
| Body | Inter 400 | 15–16px / 1.65 | default |
| Small | Inter 400 | 13px / 1.5 | fine print |
| Label | JetBrains Mono 500 | 10–11px, uppercase, 0.14em | eyebrows, meta, version chips |

Load only the weights used: Instrument Serif 400 + italic; Inter 400/500/600; JetBrains Mono 400/500.
Subset to `latin`, `woff2`, `font-display: swap`, preload the display face.

### 3.4 Layout & spacing

- Container: `max-width: 1200px`, 24px gutters (16px on mobile).
- 12-column grid; feature splits are 6/6, bento uses 6/3/3 and 4/4/4.
- Spacing scale: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96 / 128.
- Section rhythm: 96–128px desktop, 64–80px mobile.
- Radii: 8 (chips), 12 (buttons), 18 (cards), 28 (stage), 999 (pills).
- Shadows: hairlines first; one soft shadow for the stage
  `0 40px 120px rgba(0,0,0,.18), 0 2px 0 rgba(255,255,255,.04) inset`.
- Texture: a 2–3% SVG noise overlay on the paper; no gradients except a subtle top-edge fade.

### 3.5 The signature element

A **real notch tab fixed to the top edge of the page's dark stage**, not the browser. It starts as a
122 × 38 px black tab with a tiny coral dot. On hover/focus it unfolds into the full 900 × 520 UI
(video or screenshot panes), exactly like the app. A mono hint under it says "hover the notch".
Clicking pins it open. On mobile/reduced motion it is a static, captioned screenshot.

This is the one memorable interaction; everything else stays quiet.

### 3.6 Imagery

- Real screenshots only. No fake 3D icons, no invented UI.
- Capture at 2× on a clean 1920×1080 desktop, dark wallpaper, no personal data.
- Present screenshots inside a minimal Windows desktop stage: wallpaper strip, a faint taskbar
  hint, the notch at top center. Crop tighter than a full desktop; the notch must be legible.
- Use consistent 16:10 frames; 1px night border; 18–28px radius; no perspective tilts.
- One art-directed detail shot per feature (e.g., the reminder notice under the tab).

### 3.7 Motion

- 180–260ms ease-out for UI; 400–600ms for the notch unfold; spring only on the notch.
- Scroll reveals: opacity + 8px rise, once, staggered 40ms. Nothing else moves.
- Video: muted, loop, `playsinline`, poster, play/pause button, captions.
- Always honor `prefers-reduced-motion` → static posters, no autoplay.
- No parallax, no cursor followers, no scroll-jacking.

### 3.8 Iconography

Lucide at 1.5px stroke, 16/18/20px, currentColor. Feature icons sit in a 36px paper square with a
hairline. No emoji in the UI; one optional ✳ mark in the wordmark. Brand logos (Spotify, Codex,
OpenCode, Anti Gravity) only where factually needed, monochrome, with a text label.

### 3.9 Do / don't

| Do | Don't |
| --- | --- |
| Lead with the notch and the real UI | Lead with abstract gradients or 3D blobs |
| Use serif for emotion, sans for instructions | Use serif for body copy |
| Keep one coral CTA per viewport | Use coral for links, borders, and buttons at once |
| Show the collapsed state first | Show only the expanded panel |
| Say "free, unsigned, verify the hash" | Hide the SmartScreen warning |
| Let the product be the hero | Put a stock photo of a person at a laptop |

---

## 4. Sitemap & page specs

### 4.1 MVP (ship first)

```
/                 Landing page (all sections below)
/download         Install hub: version, size, SHA-256, installer vs portable, SmartScreen, SAC
/changelog        Release list with highlights, links to GitHub tags
/help             FAQ + troubleshooting (install, Spotify, camera, shortcuts, uninstall)
/privacy          Local data, camera, Spotify tokens, analytics
/terms            Short, plain-language terms
/404
```

### 4.2 Phase 2 (SEO and depth)

```
/features/spotify
/features/notes
/features/planner
/features/posture
/features/sessions
/features/focus
/features/customization
/compare/buildnotch
/compare/notchy
/windows-notch-apps          (category guide, BuildNotch does this well)
/blog/...                    capture guides and release notes
/roadmap
/about
```

Do not build 200 comparison pages. Build the six feature pages and two honest comparisons; they
will outrank thin pages.

### 4.3 Landing page wireframe

1. **Announcement bar (optional, 32px)** — `v1.0.22 · Reminders now surface under the notch →`
2. **Nav (64px, sticky, paper blur)**
   - Left: notch wordmark (black tab glyph + "notch").
   - Center: Tour, Features, Install, Changelog, GitHub.
   - Right: version chip `v1.0.22`, `Download` pill (ink background, ivory text).
3. **Hero (max 92vh)**
   - Eyebrow (mono): `FREE · WINDOWS 10/11 · LOCAL-FIRST`.
   - H1 (serif): "The top of your screen, finally useful."
   - Sub (18–20px, max 54ch): one sentence listing the five surfaces.
   - CTAs: `Download for Windows` (coral) + `Watch the 60-second tour` (ghost, play icon).
   - Meta line: `v1.0.22 · 128 MB installer · unsigned build · SHA-256 included`.
   - **Desktop stage** below: dark 16:9 panel, wallpaper, taskbar hint, real notch at top center;
     hover unfolds the panel. A caption below: "Hover the top edge. Press Esc to close."
4. **Trust strip** — four mono items with hairlines: `FREE FOREVER`, `NO ACCOUNT`, `ON-DEVICE`,
   `GITHUB RELEASES`.
5. **Tour** (dark stage section, paper heading)
   - Left: sticky tab list (Now playing · Notes · Plan · Posture · Sessions · Focus · Styles).
   - Right: 16:10 clip with poster, caption, and a "what to notice" line.
   - Keyboard: arrow keys switch tabs; each tab is a real button.
6. **Feature splits** (paper, alternating)
   - Spotify, Notes, Planner/reminders, Posture, Sessions, Focus/customization.
   - Each: mono kicker (`01 — MUSIC`), serif H2, 2 short paragraphs, 3 bullets, a "See it in the
     tour" text link, and one screenshot.
7. **Bento: the quiet details**
   - Never on the taskbar · Five accents · Drag-anywhere placement · Hover or click · Local files ·
     Collapsed by default.
8. **"Install in a minute"**
   - Three steps: Download → Run and approve SmartScreen → Hover the top edge.
   - Inline `Get-FileHash` verification snippet.
   - Accordion: "Why does Windows warn?", "What is Smart App Control?", "Installer or portable?".
   - Secondary link: "Read the full install guide → /download".
9. **Honest limits** (short, unusual, trust-building)
   - Unsigned build; no auto-update yet; Windows only; Spotify queue needs an optional developer app.
10. **FAQ** — 8 questions, accordion, one open by default.
11. **Final CTA** — dark band: "Put it at the top of your screen." Download + GitHub.
12. **Footer** — wordmark, tagline, columns, version, GitHub, releases, X/email, legal disclaimer.

### 4.4 `/download` spec

- H1: "Download Notch for Windows."
- Version card: version, release date, size, Windows 10/11, `SHA256SUMS.txt` link.
- Two primary options, side by side:
  - **Installer** — Start-menu shortcut, per-user install, recommended.
  - **Portable** — no install, runs from a folder, good for Smart App Control or locked-down PCs.
- Download buttons use **stable asset names** (see §6) so the page never links to a stale version.
- "Verify your download" block with the exact PowerShell command and the expected hash.
- "If Windows warns you" — SmartScreen steps with two screenshots.
- "If Smart App Control blocks it" — plain explanation, link to Microsoft's page, portable option,
  and the honest note that turning SAC off is a system-wide security decision.
- "After installing" — first-run checklist (hover the notch, grant camera only if you enable
  posture, connect Spotify optionally, set launch at login).
- "Uninstall" — Settings → Apps, and what stays in `%APPDATA%\notch` (state/logs) with a cleanup
  command.
- Link to all releases and the changelog.

### 4.5 `/changelog` spec

- One entry per GitHub release: version, date, 2–4 highlight bullets, full notes link, asset links.
- Top entry carries a "Latest" chip.
- Generated from a content collection or `releases.json`; do not hand-maintain URLs.
- RSS feed at `/changelog.xml` and an "All releases on GitHub" CTA.

### 4.6 `/help` spec

- Searchable FAQ grouped by: Install & SmartScreen, Notch behavior, Spotify, Notes, Planner,
  Posture & camera, Sessions, Privacy, Uninstall.
- Each answer 2–5 sentences, one screenshot max.
- Deep links from the app's error messages (`/help#smart-app-control`, `/help#spotify-client-id`).
- "Still stuck?" mailto and GitHub issue link.

### 4.7 `/privacy` spec

- What is stored locally and where: `%APPDATA%\notch\notch-state.json`, `spotify-auth.json`,
  `spotify-credentials.json`, logs, and the Markdown vault.
- Camera: frames processed in-process, never written or uploaded; LED stays on while enabled.
- Spotify: PKCE, tokens local, no client secret.
- Website: cookieless analytics, no ads, no cross-site tracking; GitHub download leaves the site.
- Contact and deletion instructions.

---

## 5. Demo system

Full production detail lives in [`DEMO.md`](./DEMO.md). Summary:

- **Hero reel (30s, 1080p, silent):** hover → open → music → notes → plan + reminder notice →
  posture ring → sessions → styles → collapse. End card: wordmark + "Free for Windows".
- **Seven feature clips (8–12s each):** one action per clip, one caption per clip, cursor visible,
  no dead time. 1080p H.264 + WebM; ≤ 1.5 MB each; poster JPG.
- **In-page tour:** tabbed clips synced to copy. Do not build a fake full app.
- **Optional simulator (week 2+):** a single React island that renders a 122×38 tab on a 1200×700
  desktop; hover unfolds real screenshot panes with working tab switching. Fallback to the poster
  on mobile and `prefers-reduced-motion`. Budget 2–3 days.
- Every video has captions (`.vtt`), a pause button, and a poster. No audio.

---

## 6. Download & trust flow

### 6.1 Stable asset names (important)

Today releases contain versioned names (`Notch-Setup-1.0.22.exe`). GitHub's
`/releases/latest/download/<asset>` only works with a fixed name. Publish **both**:

```
Notch-Setup.exe            ← stable, always latest
Notch-Portable.exe         ← stable, always latest
Notch-Setup-1.0.22.exe     ← archive copy
Notch-Portable-1.0.22.exe  ← archive copy
SHA256SUMS.txt
```

Then the site can link to:

```
https://github.com/Saiteja02806/heronotch/releases/latest/download/Notch-Setup.exe
https://github.com/Saiteja02806/heronotch/releases/latest/download/Notch-Portable.exe
```

No API, no rate limits, no stale links.

### 6.2 Version + hash display

Keep a generated `src/data/release.json`:

```json
{
  "version": "1.0.22",
  "releasedAt": "2026-11-14T09:26:00Z",
  "setupUrl": "…/latest/download/Notch-Setup.exe",
  "portableUrl": "…/latest/download/Notch-Portable.exe",
  "sumsUrl": "…/latest/download/SHA256SUMS.txt",
  "setupSha256": "…",
  "portableSha256": "…",
  "setupMb": 128.2,
  "portableMb": 112.6,
  "notesUrl": "https://github.com/Saiteja02806/heronotch/releases/tag/v1.0.22"
}
```

Refresh it from GitHub Actions on a `release` event or a nightly schedule:

```yaml
on:
  schedule: [{ cron: '17 4 * * *' }]
  repository_dispatch: { types: [release] }
  workflow_dispatch:
```

### 6.3 Tracked download redirects

Do not link straight to GitHub if you want conversion data. Use Cloudflare Pages Functions:

```
/download/setup     → 302 /releases/latest/download/Notch-Setup.exe
/download/portable  → 302 /releases/latest/download/Notch-Portable.exe
```

Log one cookieless event (`download`, `{ variant, version, os }`) then redirect. Also keep plain
GitHub links visible under "All releases".

### 6.4 Trust content

- "Why is this unsigned?" — honest paragraph; signing costs money; the build is produced by the
  public GitHub Actions workflow; verify the hash.
- SHA-256 block with a copy button and `Get-FileHash` command.
- Release provenance: CI badge, commit SHA, build date.
- SmartScreen steps (More info → Run anyway) with screenshots of the actual dialog.
- Smart App Control: what it is, why it may block a free unsigned app, and the portable fallback.
- Never use "virus-free", "100% safe", or fake security badges.

---

## 7. Tech stack

### 7.1 Recommendation

**Astro 5 + TypeScript + Tailwind CSS v4**, static output, Cloudflare Pages.

Why Astro:

- Zero JS by default; only the tour/simulator hydrate.
- Content collections for changelog, FAQ, features; MDX when needed.
- First-class image optimization (`astro:assets`) and sitemap.
- Deploys anywhere (Cloudflare Pages free tier is plenty).
- Easier to hand off than a Next.js app with mostly static content.

Next.js is the alternative if you want the Notchy-style app-router scale later. For this site,
Astro is simpler and faster.

### 7.2 Dependencies

```
astro
@astrojs/sitemap
@astrojs/mdx
@astrojs/rss
tailwindcss @tailwindcss/vite
lucide-astro            (or astro-icon + lucide)
motion                  (only inside the simulator island)
@fontsource-variable/inter
@fontsource/instrument-serif
@fontsource-variable/jetbrains-mono
```

Dev-only: `sharp` (Astro), `ffmpeg` (system) for clips, `pa11y`/Lighthouse CI optional.

### 7.3 Repository structure

```
notch-site/
├─ astro.config.mjs
├─ package.json
├─ public/
│  ├─ favicon.svg
│  ├─ og/default.png
│  ├─ media/
│  │  ├─ hero-tour.mp4 / .webm / .jpg
│  │  └─ clips/{music,notes,plan,posture,sessions,focus,styles}.{mp4,webm,jpg,vtt}
│  ├─ screenshots/{hero,music,notes,plan,posture,sessions,styles}@2x.png
│  └─ robots.txt
├─ scripts/
│  ├─ fetch-release.mjs
│  └─ optimize-media.mjs
├─ src/
│  ├─ components/
│  │  ├─ Nav.astro
│  │  ├─ Hero.astro
│  │  ├─ DesktopStage.astro
│  │  ├─ NotchMock.astro
│  │  ├─ TrustStrip.astro
│  │  ├─ Tour.astro                 (+ TourIsland.tsx)
│  │  ├─ FeatureSplit.astro
│  │  ├─ Bento.astro
│  │  ├─ InstallSteps.astro
│  │  ├─ Limits.astro
│  │  ├─ Faq.astro
│  │  ├─ FinalCta.astro
│  │  ├─ Footer.astro
│  │  ├─ DownloadCard.astro
│  │  └─ ui/{Button,Tag,SectionHead,CopyButton,Video}.astro
│  ├─ content/
│  │  ├─ features/*.md
│  │  ├─ faq/*.md
│  │  └─ changelog/*.md
│  ├─ data/{site.ts,release.json}
│  ├─ layouts/Base.astro
│  ├─ pages/{index,download,changelog,help,privacy,terms,404}.astro
│  ├─ styles/global.css
│  └─ utils/format.ts
├─ functions/download/[variant].ts   (Cloudflare Pages Function)
└─ .github/workflows/{deploy.yml,refresh-release.yml}
```

### 7.4 Design tokens in Tailwind v4

```css
/* src/styles/global.css */
@import "tailwindcss";

@theme {
  --color-paper: #f4f1ea;
  --color-paper-2: #ece8df;
  --color-ink: #0b0c0d;
  --color-ink-2: #1a1b1c;
  --color-muted: #6f706b;
  --color-line: #dcd8ce;
  --color-coral: #ff6f61;
  --color-coral-deep: #c44a3f;
  --color-night: #050607;
  --color-night-2: #0d0f10;
  --color-night-line: #232527;
  --color-night-ink: #f2f0e9;
  --color-night-muted: #8b8c87;
  --font-display: "Instrument Serif", Georgia, serif;
  --font-sans: "Inter", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --radius-card: 18px;
  --radius-stage: 28px;
}
```

### 7.5 Key component contracts

`DesktopStage.astro`

- Props: `title`, `poster`, `video?`, `autoUnfold?`, `caption?`.
- Renders a 16:9 night panel, a faux wallpaper (blurred, very dark), a 122×38 notch tab at top
  center, and an absolutely positioned expanded pane clipped by the stage.
- Hover/focus unfolds (`aria-expanded`), Escape folds, click pins.
- Falls back to the poster and no animation when `prefers-reduced-motion` or pointer is coarse.

`Tour.astro` + `TourIsland.tsx`

- Data-driven tabs: `{ id, label, clip, poster, vtt, caption, notice }`.
- Only the active video is mounted; others are posters.
- Arrow-key navigation, `role="tablist"`, `aria-selected`, focus ring.
- Emits `tour_select` analytics event.

`DownloadCard.astro`

- Reads `release.json`, renders version/date/size and both variants.
- Primary button → `/download/setup`; secondary → `/download/portable`.
- Shows `SHA256SUMS.txt` link and a copyable hash row.
- If the release is older than 30 days, show a subtle "check for a newer release" link (from the
  refresh workflow, so it is rarely needed).

`Video.astro`

- Props: `src`, `webm`, `poster`, `caption`, `vtt`, `loop`, `autoplay`.
- `preload="none"` except the hero; `playsinline`; `muted`; `controls` only on the tour.
- Pause when off-screen via IntersectionObserver.
- Text alternative below the video for screen readers.

### 7.6 JSON-LD

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Notch",
  "applicationCategory": "UtilitiesApplication",
  "operatingSystem": "Windows 10, Windows 11",
  "softwareVersion": "1.0.22",
  "downloadUrl": "https://heronotch.app/download",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "author": { "@type": "Person", "name": "Saiteja" },
  "license": "https://github.com/Saiteja02806/heronotch",
  "screenshot": "https://heronotch.app/screenshots/hero@2x.png"
}
```

Add `FAQPage` JSON-LD from the FAQ content, and `SoftwareSourceCode` if you want to emphasize the
public repo.

---

## 8. SEO, analytics, performance, accessibility

### 8.1 SEO / AEO

- One `<h1>` per page; descriptive `<title>` (≤ 60 chars) and meta description (≤ 155).
- Canonical URLs, `og:image` 1200×630 per page, `twitter:card=summary_large_image`.
- `sitemap.xml`, `robots.txt`, RSS for the changelog.
- Target intents: "windows notch app", "notch for windows", "spotify controls top of screen",
  "windows desktop widget notch", "free notch app windows", "codex opencode session dashboard".
- Add `llms.txt` and `llms-full.txt` (Notchy does this): a plain-text map of the product, features,
  install steps, and FAQ for AI assistants.
- Comparison pages must be factual and dated, with a "last verified" line. Never disparage; link
  to the other product.

### 8.2 Analytics

- Cloudflare Web Analytics or Plausible (cookieless, no banner needed).
- Events: `download_click` (variant), `tour_select`, `video_play`, `github_click`, `faq_open`,
  `copy_hash`, `install_guide_view`.
- No user IDs, no cross-site pixels, no session recording.

### 8.3 Performance budgets

| Metric | Budget |
| --- | --- |
| LCP | < 2.0s on a simulated 4G laptop |
| CLS | < 0.05 |
| INP | < 200ms |
| Landing JS | < 60KB gzipped |
| Hero video | ≤ 8MB, poster ≤ 120KB |
| Feature clip | ≤ 1.5MB each |
| Fonts | ≤ 180KB total, woff2, subset |
| Images | AVIF/WebP, `srcset`, 2× max |

Techniques: static HTML, islands only, `loading="lazy"` + `decoding="async"`, responsive images,
preload only the display font + hero poster, defer analytics, cache immutable assets at the edge.

### 8.4 Accessibility

- WCAG 2.2 AA contrast; test coral on paper (use `--coral-deep` for text, not `--coral`).
- Visible `:focus-visible` rings (2px ink offset 2px).
- Skip link; landmark regions; one h1; logical heading order.
- Tabs and accordions with correct ARIA and keyboard support.
- Captions for every clip; transcripts for the hero tour.
- `prefers-reduced-motion` disables unfolds/autoplay.
- Alt text describes the action, not "screenshot".

---

## 9. Deployment & release automation

### 9.1 Hosting

- Cloudflare Pages, connected to `notch-site` `main`.
- Build: `npm ci && npm run build`; output `dist`.
- Preview deploys per PR; production on merge.
- Custom domain + HTTPS + HSTS; `www` → apex redirect.
- Security headers: `Content-Security-Policy`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Content-Type-Options: nosniff`, `Permissions-Policy` (no camera/mic on the marketing site).

### 9.2 Workflows

`deploy.yml` — on push/PR: install, typecheck, build, (optional) Lighthouse CI, deploy preview.

`refresh-release.yml` — nightly + `release` event:
1. `gh api repos/Saiteja02806/heronotch/releases/latest`
2. Download `SHA256SUMS.txt`, parse the two hashes.
3. Write `src/data/release.json`.
4. Commit `chore: refresh release data` and push (triggers deploy).

This keeps version, size, hashes, and links current without a server.

### 9.3 Domain & email

- Register `heronotch.app` (safe, matches the repo) or `notchforwindows.com`.
- Add `hello@` / `support@` forwarding.
- Use the same address in the footer, privacy page, and GitHub issue templates.

---

## 10. Build plan

### Phase 0 — inputs (½ day)

Collect screenshots, clips, logo SVG, release data, legal copy, and the feature/FAQ content.
Everything below assumes these exist; see [`DEMO.md`](./DEMO.md) for the asset list.

### Phase 1 — skeleton (1–2 days)

Astro + Tailwind + tokens + fonts; Nav, Footer, Base layout; landing hero + desktop stage;
download card wired to a mock `release.json`; responsive pass.

### Phase 2 — story (2–3 days)

Tour island with 7 clips; six feature splits; bento; install steps; limits; FAQ; final CTA.
Copy from [`COPY.md`](./COPY.md). Video encoding and posters.

### Phase 3 — trust & pages (1–2 days)

`/download` with SmartScreen/SAC/verify; `/changelog`; `/help`; `/privacy`; `/terms`; 404.
Release refresh workflow + download redirect function.

### Phase 4 — polish (1–2 days)

SEO metadata + OG images + JSON-LD + `llms.txt`; analytics events; Lighthouse; axe/pa11y; keyboard
and reduced-motion passes; cross-browser (Chrome, Edge, Firefox, Safari); 360px mobile.

### Phase 5 — optional depth (ongoing)

Feature pages, comparison pages, guides, roadmap, interactive simulator, light/dark toggle,
release announcement posts.

**MVP total: ~5–9 focused days** after assets are ready. The simulator adds 2–3 days.

### Acceptance criteria

- A first-time visitor can explain the product after 10 seconds and download in two clicks.
- The download button always resolves to the latest stable asset.
- No horizontal scroll at 360/768/1280/1536.
- Lighthouse mobile: Performance ≥ 90, Accessibility ≥ 95, SEO 100, Best Practices ≥ 95.
- `prefers-reduced-motion` and keyboard-only flows work.
- Every claim on the page is true for v1.0.22.
- The unsigned/SAC reality is explained before the download.

---

## 11. Risks and how to handle them

| Risk | Mitigation |
| --- | --- |
| "Notch" is a generic, crowded name | Strong wordmark + `heronotch.app`; lean on "free Windows" and "local-first". |
| Users abandon at SmartScreen | Put the warning above the download, with screenshots and hashes; offer portable. |
| Smart App Control blocks the app | Explain it honestly; portable fallback; link to Microsoft docs; never tell users to disable security lightly. |
| No auto-update | "Check for updates" link to releases; show version in-app and on site; mention it in limits. |
| Electron size (~128 MB installer / ~113 MB portable) | Do not hide it; frame it as "one small app replaces six"; show actual size. |
| Video weight | Strict budgets, posters, lazy loading, CDN. |
| Spotify/Obsidian/AI trademarks | Text-only mentions, no implied endorsement, follow brand guidelines for logos. |
| Camera privacy concern | Dedicated privacy section + on-device explanation + "camera LED stays on". |
| Stale release links | Stable asset names + nightly release refresh workflow. |

---

## 12. Immediate next steps

1. Approve the positioning, name/domain, and visual direction.
2. Capture the screenshots and clips using [`DEMO.md`](./DEMO.md); without them the site is generic.
3. Add stable asset names (`Notch-Setup.exe`, `Notch-Portable.exe`) to the release workflow.
4. Scaffold `notch-site` with Astro + Tailwind using the tree in §7.3.
5. Build the hero + desktop stage first; it is the whole pitch.
6. Wire `/download` and the release refresh workflow; test the SmartScreen flow on a clean VM.
7. Ship the MVP, then add feature pages and a launch post.
