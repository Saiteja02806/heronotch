# Microsoft Store (MSIX) + Dodo Payments Setup Checklist

This repository is prepared to ship Notch through the **Microsoft Store (`appx`)** at **\$0 signing cost** while selling one-time license keys through **Dodo Payments** on `buildnotch.app` (**0% Microsoft Store cut** under Policy 10.8 for non-game PC apps).

---

## 1. Dodo Payments setup (Website checkout & license keys)

1. Create your **Dodo Payments** account and complete merchant KYC.
2. Create your one-time products (for example **Early Bird — \$3.99** and **Standard — \$9.99**) and enable **License Key generation** on each product.
3. Copy from your Dodo dashboard:
   - Your **Business ID** (`bus_...`) -> put into `DODO_EXPECTED_BUSINESS_ID` in `src/shared/license.ts`.
   - Your **Product IDs** (`pdt_...`) -> put into `DODO_EXPECTED_PRODUCT_IDS` in `src/shared/license.ts`.
   - Note: `src/main/license.ts` calls only Dodo's public unauthenticated client endpoints (`/licenses/activate`, `/licenses/validate`, `/licenses/deactivate`), so **no secret API key** is embedded in the desktop app.
4. Put the Dodo checkout payment links into `notch-website/src/pages/pricing.astro`, and after payment redirect/deliver users to:
   - Your direct Microsoft Store Web Installer (`https://get.microsoft.com/installer/download/<Store-App-ID>`), plus
   - Their Dodo license key (sent automatically by Dodo's receipt email as well).

---

## 2. Microsoft Partner Center setup (`$0`)

1. Register at `https://storedeveloper.microsoft.com` (**\$0** fee waived for both Individual and Company accounts).
   - Use a **Company** account if publishing under a brand name rather than your personal legal name (Store Policy 10.14).
2. Create a new **MSIX or PWA app** in Partner Center -> **Apps and games** -> **New product**, and reserve your app name.
3. Under **Product management -> Product identity**, copy:
   - **`Package/Identity/Name`** -> update `"appx.identityName"` in `package.json`
   - **`Package/Identity/Publisher`** (`CN=...`) -> update `"appx.publisher"` in `package.json`
   - **`Package/Properties/PublisherDisplayName`** -> update `"appx.publisherDisplayName"` in `package.json`
   - **`Store ID`** -> builds your `https://get.microsoft.com/installer/download/<Store-ID>` website download URL.

---

## 3. Build the Store package

```powershell
npm run typecheck
npm run dist:store
```

This builds `out/`, bundles the pre-compiled Windows foreground helper (`resources/notch-foreground.exe`), declares the `<desktop:StartupTask TaskId="NotchStartup" Enabled="true" />` login entry (`build/appx-extensions.xml`), packs Store icons (`build/appx/*.png`), and outputs the `.appx` package inside `release/` (no paid CA certificate needed — Microsoft Store signs it automatically after certification).

*(Remember: `installer` self-updates via GitHub Releases are automatically disabled whenever `process.windowsStore === true`; Microsoft Store manages updates itself.)*

---

## 4. Partner Center Submission Fields

- **Pricing & Availability:** Set Store price to **Free** and declare **third-party / external commerce** (Policy 10.8 / 10.8.6).
- **Store Listing Description:** State clearly that Notch is free to download from the Store and requires a one-time license key from `https://www.buildnotch.app/pricing` (Policy 10.8.4).
- **Capabilities (`runFullTrust` justification):** Explain that Notch is a desktop workspace needing access to user-chosen Markdown/Obsidian folders and local coding session status files.
- **Notes for Certification (Policy 10.3.1):** Generate 1 test license key in Dodo Payments and paste it in **Notes for certification** so Microsoft's human reviewer can activate and test Notch.
