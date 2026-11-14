import { app, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {
  needsRecentScope,
  pickConnectDevice,
  readSpotifyFailure,
  type SpotifyFailure
} from '../shared/spotifyPlayback'
import type {
  SpotifyAction,
  SpotifyLibrary,
  SpotifyMemory,
  SpotifyPlayback,
  SpotifyPlaylistItem,
  SpotifyProfile,
  SpotifyQueueItem,
  SpotifyRecentItem,
  SpotifyStatus
} from '../shared/types'

interface TokenFile {
  accessToken: string
  refreshToken: string | null
  expiresAt: number
  profile: SpotifyProfile | null
  clientId?: string
  /** Space-separated scopes from the last token response. Absent on older grants. */
  scope?: string
}

export class SpotifyControlError extends Error {
  status: number
  reason: SpotifyFailure['reason']

  constructor(failure: SpotifyFailure) {
    super(failure.message)
    this.name = 'SpotifyControlError'
    this.status = failure.status
    this.reason = failure.reason
  }
}

export function isNoActiveDevice(error: unknown): boolean {
  return error instanceof SpotifyControlError && error.reason === 'NO_ACTIVE_DEVICE'
}

export function isPremiumRequired(error: unknown): boolean {
  return error instanceof SpotifyControlError && error.reason === 'PREMIUM_REQUIRED'
}

interface SpotifyCredentials {
  clientId: string
  redirectPort?: number
}

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'playlist-read-private',
  'user-read-private'
].join(' ')

function demoPhase(): SpotifyStatus['demoPhase'] {
  const value = process.env.NOTCH_DEMO_MEDIA_PHASE
  if (value === 'opening' || value === 'nodevice' || value === 'premium') return value
  return null
}

function controlError(status: number, text: string): SpotifyControlError {
  return new SpotifyControlError(readSpotifyFailure(status, text))
}

const DEMO_MEDIA = process.env.NOTCH_DEMO_MEDIA === '1'
let authInProgress = false
let cachedTokens: TokenFile | null | undefined

function demoPlayback(): SpotifyPlayback {
  const started = Date.now() % 214000
  const phase = demoPhase()
  const deviceDown = phase === 'opening' || phase === 'nodevice'
  return {
    connected: true,
    playing: !phase,
    track: {
      id: 'demo-1',
      name: 'A Walk Through the Void',
      artists: 'Notch Ensemble, Mira Vale',
      album: 'Small Hours',
      image: null,
      duration: 214000,
      progress: started,
      url: 'https://open.spotify.com'
    },
    device: deviceDown
      ? null
      : { id: 'demo', name: 'This computer', type: 'Computer', active: phase !== 'premium', volume: 68 },
    shuffle: false,
    repeat: 'context',
    volume: 68,
    fetchedAt: Date.now(),
    source: 'api',
    queueAvailable: true
  }
}

function tokenPath(): string {
  if (process.env.NOTCH_SPOTIFY_TOKENS) return process.env.NOTCH_SPOTIFY_TOKENS
  return path.join(app.getPath('userData'), 'spotify-auth.json')
}

function credentialsPath(): string {
  return path.join(app.getPath('userData'), 'spotify-credentials.json')
}

export function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`
}

async function loadTokens(): Promise<TokenFile | null> {
  if (cachedTokens !== undefined) return cachedTokens
  try {
    const raw = await fs.readFile(tokenPath(), 'utf8')
    cachedTokens = JSON.parse(raw.replace(/^\uFEFF/, '')) as TokenFile
  } catch {
    cachedTokens = null
  }
  return cachedTokens
}

async function saveTokens(tokens: TokenFile | null): Promise<void> {
  cachedTokens = tokens
  const file = tokenPath()
  if (!tokens) {
    await fs.unlink(file).catch(() => undefined)
    return
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await fs.writeFile(temp, JSON.stringify(tokens, null, 2), 'utf8')
  await fs.rename(temp, file).catch(async () => {
    await fs.writeFile(file, JSON.stringify(tokens, null, 2), 'utf8')
    await fs.unlink(temp).catch(() => undefined)
  })
}

export async function saveCredentials(clientId: string, redirectPort?: number): Promise<void> {
  const clean = clientId.trim()
  if (!clean) return
  const file = credentialsPath()
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const payload = JSON.stringify({ clientId: clean, redirectPort } satisfies SpotifyCredentials, null, 2)
    const temp = `${file}.tmp`
    await fs.writeFile(temp, payload, 'utf8')
    await fs.rename(temp, file).catch(async () => {
      await fs.writeFile(file, payload, 'utf8')
      await fs.unlink(temp).catch(() => undefined)
    })
  } catch {
    // Credential backup is best-effort; the state file is still authoritative.
  }
}

export async function loadCredentials(): Promise<SpotifyCredentials | null> {
  try {
    const raw = await fs.readFile(credentialsPath(), 'utf8')
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<SpotifyCredentials>
    if (parsed.clientId && parsed.clientId.trim()) {
      return {
        clientId: parsed.clientId.trim(),
        redirectPort:
          typeof parsed.redirectPort === 'number' ? parsed.redirectPort : undefined
      }
    }
  } catch {
    // Fall through to the token file.
  }
  const tokens = await loadTokens()
  if (tokens?.clientId) return { clientId: tokens.clientId }
  return null
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function exchangeCode(
  clientId: string,
  code: string,
  verifier: string,
  port: number
): Promise<TokenFile> {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(port),
    code_verifier: verifier
  })
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Spotify rejected the sign-in. ${text.slice(0, 180)}`)
  }
  const data = (await response.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
    scope?: string
  }

  let profile: SpotifyProfile | null = null
  try {
    const profileResponse = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${data.access_token}` }
    })
    if (profileResponse.ok) {
      const me = (await profileResponse.json()) as {
        id: string
        display_name?: string
        images?: { url: string }[]
        product?: string
      }
      profile = {
        id: me.id,
        name: me.display_name || 'Spotify listener',
        image: me.images?.[0]?.url ?? null,
        product: me.product || 'free'
      }
    }
  } catch {
    profile = null
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: Date.now() + data.expires_in * 1000,
    profile,
    clientId,
    scope: data.scope
  }
}

async function getAccessToken(clientId: string): Promise<string> {
  const tokens = await loadTokens()
  if (!tokens) throw new Error('Connect Spotify in Settings first.')
  if (tokens.expiresAt > Date.now() + 30_000) {
    if (clientId && !tokens.clientId) {
      await saveTokens({ ...tokens, clientId })
    }
    return tokens.accessToken
  }
  if (!tokens.refreshToken) {
    await saveTokens(null)
    throw new Error('Your Spotify session expired. Reconnect Spotify in Settings.')
  }

  // The state file can be reset independently of the token file. Prefer the
  // client ID stored beside the refresh token so the session can still renew.
  const effectiveClientId = tokens.clientId || clientId
  if (!effectiveClientId) {
    throw new Error('Spotify credentials are missing. Open Settings and reconnect Spotify.')
  }

  const body = new URLSearchParams({
    client_id: effectiveClientId,
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken
  })
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!response.ok) {
    // Only an auth failure invalidates the saved session. A 5xx or 429 is
    // temporary and must not delete the user's refresh token.
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      await saveTokens(null)
      throw new Error('Spotify needs to be reconnected. Open Settings to sign in again.')
    }
    throw new Error('Spotify could not refresh the session. Check your connection and try again.')
  }
  const data = (await response.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
    scope?: string
  }
  const next: TokenFile = {
    ...tokens,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    clientId: tokens.clientId ?? effectiveClientId,
    scope: data.scope || tokens.scope
  }
  await saveTokens(next)
  return next.accessToken
}

async function spotifyFetch(
  clientId: string,
  endpoint: string,
  init: RequestInit = {}
): Promise<Response> {
  const token = await getAccessToken(clientId)
  const response = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`
    }
  })
  if (response.status === 401) {
    const retryToken = await getAccessToken(clientId)
    return fetch(`https://api.spotify.com/v1${endpoint}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${retryToken}`
      }
    })
  }
  return response
}

function friendlyError(status: number, text: string): SpotifyControlError {
  return controlError(status, text)
}

export async function getStatus(port: number): Promise<SpotifyStatus> {
  if (DEMO_MEDIA) {
    return {
      connected: true,
      profile: { id: 'demo', name: 'Notch Listener', image: null, product: 'premium' },
      redirectUri: redirectUri(port),
      localAvailable: false,
      needsConsent: false,
      demoPhase: demoPhase()
    }
  }
  const tokens = await loadTokens()
  return {
    connected: Boolean(tokens),
    profile: tokens?.profile ?? null,
    redirectUri: redirectUri(port),
    localAvailable: false,
    needsConsent: Boolean(tokens) && needsRecentScope(tokens?.scope),
    demoPhase: null
  }
}

export async function connect(clientId: string, port: number): Promise<SpotifyStatus> {
  if (!clientId.trim()) throw new Error('Add your Spotify Client ID in Settings first.')
  if (authInProgress) throw new Error('Spotify sign-in is already waiting in your browser.')
  await saveCredentials(clientId, port)
  const existing = await loadTokens()
  const forceDialog = Boolean(existing && needsRecentScope(existing.scope))
  authInProgress = true

  const verifier = base64Url(randomBytes(64))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  const state = base64Url(randomBytes(18))
  const uri = redirectUri(port)

  return new Promise<SpotifyStatus>((resolve, reject) => {
    let settled = false
    let timeout: NodeJS.Timeout | null = null

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      authInProgress = false
      if (timeout) clearTimeout(timeout)
      server.close()
      fn()
    }

    const server = http.createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url || '/', uri)
        if (requestUrl.pathname !== '/callback') {
          response.writeHead(404).end()
          return
        }
        const error = requestUrl.searchParams.get('error')
        const code = requestUrl.searchParams.get('code')
        const returnedState = requestUrl.searchParams.get('state')

        if (error || !code || returnedState !== state) {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(resultPage(false, error || 'The sign-in response did not look right.'))
          finish(() => reject(new Error('Spotify sign-in was cancelled.')))
          return
        }

        const tokens = await exchangeCode(clientId, code, verifier, port)
        await saveTokens(tokens)
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(resultPage(true, 'Notch is connected to Spotify. You can close this tab.'))
        finish(() =>
          resolve({
            connected: true,
            profile: tokens.profile,
            redirectUri: uri,
            localAvailable: false,
            needsConsent: needsRecentScope(tokens.scope),
            demoPhase: null
          })
        )
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(resultPage(false, error instanceof Error ? error.message : 'Sign-in failed.'))
        finish(() => reject(error instanceof Error ? error : new Error('Spotify sign-in failed.')))
      }
    })

    server.on('error', (error) => {
      finish(() => reject(new Error(`Could not listen on port ${port}. ${error.message}`)))
    })

    server.listen(port, '127.0.0.1', () => {
      const params = new URLSearchParams({
        client_id: clientId.trim(),
        response_type: 'code',
        redirect_uri: uri,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state,
        scope: SCOPES,
        show_dialog: forceDialog ? 'true' : 'false'
      })
      void shell.openExternal(`https://accounts.spotify.com/authorize?${params.toString()}`)
      timeout = setTimeout(() => {
        finish(() => reject(new Error('Spotify sign-in timed out. Try connecting again.')))
      }, 180_000)
    })
  })
}

export async function disconnect(port: number): Promise<SpotifyStatus> {
  await saveTokens(null)
  return {
    connected: false,
    profile: null,
    redirectUri: redirectUri(port),
    localAvailable: false,
    needsConsent: false,
    demoPhase: null
  }
}

function preferredCover(
  images: Array<{ url?: string; width?: number; height?: number }> | null | undefined
): string | null {
  const usable = (images || []).filter((image) => Boolean(image?.url))
  if (!usable.length) return null
  const stretch = (image: { width?: number; height?: number }): number => {
    const width = image.width || 0
    const height = image.height || 0
    if (!width || !height) return 1
    return Math.max(width / height, height / width)
  }
  usable.sort((a, b) => {
    const ratio = stretch(a) - stretch(b)
    if (Math.abs(ratio) > 0.02) return ratio
    return (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
  })
  return usable[0].url || null
}

function mapPlayback(payload: any): SpotifyPlayback {
  if (!payload || !payload.item) {
    return {
      connected: true,
      playing: false,
      track: null,
      device: payload?.device
        ? {
            id: payload.device.id,
            name: payload.device.name,
            type: payload.device.type,
            active: Boolean(payload.device.is_active),
            volume: payload.device.volume_percent ?? 0
          }
        : null,
      shuffle: Boolean(payload?.shuffle_state),
      repeat: payload?.repeat_state ?? 'off',
      volume: payload?.device?.volume_percent ?? 0,
      fetchedAt: Date.now(),
      source: 'api',
      queueAvailable: true,
      contextUri: typeof payload?.context?.uri === 'string' ? payload.context.uri : null
    }
  }

  return {
    connected: true,
    playing: Boolean(payload.is_playing),
    track: {
      id: payload.item.id,
      name: payload.item.name,
      artists: (payload.item.artists || []).map((artist: { name: string }) => artist.name).join(', '),
      album: payload.item.album?.name ?? payload.item.show?.name ?? '',
      image: preferredCover(payload.item.album?.images || payload.item.images),
      duration: payload.item.duration_ms ?? 0,
      progress: payload.progress_ms ?? 0,
      url: payload.item.external_urls?.spotify ?? null
    },
    device: payload.device
      ? {
          id: payload.device.id,
          name: payload.device.name,
          type: payload.device.type,
          active: Boolean(payload.device.is_active),
          volume: payload.device.volume_percent ?? 0
        }
      : null,
    shuffle: Boolean(payload.shuffle_state),
    repeat: payload.repeat_state ?? 'off',
    volume: payload.device?.volume_percent ?? 0,
    fetchedAt: Date.now(),
    source: 'api',
    queueAvailable: true,
    contextUri: typeof payload?.context?.uri === 'string' ? payload.context.uri : null
  }
}

export async function getPlayback(clientId: string): Promise<SpotifyPlayback> {
  if (DEMO_MEDIA) return demoPlayback()
  const tokens = await loadTokens()
  if (!tokens) {
    return {
      connected: false,
      playing: false,
      track: null,
      device: null,
      shuffle: false,
      repeat: 'off',
      volume: 0,
      fetchedAt: Date.now(),
      source: 'none',
      queueAvailable: false
    }
  }

  const response = await spotifyFetch(clientId, '/me/player?additional_types=track,episode')
  if (response.status === 204) {
    return {
      connected: true,
      playing: false,
      track: null,
      device: null,
      shuffle: false,
      repeat: 'off',
      volume: 0,
      fetchedAt: Date.now(),
    source: 'api',
    queueAvailable: true
    }
  }
  if (!response.ok) {
    const text = await response.text()
    throw friendlyError(response.status, text)
  }
  const payload = await response.json()
  return mapPlayback(payload)
}

export async function getQueue(clientId: string): Promise<SpotifyQueueItem[]> {
  if (DEMO_MEDIA) {
    return [
      { id: 'q1', uri: 'spotify:track:q1', name: 'Soft Focus', artists: 'Notch Ensemble', image: null, duration: 188000 },
      { id: 'q2', uri: 'spotify:track:q2', name: 'Late Light', artists: 'Mira Vale', image: null, duration: 241000 },
      { id: 'q3', uri: 'spotify:track:q3', name: 'The Quiet Part', artists: 'Aster, Juniper', image: null, duration: 203000 }
    ]
  }
  const response = await spotifyFetch(clientId, '/me/player/queue')
  if (!response.ok) return []
  const payload = (await response.json()) as any
  return (payload.queue || []).slice(0, 10).map((item: any) => ({
    id: item.id,
    uri: item.uri ?? (item.id ? `spotify:${item.type === 'episode' ? 'episode' : 'track'}:${item.id}` : ''),
    name: item.name,
    artists: (item.artists || []).map((artist: { name: string }) => artist.name).join(', ') || item.show?.publisher || '',
    image: preferredCover(item.album?.images || item.images),
    duration: item.duration_ms ?? 0
  }))
}

const PLAYABLE_URI = /^spotify:(track|episode):[A-Za-z0-9]+$/
const CONTEXT_URI = /^spotify:(album|playlist|show):[A-Za-z0-9]+$/
const SPOTIFY_ID = /^[A-Za-z0-9]{10,}$/

function demoLibrary(): SpotifyLibrary {
  return {
    recent: [
      {
        id: 'r1',
        uri: 'spotify:track:r1',
        name: 'Paper Sky',
        artists: 'Notch Ensemble',
        image: null,
        duration: 226000,
        contextUri: 'spotify:album:a1',
        contextType: 'album',
        contextName: 'Small Hours',
        playedAt: Date.now() - 3600_000
      },
      {
        id: 'r2',
        uri: 'spotify:track:r2',
        name: 'Late Light',
        artists: 'Mira Vale',
        image: null,
        duration: 241000,
        contextUri: 'spotify:playlist:p1',
        contextType: 'playlist',
        contextName: 'Playlist',
        playedAt: Date.now() - 7200_000
      },
      {
        id: 'r3',
        uri: 'spotify:track:r3',
        name: 'The Quiet Part',
        artists: 'Aster, Juniper',
        image: null,
        duration: 203000,
        contextUri: null,
        contextType: null,
        contextName: null,
        playedAt: Date.now() - 86_400_000
      }
    ],
    playlists: [
      { id: 'p1', uri: 'spotify:playlist:p1', name: 'Evening desk', image: null, owner: 'Ada' },
      { id: 'p2', uri: 'spotify:playlist:p2', name: 'Focus without words', image: null, owner: 'Ada' },
      { id: 'p3', uri: 'spotify:playlist:p3', name: 'Walk home', image: null, owner: 'Ada' }
    ]
  }
}

function contextType(value: unknown): SpotifyRecentItem['contextType'] {
  if (value === 'album' || value === 'playlist' || value === 'show' || value === 'artist') return value
  return null
}

export async function getLibrary(clientId: string): Promise<SpotifyLibrary> {
  if (DEMO_MEDIA) return demoLibrary()
  const tokens = await loadTokens()
  if (!tokens) return { recent: [], playlists: [] }

  const recent: SpotifyRecentItem[] = []
  if (!needsRecentScope(tokens.scope)) {
    const response = await spotifyFetch(clientId, '/me/player/recently-played?limit=8')
    if (response.ok) {
      const payload = (await response.json()) as { items?: any[] }
      for (const item of payload.items || []) {
        const track = item.track
        if (!track?.id || !track.uri) continue
        const type = contextType(item.context?.type)
        recent.push({
          id: track.id,
          uri: track.uri,
          name: track.name,
          artists: (track.artists || []).map((artist: { name: string }) => artist.name).join(', '),
          image: preferredCover(track.album?.images || track.images),
          duration: track.duration_ms ?? 0,
          contextUri: typeof item.context?.uri === 'string' ? item.context.uri : null,
          contextType: type,
          contextName: type === 'album' ? track.album?.name || 'Album' : type === 'playlist' ? 'Playlist' : type === 'show' ? 'Show' : null,
          playedAt: Date.parse(item.played_at) || Date.now()
        })
      }
    }
  }

  const playlists: SpotifyPlaylistItem[] = []
  const lists = await spotifyFetch(clientId, '/me/playlists?limit=6')
  if (lists.ok) {
    const payload = (await lists.json()) as { items?: any[] }
    for (const item of payload.items || []) {
      if (!item?.id || !item.uri) continue
      playlists.push({
        id: item.id,
        uri: item.uri,
        name: item.name,
        image: preferredCover(item.images),
        owner: item.owner?.display_name || ''
      })
    }
  }
  return { recent, playlists }
}

async function listDevices(clientId: string): Promise<Array<{ id: string | null; name?: string; type?: string; is_active?: boolean; is_restricted?: boolean }>> {
  const response = await spotifyFetch(clientId, '/me/player/devices')
  if (!response.ok) return []
  const payload = (await response.json()) as { devices?: Array<{ id: string | null; name?: string; type?: string; is_active?: boolean; is_restricted?: boolean }> }
  return payload.devices || []
}

async function transferPlayback(clientId: string, deviceId: string, play: boolean): Promise<void> {
  const response = await spotifyFetch(clientId, '/me/player', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [deviceId], play })
  })
  if (!response.ok && response.status !== 204) {
    const text = await response.text()
    throw friendlyError(response.status, text)
  }
}

/** Poll until Spotify lists a device Notch can control. Does not start audio. */
export async function waitForDevice(clientId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const device = pickConnectDevice(await listDevices(clientId).catch(() => []))
    if (device?.id) return true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

async function resumeMemory(clientId: string, memory: SpotifyMemory | null | undefined, deviceId?: string): Promise<SpotifyPlayback | null> {
  const trackId = memory?.track?.id
  if (!trackId || !SPOTIFY_ID.test(trackId)) return null
  return playQueuedTrack(clientId, {
    type: 'play-track',
    uri: `spotify:track:${trackId}`,
    contextUri: memory?.contextUri || undefined,
    deviceId
  })
}

async function playOrTransfer(clientId: string, memory: SpotifyMemory | null | undefined): Promise<SpotifyPlayback> {
  const direct = await spotifyFetch(clientId, '/me/player/play', { method: 'PUT' })
  if (direct.ok || direct.status === 204) {
    const playback = await getPlayback(clientId).catch(() => null)
    if (playback?.track) return { ...playback, playing: true, fetchedAt: Date.now() }
    const resumed = await resumeMemory(clientId, memory).catch(() => null)
    if (resumed) return resumed
    if (playback) return { ...playback, playing: true, fetchedAt: Date.now() }
  } else {
    const text = await direct.text()
    const error = friendlyError(direct.status, text)
    if (error.reason !== 'NO_ACTIVE_DEVICE') throw error
  }

  const device = pickConnectDevice(await listDevices(clientId))
  if (!device?.id) throw friendlyError(404, JSON.stringify({ error: { reason: 'NO_ACTIVE_DEVICE' } }))
  await transferPlayback(clientId, device.id, true)
  const playback = await getPlayback(clientId).catch(() => null)
  if (playback?.track) return { ...playback, playing: true, fetchedAt: Date.now() }
  const resumed = await resumeMemory(clientId, memory, device.id).catch(() => null)
  if (resumed) return resumed
  return {
    ...(playback || {
      connected: true,
      playing: true,
      track: null,
      device: null,
      shuffle: false,
      repeat: 'off' as const,
      volume: 0,
      fetchedAt: Date.now(),
      source: 'api' as const,
      queueAvailable: true
    }),
    playing: true,
    fetchedAt: Date.now()
  }
}

async function putPlay(clientId: string, deviceId: string | undefined, body: object): Promise<Response> {
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''
  return spotifyFetch(clientId, `/me/player/play${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

async function waitForTrackId(clientId: string, targetId: string, timeoutMs: number): Promise<SpotifyPlayback | null> {
  const deadline = Date.now() + timeoutMs
  let playback = await getPlayback(clientId).catch(() => null)
  while (Date.now() < deadline) {
    if (playback?.track?.id === targetId) return playback
    await new Promise((resolve) => setTimeout(resolve, 250))
    playback = (await getPlayback(clientId).catch(() => null)) ?? playback
  }
  return playback?.track?.id === targetId ? playback : null
}

async function playQueuedTrack(
  clientId: string,
  action: Extract<SpotifyAction, { type: 'play-track' }>
): Promise<SpotifyPlayback> {
  if (!PLAYABLE_URI.test(action.uri)) {
    throw new Error('That item cannot be started from the queue.')
  }
  const targetId = action.uri.split(':').pop() || ''
  const deviceId = action.deviceId && action.deviceId !== 'spotify-desktop' ? action.deviceId : undefined
  const bodies: object[] = []
  if (action.contextUri && CONTEXT_URI.test(action.contextUri)) {
    bodies.push({ context_uri: action.contextUri, offset: { uri: action.uri }, position_ms: 0 })
  }
  bodies.push({ uris: [action.uri], position_ms: 0 })

  let lastStatus = 0
  let lastText = ''
  let listedDevice: string | undefined
  const deviceIds = deviceId ? [deviceId, undefined] : [undefined]
  for (const playBody of bodies) {
    for (const device of deviceIds) {
      const response = await putPlay(clientId, device, playBody)
      if (!response.ok) {
        lastStatus = response.status
        lastText = await response.text()
        if (response.status === 401) throw friendlyError(401, lastText)
        if (response.status === 404 && !listedDevice && !deviceId) {
          listedDevice = pickConnectDevice(await listDevices(clientId).catch(() => []))?.id || undefined
          if (listedDevice) {
            const retry = await putPlay(clientId, listedDevice, playBody)
            if (retry.ok || retry.status === 204) {
              const playback = await waitForTrackId(clientId, targetId, 2000)
              if (playback) return { ...playback, playing: true, fetchedAt: Date.now() }
            } else {
              lastStatus = retry.status
              lastText = await retry.text()
            }
          }
        }
        continue
      }
      const playback = await waitForTrackId(clientId, targetId, 2000)
      if (playback) return { ...playback, playing: true, fetchedAt: Date.now() }
      break
    }
  }
  throw friendlyError(lastStatus || 500, lastText || 'Spotify did not start that track.')
}

async function playContext(clientId: string, contextUri: string, deviceId?: string): Promise<SpotifyPlayback> {
  if (!CONTEXT_URI.test(contextUri)) throw new Error('That playlist or album cannot be started.')
  const preferred = deviceId && deviceId !== 'spotify-desktop' ? deviceId : undefined
  let response = await putPlay(clientId, preferred, { context_uri: contextUri })
  if (!response.ok && response.status === 404 && !preferred) {
    const listed = pickConnectDevice(await listDevices(clientId).catch(() => []))
    if (listed?.id) {
      await transferPlayback(clientId, listed.id, false)
      response = await putPlay(clientId, listed.id, { context_uri: contextUri })
    }
  }
  if (!response.ok && response.status !== 204) {
    const text = await response.text()
    throw friendlyError(response.status, text)
  }
  const playback = await getPlayback(clientId).catch(() => null)
  return {
    ...(playback || {
      connected: true,
      playing: true,
      track: null,
      device: null,
      shuffle: false,
      repeat: 'off' as const,
      volume: 0,
      fetchedAt: Date.now(),
      source: 'api' as const,
      queueAvailable: true
    }),
    playing: true,
    fetchedAt: Date.now()
  }
}

export async function performAction(
  clientId: string,
  action: SpotifyAction,
  memory?: SpotifyMemory | null
): Promise<SpotifyPlayback> {
  if (DEMO_MEDIA) return demoPlayback()
  if (action.type === 'play') return playOrTransfer(clientId, memory)
  if (action.type === 'play-track') return playQueuedTrack(clientId, action)
  if (action.type === 'play-context') return playContext(clientId, action.contextUri, action.deviceId)
  let endpoint = ''
  let method = 'POST'
  let body: string | undefined

  const waitForTrackChange = action.type === 'next' || action.type === 'previous'
  const before = waitForTrackChange ? await getPlayback(clientId).catch(() => null) : null

  switch (action.type) {
    case 'pause':
      endpoint = '/me/player/pause'
      method = 'PUT'
      break
    case 'next':
      endpoint = '/me/player/next'
      break
    case 'previous':
      endpoint = '/me/player/previous'
      break
    case 'seek':
      endpoint = `/me/player/seek?position_ms=${Math.max(0, Math.round(action.position))}`
      method = 'PUT'
      break
    case 'volume':
      endpoint = `/me/player/volume?volume_percent=${Math.max(0, Math.min(100, Math.round(action.volume)))}`
      method = 'PUT'
      break
    case 'shuffle':
      endpoint = `/me/player/shuffle?state=${action.state}`
      method = 'PUT'
      break
    case 'repeat':
      endpoint = `/me/player/repeat?state=${action.state}`
      method = 'PUT'
      break
    case 'transfer':
      endpoint = '/me/player'
      method = 'PUT'
      body = JSON.stringify({ device_ids: [action.deviceId], play: true })
      break
  }

  const response = await spotifyFetch(clientId, endpoint, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body
  })
  if (!response.ok) {
    const text = await response.text()
    throw friendlyError(response.status, text)
  }

  try {
    let playback = await getPlayback(clientId)
    if (action.type === 'play' || action.type === 'pause') {
      // Spotify can return the previous transport state for a moment after the
      // command. The command succeeded, so keep the accepted state.
      return { ...playback, playing: action.type === 'play', fetchedAt: Date.now() }
    }
    if (waitForTrackChange) {
      const beforeId = before?.track?.id ?? null
      const deadline = Date.now() + 2200
      while (Date.now() < deadline) {
        if (!beforeId || (playback.track?.id && playback.track.id !== beforeId)) break
        await new Promise((resolve) => setTimeout(resolve, 200))
        const next = await getPlayback(clientId).catch(() => null)
        if (next) playback = next
      }
    }
    return playback
  } catch {
    return {
      connected: true,
      playing: action.type === 'play' || action.type === 'play-track',
      track: null,
      device: null,
      shuffle: false,
      repeat: 'off',
      volume: 0,
      fetchedAt: Date.now(),
    source: 'api',
    queueAvailable: true
    }
  }
}

function resultPage(success: boolean, message: string): string {
  const accent = success ? '#a8e36b' : '#ff6f61'
  const title = success ? 'Connected.' : 'Not connected.'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · Notch</title>
  <style>
    * { box-sizing: border-box; }
    body {
      min-height: 100vh; margin: 0; display: grid; place-items: center;
      background: #080909; color: #f4f2ec;
      font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    }
    .card {
      width: min(440px, calc(100vw - 40px)); padding: 36px;
      border: 1px solid rgba(255,255,255,.1); border-radius: 28px;
      background: linear-gradient(160deg, rgba(255,255,255,.07), rgba(255,255,255,.02));
      box-shadow: 0 30px 80px rgba(0,0,0,.55);
    }
    .dot { width: 12px; height: 12px; border-radius: 50%; background: ${accent}; box-shadow: 0 0 24px ${accent}; }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 13px; letter-spacing: .16em; text-transform: uppercase; color: #9c9c97; }
    h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 400; font-size: 42px; letter-spacing: -.03em; margin: 28px 0 12px; }
    p { line-height: 1.6; color: #b9b9b2; margin: 0; }
    small { display: block; margin-top: 28px; color: #6f706c; font-size: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand"><span class="dot"></span> Notch × Spotify</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <small>You can close this tab and return to Notch.</small>
  </div>
</body>
</html>`
}
