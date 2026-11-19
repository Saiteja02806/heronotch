import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DODO_EXPECTED_BUSINESS_ID,
  DODO_EXPECTED_PRODUCT_IDS,
  DODO_LIVE_API_URL,
  DODO_TEST_API_URL,
  LICENSE_OFFLINE_GRACE_MS,
  LICENSE_PURCHASE_URL,
  LICENSE_REVALIDATE_MS,
  extractDodoErrorMessage,
  maskLicenseKey,
  offlineGraceRemainingDays,
  parseDodoActivateResponse,
  parseDodoValidateResponse,
  validateDodoProductMatch,
  type LicenseState,
  type LicenseStatus
} from '../shared/license'

interface StoredSecretPayload {
  licenseKey: string
  instanceId: string
  businessId: string | null
  productId: string | null
  productName: string | null
  customerEmail: string | null
  customerName: string | null
  status?: LicenseStatus
  activatedAt?: number | null
  lastValidatedAt?: number | null
}

interface StoredLicenseDisk {
  version: 1
  status: LicenseStatus
  encrypted?: string
  plain?: StoredSecretPayload
  activatedAt: number | null
  lastValidatedAt: number | null
  error: string | null
}

interface LicenseHooks {
  isDemoMode: boolean
  isCapture: boolean
  log: (line: string) => void
  onStateChange: (state: LicenseState) => void
}

let hooks: LicenseHooks | null = null
let secretRecord: StoredSecretPayload | null = null
let diskMeta: Pick<StoredLicenseDisk, 'status' | 'activatedAt' | 'lastValidatedAt' | 'error'> = {
  status: 'unlicensed',
  activatedAt: null,
  lastValidatedAt: null,
  error: null
}
let publicState: LicenseState = {
  required: false,
  status: 'unlicensed',
  maskedKey: null,
  instanceId: null,
  customerEmail: null,
  customerName: null,
  productName: null,
  activatedAt: null,
  lastValidatedAt: null,
  offlineGraceRemainingDays: null,
  error: null,
  mode: 'live',
  purchaseUrl: LICENSE_PURCHASE_URL
}

function licenseFile(): string {
  return path.join(app.getPath('userData'), 'license.json')
}

function resolveApiConfig(): { baseUrl: string; mode: LicenseState['mode']; required: boolean } {
  if (!app.isPackaged) {
    // Demo / capture runs only exist for development builds. A packaged build must
    // never honour --demo, NOTCH_DEMO or NOTCH_CAPTURE as a way around the gate.
    if (hooks?.isDemoMode || hooks?.isCapture) {
      return { baseUrl: DODO_LIVE_API_URL, mode: 'demo-bypass', required: false }
    }
    const customUrl = process.env.NOTCH_LICENSE_API_URL?.trim()
    const useTest = process.env.NOTCH_DODO_ENV === 'test'
    const required = process.env.NOTCH_ENFORCE_LICENSE === '1'
    return {
      baseUrl: customUrl ? customUrl.replace(/\/+$/, '') : useTest ? DODO_TEST_API_URL : DODO_LIVE_API_URL,
      mode: !required ? 'dev-bypass' : customUrl || useTest ? 'test' : 'live',
      required
    }
  }
  return { baseUrl: DODO_LIVE_API_URL, mode: 'live', required: true }
}

function resolveExpectedIds(): { businessId: string; productIds: readonly string[] } {
  if (!app.isPackaged) {
    const envBiz = process.env.NOTCH_DODO_BUSINESS_ID?.trim()
    const envProducts = process.env.NOTCH_DODO_PRODUCT_IDS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return {
      businessId: envBiz || DODO_EXPECTED_BUSINESS_ID,
      productIds: envProducts?.length ? envProducts : DODO_EXPECTED_PRODUCT_IDS
    }
  }
  return {
    businessId: DODO_EXPECTED_BUSINESS_ID,
    productIds: DODO_EXPECTED_PRODUCT_IDS
  }
}

function buildPublicState(): LicenseState {
  const cfg = resolveApiConfig()
  return {
    required: cfg.required,
    status: diskMeta.status,
    maskedKey: secretRecord ? maskLicenseKey(secretRecord.licenseKey) : null,
    instanceId: secretRecord?.instanceId ?? null,
    customerEmail: secretRecord?.customerEmail ?? null,
    customerName: secretRecord?.customerName ?? null,
    productName: secretRecord?.productName ?? null,
    activatedAt: diskMeta.activatedAt,
    lastValidatedAt: diskMeta.lastValidatedAt,
    offlineGraceRemainingDays:
      diskMeta.status === 'active'
        ? offlineGraceRemainingDays(diskMeta.lastValidatedAt, Date.now(), LICENSE_OFFLINE_GRACE_MS)
        : null,
    error: diskMeta.error,
    mode: cfg.mode,
    purchaseUrl: LICENSE_PURCHASE_URL
  }
}

function publish(): LicenseState {
  publicState = buildPublicState()
  hooks?.onStateChange(publicState)
  return publicState
}

async function saveToDisk(): Promise<void> {
  const file = licenseFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  if (!secretRecord) {
    await fs.unlink(file).catch(() => undefined)
    return
  }
  const payload: StoredLicenseDisk = {
    version: 1,
    status: diskMeta.status,
    activatedAt: diskMeta.activatedAt,
    lastValidatedAt: diskMeta.lastValidatedAt,
    error: diskMeta.error
  }
  const sealedRecord: StoredSecretPayload = {
    ...secretRecord,
    status: diskMeta.status,
    activatedAt: diskMeta.activatedAt,
    lastValidatedAt: diskMeta.lastValidatedAt
  }
  const serialized = JSON.stringify(sealedRecord)
  if (safeStorage.isEncryptionAvailable()) {
    payload.encrypted = safeStorage.encryptString(serialized).toString('base64')
  } else if (!app.isPackaged) {
    payload.plain = sealedRecord
  } else {
    throw new Error('Windows credential encryption is unavailable.')
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
  await fs.rename(tmp, file).catch(async () => {
    await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8')
    await fs.unlink(tmp).catch(() => undefined)
  })
}

async function loadFromDisk(): Promise<void> {
  try {
    const raw = await fs.readFile(licenseFile(), 'utf8')
    const parsed = JSON.parse(raw) as StoredLicenseDisk
    let decrypted: StoredSecretPayload | null = null
    if (safeStorage.isEncryptionAvailable()) {
      if (!parsed.encrypted) return
      const json = safeStorage.decryptString(Buffer.from(parsed.encrypted, 'base64'))
      decrypted = JSON.parse(json) as StoredSecretPayload
    } else if (!app.isPackaged && parsed.plain) {
      decrypted = parsed.plain
    }
    if (!decrypted || !decrypted.licenseKey || !decrypted.instanceId) return
    const expected = resolveExpectedIds()
    const match = validateDodoProductMatch(
      { businessId: decrypted.businessId, productId: decrypted.productId },
      expected.businessId,
      expected.productIds
    )
    if (!match.ok) {
      secretRecord = null
      diskMeta = {
        status: 'invalid',
        activatedAt: null,
        lastValidatedAt: null,
        error: match.error || 'Saved license does not match this product.'
      }
      return
    }
    secretRecord = decrypted
    const sealedStatus = decrypted.status || parsed.status || 'unlicensed'
    const sealedActivatedAt = decrypted.activatedAt ?? parsed.activatedAt ?? null
    const sealedValidatedAt = decrypted.lastValidatedAt ?? parsed.lastValidatedAt ?? null
    diskMeta = {
      status: sealedStatus,
      activatedAt: sealedActivatedAt,
      lastValidatedAt: sealedValidatedAt,
      error: null
    }
  } catch {
    secretRecord = null
    diskMeta = { status: 'unlicensed', activatedAt: null, lastValidatedAt: null, error: null }
  }
}

async function postDodo(
  endpoint: '/licenses/activate' | '/licenses/validate' | '/licenses/deactivate',
  body: Record<string, unknown>
): Promise<{ status: number; json: unknown }> {
  const { baseUrl } = resolveApiConfig()
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000)
  })
  const text = await response.text()
  let json: unknown = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = { message: text }
    }
  }
  return { status: response.status, json }
}

export function getLicenseState(): LicenseState {
  return publicState
}

export function isLicenseUnlocked(): boolean {
  return !publicState.required || publicState.status === 'active'
}

export async function activateLicenseKey(rawKey: string): Promise<LicenseState> {
  const key = rawKey.trim()
  if (!key) {
    diskMeta = { ...diskMeta, error: 'Enter the license key from your purchase email.' }
    return publish()
  }

  const deviceName = `${os.hostname() || 'Windows PC'} (${process.platform})`
  try {
    const { status, json } = await postDodo('/licenses/activate', {
      license_key: key,
      name: deviceName
    })
    if (status < 200 || status >= 300) {
      const msg = extractDodoErrorMessage(json, status)
      hooks?.log(`license: activate failed status=${status}`)
      diskMeta = { ...diskMeta, error: msg }
      return publish()
    }
    const parsed = parseDodoActivateResponse(json)
    if (!parsed) {
      diskMeta = { ...diskMeta, error: 'Unexpected response from Dodo license server.' }
      return publish()
    }

    const expected = resolveExpectedIds()
    const match = validateDodoProductMatch(
      { businessId: parsed.businessId, productId: parsed.productId },
      expected.businessId,
      expected.productIds
    )
    if (!match.ok) {
      // Release the unused activation seat immediately so wrong-product keys do not burn an activation.
      void postDodo('/licenses/deactivate', {
        license_key: key,
        license_key_instance_id: parsed.instanceId
      }).catch(() => undefined)
      diskMeta = { ...diskMeta, error: match.error || 'License key does not match Notch.' }
      return publish()
    }

    const now = Date.now()
    secretRecord = {
      licenseKey: key,
      instanceId: parsed.instanceId,
      businessId: parsed.businessId,
      productId: parsed.productId,
      productName: parsed.productName,
      customerEmail: parsed.customerEmail,
      customerName: parsed.customerName
    }
    diskMeta = {
      status: 'active',
      activatedAt: now,
      lastValidatedAt: now,
      error: null
    }
    await saveToDisk()
    hooks?.log(`license: activated instance=${parsed.instanceId}`)
    return publish()
  } catch (cause) {
    const message =
      cause instanceof Error && cause.name === 'TimeoutError'
        ? 'License activation timed out. Check your internet connection and try again.'
        : cause instanceof Error
          ? `Could not reach Dodo Payments: ${cause.message}`
          : 'Could not reach Dodo Payments.'
    hooks?.log(`license: activate error (${message})`)
    diskMeta = { ...diskMeta, error: message }
    return publish()
  }
}

export async function validateStoredLicense(manual = true): Promise<LicenseState> {
  if (!secretRecord) {
    if (manual) diskMeta = { ...diskMeta, error: 'No license key is saved on this PC.' }
    return publish()
  }
  try {
    const { status, json } = await postDodo('/licenses/validate', {
      license_key: secretRecord.licenseKey,
      license_key_instance_id: secretRecord.instanceId
    })
    if (status >= 200 && status < 300) {
      const valid = parseDodoValidateResponse(json)
      if (valid === true) {
        diskMeta = {
          ...diskMeta,
          status: 'active',
          lastValidatedAt: Date.now(),
          error: null
        }
        await saveToDisk()
        hooks?.log('license: validation ok')
        return publish()
      }
      if (valid === false) {
        diskMeta = {
          ...diskMeta,
          status: 'invalid',
          error: 'This license key is deactivated, refunded, or expired.'
        }
        await saveToDisk()
        hooks?.log('license: validation returned valid=false')
        return publish()
      }
    }
    if (status === 404 || status === 400 || status === 422) {
      diskMeta = {
        ...diskMeta,
        status: 'invalid',
        error: extractDodoErrorMessage(json, status)
      }
      await saveToDisk()
      return publish()
    }
    if (manual) {
      diskMeta = { ...diskMeta, error: extractDodoErrorMessage(json, status) }
    }
    return publish()
  } catch {
    // Once activated on this PC, network failures must never lock out an already
    // active license — but never unlock a license already marked invalid/unlicensed.
    if (manual) {
      if (diskMeta.status === 'active') {
        diskMeta = {
          ...diskMeta,
          error: 'Offline right now — your license stays active on this PC.'
        }
      } else {
        diskMeta = {
          ...diskMeta,
          error: 'Could not reach Dodo Payments. Connect to the internet to verify your license key.'
        }
      }
    }
    return publish()
  }
}

export async function deactivateStoredLicense(): Promise<LicenseState> {
  if (!secretRecord) {
    diskMeta = { status: 'unlicensed', activatedAt: null, lastValidatedAt: null, error: null }
    await saveToDisk()
    return publish()
  }
  try {
    const { status, json } = await postDodo('/licenses/deactivate', {
      license_key: secretRecord.licenseKey,
      license_key_instance_id: secretRecord.instanceId
    })
    if ((status >= 200 && status < 300) || status === 404 || status === 400 || status === 422) {
      hooks?.log(`license: deactivated status=${status}`)
      secretRecord = null
      diskMeta = { status: 'unlicensed', activatedAt: null, lastValidatedAt: null, error: null }
      await saveToDisk()
      return publish()
    }
    diskMeta = { ...diskMeta, error: extractDodoErrorMessage(json, status) }
    return publish()
  } catch {
    diskMeta = {
      ...diskMeta,
      error: 'Connect to the internet so Notch can free this device seat on Dodo Payments.'
    }
    return publish()
  }
}

let revalidateTimer: ReturnType<typeof setInterval> | null = null

/** Quietly re-check the saved key when the last successful check is over 24h old. */
async function revalidateIfStale(): Promise<void> {
  if (!secretRecord || diskMeta.status !== 'active') return
  const last = diskMeta.lastValidatedAt
  if (last && Date.now() - last < LICENSE_REVALIDATE_MS) return
  // Network failures are swallowed inside validateStoredLicense: only an explicit
  // "invalid / refunded / deactivated" answer from Dodo can lock the app.
  await validateStoredLicense(false)
}

function startRevalidation(): void {
  if (revalidateTimer || !resolveApiConfig().required) return
  void revalidateIfStale()
  revalidateTimer = setInterval(() => void revalidateIfStale(), 60 * 60 * 1000)
  revalidateTimer.unref()
}

export async function initLicense(nextHooks: LicenseHooks): Promise<LicenseState> {
  hooks = nextHooks
  await loadFromDisk()
  const state = publish()
  startRevalidation()
  return state
}
