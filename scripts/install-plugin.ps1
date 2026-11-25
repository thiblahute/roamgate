$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$pluginRoot = Split-Path -Parent $PSScriptRoot
$manifest = [IO.File]::ReadAllText((Join-Path $pluginRoot 'herdr-plugin.toml'))
$versionMatch = [regex]::Match($manifest, '(?m)^version = "([0-9]+\.[0-9]+\.[0-9]+)"\s*$')
if (!$versionMatch.Success) { throw 'Roamgate plugin: invalid manifest version' }
$version = $versionMatch.Groups[1].Value
$architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
switch ($architecture) {
  'X64' { $platform = 'windows-x64' }
  'Arm64' { $platform = 'windows-arm64' }
  default { throw "Roamgate plugin: unsupported Windows architecture $architecture" }
}
Get-Command tar.exe -CommandType Application -ErrorAction Stop | Out-Null
$packageDir = "roamgate-$platform"
# Windows packages are zip: tar.exe reads no xz before Windows 11.
$archiveName = "roamgate-v$version-$platform.zip"
$releaseBase = "https://github.com/powerfooI/roamgate/releases/download/v$version"
$environment = [Environment]::GetEnvironmentVariables()
$customReleaseBase = if ($environment.Contains('ROAMGATE_RELEASE_BASE_URL')) {
  $environment['ROAMGATE_RELEASE_BASE_URL']
} else {
  $environment['HERDR_GUI_RELEASE_BASE_URL']
}
if ($customReleaseBase) { $releaseBase = $customReleaseBase.TrimEnd('/') }
$uri = [Uri]$releaseBase
if (!$uri.IsAbsoluteUri -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
    ($uri.Scheme -ne 'https' -and !($uri.Scheme -eq 'http' -and $uri.IsLoopback))) {
  throw 'Roamgate plugin: release base must use HTTPS (or loopback HTTP), without credentials, query or fragment'
}

$serverDir = Join-Path $pluginRoot 'server'
New-Item -ItemType Directory -Path $serverDir -Force | Out-Null
$staging = Join-Path $serverDir ('.plugin-install-' + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  $archive = Join-Path $staging $archiveName
  $checksum = "$archive.sha256"
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri "$releaseBase/$archiveName" -OutFile $archive
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri "$releaseBase/$archiveName.sha256" -OutFile $checksum
  if ((Get-Item -LiteralPath $checksum).Length -gt 4096) { throw 'Invalid package checksum file' }
  $pattern = '\A([0-9a-fA-F]{64})[ \t]+' + [regex]::Escape($archiveName) + '\r?\n?\z'
  $digest = [regex]::Match([IO.File]::ReadAllText($checksum), $pattern)
  if (!$digest.Success) { throw 'Invalid package checksum file' }
  # .NET's SHA-256, not Get-FileHash: a powershell.exe started from pwsh 7
  # may not load the module that has it.
  $sha256 = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($archive)
  try { $actual = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '') } finally { $stream.Dispose() }
  if ($actual -ne $digest.Groups[1].Value.ToUpperInvariant()) {
    throw 'Package checksum mismatch'
  }
  # The Pi sidecar beside the binary; releases before the Rust build have none.
  $members = @(& tar.exe -tf $archive)
  if ($LASTEXITCODE -ne 0) { throw 'Could not read the Roamgate package' }
  $hasPi = $members -contains "$packageDir/roamgate-pi.exe"
  $wanted = @("$packageDir/VERSION", "$packageDir/roamgate.exe")
  if ($hasPi) { $wanted += "$packageDir/roamgate-pi.exe" }
  & tar.exe -xf $archive -C $staging @wanted
  if ($LASTEXITCODE -ne 0) { throw 'Could not extract the Roamgate package' }
  $extracted = Join-Path $staging $packageDir
  $binary = Join-Path $extracted 'roamgate.exe'
  $pi = Join-Path $extracted 'roamgate-pi.exe'
  $versionFile = Join-Path $extracted 'VERSION'
  $packaged = @($extracted, $binary, $versionFile)
  if ($hasPi) { $packaged += $pi }
  foreach ($path in $packaged) {
    if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'Invalid package layout'
    }
  }
  if ([IO.File]::ReadAllText($versionFile).Trim() -ne "roamgate $version $platform") {
    throw 'Package VERSION does not match the plugin version and platform'
  }
  $actualVersion = (& $binary --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $actualVersion -ne "roamgate $version") { throw 'Binary version mismatch' }
  $nativeVersion = (& $binary plugin version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $nativeVersion -ne "roamgate $version") {
    throw 'This release has no native plugin commands. Build an unreleased checkout with `bun scripts/studio-plugin.ts build-source`, then `herdr plugin link .`, or select a published tag that includes native plugin support.'
  }
  $target = Join-Path $serverDir 'roamgate.exe'
  $piTarget = Join-Path $serverDir 'roamgate-pi.exe'
  foreach ($path in @($target, $piTarget)) {
    if (Test-Path -LiteralPath $path) {
      $existing = Get-Item -LiteralPath $path -Force
      if ($existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Install target is not a regular file'
      }
    }
  }
  if ($hasPi) {
    if (Test-Path -LiteralPath $piTarget) {
      [IO.File]::Replace($pi, $piTarget, (Join-Path $staging 'previous-roamgate-pi.exe'))
    } else {
      [IO.File]::Move($pi, $piTarget)
    }
  } elseif (Test-Path -LiteralPath $piTarget) {
    Remove-Item -LiteralPath $piTarget -Force
  }
  if (Test-Path -LiteralPath $target) {
    [IO.File]::Replace($binary, $target, (Join-Path $staging 'previous-roamgate.exe'))
  } else {
    [IO.File]::Move($binary, $target)
  }
  Write-Output "Installed Roamgate plugin binary $version"
} finally {
  Remove-Item -LiteralPath $staging -Recurse -Force
}
