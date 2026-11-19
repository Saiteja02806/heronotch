export const DODO_LIVE_API_URL = 'https://live.dodopayments.com'
export const DODO_TEST_API_URL = 'https://test.dodopayments.com'
export const LICENSE_PURCHASE_URL = 'https://www.buildnotch.app/pricing'

/**
 * Informational only: how long ago the last successful Dodo check was. Being offline
 * never locks an activated PC; only an explicit invalid answer from Dodo does.
 */
export const LICENSE_OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000
/** Re-verify active licenses quietly once per 24 hours. */
export const LICENSE_REVALIDATE_MS = 24 * 60 * 60 * 1000

/**
 * Optional Dodo Payments merchant & product pinning.
 * Populate these once your Dodo Payments store/products are created so keys
 * issued by other Dodo businesses or unrelated products cannot activate Notch.
 */
export const DODO_EXPECTED_BUSINESS_ID = 'bus_0Ns4Z5V10oOxG15PpvLTO'
export const DODO_EXPECTED_PRODUCT_IDS: readonly string[] = ['pdt_0NsCiyu9P16LIooKudc8W']

export type LicenseStatus = 'active' | 'unlicensed' | 'expired' | 'invalid'

export interface LicenseState {
  /** True in packaged / Store builds (and when NOTCH_ENFORCE_LICENSE=1 in dev). */
  required: boolean
  status: LicenseStatus
  maskedKey: string | null
  instanceId: string | null
  customerEmail: string | null
  customerName: string | null
  productName: string | null
  activatedAt: number | null
  lastValidatedAt: number | null
  offlineGraceRemainingDays: number | null
  error: string | null
  mode: 'live' | 'test' | 'dev-bypass' | 'demo-bypass'
  purchaseUrl: string
}

export interface DodoActivateParsed {
  instanceId: string
  licenseKeyId: string | null
  businessId: string | null
  productId: string | null
  productName: string | null
  customerEmail: string | null
  customerName: string | null
  name: string | null
}

/** Mask a license key for safe display in the renderer (never exposes full secret). */
export function maskLicenseKey(raw: string): string {
  const key = raw.trim()
  if (!key) return ''
  if (key.length <= 8) {
    return `${'*'.repeat(Math.max(2, key.length - 2))}${key.slice(-2)}`
  }
  return `${key.slice(0, 4)}-••••-••••-${key.slice(-4)}`
}

export function offlineGraceRemainingDays(
  lastValidatedAt: number | null,
  now = Date.now(),
  graceMs = LICENSE_OFFLINE_GRACE_MS
): number | null {
  if (!lastValidatedAt || !Number.isFinite(lastValidatedAt)) return null
  const remaining = lastValidatedAt + graceMs - now
  if (remaining <= 0) return 0
  return Math.ceil(remaining / (24 * 60 * 60 * 1000))
}

export function isWithinOfflineGrace(
  lastValidatedAt: number | null,
  now = Date.now(),
  graceMs = LICENSE_OFFLINE_GRACE_MS
): boolean {
  if (!lastValidatedAt || !Number.isFinite(lastValidatedAt)) return false
  if (lastValidatedAt > now + 5 * 60 * 1000) return false
  return now - lastValidatedAt < graceMs
}

export function validateDodoProductMatch(
  input: { businessId?: string | null; productId?: string | null },
  expectedBusinessId = DODO_EXPECTED_BUSINESS_ID,
  expectedProductIds: readonly string[] = DODO_EXPECTED_PRODUCT_IDS
): { ok: boolean; error?: string } {
  const biz = expectedBusinessId.trim()
  if (biz && (!input.businessId || input.businessId !== biz)) {
    return { ok: false, error: 'That license key belongs to a different product or merchant.' }
  }
  if (expectedProductIds.length > 0 && (!input.productId || !expectedProductIds.includes(input.productId))) {
    return { ok: false, error: 'That license key is not valid for this edition of Notch.' }
  }
  return { ok: true }
}

export function parseDodoActivateResponse(raw: unknown): DodoActivateParsed | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const instanceId = typeof obj.id === 'string' ? obj.id.trim() : ''
  if (!instanceId) return null
  const customer = obj.customer && typeof obj.customer === 'object' ? (obj.customer as Record<string, unknown>) : null
  const product = obj.product && typeof obj.product === 'object' ? (obj.product as Record<string, unknown>) : null
  return {
    instanceId,
    licenseKeyId: typeof obj.license_key_id === 'string' ? obj.license_key_id.trim() : null,
    businessId: typeof obj.business_id === 'string' ? obj.business_id.trim() : null,
    productId: product && typeof product.product_id === 'string' ? product.product_id.trim() : null,
    productName: product && typeof product.name === 'string' ? product.name.trim() : null,
    customerEmail: customer && typeof customer.email === 'string' ? customer.email.trim() : null,
    customerName: customer && typeof customer.name === 'string' ? customer.name.trim() : null,
    name: typeof obj.name === 'string' ? obj.name.trim() : null
  }
}

export function parseDodoValidateResponse(raw: unknown): boolean | null {
  if (!raw || typeof raw !== 'object') return null
  const valid = (raw as Record<string, unknown>).valid
  return typeof valid === 'boolean' ? valid : null
}

export function extractDodoErrorMessage(raw: unknown, statusCode: number): string {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    const msg =
      (typeof obj.message === 'string' && obj.message) ||
      (typeof obj.error === 'string' && obj.error) ||
      (typeof obj.detail === 'string' && obj.detail)
    if (msg) return msg.trim()
  }
  if (statusCode === 404) return 'License key was not found. Double-check the key from your receipt.'
  if (statusCode === 400 || statusCode === 422) {
    return 'This license key could not be activated (it may have reached its device limit or expired).'
  }
  if (statusCode === 429) return 'Too many verification attempts. Please try again in a moment.'
  if (statusCode >= 500) return 'Dodo Payments license server is temporarily unavailable. Try again shortly.'
  return `License check failed (HTTP ${statusCode}).`
}
