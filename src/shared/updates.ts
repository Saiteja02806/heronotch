import { plainErrorMessage } from './errors'

export const GITHUB_OWNER = 'Saiteja02806'
export const GITHUB_REPO = 'heronotch'
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`
export const GITHUB_LATEST_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

export type UpdateInstallKind = 'nsis' | 'portable' | 'store' | 'source' | 'disabled'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  installKind: UpdateInstallKind
  currentVersion: string
  availableVersion: string | null
  releaseName: string | null
  releaseNotes: string | null
  releaseUrl: string | null
  downloadUrl: string | null
  publishedAt: string | null
  progress: number | null
  transferredBytes: number | null
  totalBytes: number | null
  bytesPerSecond: number | null
  checkedAt: number | null
  error: string | null
  /** True when the app can download the installer inside Settings via electron-updater. */
  canAutoDownload: boolean
  /** True only when an NSIS update is downloaded and ready for quitAndInstall(). */
  canAutoInstall: boolean
}

export interface GitHubReleaseAsset {
  name?: unknown
  browser_download_url?: unknown
}

export interface GitHubLatestReleasePayload {
  tag_name?: unknown
  name?: unknown
  body?: unknown
  html_url?: unknown
  published_at?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: unknown
}

interface ParsedSemver {
  core: [number, number, number]
  pre: (number | string)[]
}

function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = raw.trim().replace(/^v/i, '').split('+')[0]
  if (!cleaned) return null
  const dashIndex = cleaned.indexOf('-')
  const coreRaw = dashIndex >= 0 ? cleaned.slice(0, dashIndex) : cleaned
  const preRaw = dashIndex >= 0 ? cleaned.slice(dashIndex + 1) : ''
  const parts = coreRaw.split('.')
  if (parts.length === 0 || parts.length > 3) return null
  const nums: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < parts.length; i += 1) {
    if (!/^\d+$/.test(parts[i])) return null
    nums[i] = Number(parts[i])
  }
  const pre = preRaw
    ? preRaw
        .split('.')
        .filter((part) => part.length > 0)
        .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()))
    : []
  return { core: nums, pre }
}

/** Compare two semver strings (with or without a leading `v`). Returns -1, 0, or 1. */
export function compareVersions(left: string, right: string): number {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) {
    return left.trim().replace(/^v/i, '').localeCompare(right.trim().replace(/^v/i, ''))
  }
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const len = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < len; i += 1) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

export function normalizeVersionTag(version: string): string {
  return version.trim().replace(/^v/i, '')
}

/** Reduce GitHub/YAML release notes (HTML or Markdown) to concise plain lines for Settings. */
export function cleanReleaseNotes(raw: unknown): string | null {
  let text = ''
  if (typeof raw === 'string') {
    text = raw
  } else if (Array.isArray(raw)) {
    text = raw
      .map((entry) => {
        if (typeof entry === 'string') return entry
        if (entry && typeof entry === 'object' && typeof (entry as { note?: unknown }).note === 'string') {
          return (entry as { note: string }).note
        }
        return ''
      })
      .filter(Boolean)
      .join('\n\n')
  }
  if (!text.trim()) return null

  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1].length > 0))
    .join('\n')
    .trim()

  if (!normalized) return null
  if (normalized.length <= 720) return normalized
  return `${normalized.slice(0, 717).trimEnd()}…`
}

export function selectGitHubReleaseAsset(
  assets: unknown,
  installKind: UpdateInstallKind,
  fallbackUrl: string | null = GITHUB_RELEASES_URL
): string | null {
  if (!Array.isArray(assets) || installKind === 'source' || installKind === 'disabled') {
    return fallbackUrl
  }
  const valid = assets.filter(
    (item): item is { name: string; browser_download_url: string } =>
      Boolean(item) &&
      typeof (item as GitHubReleaseAsset).name === 'string' &&
      typeof (item as GitHubReleaseAsset).browser_download_url === 'string' &&
      /^https:\/\//i.test((item as GitHubReleaseAsset).browser_download_url as string)
  )

  const patterns =
    installKind === 'portable'
      ? [/^Notch-Portable-.+\.exe$/i, /^Notch-Portable\.exe$/i]
      : [/^Notch-Setup-.+\.exe$/i, /^Notch-Setup\.exe$/i]

  for (const pattern of patterns) {
    const match = valid.find((item) => pattern.test(item.name))
    if (match) return match.browser_download_url
  }
  return fallbackUrl
}

export function isMissingManifestError(cause: unknown): boolean {
  const raw = cause instanceof Error ? cause.message : String(cause ?? '')
  return /404|Cannot find latest\.yml|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|No published versions|ENOENT.*app-update\.yml/i.test(
    raw
  )
}

export function friendlyUpdaterError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause ?? '')
  if (/ENOTFOUND|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|network/i.test(raw)) {
    return 'Could not reach GitHub Releases. Check your internet connection and try again.'
  }
  if (/ETIMEDOUT|AbortError|TimeoutError|timed out/i.test(raw)) {
    return 'Update check timed out. Try again in a moment.'
  }
  if (/403|rate limit/i.test(raw)) {
    return 'GitHub temporarily rate-limited update checks. Try again shortly or open Releases.'
  }
  if (/404|Cannot find latest\.yml|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(raw)) {
    return 'Release metadata was not found on GitHub yet. You can download from the Releases page.'
  }
  if (/ERR_UPDATER_INVALID_SIGNATURE|not signed/i.test(raw)) {
    return 'The downloaded update did not pass signature verification and was discarded.'
  }
  if (/sha512|checksum/i.test(raw)) {
    return 'The downloaded update failed integrity verification. Try downloading again.'
  }
  if (/Application Control|blocked/i.test(raw)) {
    return 'Windows Smart App Control blocked the installer. See GitHub Releases for status.'
  }
  return plainErrorMessage(cause)
}

export function createInitialUpdateState(
  currentVersion: string,
  installKind: UpdateInstallKind
): UpdateState {
  return {
    status: 'idle',
    installKind,
    currentVersion: normalizeVersionTag(currentVersion),
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseUrl: GITHUB_RELEASES_URL,
    downloadUrl: null,
    publishedAt: null,
    progress: null,
    transferredBytes: null,
    totalBytes: null,
    bytesPerSecond: null,
    checkedAt: null,
    error: null,
    canAutoDownload: false,
    canAutoInstall: false
  }
}
