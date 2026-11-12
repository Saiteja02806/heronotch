param(
  [string]$Subject,
  [string]$Sha1,
  [string]$ElectronDist = (Join-Path $PSScriptRoot '..\node_modules\electron\dist')
)

# Signs the local Electron binaries so `npx electron .` also starts on a PC where
# Smart App Control is enabled. This modifies node_modules; running `npm ci`
# removes the signatures and this script must be run again.

$ErrorActionPreference = 'Stop'

if (-not $Subject -and -not $Sha1) {
  throw 'Pass -Subject "CN=Your Name" or -Sha1 <thumbprint> for the code-signing certificate.'
}
if (-not (Test-Path $ElectronDist)) {
  throw "Electron dist not found: $ElectronDist"
}

$signtool = Get-ChildItem "${env:LOCALAPPDATA}\electron-builder\Cache\winCodeSign" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'x64' } |
  Select-Object -First 1

if (-not $signtool) {
  $kits = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
  if (Test-Path $kits) {
    $signtool = Get-ChildItem $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match 'x64' } |
      Select-Object -Last 1
  }
}

if (-not $signtool) {
  throw 'signtool.exe not found. Install the Windows SDK or run an electron-builder Windows build once so its winCodeSign tools are cached.'
}

$targets = Get-ChildItem $ElectronDist -Recurse -File |
  Where-Object { $_.Extension -in '.exe', '.dll' }

foreach ($file in $targets) {
  $signArgs = @(
    'sign',
    '/fd', 'sha256',
    '/td', 'sha256',
    '/tr', 'http://timestamp.digicert.com'
  )
  if ($Sha1) { $signArgs += @('/sha1', $Sha1) } else { $signArgs += @('/n', $Subject) }
  $signArgs += $file.FullName

  Write-Host ("Signing {0}" -f $file.Name)
  & $signtool.Source @signArgs | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "signtool failed for $($file.FullName)"
  }
}

Write-Host 'Electron development binaries signed.' -ForegroundColor Green
