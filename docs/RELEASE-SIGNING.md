# Release signing for Notch

Notch is distributed as a direct download from the website, so the installer and
every binary inside it must be Authenticode-signed. Windows 11 **Smart App
Control** evaluates every `.exe`, `.dll`, and `.node` that is loaded — not just
the installer — so signing only `Notch.exe` is not enough.

## What happened before

- The unsigned portable was blocked before it started
  (`Application Control policy has blocked this file`, CodeIntegrity event 3118).
- The dev build started but its renderer was killed while loading
  `ffmpeg.dll` and `vk_swiftshader.dll`, leaving an invisible window.

Both are the same root cause: unsigned code under Smart App Control.

## What Microsoft actually guarantees

Two different systems decide whether a download runs:

| System | What it checks | Result for a validly signed app |
| --- | --- | --- |
| **Smart App Control** | Cloud verdict first; if the cloud cannot classify the file, a valid signature from a Microsoft Trusted Root CA is enough | **Runs.** Unsigned or invalidly signed files are blocked. |
| **SmartScreen** | Publisher reputation and per-file hash reputation | **Still warns** ("unrecognized app") until reputation accumulates |

This is the single most important expectation to set: signing fixes *execution*
under Smart App Control, but it does **not** remove the first-download
SmartScreen prompt. Microsoft states this explicitly for OV in its
[SmartScreen reputation guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation):

> Valid Certificate (OV/EV): Warning — app flagged as unrecognized until
> reputation accumulates; verified publisher name is displayed.

EV no longer bypasses SmartScreen, so there is no reason to pay for it here.
Reputation is tied to the **certificate key**, not the CA: renewing with a new
key starts over.

The Microsoft Store avoids the warning entirely because Microsoft re-signs the
package — but the product is a direct website download, so that trade-off is
accepted.

## Certificate options for India

Azure Artifact Signing (formerly Trusted Signing) is **not available** to
individual developers in India (individuals: US/Canada only), so a traditional
certificate is required. Only cloud-signing products that work unattended in
CI are viable, because this PC cannot build NSIS installers and has no room for
a local VM.

| Provider | Product | Price | CI/CD signing | Verdict |
| --- | --- | --- | --- | --- |
| **SSL.com** | **IV Code Signing + eSigner** | **$129/yr + $15/mo** (annual) | **Yes** — eSigner CKA exposes the certificate to `signtool.exe` | **Recommended** |
| Certum | Standard/Individual Code Signing in the Cloud | $99–$139/yr | **No** — SimplySign needs a one-time code from the mobile app; Certum states CI/CD is not supported yet | Not viable for this pipeline |
| Sectigo / Comodo resellers | OV / Individual | from ~$219/yr | Only with a USB token in the build machine | Needs a build PC without Smart App Control |
| DigiCert | OV | ~$400/yr | KeyLocker / Secure App Service | Works, but the most expensive |

SSL.com's code-signing roots (`SSL.com Code Signing RSA Root CA 2022` and
`SSL.com Code Signing ECC Root CA 2022`) are listed as **Included** in the
Microsoft Trusted Root Program, which is what Smart App Control checks.

Identity validation usually takes **1–7 business days** (up to 20 if documents
are requested). Individuals submit government ID (passport, Aadhaar, PAN +
voter ID, or driver's licence) and a recent utility bill. Certificates issued
after February 2026 are valid for at most ~459 days.

## Build configuration (already in place)

`package.json`:

- keeps **portable** as the local default (it builds even with Smart App Control on);
- provides `dist:win` and `dist:signed` for **portable + NSIS installer**;
- signs `.exe`, `.dll`, and `.node` (`signExts`), which covers
  `ffmpeg.dll`, `vk_swiftshader.dll`, `vulkan-1.dll`, `dxcompiler.dll`,
  `electron_wer.dll`, `resources\elevate.exe`, and native modules;
- timestamps with RFC 3161;
- keeps signing optional for local builds and enforces it for releases through
  `npm run dist:signed` (`forceCodeSigning`).

> **NSIS builds cannot run on this PC.** electron-builder builds a temporary
> unsigned installer, runs it to generate the uninstaller, and signs it
> afterwards. Smart App Control blocks that temporary executable, so the build
> fails with `spawn UNKNOWN`. The portable target does not do this and still
> builds locally. Release builds therefore run in CI.

## Recommended pipeline: GitHub Actions + eSigner

`.github/workflows/release.yml` builds, signs, verifies, and hashes both
artifacts on a clean `windows-latest` runner. It already handles the two
problems that break naive setups:

1. **electron-builder's bundled `signtool.exe` does not work with eSigner.**
   The workflow locates the Windows SDK copy and sets `SIGNTOOL_PATH`, which
   electron-builder v26 honours.
2. **SSL.com's malware blocker must be disabled** for the certificate, otherwise
   signing fails with `SignerSign() failed (-2146893821)`. Turn it off in the
   SSL.com order page when enrolling the certificate in eSigner.

### One-time setup

1. Buy **SSL.com IV Code Signing** and enroll the certificate in **eSigner**
   (Tier 1, 240 signings/month is enough: a release signs about 12 files).
2. Disable **malware blocker** for the certificate in the SSL.com order page.
3. Push this repository to GitHub (private is fine).
4. Create an environment named `release-signing` in the repository settings and
   add the secrets there:
   - `ESIGNER_USERNAME` — SSL.com account e-mail
   - `ESIGNER_PASSWORD` — SSL.com account password
   - `ESIGNER_TOTP_SECRET` — OAuth TOTP secret from eSigner enrolment
   - `ESIGNER_MODE` — `product`
   - optional `ESIGNER_CERT_MATCH` — part of the certificate subject if the
     account has more than one certificate
5. Run **Actions → Build and sign Notch → Run workflow**.

The workflow fails closed: `forceCodeSigning` stops the build if any file could
not be signed, `verify-signatures.ps1` fails if any `.exe` / `.dll` / `.node`
in `release\win-unpacked` or the artifacts is unsigned, and only then are
`Notch-Setup-*.exe`, `Notch-Portable-*.exe`, and `SHA256SUMS.txt` uploaded.

The TOTP secret can sign code as you. Keep it in the `release-signing`
environment (not a plain repository secret), require a reviewer if the
repository has collaborators, and rotate it if it is ever exposed.

## Alternative: USB token on a build PC

If you buy a token-based certificate instead, run this on a Windows PC or VM
**without Smart App Control**:

```powershell
npm run dist:signed
npm run verify:signatures
```

Then add the certificate identity to `package.json` under
`build.win.signtoolOptions`:

```json
"certificateSubjectName": "CN=Your Legal Name"
```

or, if several certificates exist, `"certificateSha1": "ABCDEF..."`. A token
must stay plugged in, so this cannot run unattended in CI.

## Optional: sign the local dev binaries

`npx electron .` uses unsigned binaries from `node_modules`, so Smart App
Control still blocks development on this PC even after release signing. After
the certificate is installed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sign-dev-electron.ps1 `
  -Subject "CN=Your Legal Name"
```

Running `npm ci` removes those signatures; re-run the script afterwards. A
Windows 11 VM without Smart App Control is still the cleaner development
environment, but this PC has only ~15 GB free, so CI is the practical build
path.

## Publishing

Upload from the CI artifact bundle:

- `Notch-Setup-<version>.exe` — installer, recommended download
- `Notch-Portable-<version>.exe` — portable
- `SHA256SUMS.txt` — publish next to the downloads

Keep the same certificate identity for every release. Do not re-key on renewal
unless the old key is compromised; a new key resets SmartScreen reputation.

## Validate before announcing

Test on a **clean Windows 11 VM with Smart App Control On**:

1. Download the artifact through a browser, not a local copy.
2. Confirm the publisher name in the UAC prompt.
3. Install, launch, and confirm the notch appears.
4. Install and uninstall, then check
   `Microsoft-Windows-CodeIntegrity/Operational` for events 3033/3077/3118.
5. Exercise the features that load extra binaries: posture camera, Spotify,
   Obsidian vault, reminders/notifications.
6. Expect the SmartScreen "unrecognized app" prompt on early downloads. It
   fades as the certificate builds reputation; Smart App Control should still
   allow the app to run.
