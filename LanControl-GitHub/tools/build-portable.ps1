# Assemble the release folder: everything the user needs lands directly in dist\.
#
# Layout produced (flat, no version-specific subfolders):
#   dist\LanControlServer.exe/.dll/.deps.json/.runtimeconfig.json   <- the program
#   dist\LanControl-Android.apk                                     <- optional phone app
#   dist\*.cmd, *.ps1, *.txt                                        <- launchers / tools / manuals
#   dist\traytest\                                                  <- tray diagnostics
#   dist\optional\                                                  <- admin installer (if built)
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI.
$ErrorActionPreference = 'Stop'

$root = 'D:\Deepseekharness'
$src = Join-Path $root 'LanControl\Portable'
$staging = Join-Path $root '.cache\pc-build'
$out = Join-Path $root 'dist'

if (-not (Test-Path (Join-Path $staging 'LanControlServer.exe'))) {
    throw "PC server not built yet: run tools\build-pcserver.ps1 first (expected $staging)"
}

New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item (Join-Path $staging '*') $out -Force
Write-Output ("program files <- " + $staging)

# launcher + deploy scripts + manuals
Get-ChildItem $src -File | ForEach-Object { Copy-Item $_.FullName (Join-Path $out $_.Name) -Force }

# phone app (optional launcher path)
$apk = Join-Path $root 'dist\LanControl-Android.apk'
if (-not (Test-Path $apk)) { Write-Warning 'APK not found; run tools\build-apk.ps1 first' }

# .cmd files must be CRLF without BOM or cmd.exe mis-parses them
& node (Join-Path $root 'tools\fix-cmd-encoding.mjs') $out | Out-Null

# tray diagnostics (reproduce/verify the tray icon behaviour locally)
$traySrc = Join-Path $out 'traytest'
$trayDst = Join-Path $out 'traytest'
New-Item -ItemType Directory -Force -Path $trayDst | Out-Null
$trayBuilt = Test-Path (Join-Path $trayDst 'TrayWatcher.exe')
if (-not $trayBuilt) { Write-Warning 'traytest not built; run tools\build-traytest.cmd to include it' }
else { Write-Output 'included traytest\ (tray diagnostics)' }

# extra helper scripts for traytest kept in the source tree (non-ASCII names allowed)
$extra = Join-Path $root 'LanControl\Portable\traytest'
if (Test-Path $extra) { Get-ChildItem $extra -File | ForEach-Object { Copy-Item $_.FullName $trayDst -Force } }

Write-Output ''
Write-Output '== release folder (dist) =='
Get-ChildItem $out | Sort-Object Name |
    Select-Object Name, @{n = 'KB'; e = { if ($_.PSIsContainer) { '<dir>' } else { [math]::Round($_.Length / 1KB, 1) } } } |
    Format-Table -AutoSize
Write-Output ("output: " + $out)
