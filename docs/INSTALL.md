# Install Notch on Windows

Notch is a Windows 11 dashboard that lives in the top edge of the screen. It is
distributed as a direct download from the releases page, like most small Windows
apps.

## Before you install: Notch is not code-signed yet

Code-signing certificates cost a few hundred dollars a year, and every download
is currently built by hand on GitHub Actions. So the binaries you download are
unsigned. That has two visible consequences.

### 1. SmartScreen shows a warning

On first run Windows shows *"Windows protected your PC"*.

1. Click **More info**.
2. Click **Run anyway**.

The warning disappears once enough people have downloaded the same file.

### 2. Some PCs block it completely (Smart App Control)

If Windows says **"An Application Control policy has blocked this file"**, or the
app starts but no notch appears, this PC has **Smart App Control** enabled.

Smart App Control is a Windows 11 security feature that only allows binaries
that are signed and well known. It checks *every* DLL that a program loads, not
just the `.exe`, so unsigned Electron apps cannot start at all. Microsoft does
not provide any per-app exception, and Notch cannot detect its way around it.

**There is no way to run an unsigned build on such a PC.** You have three
options:

- Use Notch on a PC where Smart App Control is off.
- Wait for a signed build.
- Turn Smart App Control off: **Windows Security → App & browser control →
  Smart App Control → Off**. Be aware that Windows will not let you turn it back
  on without resetting the PC, so only do this if you understand the trade-off.

To check whether Smart App Control is on, open Windows Security and look at
**App & browser control → Smart App Control**.

## Download

Pick one:

| File | Use it when |
| --- | --- |
| `Notch-Setup-<version>.exe` | You want a normal installer with a Start-menu entry and uninstaller. |
| `Notch-Portable-<version>.exe` | You want a single file with no installation. |

Both contain the same app.

## Verify the download (optional, recommended)

```powershell
Get-FileHash .\Notch-Portable-1.0.0.exe -Algorithm SHA256
```

Compare the output with the matching line in `SHA256SUMS.txt`. They must match
exactly. `SHA256SUMS.txt` uses the standard `sha256sum` format: lower-case hash,
two spaces, then the file name.

## First run

- The notch is collapsed at the top edge of the screen. Hover it to open the
  tab, or press the shortcut shown in the app.
- **Esc** or the collapse arrow closes it again. It also closes when you click
  outside it, unless you pin it.
- Everything runs locally. Notes are plain Markdown files in the vault folder
  you pick. Spotify tokens are stored on your PC.

## Where your data lives

| Path | Contents |
| --- | --- |
| `%APPDATA%\notch\notch-state.json` | Settings, tasks, placement, vault path |
| `%APPDATA%\notch\spotify-auth.json` | Spotify tokens and Client ID |
| `%APPDATA%\notch\notch.log` | Startup and crash diagnostics |

Deleting `%APPDATA%\notch` resets the app. Your notes are never stored there.

## Uninstall

- Installer build: **Settings → Apps → Installed apps → Notch → Uninstall**.
- Portable build: delete the `.exe`. Optionally delete `%APPDATA%\notch`.

## If the notch does not appear

1. Look for the Notch icon in the tray (near the clock).
2. Click it, or run the app again; a second launch reveals the existing window.
3. Open the log: tray icon → **Open log file**, or `%APPDATA%\notch\notch.log`.
4. If the log mentions `render-process-gone` and the dialog mentions Smart App
   Control, see the section above.

## For maintainers

- Unsigned releases: `.github/workflows/release-unsigned.yml`
- Signed releases: `.github/workflows/release.yml`
- Signing details and costs: `docs/RELEASE-SIGNING.md`
