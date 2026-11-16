# Notch incident ledger

## NOTCH-20261115-COMPACT-LAYOUT · 15 November 2026

- User report and impact. The expanded compact panel uses too much vertical space and shows too little of the selected page. The annotated Settings screenshot requests a wider, shorter footprint.
- Verified baseline at c72b327. Compact geometry caps at 440 × 360 logical pixels. Compact Settings stacks navigation above the content, and the content reserves 34 pixels for a 40-pixel overlay footer. These rules limit the visible settings area. Other page-specific clipping in the reported session is unknown.
- Expected. Keep navigation reachable while making more horizontal room for values and actions. Preserve compact and enlarged modes, placement, and the native input region.
- Status at intake. OPEN. Compare both panel sizes, check narrow-screen fallback, test scrolling to the last setting, and verify the compact footer and content do not overlap.

### Correction and local verification · 15 November 2026

- Compact now caps at 624 × 296. The rendered panel, open animation and native shape use the shared geometry. Wide compact Settings uses a side rail and narrow compact Settings retains tabs. The footer participates in layout.
- Headless Edge rendered the source Settings, header and footer with test state and the project stylesheet. At 624 × 296 and 350 × 296 there was zero horizontal overflow in the settings column. The content ended at y=259, exactly where the footer began. The final settings group scrolled fully into view at both widths. At 1120 × 600 the full-size rail and scrolling also passed. Music playback, disconnected Spotify setup and Water action buttons passed pointer hit tests in wide compact mode.
- Related visibility change. The browser-only switch produced true and false patches. The real state store preserved the enabled value after reload and defaulted missing or invalid values to off. The real Windows watcher reported false in the sandbox and true on the desktop. Preload and main-handler tests with simulated Electron transport and window verified hide/show, last-window close, tray recovery, manual hiding, fullscreen and named-app exclusions.
- OPEN for packaged output. On a build containing these changes, check the compact panel at desktop scaling, open and minimize a supported browser, close its last window, recover from the tray, then disable the option and restart. These checks did not launch or modify the installed application.

## NOTCH-20261115-MEDIA-TARGET · 15 November 2026

- Observed in the roadmap review. The real PowerShell Get-TargetSession function was given a synthetic session manager with TestBrowser active and an explicit TestMusicPlayer target that was absent. It returned TestBrowser. The renderer also uses Spotify account connection status to expose Spotify controls, and labels a local media session as Spotify Desktop even when Windows can supply another player.
- Expected and impact. If an explicitly selected player disappears between polling and command execution, its controls should report that it is unavailable. A pending command can otherwise reach a different player. The screen should identify the actual source and display the controls available for it.
- Evidence and cause. In src/main/localMedia.ts the exact-name lookup falls through to the current or first session. In src/renderer/src/pages/MusicPage.tsx account connection and local availability drive the control and label branches. The selector fallback was executed against a fixture. No live playback command was sent.
- Status OPEN. Verify Spotify connected and disconnected with a second active player. Select A, remove A before its queued command runs, and assert B receives no command. Reopen A, switch to B, and confirm the visible player, transport destination and supported controls agree. Verify auto-follow separately.

## NOTCH-20261115-REAL-DATA-STATES · 15 November 2026

- Expected. The Windows-first notch shows actual user activity. New task lists start empty, unavailable media is not presented as live, and remembered real tracks are identified as history.
- Verified source observations. `createDefaultState` inserts two onboarding tasks into the user's task list. `refreshPlayer` catches a failed read without clearing the previous playback's connected/playing flags. Dashboard always labels the card Now playing; Music labels any track Now playing, including a cached track. These source branches are verified; their appearance in the installed app has not been observed in this task.
- Impact. Invented tasks can look like user activity. A media read failure can leave stale live indicators and advancing progress. Saved track history itself is useful and must be preserved.
- Root cause. Seed content is mixed with user state; the media error transition updates the error only; headings do not distinguish live, paused and remembered data.
- Correction/status. OPEN, scoped local correction in progress. Preserve existing saved tasks, media targeting, automatic player selection, Spotify recovery, notes, timers, and display geometry. No application build or deployment authorized by this record.
- Prevention. Exercise fresh state, explicit empty state and existing-state restoration; media playing -> read failure -> recovery; cached/paused/playing headings; A-to-B player selection and null playback. Verify actual desktop loss/recovery separately before calling output accepted.

### NOTCH-20261115-CHECK-HARNESS · 15 November 2026

- Observed/expected. Initial new regression script exited before tests because it assumed the installed TypeScript package exported `ScriptTarget` and `createSourceFile`. Expected checks to execute the actual source without an application build.
- Evidence/root cause. `node --test scripts/check-real-data.cjs` returned TypeError reading `ScriptTarget.Latest`; this installed package does not expose the assumed compiler API. Application type checking passed independently. This was a test harness error, not an observed application failure.
- Correction. Use Node's existing in-memory type stripping, following the repository's native-media check pattern; extract the actual refresh callback with an asserted boundary. Final rerun pending.
- Prevention. Verify installed package exports before using a compiler API, and distinguish harness startup failure from behavioral test failures. Never interpret a noEmit type check as runtime acceptance.

### Real-data correction verification · 15 November 2026

- IMPLEMENTED: empty new task lists, unavailable playback transition on failed reads, and history/paused/live/empty headings in Dashboard and Music. Existing saved tasks, track history and recovery functions preserved.
- LOCALLY VERIFIED: `node --test scripts/check-real-data.cjs` passed 7/7 checks after correcting the harness. Actual state initialization, persistence, editing and reload ran with a simulated filesystem. The actual refresh callback ran against simulated successful, failed and late IPC responses; loss/recovery and A-to-B isolation passed. Both noEmit type checks and `git diff --check` passed.
- OPEN: rendered desktop states, real Windows player closure/recovery, two-player command isolation, and packaged output. No build, deployment, real state mutation or live playback command occurred. Full scope and exact checks: WINDOWS-FIRST.md. A successful local check does not establish native user-facing acceptance.

- Ledger tooling follow-up: a multiline patch passed through the Windows batch wrapper was rejected before any global-ledger write. Retrying the same scoped append directly through the native patch executable succeeded. Exact batch argument-loss mechanism was not investigated. For multiline patches, use the native patch tool directly and verify the resulting append.

### NOTCH-20261115-MEDIA-TARGET verification update

- The corrected native selector was exercised with two distinguishable simulated Windows sessions. In both directions it selected the named player while present and returned null after removal even though the other player remained current. Seven existing state/display regression checks passed.
- Spotify and the YouTube test video were opened on the desktop. The desktop-session inspection command was rejected before execution because automatic approval review hit its usage limit. Live transport and closure in both directions remain OPEN. A selector fixture does not prove actual app behavior. No build was started.
