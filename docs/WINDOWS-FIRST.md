# Windows-first Notch

Scope confirmed by the user on 15 November 2026: Windows PC features first.
The current Electron app is the implementation base. Phone/Bluetooth integration
is deferred; PC media, notes, timers and reminders do not depend on a phone.

## First usable version

| Capability | Intended behavior | Current evidence and remaining check |
| --- | --- | --- |
| Compact desktop notch | Open, collapse, move, pin, recover from tray; respect display scaling | Existing source and earlier local geometry checks. Native desktop acceptance remains open in MISTAKES.md. |
| Real PC media | Show the actual player and track; command only that player; identify unavailable and remembered data | Native monitor, selection and queued-command paths exist. This pass checks read failure/recovery and history labels. Two-player live control acceptance remains open. |
| Tasks and reminders | Only user tasks; save edits and survive restart; deliver reminders | Fresh task list corrected to empty. Actual state loading/persistence functions passed with a memory filesystem. Native reminder delivery remains to be checked. |
| Notes | Choose a real folder; read, edit and save files | Existing preload/main handlers and local filesystem integration. No note operation was exercised in this pass. |
| Focus timer | Start/pause/reset and recover saved state; notify on completion | Existing implementation, preserved. Native completion and restart acceptance remains open. |
| Clear empty/error states | Never invent activity or keep failed data looking live | Implemented media failure transition and explicit Last played/Paused/Nothing playing headings. Native rendered output remains open. |

Existing coding sessions, posture, water tracking, Spotify account features and
display preferences remain available. No existing user records were deleted.
Optional developer demo modes were not enabled or removed in this pass.

## 15 November local correction receipt

Baseline: c72b327 plus pre-existing working-tree edits to media targeting, display
layout, visibility and other source files. Those edits were preserved.

- New state starts with `tasks: []`. Existing saved arrays are loaded unchanged;
  records are not removed based on their titles.
- A failed media read marks the remembered playback unavailable and stops its
  playing flag. Track history and source identity remain available. A successful
  later read restores actual playback state.
- Dashboard and Music headings distinguish Now playing, Paused, Last played,
  and Nothing playing.

| Boundary | Verification |
| --- | --- |
| Fresh/default and saved task state -> persistence -> reload | VERIFIED locally with actual state functions and simulated filesystem; existing task editing preserved. |
| Actual renderer refresh callback -> failure state -> recovery | VERIFIED locally with simulated IPC responses and real callback/helper code. |
| A pending failure -> changed player selection | VERIFIED locally; late A failure does not overwrite B. |
| Track flags -> heading function | VERIFIED locally for live, paused, remembered and empty states; both source components call the function. |
| Rendered desktop headings and controls | NOT TESTED; requires launching an authorized build containing the changes. |
| Live Windows media disappearance/recovery and targeted controls | NOT TESTED in this pass; exercise two real players and ensure commands never reach the wrong one. |

Commands: `node --test scripts/check-real-data.cjs` passed 7/7 checks;
`npm run typecheck` passed both noEmit checks; `git diff --check` passed.
The first harness run failed before tests because of an unavailable compiler API;
the corrected harness uses Node type stripping and the final seven checks passed.

No application build, deployment, live playback command, or real saved-state write
was performed. Incidents: NOTCH-20261115-REAL-DATA-STATES and
NOTCH-20261115-CHECK-HARNESS in MISTAKES.md. Native acceptance stays OPEN.
