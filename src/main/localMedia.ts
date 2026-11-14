import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { friendlyMediaName, pickMediaSession, type MediaSessionInfo } from '../shared/mediaFollow'
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
  $task.Wait(-1) | Out-Null
  $task.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackInfo,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionTimelineProperties,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
function Get-TargetSession([string]$wanted) {
  $sessions = @($manager.GetSessions())
  if ($wanted) {
    $match = $sessions | Where-Object { [string]$_.SourceAppUserModelId -eq $wanted } | Select-Object -First 1
    if ($match) { return $match }
  }
  $current = $null
  try { $current = $manager.GetCurrentSession() } catch {}
  if ($current) { return $current }
  return $sessions | Select-Object -First 1
}
`

const MONITOR_SCRIPT = `${WINRT_PREAMBLE}
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
        }
      } catch {}
    }
    [Console]::Out.WriteLine((ConvertTo-Json ([ordered]@{ sessions = $list }) -Compress -Depth 4))
    [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine((ConvertTo-Json ([ordered]@{ sessions = @(); error = $_.Exception.Message }) -Compress))
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 1100
}
`

let monitor: ChildProcess | null = null
let latest: LocalSnapshot | null = null
let sessions: MediaSessionInfo[] = []
let sessionsAt = 0
let positionClock = 0
let buffer = ''

function preference(): string {
  try {
    return getState().settings.mediaSource || 'auto'
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

function scheduleRestart(): void {
  if (stopping || restartTimer) return
  restartTimer = setTimeout(() => {
    restartTimer = null
    startLocalMediaMonitor()
  }, 3000)
}

export function startLocalMediaMonitor(): void {
  if (process.platform !== 'win32' || monitor || stopping || paused) return
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
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    monitor = child
  } catch {
    monitor = null
    scheduleRestart()
    return
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        try {
          const parsed = JSON.parse(line) as { sessions?: MediaSessionInfo[] }
          if (!Array.isArray(parsed.sessions)) continue
          const nextSessions = parsed.sessions.filter((session) => session && typeof session.id === 'string')
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
        } catch {
          // Ignore partial or malformed status lines.
        }
      }
      newline = buffer.indexOf('\n')
    }
  })
  child.stderr?.on('data', () => undefined)
  child.on('error', () => {
    if (monitor === child) monitor = null
    scheduleRestart()
  })
  child.on('exit', () => {
    if (monitor === child) monitor = null
    latest = null
    sessions = []
    if (!paused) scheduleRestart()
  })
}

export function pauseLocalMediaMonitor(): void {
  paused = true
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
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
  monitor?.kill()
  monitor = null
  latest = null
}

export function listMediaSources(): { id: string; label: string }[] {
  const seen = new Set<string>()
  const list: { id: string; label: string }[] = []
  for (const session of freshSessions()) {
    if (seen.has(session.id)) continue
    seen.add(session.id)
    list.push({ id: session.id, label: friendlyMediaName(session.id) })
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
    playing: picked.status === 'Playing',
    track: picked.title
      ? {
          id: `local-${picked.id}-${picked.title}`,
          name: picked.title,
          artists: picked.artist || label,
          album: picked.album || '',
          image: null,
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
  const wanted = (currentMediaId() || '').replace(/'/g, "''")
  return `${WINRT_PREAMBLE}
$session = Get-TargetSession '${wanted}'
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

function runControl(
  action: Extract<SpotifyAction, { type: 'play' | 'pause' | 'next' | 'previous' | 'seek' }>
): Promise<ControlResult> {
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
      { windowsHide: true, timeout: 9000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false })
          return
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as Partial<LocalSnapshot> & { ok?: boolean }
          if (!parsed.ok) {
            resolve({ ok: false })
            return
          }
          resolve({
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
          })
        } catch {
          resolve({ ok: false })
        }
      }
    )
  })
}

async function performLocalActionNow(action: SpotifyAction): Promise<SpotifyPlayback> {
  if (!isLocalAvailable()) {
    throw new Error('No media session is available. Start playback in an app on this PC.')
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
    return getLocalPlayback()
  }

  const beforeTitle = latest?.title || null
  const result = await runControl(action)
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

  const base = getLocalPlayback()
  if (!base.track) return base
  if (action.type === 'play' || action.type === 'pause') {
    const nextPlaying = action.type === 'play'
    if (latest) {
      latest = {
        ...latest,
        status: nextPlaying ? 'Playing' : 'Paused',
        sampledAt: Date.now(),
        positionSampledAt: Date.now()
      }
    }
    return { ...getLocalPlayback(), playing: nextPlaying }
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

export function performLocalAction(action: SpotifyAction): Promise<SpotifyPlayback> {
  // Controls arrive from the renderer as separate IPC calls. Queue them so a
  // quick pause/play or double-skip is applied in order instead of dropped.
  const run = actionQueue.then(() => performLocalActionNow(action))
  actionQueue = run.catch(() => undefined)
  return run
}
