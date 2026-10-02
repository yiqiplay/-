# 鏋勫缓 PC 琚帶绔紙.NET 8锛屽崟鏂囦欢鍙戝竷锛屼緷璧栫郴缁?.NET 8 妗岄潰杩愯鏃讹級
# 鐢ㄦ硶: powershell -NoProfile -ExecutionPolicy Bypass -File build-pcserver.ps1
$ErrorActionPreference = 'Stop'

$root = 'D:\Deepseekharness'
$dotnetRoot = Join-Path $root 'tools\dotnet-sdk'
$cliHome = Join-Path $root '.cache\dotnet-cli'

$env:DOTNET_ROOT = $dotnetRoot
$env:DOTNET_CLI_HOME = $cliHome
$env:APPDATA = Join-Path $cliHome 'AppData\Roaming'
$env:LOCALAPPDATA = Join-Path $cliHome 'AppData\Local'
$env:USERPROFILE = Join-Path $cliHome 'profile'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:NUGET_PACKAGES = Join-Path $root '.cache\nuget'
New-Item -ItemType Directory -Force -Path $env:APPDATA, $env:LOCALAPPDATA, $env:USERPROFILE | Out-Null

# 鏋勫缓鐜鏃犲缃?NuGet 璁块棶锛屾竻绌哄寘婧愶紝閬垮厤杩樺師闃舵鑱旂綉绛夊緟
$nugetDir = Join-Path $env:APPDATA 'NuGet'
New-Item -ItemType Directory -Force -Path $nugetDir | Out-Null
@'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
  </packageSources>
</configuration>
'@ | Set-Content -Path (Join-Path $nugetDir 'NuGet.Config') -Encoding UTF8

$proj = Join-Path $root 'LanControl\PcServer\LanControlServer.csproj'
# Publish into a staging folder, NOT directly into dist.
# (dist also holds the launchers/manuals/APK; wiping it here used to destroy them.)
$out = Join-Path $root '.cache\pc-build'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Output "== 鍙戝竷 PC 琚帶绔?=="
# 璇存槑锛氭瀯寤虹幆澧冩棤娉曡闂?NuGet锛屾晠涓嶆寚瀹?RID锛堥伩鍏嶈繕鍘?ILLink.Tasks / 杩愯鏃跺寘锛夛紝
# 鍙戝竷涓轰緷璧栫郴缁?.NET 8 妗岄潰杩愯鏃剁殑澶氭枃浠惰緭鍑猴紝鐢卞畨瑁呯▼搴忎竴骞跺畨瑁呫€?$dotnetExe = Join-Path $dotnetRoot 'dotnet.exe'
$arguments = @('publish', $proj, '-c', 'Release', '--self-contained', 'false',
    '-p:PublishSingleFile=false', '-p:PublishTrimmed=false', '-p:DebugType=none', '-o', $out)
$proc = Start-Process -FilePath $dotnetExe -ArgumentList $arguments -NoNewWindow -Wait -PassThru
$code = $proc.ExitCode
if ($code -ne 0) { throw "dotnet publish 澶辫触锛岄€€鍑虹爜 $code" }

Get-ChildItem $out | Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } } | Format-Table -AutoSize
Write-Output "杈撳嚭鐩綍: $out"

