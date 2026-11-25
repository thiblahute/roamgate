# Installs the latest (or ROAMGATE_VERSION's) Roamgate release for Windows:
# the PowerShell side of install-roamgate.sh, with the same variables.
#
#   irm https://github.com/powerfooI/roamgate/releases/latest/download/install-roamgate.ps1 | iex
#
# ROAMGATE_INSTALL_DIR  where roamgate.exe goes (default:
#                       %LOCALAPPDATA%\Programs\roamgate)
# ROAMGATE_VERSION      X.Y.Z to install instead of the latest release
# ROAMGATE_RELEASE_BASE_URL
#                       a mirror holding the release assets in one directory
#
# The archive is checked against its published SHA-256, its VERSION and the
# binary's --version, then roamgate.exe and roamgate-pi.exe replace the
# installed ones by rename (a running roamgate keeps running): the replaced
# ones stay as roamgate.exe.previous and roamgate-pi.exe.previous, which
# `roamgate rollback` restores.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  function Fail([string]$message) { throw "Roamgate installer: $message" }

  # New names take precedence even when explicitly empty (VERSION= means latest).
  $environment = [Environment]::GetEnvironmentVariables()
  function Setting([string]$name, [string]$fallback) {
    if ($environment.Contains("ROAMGATE_$name")) { return [string]$environment["ROAMGATE_$name"] }
    if ($environment.Contains("HERDR_GUI_$name") -and $environment["HERDR_GUI_$name"]) {
      return [string]$environment["HERDR_GUI_$name"]
    }
    return $fallback
  }
  $githubRepository = 'powerfooI/roamgate'
  $customReleaseBase = Setting 'RELEASE_BASE_URL' ''
  $installDir = Setting 'INSTALL_DIR' (Join-Path $env:LOCALAPPDATA 'Programs\roamgate')
  $requestedVersion = Setting 'VERSION' ''
  if (!$installDir) { Fail 'install directory must not be empty' }

  $architecture = $null
  try {
    $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  } catch {
    # Windows PowerShell on an old .NET: the machine's, not this process's.
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  }
  switch ($architecture) {
    { $_ -in 'X64', 'AMD64' } { $platform = 'windows-x64' }
    { $_ -in 'Arm64', 'ARM64' } { $platform = 'windows-arm64' }
    default { Fail "unsupported Windows architecture $architecture" }
  }
  if (!(Get-Command tar.exe -CommandType Application -ErrorAction SilentlyContinue)) { Fail 'required command not found: tar.exe (Windows 10 1803 or later)' }

  if ($requestedVersion) {
    if ($requestedVersion -notmatch '\A[0-9A-Za-z._-]+\z') { Fail "invalid ROAMGATE_VERSION: $requestedVersion" }
    $archiveName = "roamgate-v$requestedVersion-$platform.zip"
  } else {
    $archiveName = "roamgate-$platform.zip"
  }
  # GitHub uses a different asset directory for latest and versioned
  # releases; custom mirrors keep the flat-directory contract.
  if ($customReleaseBase) {
    $releaseBase = $customReleaseBase
  } elseif ($requestedVersion) {
    $releaseBase = "https://github.com/$githubRepository/releases/download/v$requestedVersion"
  } else {
    $releaseBase = "https://github.com/$githubRepository/releases/latest/download"
  }
  $releaseBase = $releaseBase.TrimEnd('/')
  if ($releaseBase.Contains('?') -or $releaseBase.Contains('#')) {
    Fail 'release base URL must not contain a query or fragment'
  }
  $uri = $null
  if (![Uri]::TryCreate($releaseBase, [UriKind]::Absolute, [ref]$uri) -or !$uri.Host) {
    Fail 'invalid release base URL'
  }
  if ($uri.UserInfo) { Fail 'release base URL must not contain credentials' }
  if ($uri.Scheme -eq 'http') {
    if (!$uri.IsLoopback) { Fail 'release base URL must use HTTPS unless the mirror is loopback' }
  } elseif ($uri.Scheme -ne 'https') {
    Fail 'release base URL must be an HTTP(S) URL'
  }

  $packageDir = "roamgate-$platform"
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  $target = Join-Path $installDir 'roamgate.exe'
  # The Pi sidecar Ranger runs for models other than Claude Code, beside
  # roamgate.exe.
  $piTarget = Join-Path $installDir 'roamgate-pi.exe'
  function Assert-Regular([string]$path, [string]$message) {
    if (Test-Path -LiteralPath $path) {
      $item = Get-Item -LiteralPath $path -Force
      if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail $message }
    }
  }
  foreach ($path in @($target, $piTarget)) {
    Assert-Regular $path 'install target exists but is not a regular file'
  }

  $staging = Join-Path $installDir ('.roamgate-install-' + [IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $staging | Out-Null
  try {
    $archive = Join-Path $staging $archiveName
    $checksum = "$archive.sha256"
    Write-Output "Downloading roamgate for $platform..."
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 -Uri "$releaseBase/$archiveName" -OutFile $archive
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri "$releaseBase/$archiveName.sha256" -OutFile $checksum
    if ((Get-Item -LiteralPath $checksum).Length -gt 4096) { Fail 'invalid package checksum file' }
    $pattern = '\A([0-9a-fA-F]{64})[ \t]+' + [regex]::Escape($archiveName) + '\r?\n?\z'
    $digest = [regex]::Match([IO.File]::ReadAllText($checksum), $pattern)
    if (!$digest.Success) { Fail 'invalid package checksum file' }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $digest.Groups[1].Value.ToUpperInvariant()) {
      Fail 'package checksum mismatch'
    }

    $members = @(& tar.exe -tf $archive)
    if ($LASTEXITCODE -ne 0) { Fail 'could not read the package' }
    $hasPi = $members -contains "$packageDir/roamgate-pi.exe"
    $wanted = @("$packageDir/VERSION", "$packageDir/roamgate.exe")
    if ($hasPi) { $wanted += "$packageDir/roamgate-pi.exe" }
    & tar.exe -xf $archive -C $staging @wanted
    if ($LASTEXITCODE -ne 0) { Fail 'could not extract the package' }
    $extracted = Join-Path $staging $packageDir
    $binary = Join-Path $extracted 'roamgate.exe'
    $pi = Join-Path $extracted 'roamgate-pi.exe'
    $versionFile = Join-Path $extracted 'VERSION'
    $packaged = @($extracted, $binary, $versionFile)
    if ($hasPi) { $packaged += $pi }
    foreach ($path in $packaged) {
      if (!(Test-Path -LiteralPath $path)) { Fail 'package is missing files' }
      if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Fail 'package directory is invalid'
      }
    }

    $fields = @([IO.File]::ReadAllText($versionFile).Trim() -split '\s+')
    if ($fields.Count -ne 3 -or $fields[0] -ne 'roamgate' -or !$fields[1]) { Fail 'invalid package VERSION file' }
    $packageVersion = $fields[1]
    if ($fields[2] -ne $platform) { Fail "package platform is $($fields[2]), expected $platform" }
    if ($requestedVersion -and $packageVersion -ne $requestedVersion) {
      Fail "package version is $packageVersion, expected $requestedVersion"
    }
    $binaryVersion = (& $binary --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $binaryVersion -ne "roamgate $packageVersion") {
      Fail 'binary version does not match package VERSION'
    }

    foreach ($path in @($target, $piTarget)) {
      Assert-Regular $path 'install target changed during installation'
    }
    # Each installed file moves to <name>.previous and the new one takes its
    # name: renames, which Windows allows on a running executable. A failure
    # puts back what was moved.
    $moved = New-Object System.Collections.ArrayList
    function Retire([string]$path) {
      $previous = "$path.previous"
      if (Test-Path -LiteralPath $previous) {
        try { Remove-Item -LiteralPath $previous -Force } catch {
          Fail "$previous is in use: stop the roamgate running from it and retry"
        }
      }
      if (Test-Path -LiteralPath $path) {
        [IO.File]::Move($path, $previous)
        [void]$moved.Add(@($previous, $path))
        return $true
      }
      return $false
    }
    $backup = $false
    try {
      $backup = Retire $target
      if ($backup) {
        # roamgate-pi.exe.previous goes with roamgate.exe.previous.
        if (!(Retire $piTarget)) { Remove-Item -LiteralPath "$piTarget.previous" -Force -ErrorAction SilentlyContinue }
      } elseif ($hasPi -and (Test-Path -LiteralPath $piTarget)) {
        Retire $piTarget | Out-Null
      }
      if ($hasPi) { [IO.File]::Move($pi, $piTarget) }
      [IO.File]::Move($binary, $target)
    } catch {
      foreach ($pair in $moved) {
        if (Test-Path -LiteralPath $pair[1]) { Remove-Item -LiteralPath $pair[1] -Force -ErrorAction SilentlyContinue }
        [IO.File]::Move($pair[0], $pair[1])
      }
      throw
    }
  } finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Output "Installed roamgate $packageVersion to $target"
  if ($hasPi) { Write-Output "Installed its Pi sidecar to $piTarget" }
  if ($backup) { Write-Output "Previous binary saved to $target.previous" }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $onPath = (@("$env:Path;$userPath" -split ';') | Where-Object { $_ -and ($_.TrimEnd('\') -eq $installDir.TrimEnd('\')) }).Count -gt 0
  if (!$onPath) {
    Write-Output "Add $installDir to PATH to run roamgate directly, for example:"
    Write-Output "  [Environment]::SetEnvironmentVariable('Path', `"$installDir;`" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
  }
}
