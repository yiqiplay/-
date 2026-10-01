# Build Windows installer (Inno Setup, toolchain lives inside the workspace)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File build-installer.ps1
# NOTE: keep this file ASCII-only; Windows PowerShell 5.1 reads .ps1 as ANSI.
$ErrorActionPreference = 'Stop'

$root = 'D:\Deepseekharness'
$iscc = Join-Path $root 'tools\innosetup\ISCC.exe'
$iss = Join-Path $root 'LanControl\Installer\LanControl.iss'
$dist = Join-Path $root 'dist'

if (-not (Test-Path $iscc)) { throw "ISCC.exe not found: $iscc" }
New-Item -ItemType Directory -Force -Path $dist | Out-Null

# 1) phone APK
$apkSrc = Join-Path $root 'LanControl\AndroidApp\app\build\outputs\apk\release\app-release.apk'
if (Test-Path $apkSrc) {
    Copy-Item $apkSrc (Join-Path $dist 'LanControl-Android.apk') -Force
    Write-Output 'APK copied -> dist\LanControl-Android.apk'
} else {
    Write-Warning "APK not found: $apkSrc"
}

# 2) Chinese user manual (name is non-ASCII, so locate it by pattern)
$manual = Get-ChildItem (Join-Path $root 'LanControl\Installer') -Filter '*.txt' | Select-Object -First 1
if ($manual) {
    Copy-Item $manual.FullName (Join-Path $dist $manual.Name) -Force
    Write-Output ("manual copied -> dist\{0}" -f $manual.Name)
} else {
    Write-Warning 'user manual (*.txt) not found in Installer folder'
}

# 3) README
$readme = Join-Path $root 'README.md'
if (Test-Path $readme) { Copy-Item $readme (Join-Path $dist 'README.md') -Force }

Write-Output '== compiling installer (no-admin, default) =='
& $iscc $iss
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
if ($code -ne 0) { throw "ISCC failed with exit code $code" }

Write-Output '== compiling installer (admin variant for custom port + firewall rules) =='
$optional = Join-Path $dist 'optional'
New-Item -ItemType Directory -Force -Path $optional | Out-Null
$issAdmin = Join-Path $root 'LanControl\Installer\LanControl-admin.iss'
$content = Get-Content $iss -Raw -Encoding UTF8
$content = "#define AdminMode`r`n" + $content
$content = $content -replace '(?m)^OutputDir=.*$', ("OutputDir=" + $optional)
# 管理员模式下 [Setup] 需要显式的 DefaultDirName（条件块里的那行在 #else 分支里）
$content = $content -replace '(?m)^AppPublisher=.*$', ("AppPublisher={#AppPublisher}`r`nDefaultDirName={autopf}\LanControl")
[System.IO.File]::WriteAllText($issAdmin, $content, (New-Object System.Text.UTF8Encoding($false)))
& $iscc $issAdmin
$code2 = $LASTEXITCODE
if ($null -eq $code2) { $code2 = 0 }
if ($code2 -ne 0) { Write-Warning "admin variant build failed with exit code $code2" }

Get-ChildItem $dist -Filter '*.exe' |
    Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } }, LastWriteTime |
    Format-Table -AutoSize
Get-ChildItem $optional -Filter '*.exe' -ErrorAction SilentlyContinue |
    Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } } |
    Format-Table -AutoSize
