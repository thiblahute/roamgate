
$ErrorActionPreference = 'Stop'
function Emit($kind, $value) { Write-Output ($kind + "	" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))) }
$path = '{{path}}'
if ($path -match '^~([/\\]|$)') { $path = $env:USERPROFILE + $path.Substring(1) }
$path = [IO.Path]::GetFullPath($path)
$errorText = ''
if (Test-Path -LiteralPath $path -PathType Container) { $path = (Get-Item -Force -LiteralPath $path).FullName }
elseif (Test-Path -LiteralPath $path) { $errorText = 'Path is not a directory.' }
else { $errorText = 'Directory does not exist.' }
Emit 'PATH' $path
Emit 'ERROR' $errorText
if ({{suggestions}}) {
  $directory = $path
  $prefix = ''
  if ($errorText) { $directory = [IO.Path]::GetDirectoryName($path); $prefix = [IO.Path]::GetFileName($path) }
  Get-ChildItem -Force -Directory -LiteralPath $directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and ($prefix.StartsWith('.') -or -not $_.Name.StartsWith('.')) -and $_.Name -notmatch '[\x00-\x1f\x7f]' } |
    Sort-Object Name | Select-Object -First {{limit}} | ForEach-Object { Emit 'DIRECTORY' $_.FullName }
}
