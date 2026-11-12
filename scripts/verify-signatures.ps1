param(
  [string]$ReleaseDir = (Join-Path $PSScriptRoot '..\release')
)

$ErrorActionPreference = 'Stop'
$release = [System.IO.Path]::GetFullPath($ReleaseDir)
if (-not (Test-Path $release)) {
  throw "Release folder not found: $release. Run 'npm run dist:win' first."
}

$files = New-Object System.Collections.Generic.List[System.IO.FileInfo]

$unpacked = Join-Path $release 'win-unpacked'
if (Test-Path $unpacked) {
  Get-ChildItem $unpacked -Recurse -File |
    Where-Object { $_.Extension -in '.exe', '.dll', '.node' } |
    ForEach-Object { $files.Add($_) }
}

Get-ChildItem $release -File |
  Where-Object { $_.Extension -eq '.exe' } |
  ForEach-Object { $files.Add($_) }

if ($files.Count -eq 0) {
  throw "No .exe/.dll/.node files found under $release."
}

$results = foreach ($file in $files) {
  $sig = Get-AuthenticodeSignature -FilePath $file.FullName
  [pscustomobject]@{
    Status     = $sig.Status
    Signer     = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' }
    Timestamp  = [bool]$sig.TimeStamperCertificate
    File       = $file.FullName.Substring($release.Length).TrimStart('\')
  }
}

$results | Sort-Object Status, File | Format-Table -AutoSize

$bad = $results | Where-Object { $_.Status -ne 'Valid' }
$critical = @(
  'Notch.exe',
  'ffmpeg.dll',
  'vk_swiftshader.dll',
  'vulkan-1.dll',
  'dxcompiler.dll',
  'electron_wer.dll',
  'd3dcompiler_47.dll',
  'elevate.exe'
)
$byName = @{}
foreach ($item in $results) {
  $byName[(Split-Path $item.File -Leaf)] = $item
}

Write-Host ''
Write-Host ("Signed: {0} / {1}" -f ($results.Count - $bad.Count), $results.Count)
Write-Host 'Critical binaries:'
foreach ($name in $critical) {
  if ($byName.ContainsKey($name)) {
    $status = $byName[$name].Status
    Write-Host ("  {0,-22} {1}" -f $name, $status)
  } else {
    Write-Host ("  {0,-22} not found" -f $name)
  }
}

if ($bad.Count -gt 0) {
  Write-Host ''
  Write-Host "Unsigned or invalid files:" -ForegroundColor Red
  $bad | ForEach-Object { Write-Host ("  {0}  [{1}]" -f $_.File, $_.Status) }
  exit 1
}

Write-Host ''
Write-Host 'All binaries carry a valid Authenticode signature.' -ForegroundColor Green
exit 0
