# Temporary diagnostic: runs each variant's --version, then the crashing
# ones under cdb, with WER local dumps.
$ErrorActionPreference = 'Continue'
$dumps = Join-Path $env:GITHUB_WORKSPACE 'dumps'
New-Item -ItemType Directory -Force $dumps | Out-Null
$key = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name DumpFolder -Value $dumps -Type ExpandString
Set-ItemProperty -Path $key -Name DumpType -Value 2 -Type DWord
Set-ItemProperty -Path $key -Name DumpCount -Value 20 -Type DWord

$cdb = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\Debuggers' -Recurse -Filter cdb.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
"cdb candidates: $cdb"
$cdb = $cdb | Where-Object { $_ -match 'arm64' } | Select-Object -First 1
"cdb: $cdb"

$exes = Get-ChildItem bins -Recurse -Filter *.exe
$crashed = @()
foreach ($exe in $exes) {
  foreach ($a in @(@('--version'), @('--help'))) {
    & $exe.FullName @a | Out-Host
    $code = $LASTEXITCODE
    "RESULT $($exe.FullName) $a exit=0x{0:x8}" -f $code
    if ($code -ne 0 -and $code -ne 1 -and $code -ne 2) { $crashed += $exe }
  }
}
Get-ChildItem $dumps | Out-Host
if ($cdb) {
  foreach ($exe in ($crashed | Sort-Object FullName -Unique)) {
    "===== cdb $($exe.FullName)"
    $sym = Split-Path $exe.FullName
    & $cdb -G -y "$sym;srv*C:\symcache*https://msdl.microsoft.com/download/symbols" -c ".symopt+0x40;sxe av;g;.lastevent;.ecxr;r;kn 60;ub @pc L10;u @pc L4;~*kn 30;lm;q" $exe.FullName --version | Out-Host
  }
}
