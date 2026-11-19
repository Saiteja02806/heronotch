import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { friendlyMediaName, musicAppFor, musicAppLabel, normalizeMediaPreference, pickMediaSession, type MediaSessionInfo } from '../shared/mediaFollow'
import { getState } from './state'
import type { SpotifyAction, SpotifyPlayback } from '../shared/types'

interface LocalSnapshot {
  available: boolean
  title?: string
  artist?: string
  album?: string
  status?: string
  position?: number
  end?: number
  canNext?: boolean
  canPrevious?: boolean
  canSeek?: boolean
  source?: string
  sampledAt: number
  positionSampledAt?: number
}

const WINRT_PREAMBLE = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($operation, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  if (-not $task.Wait(4000)) { throw 'SMTC timeout' }
  $task.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackInfo,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionTimelineProperties,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
function Get-TargetSession([string]$wanted) {
  if (-not $wanted) { return $null }
  return @($manager.GetSessions()) | Where-Object { [string]$_.SourceAppUserModelId -ceq $wanted } | Select-Object -First 1
}
`

// One album-art file per unique title+artist+session. Windows exposes the
// cover as a thumbnail stream on the media properties; it is cached to disk so
// the renderer can load it as a file:// image. Nothing here runs unless the
// monitor was given NOTCH_MEDIA_ART_DIR.
const ART_SCRIPT = `
$artDir = $env:NOTCH_MEDIA_ART_DIR
$artDll = $env:NOTCH_MEDIA_ART_DLL
$artLoaded = $false
if ($artDir -and $artDll -and [System.IO.File]::Exists($artDll)) {
  try { [Reflection.Assembly]::LoadFrom($artDll) | Out-Null; $artLoaded = $true } catch {}
}
$artMap = @{}
# The WinRT stream projection PowerShell 5.1 cannot do happens in
# resources/notch-media-art.dll (see notch-media-art.cs for the rebuild).
function Get-Art([string]$sessionKey, $session, $props) {
  if (-not $artLoaded) { return $null }
  $key = -join ($sessionKey, '|', $props.Title, '|', $props.Artist)
  $cached = $artMap[$key]
  if ($cached) {
    if ([System.IO.File]::Exists($cached)) { return $cached }
    $artMap.Remove($key)
  }
  try {
    $bytes = [NotchMediaArt]::Read([object]$session)
    if (-not $bytes -or $bytes.Length -eq 0) { return $null }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $digest = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($key))
    } finally {
      $sha.Dispose()
    }
    $name = ([System.BitConverter]::ToString($digest)).Replace('-', '').Substring(0, 24).ToLower()
    $isPng = $bytes.Length -gt 4 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50
    $file = Join-Path $artDir ($name + $(if ($isPng) { '.png' } else { '.jpg' }))
    [System.IO.File]::WriteAllBytes($file, $bytes)
    if ($artMap.Count -ge 128) { $artMap.Clear() }
    $artMap[$key] = $file
    return $file
  } catch {}
  return $null
}
`

// Windows only hands out media metadata through WinRT, which PowerShell 5.1
// cannot project from a compiled helper, so this monitor lives in a single
// persistent shell and handles control commands over stdin instead of cold-
// spawning a fresh powershell.exe per click.
const MONITOR_INTERVAL_MS = 1500
const MONITOR_SCRIPT = `${WINRT_PREAMBLE}${ART_SCRIPT}
function Invoke-ControlLine([string]$raw) {
  try {
    $cmd = ConvertFrom-Json $raw
    $cmdId = $cmd.cmdId
    $session = Get-TargetSession ([string]$cmd.target)
    if (-not $session) {
      [Console]::Out.WriteLine((ConvertTo-Json ([ordered]@{ cmdId = $cmdId; ok = $false; error = 'no-session' }) -Compress))
      [Console]::Out.Flush()
      return
    }
    $beforeTitle = ''
    try {
      $beforeProps = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $beforeTitle = $beforeProps.Title
    } catch {}
    $op = $null
    switch ([string]$cmd.type) {
      'play' { $op = $session.TryPlayAsync() }
      'pause' { $op = $session.TryPauseAsync() }
      'next' { $op = $session.TrySkipNextAsync() }
      'previous' { $op = $session.TrySkipPreviousAsync() }
      'seek' {
        $ticks = [long]([Math]::Max(0, [Math]::Round([double]$cmd.position)) * 10000)
        $op = $session.TryChangePlaybackPositionAsync($ticks)
      }
      default {
        [Console]::Out.WriteLine((ConvertTo-Json ([ordered]@{ cmdId = $cmdId; ok = $false }) -Compress))
        [Console]::Out.Flush()
        return
      }
    }
    $ok = Await $op ([bool])
    $result = [ordered]@{ cmdId = $cmdId; ok = [bool]$ok }
    if ($ok) {
      $waitForTitle = ($cmd.type -eq 'next' -or $cmd.type -eq 'previous')
      $deadline = [DateTime]::UtcNow.AddMilliseconds($(if ($waitForTitle) { 2500 } else { 250 }))
      do {
        try {
          $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
          $info = $session.GetPlaybackInfo()
          $timeline = $session.GetTimelineProperties()
          $result.available = $true
          $result.source = [string]$session.SourceAppUserModelId
          $result.title = $props.Title
          $result.artist = $props.Artist
          $result.album = $props.AlbumTitle
          $result.status = [string]$info.PlaybackStatus
          $result.position = [double]$timeline.Position.TotalMilliseconds
          $result.end = [double]$timeline.EndTime.TotalMilliseconds
          $result.canNext = $info.Controls.IsNextEnabled
          $result.canPrevious = $info.Controls.IsPreviousEnabled
          $result.canSeek = $info.Controls.IsPlaybackPositionEnabled
          if (-not $waitForTitle -or $props.Title -ne $beforeTitle) { break }
        } catch {}
        Start-Sleep -Milliseconds 100
      } while ([DateTime]::UtcNow -lt $deadline)
    }
    [Console]::Out.WriteLine((ConvertTo-Json $result -Compress))
    [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine((ConvertTo-Json ([ordered]@{ cmdId = $(if ($cmd) { $cmd.cmdId } else { 0 }); ok = $false }) -Compress))
    [Console]::Out.Flush()
  }
}

$readTask = [Console]::In.ReadLineAsync()
while ($true) {
  try {
    $currentId = ''
    try {
      $current = $manager.GetCurrentSession()
      if ($current) { $currentId = [string]$current.SourceAppUserModelId }
    } catch {}
    $list = @()
    foreach ($session in @($manager.GetSessions())) {
      try {
        $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $info = $session.GetPlaybackInfo()
        $timeline = $session.GetTimelineProperties()
        $id = [string]$session.SourceAppUserModelId
        $art = $null
        try { $art = Get-Art $id $session $props } catch {}
        $list += [ordered]@{
          id = $id
          current = ($id -eq $currentId)
          title = $props.Title
          artist = $props.Artist
          album = $props.AlbumTitle
          status = [string]$info.PlaybackStatus
          position = [double]$timeline.Position.TotalMilliseconds
          end = [double]$timeline.EndTime.TotalMilliseconds
          canNext = $info.Controls.IsNextEnabled
          canPrevious = $info.Controls.IsPreviousEnabled
          canSeek = $info.Controls.IsPlaybackPositionEnabled
          art = $art
        }
      } catch {}
    }
    [Console]::Out.WriteLine((ConvertTo-Json ([ordered]@{ sessions = $list }) -Compress -Depth 4))
    [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine((ConvertTo-Json ([ordered]@{ sessions = @(); error = $_.Exception.Message }) -Compress))
    [Console]::Out.Flush()
  }
  $tickDeadline = [DateTime]::UtcNow.AddMilliseconds(${MONITOR_INTERVAL_MS})
  while ($true) {
    $remaining = [int]($tickDeadline - [DateTime]::UtcNow).TotalMilliseconds
    if ($remaining -le 0) { break }
    if ($readTask.Wait($remaining)) {
      $line = $readTask.Result
      if ($null -eq $line) { exit 0 }
      $readTask = [Console]::In.ReadLineAsync()
      if ($line.Trim()) { Invoke-ControlLine $line }
    }
  }
}
`

let monitor: ChildProcess | null = null
let latest: LocalSnapshot | null = null
let sessions: MediaSessionInfo[] = []
let sessionsAt = 0
let positionClock = 0
let buffer = ''
let cmdSerial = 0
const pendingControls = new Map<number, (result: ControlResult) => void>()
let lineQueue: Promise<void> = Promise.resolve()

function preference(): string {
  try {
    return normalizeMediaPreference(getState().settings.mediaSource)
  } catch {
    return 'auto'
  }
}

function freshSessions(): MediaSessionInfo[] {
  if (Date.now() - sessionsAt > 15_000) return []
  return sessions
}
let stopping = false
let paused = false
let restartTimer: NodeJS.Timeout | null = null
let actionQueue: Promise<unknown> = Promise.resolve()
let artPrunedAt = 0

/** Resolved art file URLs per track key; null means known-miss or in flight. */
const artByKey = new Map<string, string | null>()
const artQueriedAt = new Map<string, number>()

function setBoundedArt<T>(map: Map<string, T>, key: string, value: T, limit = 256): void {
  if (map.size >= limit && !map.has(key)) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

function artKey(session: { id?: string; title?: string; artist?: string }): string {
  return `${session.id || ''}|${session.title || ''}|${session.artist || ''}`
}

function artHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 24)
}

/**
 * Cover art fallback. Windows only exposes a thumbnail to the compiled helper
 * (blocked by Application Control policies on some machines), so a track with
 * no local art is looked up once on the public iTunes Search API and cached on
 * disk. Keyless, no account, small result.
 */
async function remoteArtFile(session: { id?: string; title?: string; artist?: string }): Promise<string | null> {
  const key = artKey(session)
  const dir = mediaArtDir()
  if (!dir || !session.title) return null
  if (artByKey.has(key)) {
    const cached = artByKey.get(key) || null
    if (!cached) return null
    if (cached.startsWith('file://')) {
      try {
        if (existsSync(new URL(cached))) return cached
      } catch {
        // Fall through and re-fetch if invalid/pruned.
      }
      artByKey.delete(key)
    } else {
      return cached
    }
  }
  const last = artQueriedAt.get(key) || 0
  if (Date.now() - last < 10 * 60_000) return null
  setBoundedArt(artQueriedAt, key, Date.now())
  setBoundedArt(artByKey, key, null)
  try {
    const term = [session.artist, session.title].filter(Boolean).join(' ')
    const query = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`
    const res = await fetch(query, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const json = (await res.json()) as { results?: { artworkUrl100?: string }[] }
    const cover = json.results?.[0]?.artworkUrl100
    if (!cover) return null
    const image = await fetch(cover.replace('100x100bb', '600x600bb'), { signal: AbortSignal.timeout(8000) })
    if (!image.ok) return null
    const bytes = Buffer.from(await image.arrayBuffer())
    if (bytes.length < 1000) return null
    const file = path.join(dir, `${artHash(key)}.jpg`)
    await fsPromises.writeFile(file, bytes)
    const url = pathToFileURL(file).href
    setBoundedArt(artByKey, key, url)
    return url
  } catch {
    return null
  }
}

function mediaArtDir(): string {
  try {
    // electron 'app' is intentionally not imported here; resolve it lazily so
    // this module stays loadable outside the ready app (tests, dev tooling).
    const app = process.versions.electron ? require('electron').app : null
    const base = app ? app.getPath('userData') : process.env.APPDATA || ''
    if (!base) return ''
    return `${base}/media-art`
  } catch {
    return ''
  }
}

/**
 * Resolve `notch-media-art.dll` to a real unpacked Win32 file path.
 * Electron patches `existsSync` inside `.asar`, so checking `app.asar` first would
 * return a virtual archive path that `.NET Assembly.LoadFrom` cannot open.
 */
export function resolveMediaArtDll(
  appPath: string,
  resourcesPath = process.resourcesPath || '',
  fileExists: (file: string) => boolean = existsSync
): string {
  const unpackedFromApp = appPath.replace(/([\\/])app\.asar(?=[\\/]|$)/i, '$1app.asar.unpacked')
  const candidates = [
    unpackedFromApp !== appPath ? path.join(unpackedFromApp, 'resources', 'notch-media-art.dll') : '',
    resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked', 'resources', 'notch-media-art.dll') : '',
    resourcesPath ? path.join(resourcesPath, 'notch-media-art.dll') : '',
    !/[\\/]app\.asar([\\/]|$)/i.test(appPath) ? path.join(appPath, 'resources', 'notch-media-art.dll') : ''
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate
  }
  return ''
}

/** The compiled WinRT helper. In a packaged build it is unpacked from the asar. */
function mediaArtDll(): string {
  try {
    const app = process.versions.electron ? require('electron').app : null
    const appPath = app ? app.getAppPath() : process.cwd()
    return resolveMediaArtDll(appPath, process.resourcesPath || '')
  } catch {
    return ''
  }
}

/** Validate the PowerShell-written art file and hand the renderer a file:// URL. */
async function resolveArtUrl(pathName: string): Promise<string | null> {
  try {
    const stat = await fsPromises.stat(pathName)
    if (!stat.isFile() || stat.size === 0) return null
    if (Date.now() - artPrunedAt > 10 * 60_000) {
      artPrunedAt = Date.now()
      void pruneMediaArt()
    }
    return pathToFileURL(pathName).href
  } catch {
    return null
  }
}

/** Art files are small, but a music library can still pile them up. Drop a day's leftovers. */
async function pruneMediaArt(): Promise<void> {
  const dir = mediaArtDir()
  if (!dir) return
  try {
    const names = await fsPromises.readdir(dir)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const name of names) {
      if (!/\.(png|jpe?g|img)$/i.test(name)) continue
      const full = `${dir}/${name}`
      const stat = await fsPromises.stat(full).catch(() => null)
      if (stat && stat.isFile() && stat.mtimeMs < cutoff) {
        await fsPromises.unlink(full).catch(() => undefined)
      }
    }
  } catch {
    // The directory may not exist yet.
  }
}

function scheduleRestart(): void {
  if (stopping || paused || restartTimer) return
  restartTimer = setTimeout(() => {
    restartTimer = null
    if (!stopping && !paused) startLocalMediaMonitor()
  }, 3000)
}

function parseControlPayload(parsed: Partial<LocalSnapshot> & { ok?: boolean }): ControlResult {
  if (!parsed.ok) return { ok: false }
  return {
    ok: true,
    snapshot: parsed.available
      ? {
          available: true,
          title: parsed.title,
          artist: parsed.artist,
          album: parsed.album,
          status: parsed.status,
          position: parsed.position,
          end: parsed.end,
          canNext: parsed.canNext,
          canPrevious: parsed.canPrevious,
          canSeek: parsed.canSeek,
          source: parsed.source,
          sampledAt: Date.now(),
          positionSampledAt: Date.now()
        }
      : undefined
  }
}

async function handleMonitorLine(line: string): Promise<void> {
  try {
    const parsed = JSON.parse(line) as {
      cmdId?: number
      sessions?: MediaSessionInfo[]
    } & Partial<LocalSnapshot> & { ok?: boolean }
    if (typeof parsed.cmdId === 'number') {
      const resolve = pendingControls.get(parsed.cmdId)
      if (resolve) {
        pendingControls.delete(parsed.cmdId)
        resolve(parseControlPayload(parsed))
      }
      return
    }
    if (!Array.isArray(parsed.sessions)) return
    const nextSessions = parsed.sessions.filter((session) => session && typeof session.id === 'string')
    for (const session of nextSessions) {
      if (session.art && typeof session.art === 'string') {
        const url = await resolveArtUrl(session.art)
        session.art = url
      } else {
        session.art = null
      }
    }
    const previous = pickMediaSession(sessions, preference())
    const snapshot = pickMediaSession(nextSessions, preference())
    sessions = nextSessions
    sessionsAt = Date.now()
    const sampledAt = Date.now()
    const sameTrack =
      Boolean(previous) &&
      previous?.title === snapshot?.title &&
      previous?.artist === snapshot?.artist &&
      previous?.id === snapshot?.id
    const sameStatus = previous?.status === snapshot?.status
    const positionMoved =
      !previous ||
      !snapshot ||
      Math.abs((Number(snapshot.position) || 0) - (Number(previous.position) || 0)) >= 100
    positionClock =
      !sameTrack || !sameStatus || positionMoved
        ? sampledAt
        : positionClock || sampledAt
    latest = snapshot
      ? {
          available: true,
          title: snapshot.title,
          artist: snapshot.artist,
          album: snapshot.album,
          status: snapshot.status,
          position: snapshot.position,
          end: snapshot.end,
          canNext: snapshot.canNext,
          canPrevious: snapshot.canPrevious,
          canSeek: snapshot.canSeek,
          source: snapshot.id,
          sampledAt,
          positionSampledAt: positionClock
        }
      : { available: false, sampledAt }
    const current = latest
    if (current && current.available && current.title && current.source) {
      const key = artKey({ id: current.source, title: current.title, artist: current.artist })
      const smtcArt = nextSessions.find((session) => session.id === current.source)?.art || null
      if (smtcArt) setBoundedArt(artByKey, key, smtcArt)
      if (!smtcArt && !artByKey.has(key)) {
        void remoteArtFile({ id: current.source, title: current.title, artist: current.artist })
      }
    }
  } catch {
    // Ignore partial or malformed status lines.
  }
}

export function startLocalMediaMonitor(): void {
  if (process.platform !== 'win32' || monitor || paused) return
  stopping = false
  buffer = ''
  const artDir = mediaArtDir()
  const artDll = mediaArtDll()
  if (artDir) {
    try {
      fsPromises.mkdir(artDir, { recursive: true }).catch(() => undefined)
    } catch {
      // Art is optional; the monitor still runs without it.
    }
  }
  let child: ChildProcess
  try {
    child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-Command',
        MONITOR_SCRIPT
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(artDir ? { NOTCH_MEDIA_ART_DIR: artDir } : {}),
          ...(artDll ? { NOTCH_MEDIA_ART_DLL: artDll } : {})
        }
      }
    )
    monitor = child
  } catch {
    monitor = null
    scheduleRestart()
    return
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    if (monitor !== child) return
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        lineQueue = lineQueue.then(() => handleMonitorLine(line)).catch(() => undefined)
      }
      newline = buffer.indexOf('\n')
    }
  })
  child.stderr?.on('data', () => undefined)
  const flushPendingOnExit = (): void => {
    for (const [id, resolve] of pendingControls.entries()) {
      pendingControls.delete(id)
      resolve({ ok: false })
    }
  }
  child.on('error', () => {
    if (monitor !== child) return
    monitor = null
    buffer = ''
    flushPendingOnExit()
    if (!paused && !stopping) scheduleRestart()
  })
  child.on('exit', () => {
    if (monitor !== child) return
    monitor = null
    buffer = ''
    flushPendingOnExit()
    latest = null
    sessions = []
    if (!paused && !stopping) scheduleRestart()
  })
}

export function pauseLocalMediaMonitor(): void {
  paused = true
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  buffer = ''
  for (const [id, resolve] of pendingControls.entries()) {
    pendingControls.delete(id)
    resolve({ ok: false })
  }
  monitor?.kill()
  monitor = null
}

export function resumeLocalMediaMonitor(): void {
  paused = false
  startLocalMediaMonitor()
}

export function stopLocalMediaMonitor(): void {
  stopping = true
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  buffer = ''
  for (const [id, resolve] of pendingControls.entries()) {
    pendingControls.delete(id)
    resolve({ ok: false })
  }
  monitor?.kill()
  monitor = null
  latest = null
}

export function listMediaSources(): { id: string; label: string }[] {
  // Only music apps are offered. A browser video session never reaches the
  // picker, so it cannot be selected by accident.
  const seen = new Set<string>()
  const list: { id: string; label: string }[] = []
  const ordered = [...freshSessions()].sort(
    (a, b) =>
      Number(Boolean(b.current)) - Number(Boolean(a.current)) ||
      Number(b.status === 'Playing') - Number(a.status === 'Playing')
  )
  for (const session of ordered) {
    const app = musicAppFor(session)
    if (!app || seen.has(app)) continue
    seen.add(app)
    list.push({ id: session.id, label: musicAppLabel(app) })
  }
  return list
}

export function currentMediaId(source?: string): string | null {
  return pickMediaSession(freshSessions(), source || preference())?.id ?? null
}

export function isLocalAvailable(source?: string): boolean {
  return Boolean(pickMediaSession(freshSessions(), source || preference()))
}

export function getLocalStatus(source?: string): { available: boolean; title: string | null; artist: string | null } {
  const picked = pickMediaSession(freshSessions(), source || preference())
  if (!picked) return { available: false, title: null, artist: null }
  return {
    available: true,
    title: picked.title || null,
    artist: picked.artist || null
  }
}

function emptyPlayback(): SpotifyPlayback {
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

export function getLocalPlayback(source?: string): SpotifyPlayback {
  const picked = pickMediaSession(freshSessions(), source || preference())
  if (!picked) return emptyPlayback()

  const position = Math.max(0, Number(picked.position) || 0)
  const duration = Math.max(position, Number(picked.end) || 0)
  const label = friendlyMediaName(picked.id)
  const fetchedAt = picked.id === latest?.source ? latest.positionSampledAt || latest.sampledAt : sessionsAt
  return {
    connected: true,
    localSessionId: picked.id,
    controls: { next: picked.canNext, previous: picked.canPrevious, seek: picked.canSeek },
    playing: picked.status === 'Playing',
    track: picked.title
      ? {
          id: `local-${picked.id}-${picked.title}`,
          name: picked.title,
          artists: picked.artist || label,
          album: picked.album || '',
          image: picked.art || artByKey.get(artKey(picked)) || null,
          duration,
          progress: Math.min(position, duration || position),
          url: null
        }
      : null,
    device: {
      id: picked.id,
      name: label,
      type: 'Desktop',
      active: true,
      volume: 0
    },
    shuffle: false,
    repeat: 'off',
    volume: 0,
    fetchedAt,
    source: 'local',
    queueAvailable: false
  }
}

function controlScript(action: Extract<SpotifyAction, { type: 'play' | 'pause' | 'next' | 'previous' | 'seek' }>): string {
  let op = ''
  if (action.type === 'play') op = '$op = $session.TryPlayAsync()'
  else if (action.type === 'pause') op = '$op = $session.TryPauseAsync()'
  else if (action.type === 'next') op = '$op = $session.TrySkipNextAsync()'
  else if (action.type === 'previous') op = '$op = $session.TrySkipPreviousAsync()'
  else {
    const ticks = Math.max(0, Math.round(action.position)) * 10_000
    op = `$op = $session.TryChangePlaybackPositionAsync([long]${ticks})`
  }

  const waitForTitle = action.type === 'next' || action.type === 'previous'

  // Do not pipe the assignment into Out-Null: that would assign $null to $op
  // and make Await fail even though Spotify accepted the command.
  return `${WINRT_PREAMBLE}
$session = Get-TargetSession $env:NOTCH_MEDIA_TARGET
if (-not $session) {
  [Console]::Out.WriteLine('{"ok":false,"error":"no-session"}')
  exit
}
$beforeTitle = ''
try {
  $beforeProps = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $beforeTitle = $beforeProps.Title
} catch {
}
${op}
$ok = Await $op ([bool])
$result = [ordered]@{ ok = [bool]$ok }
if ($ok) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds(${waitForTitle ? 2500 : 250})
  do {
    try {
      $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $info = $session.GetPlaybackInfo()
      $timeline = $session.GetTimelineProperties()
      $result.available = $true
      $result.source = $session.SourceAppUserModelId
      $result.title = $props.Title
      $result.artist = $props.Artist
      $result.album = $props.AlbumTitle
      $result.status = [string]$info.PlaybackStatus
      $result.position = [double]$timeline.Position.TotalMilliseconds
      $result.end = [double]$timeline.EndTime.TotalMilliseconds
      $result.canNext = $info.Controls.IsNextEnabled
      $result.canPrevious = $info.Controls.IsPreviousEnabled
      $result.canSeek = $info.Controls.IsPlaybackPositionEnabled
      if (${waitForTitle ? '$props.Title -ne $beforeTitle' : '$true'}) { break }
    } catch {
      # The action succeeded even if the follow-up metadata read did not.
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
}
[Console]::Out.WriteLine((ConvertTo-Json $result -Compress))
`
}

interface ControlResult {
  ok: boolean
  snapshot?: LocalSnapshot
}

function runControlOverMonitor(
  action: Extract<SpotifyAction, { type: 'play' | 'pause' | 'next' | 'previous' | 'seek' }>,
  sessionId: string
): Promise<ControlResult | null> {
  const child = monitor
  if (!child || child.killed || !child.stdin || !child.stdin.writable) return Promise.resolve(null)
  const cmdId = ++cmdSerial
  const payload = JSON.stringify({
    cmdId,
    type: action.type,
    target: sessionId,
    position: action.type === 'seek' ? action.position : 0
  })
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingControls.delete(cmdId)
      resolve(null)
    }, 5000)
    pendingControls.set(cmdId, (result) => {
      clearTimeout(timer)
      resolve(result)
    })
    try {
      child.stdin!.write(`${payload}\n`)
    } catch {
      clearTimeout(timer)
      pendingControls.delete(cmdId)
      resolve(null)
    }
  })
}

async function runControl(
  action: Extract<SpotifyAction, { type: 'play' | 'pause' | 'next' | 'previous' | 'seek' }>,
  sessionId: string
): Promise<ControlResult> {
  const fast = await runControlOverMonitor(action, sessionId)
  if (fast) return fast
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-Command',
        controlScript(action)
      ],
      { windowsHide: true, timeout: 9000, maxBuffer: 1024 * 1024, env: { ...process.env, NOTCH_MEDIA_TARGET: sessionId } },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false })
          return
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as Partial<LocalSnapshot> & { ok?: boolean }
          resolve(parseControlPayload(parsed))
        } catch {
          resolve({ ok: false })
        }
      }
    )
  })
}

async function performLocalActionNow(action: SpotifyAction, sessionId: string | null): Promise<SpotifyPlayback> {
  if (!sessionId || !isLocalAvailable(sessionId)) {
    throw new Error('That player is not playing right now. Start a song in it, then try again.')
  }

  if (action.type === 'play-track') {
    throw new Error('Connect your Spotify account to choose a track from the queue.')
  }

  if (
    action.type !== 'play' &&
    action.type !== 'pause' &&
    action.type !== 'next' &&
    action.type !== 'previous' &&
    action.type !== 'seek'
  ) {
    throw new Error('This control is unavailable for the selected player.')
  }

  const beforeTitle = latest?.title || null
  const result = await runControl(action, sessionId)
  if (!result.ok) {
    throw new Error('That player did not accept the control. Make sure it is open and a track is active.')
  }
  if (result.snapshot) {
    latest = result.snapshot
    if (result.snapshot.source) {
      sessions = sessions.map((session) =>
        session.id === result.snapshot?.source
          ? {
              ...session,
              title: result.snapshot.title,
              artist: result.snapshot.artist,
              album: result.snapshot.album,
              status: result.snapshot.status,
              position: result.snapshot.position,
              end: result.snapshot.end
            }
          : session
      )
      sessionsAt = Date.now()
    }
  }

  // The control script already polls SMTC for the new metadata. If Spotify is
  // unusually slow, give the background monitor a short grace period too.
  if (action.type === 'next' || action.type === 'previous') {
    const deadline = Date.now() + 1000
    while (Date.now() < deadline && (latest?.title || null) === beforeTitle) {
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
  }

  const base = getLocalPlayback(sessionId)
  if (!base.track) return base
  if (action.type === 'play' || action.type === 'pause') {
    const nextPlaying = action.type === 'play'
    if (latest?.source === sessionId) {
      latest = {
        ...latest,
        status: nextPlaying ? 'Playing' : 'Paused',
        sampledAt: Date.now(),
        positionSampledAt: Date.now()
      }
    }
    return { ...base, playing: nextPlaying }
  }
  if (action.type === 'seek') {
    return {
      ...base,
      track: { ...base.track, progress: Math.min(action.position, base.track.duration) },
      fetchedAt: Date.now()
    }
  }
  return base
}

export function performLocalAction(action: SpotifyAction, sessionId: string | null): Promise<SpotifyPlayback> {
  // Controls arrive from the renderer as separate IPC calls. Queue them so a
  // quick pause/play or double-skip is applied in order instead of dropped.
  const run = actionQueue.then(() => performLocalActionNow(action, sessionId))
  actionQueue = run.catch(() => undefined)
  return run
}
