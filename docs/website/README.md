# Notch — Website Project

This folder is the handoff package for the public website that ships **Notch for Windows**. Start
here, then open whichever document you need.

| Document | What it contains |
| --- | --- |
| [`BLUEPRINT.md`](./BLUEPRINT.md) | Full report: research on BuildNotch and Notchy, positioning, visual system, page-by-page specs, demo plan, download/trust flow, tech stack, SEO, accessibility, deployment, build plan, risks. |
| [`COPY.md`](./COPY.md) | Finished, paste-ready copy for every page and section. |
| [`DEMO.md`](./DEMO.md) | Shot lists, capture setup, encoding commands, captions and the optional in-page simulator spec. |

The desktop app is unchanged apart from one workflow tweak: releases now also publish
`Notch-Setup.exe` and `Notch-Portable.exe` (version-stripped copies) so the site can link to
`/releases/latest/download/...` forever.

---

## The short version

**What to build:** a static marketing site plus download hub at `heronotch.app` (or
`notchforwindows.com`). One long landing page, then `/download`, `/changelog`, `/help`, `/privacy`,
`/terms`, `/404`.

**Why a site at all:** the app is free but unfinished-looking on GitHub. A site (a) explains what the
notch is in ten seconds, (b) shows it moving, and (c) handles the two questions every Windows user
has — *is it safe?* and *why does Windows warn me?* GitHub Releases stays the file host; the site is
the front door.

**The one decision that matters:** the site must *show the product*. BuildNotch and Notchy both win
on the same axis — you see the notch unfold, in motion, before you read a feature list. Plan for
screenshots and seven short clips before you plan for pages.

---

## What the two reference sites taught us

### BuildNotch (`buildnotch.app`)

A single long page for a $3 Windows utility. Sticky nav → hero with an autoplaying demo reel →
four numbered benefit chapters with looping clips → six 3D widget renders → X testimonials →
pricing → "good to know before you install" (including the SmartScreen warning) → footer.

Take: **constant product motion**, a nav CTA that states the action, and the version visible in the
nav. Skip: 3D icon renders, artificial scarcity, their light/pixel/green brand.

### Notchy (`notchy.dev`)

A mature macOS notch app on Next.js + Tailwind. Its hero *is* the product: a "Try it on this Mac"
stage where you click through tabs (Now Playing, Notifications, Live Activities, Timer…) and toggle
notch/pill. Below: quantified trust (installs, rating, active users, idle CPU), a tabbed tour,
use-case groups, a 78-feature list, reviews, a comparison table, and hundreds of SEO pages.

Take: **the interactive hero stage**, quantified trust, and per-feature pages for search. Skip: the
feature wall and 263 comparison pages — that needs a content team.

### What that means for Notch

Our unfair advantages are **free**, **local-first**, **Windows**, and **breadth in one surface**
(music + notes + planning + posture + AI sessions). The site should read like a well-made desktop
instrument: quiet, precise, honest. Not a SaaS landing page.

---

## Visual direction: "Quiet Instrument"

Warm paper page wrapped around a **dark stage** where the product lives.

- **Palette:** paper `#f4f1ea`, ink `#0b0c0d`, muted `#6f706b`, hairline `#dcd8ce`; signal coral
  `#ff6f61` (one CTA per viewport); night stage `#050607` / `#0d0f10` / border `#232527`.
- **Type:** Instrument Serif for display, Inter for UI and body, JetBrains Mono uppercase for
  eyebrows, labels and the version chip.
- **Layout:** 1200px container, 12-column grid, 96–128px section rhythm, 1px hairlines first, one
  soft shadow only on the stage.
- **Signature element:** a real 122×38 notch tab pinned to the top edge of the dark stage. Hover
  unfolds the actual UI. That is the whole pitch.
- **Motion:** 180–260ms ease-out; one spring on the unfold; scroll reveals are opacity + 8px, once.
  No parallax, no cursor followers, no scroll-jacking. `prefers-reduced-motion` gets posters.

Full tokens, type scale and do/don't table: `BLUEPRINT.md` §3.

---

## The stack

**Astro 5 + TypeScript + Tailwind v4**, static output, Cloudflare Pages.

Why: zero JS by default (only the tour island hydrates), content collections for changelog/FAQ,
built-in image optimization and sitemap, trivial deploys, and much easier to hand off than a
Next.js app that is 95% static.

Dependencies: `astro`, `@astrojs/sitemap`, `@astrojs/mdx`, `@astrojs/rss`, `tailwindcss`,
`@tailwindcss/vite`, `lucide-astro`, `motion` (island only), and the three fontsource packages.

Landing page JS budget: **under 60 KB gzipped**. LCP under 2s, CLS under 0.05.

---

## Page map

```
/            Landing: announcement bar, nav, hero + desktop stage, trust strip, tour,
             six feature splits, bento, install steps, honest limits, FAQ, final CTA, footer
/download    Version card, installer vs portable, hash verification, SmartScreen,
             Smart App Control, first-run checklist, uninstall
/changelog   One entry per GitHub release + RSS
/help        Grouped FAQ with deep links (#smart-app-control, #spotify-client-id)
/privacy     Local files table, camera, Spotify tokens, AI sessions, site analytics
/terms       Plain-language terms
/404
```

Phase 2 (after launch): six `/features/*` pages, two honest `/compare/*` pages, a
`/windows-notch-apps` guide, and a blog.

---

## Downloads and trust

The site never links to a versioned file. The unsigned release workflow now also uploads
`Notch-Setup.exe` and `Notch-Portable.exe`, so these are stable:

```
https://github.com/Saiteja02806/heronotch/releases/latest/download/Notch-Setup.exe
https://github.com/Saiteja02806/heronotch/releases/latest/download/Notch-Portable.exe
https://github.com/Saiteja02806/heronotch/releases/latest/download/SHA256SUMS.txt
```

The site keeps a generated `src/data/release.json` (version, date, size, both hashes, notes URL)
refreshed nightly by a workflow, so the version badge and checksum are never stale.

Trust is a section, not a badge: explain that the build is unsigned, show the PowerShell
`Get-FileHash` command with the real hash, show the SmartScreen steps, and explain Smart App Control
honestly — including that turning it off is a system-wide security decision. Never claim
"virus-free" or show a fake security seal.

---

## Demos to produce

| Asset | Length | Budget |
| --- | --- | --- |
| Hero tour | 30–45 s | ≤ 8 MB |
| Seven feature clips | 8–12 s each | ≤ 1.5 MB each |
| Posters | — | ≤ 120 KB each |
| WebVTT captions | — | per clip |

Silent, 1080p, H.264 + WebM, `+faststart`, real interactions only. Stills at 2× on a clean desktop
with no personal data. Shot lists and ffmpeg commands: `DEMO.md`.

Optional week-2 addition: a single React island that renders the 122×38 tab on a 1200×700 desktop
and unfolds real screenshots on hover. Budget 2–3 days; fall back to a poster on mobile.

---

## Timeline

| Phase | Work | Days |
| --- | --- | --- |
| 0 | Capture screenshots, clips, logo; confirm domain | 0.5 |
| 1 | Astro + Tailwind + tokens + nav/footer + hero stage + download card | 1–2 |
| 2 | Tour island, six feature splits, bento, install, limits, FAQ | 2–3 |
| 3 | `/download`, `/changelog`, `/help`, `/privacy`, `/terms`, release refresh workflow | 1–2 |
| 4 | SEO, OG images, JSON-LD, analytics, Lighthouse, a11y, responsive pass | 1–2 |
| 5 | Optional: feature pages, comparisons, simulator, blog | ongoing |

**MVP: roughly 5–9 focused days after the assets exist.**

---

## Definition of done

- A first-time visitor can explain the product after ten seconds and download in two clicks.
- The download button always resolves to the latest stable asset.
- No horizontal scroll at 360 / 768 / 1280 / 1536.
- Lighthouse mobile: Performance ≥ 90, Accessibility ≥ 95, SEO 100, Best Practices ≥ 95.
- Keyboard-only and `prefers-reduced-motion` flows work.
- Every claim is true for v1.0.22; the unsigned/SAC reality is explained before the download.
- The app repo stays clean: this site lives in its own repo, `notch-site`.

---

## Immediate next steps

1. Approve the name/domain (`heronotch.app` suggested) and the "Quiet Instrument" direction.
2. Capture the stills and clips (`DEMO.md`); nothing else moves the needle as much.
3. Scaffold `notch-site`: Astro + Tailwind, tokens from `BLUEPRINT.md` §7.4, tree from §7.3.
4. Build the hero + desktop stage first, with one clip. Show it to someone who has never seen the
   app; if they cannot describe it back, fix the hero before building anything else.
5. Wire `/download` to the stable asset names and add the nightly `release.json` refresh.
6. Ship, then add feature pages and a launch post.

---

## Facts this report is based on

- App version **1.0.22**, repo `https://github.com/Saiteja02806/heronotch`, branch `main`.
- Latest release assets: `Notch-Setup-1.0.22.exe` (128.2 MB), `Notch-Portable-1.0.22.exe`
  (112.6 MB), `SHA256SUMS.txt`.
- Windows 10/11 x64, Electron, unsigned, no auto-update, per-user NSIS install.
- Local state in `%APPDATA%\notch` (`notch-state.json`, `spotify-auth.json`,
  `spotify-credentials.json`, `notch.log`).
- Features: Spotify (local media session + optional Web API), Markdown notes, planner with
  reminders and under-notch notices, on-device posture with threshold ring and chime, Codex /
  OpenCode / Anti Gravity sessions with reply, focus timer, five accents and multiple notch styles,
  never on the taskbar.
