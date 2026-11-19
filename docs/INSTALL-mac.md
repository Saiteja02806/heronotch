# Install Notch on macOS

Notch runs on macOS 12 (Monterey) and later, on Apple Silicon and Intel Macs.

## Download

From the latest GitHub Release, pick the file for your Mac:

| Your Mac | File |
| --- | --- |
| Apple Silicon (M1, M2, M3, M4…) | `Notch-<version>-arm64.dmg` |
| Intel | `Notch-<version>-x64.dmg` |

Not sure which one you have? Apple menu › **About This Mac**: "Chip: Apple M…" means Apple Silicon, "Processor: Intel" means Intel.

Open the DMG and drag **Notch** into **Applications**.

## First launch: Notch is not notarized

Notch is not signed with an Apple Developer ID, so macOS blocks it the first
time with a message such as *"Notch" cannot be opened because Apple cannot
check it for malicious software* or *Apple could not verify "Notch"*.

Allow it once, using either of these:

**A. System Settings (recommended)**

1. Try to open Notch from Applications and dismiss the warning.
2. Open **System Settings › Privacy & Security**.
3. Scroll down to the message about Notch and click **Open Anyway**.
4. Confirm with your password or Touch ID, then click **Open**.

(On macOS 14 and earlier, right-click Notch in Applications › **Open** also works. macOS 15 removed that shortcut.)

**B. Terminal**

```bash
xattr -dr com.apple.quarantine /Applications/Notch.app
```

If macOS ever says Notch **"is damaged and can't be opened"**, run the command
above. That message comes from the download quarantine, not from a broken file.

## Where it lives

Notch is a menu-bar app: it has **no Dock icon**. Look for:

- the notch tab at the top centre of the screen, inside the menu bar, and
- the Notch icon in the menu bar's status area. Click it to open or close the notch. Right-click (or Control-click) it for the menu, including **Quit Notch**.

The shortcut is **⌘ ⇧ Space**.

## Permissions

macOS asks for each permission only when a feature needs it. All of them can
be changed later in **System Settings › Privacy & Security**, and Notch has a
shortcut to each pane in **Settings › Notch › macOS permissions**.

| Feature | Permission | When it is asked |
| --- | --- | --- |
| Posture coach | Camera | The first time you turn the coach on |
| Blurred desktop behind the open notch | Screen Recording | Never automatically. Turn it on yourself if you want the blur; without it the backdrop is a plain dim layer |
| Spotify play / pause / skip / seek | Automation › Spotify | The first time Notch reads or controls Spotify |
| Reminders | Notifications | The first reminder |
| Launch at login | Login Items | When you turn it on |

Because Notch is ad-hoc signed, macOS may ask again for some permissions after
you install an update. That is expected.

## Updating

Download the new DMG and drag Notch into Applications again, replacing the old
copy. Your notes folder link, tasks, timer and settings are kept in
`~/Library/Application Support/Notch`.

## Uninstall

Quit Notch from its menu-bar icon, then move `/Applications/Notch.app` to the
Trash. To remove your data too, delete `~/Library/Application Support/Notch`.

## For maintainers

- Build both DMGs on a Mac: `npm run dist:mac` (or `npm run dist:mac:arm64`).
  Output goes to `release/`.
- `npm run verify:mac` prints each app's signature and architecture.
- The afterPack hook `scripts/adhoc-sign-mac.cjs` ad-hoc signs the app. Apple
  Silicon refuses to launch an unsigned arm64 app.
- `.github/workflows/release-mac.yml` builds on `macos-latest` for every `v*`
  tag and attaches the DMGs to the release the Windows workflow creates.
- Optional: sign every release with the same self-signed code-signing
  certificate (Keychain Access › Certificate Assistant › Create a Certificate ›
  Code Signing) instead of ad hoc. Gatekeeper still warns, but macOS then keeps
  permission grants across updates.
