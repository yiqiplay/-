<#
.SYNOPSIS
  Bump the version number everywhere at once (PC + Android + installer + release folder).

.DESCRIPTION
  The version lives in 5 places and has been missed before (once the exe showed
  FileVersion 2.5.1.0 while ProductVersion was still 2.5.0, and the installer
  VersionInfo was stuck at 1.0.0.0). This script updates all of them and then
  RE-READS every file to verify; any mismatch fails loudly.

  IMPORTANT: keep this file pure ASCII. Windows PowerShell 5.1 reads .ps1 as ANSI,
  so non-ASCII text gets mangled and breaks the parser (this happened).

  Touches:
    LanControl\PcServer\Program.cs                Program.Version
    LanControl\PcServer\LanControlServer.csproj   Version / FileVersion / AssemblyVersion
    LanControl\AndroidApp\app\build.gradle        versionCode / versionName
    LanControl\Installer\LanControl.iss           AppVersion / OutputBaseFilename / VersionInfoVersion
    LanControl\Installer\LanControl-admin.iss     same
    LanControl-<old>\  ->  LanControl-<new>\      release folder rename
    release txt files and the GitHub repo folder

.EXAMPLE
  tools\bump-version.ps1 2.5.2
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    Write-Host "[ERROR] Version must look like 2.5.2 (three numbers), got: $Version" -ForegroundColor Red
    exit 1
}
$major = [int]$Matches[1]; $minor = [int]$Matches[2]; $patch = [int]$Matches[3]
# versionCode = major*100 + minor*10 + patch  (2.5.1 -> 251)
if ($patch -gt 9 -or $minor -gt 9) {
    Write-Host "[ERROR] minor and patch must be 0-9 (versionCode encoding limit)" -ForegroundColor Red
    exit 1
}
$code = $major * 100 + $minor * 10 + $patch
$v4 = "$major.$minor.$patch.0"

$utf8 = New-Object System.Text.UTF8Encoding($false)

function Edit-File {
    param([string]$Path, [hashtable]$Pairs, [string]$Label)
    if (-not (Test-Path $Path)) {
        Write-Host "  [skip] $Label (file not found)" -ForegroundColor DarkYellow
        return
    }
    $t = [System.IO.File]::ReadAllText($Path)
    $before = $t
    $hit = 0
    foreach ($k in $Pairs.Keys) {
        if ($t.Contains($k)) { $t = $t.Replace($k, $Pairs[$k]); $hit++ }
    }
    if ($t -ne $before) {
        [System.IO.File]::WriteAllText($Path, $t, $utf8)
        Write-Host "  [ok]   $Label ($hit replacement(s))" -ForegroundColor Green
    } else {
        Write-Host "  [--]   $Label" -ForegroundColor DarkGray
    }
}

$prog = Join-Path $root 'LanControl\PcServer\Program.cs'
$old = ([regex]'public const string Version = "([^"]+)"').Match([System.IO.File]::ReadAllText($prog)).Groups[1].Value
if (-not $old) { Write-Host "[ERROR] cannot read current version" -ForegroundColor Red; exit 1 }
if ($old -eq $Version) { Write-Host "Already at $Version, nothing to do." -ForegroundColor Yellow; exit 0 }

$oldParts = $old.Split('.')
$oldCode = ([int]$oldParts[0]) * 100 + ([int]$oldParts[1]) * 10 + ([int]$oldParts[2])
$oldV4 = "$old.0"

Write-Host ""
Write-Host "Bump $old -> $Version   (versionCode $oldCode -> $code)" -ForegroundColor Cyan
Write-Host ("-" * 62)

Write-Host "PC server:"
Edit-File (Join-Path $root 'LanControl\PcServer\Program.cs') @{
    "public const string Version = `"$old`";" = "public const string Version = `"$Version`";"
} 'Program.cs'
Edit-File (Join-Path $root 'LanControl\PcServer\LanControlServer.csproj') @{
    "<Version>$old</Version>"                   = "<Version>$Version</Version>"
    "<FileVersion>$oldV4</FileVersion>"         = "<FileVersion>$v4</FileVersion>"
    "<AssemblyVersion>$oldV4</AssemblyVersion>" = "<AssemblyVersion>$v4</AssemblyVersion>"
} 'LanControlServer.csproj'

Write-Host "Android:"
Edit-File (Join-Path $root 'LanControl\AndroidApp\app\build.gradle') @{
    "versionCode $oldCode"       = "versionCode $code"
    "versionName `"$old`""       = "versionName `"$Version`""
    "Program.Version = `"$old`"" = "Program.Version = `"$Version`""
    "($old -> $oldCode)"         = "($Version -> $code)"
} 'build.gradle'

Write-Host "Installer:"
foreach ($n in @('LanControl.iss', 'LanControl-admin.iss')) {
    Edit-File (Join-Path $root "LanControl\Installer\$n") @{
        "#define AppVersion `"$old`""                    = "#define AppVersion `"$Version`""
        "OutputBaseFilename=LanControl-Setup-$old-admin" = "OutputBaseFilename=LanControl-Setup-$Version-admin"
        "OutputBaseFilename=LanControl-Setup-$old"       = "OutputBaseFilename=LanControl-Setup-$Version"
        "VersionInfoVersion=$oldV4"                      = "VersionInfoVersion=$v4"
    } $n
}

Write-Host "Release folder:"
$oldDir = Join-Path $root "LanControl-$old"
$newDir = Join-Path $root "LanControl-$Version"
if (Test-Path $oldDir) {
    if (Test-Path $newDir) { Remove-Item $newDir -Recurse -Force }
    Move-Item $oldDir $newDir
    Write-Host "  [ok]   folder LanControl-$old -> LanControl-$Version" -ForegroundColor Green
    # 发布包里的安装程序目录名是中文「安装程序」；这里用通配符免得再写错
    Get-ChildItem $newDir -Recurse -File -Filter "LanControl-Setup-$old*.exe" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item $_.FullName -Force; Write-Host "  [ok]   removed old installer $($_.Name)" -ForegroundColor Green }
    foreach ($f in (Get-ChildItem $newDir -Recurse -File -Include '*.txt' -ErrorAction SilentlyContinue)) {
        Edit-File $f.FullName @{
            "v$old"                 = "v$Version"
            "LanControl-Setup-$old" = "LanControl-Setup-$Version"
        } $f.Name
    }
} else {
    Write-Host "  [skip] no LanControl-$old folder" -ForegroundColor DarkYellow
}

Write-Host "GitHub repo folder:"
$repoDir = Join-Path $root 'LanControl-GitHub'
if (Test-Path $repoDir) {
    # 注意：CHANGELOG.md 要特殊处理 —— 旧版本号出现在**历史标题**里（## v2.5.1），
    # 那是应该保留的记录，不是需要升级的引用。直接整文件替换会把历史改掉（踩过）。
    foreach ($f in (Get-ChildItem $repoDir -Recurse -File -Include '*.md','*.txt' -ErrorAction SilentlyContinue)) {
        if ($f.Name -eq 'CHANGELOG.md') {
            Write-Host "  [skip] CHANGELOG.md (history must keep old version numbers)" -ForegroundColor DarkYellow
            continue
        }
        Edit-File $f.FullName @{
            "v$old"                           = "v$Version"
            "LanControl-Setup-$old-admin.exe" = "LanControl-Setup-$Version-admin.exe"
            "LanControl-Setup-$old.exe"       = "LanControl-Setup-$Version.exe"
            "LanControl-Setup-$old"           = "LanControl-Setup-$Version"
        } $f.Name
    }
} else {
    Write-Host "  [skip] no LanControl-GitHub folder" -ForegroundColor DarkYellow
}

Write-Host ("-" * 62)
Write-Host "Verify:" -ForegroundColor Cyan
$bad = @()
function Check {
    param([string]$Path, [string]$Pattern, [string]$Expect, [string]$Label)
    if (-not (Test-Path $Path)) { $script:bad += "$Label (missing file)"; return }
    $m = ([regex]$Pattern).Match([System.IO.File]::ReadAllText($Path))
    if (-not $m.Success) { $script:bad += "$Label (pattern not found)"; return }
    if ($m.Groups[1].Value -eq $Expect) {
        Write-Host "  OK   $Label = $($m.Groups[1].Value)" -ForegroundColor Green
    } else {
        $script:bad += "$Label expected $Expect but found $($m.Groups[1].Value)"
    }
}
Check (Join-Path $root 'LanControl\PcServer\Program.cs') 'Version = "([^"]+)"' $Version 'Program.Version'
Check (Join-Path $root 'LanControl\PcServer\LanControlServer.csproj') '<Version>([^<]+)</Version>' $Version 'csproj Version'
Check (Join-Path $root 'LanControl\PcServer\LanControlServer.csproj') '<FileVersion>([^<]+)</FileVersion>' $v4 'csproj FileVersion'
Check (Join-Path $root 'LanControl\AndroidApp\app\build.gradle') 'versionName "([^"]+)"' $Version 'gradle versionName'
Check (Join-Path $root 'LanControl\AndroidApp\app\build.gradle') 'versionCode (\d+)' $code 'gradle versionCode'
Check (Join-Path $root 'LanControl\Installer\LanControl.iss') '#define AppVersion "([^"]+)"' $Version 'iss AppVersion'
Check (Join-Path $root 'LanControl\Installer\LanControl-admin.iss') '#define AppVersion "([^"]+)"' $Version 'admin iss AppVersion'

if ($bad.Count -gt 0) {
    Write-Host ""
    Write-Host "These locations did NOT sync - fix manually:" -ForegroundColor Red
    $bad | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
Write-Host ""
Write-Host "Version is now $Version everywhere." -ForegroundColor Green
Write-Host "Next: tools\build-all.ps1  (or build-pcserver / build-apk / build-installer)" -ForegroundColor Cyan
