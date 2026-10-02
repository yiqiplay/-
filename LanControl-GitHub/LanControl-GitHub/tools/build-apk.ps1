# 构建安卓客户端 APK（Gradle + Android SDK 全部位于工作区内）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File build-apk.ps1
$ErrorActionPreference = 'Stop'

$root = 'D:\Deepseekharness'
$jdk = Join-Path $root 'tools\jdk17'
$sdk = Join-Path $root 'tools\android-sdk'
$gradle = Join-Path $root 'tools\gradle-8.7'
$gradleHome = Join-Path $root '.cache\gradle-home'
$fakeUser = Join-Path $root '.cache\fake-user'

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_USER_HOME = Join-Path $root 'tools\android-home'
$env:GRADLE_USER_HOME = $gradleHome
$env:USERPROFILE = $fakeUser
$env:APPDATA = Join-Path $fakeUser 'AppData\Roaming'
$env:LOCALAPPDATA = Join-Path $fakeUser 'AppData\Local'
$env:TEMP = Join-Path $root '.cache\tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:GRADLE_USER_HOME, $env:APPDATA, $env:LOCALAPPDATA, $env:TEMP | Out-Null

$appDir = Join-Path $root 'LanControl\AndroidApp'
Set-Content -Path (Join-Path $appDir 'local.properties') -Value ("sdk.dir=" + ($sdk -replace '\\', '\\')) -Encoding ASCII

$task = if ($args.Count -gt 0) { $args[0] } else { 'assembleRelease' }
Write-Output "== 执行 Gradle 任务: $task =="
& (Join-Path $gradle 'bin\gradle.bat') -p $appDir $task --no-daemon --console=plain
if ($LASTEXITCODE -ne 0) { throw "Gradle 构建失败，退出码 $LASTEXITCODE" }

$apkDir = Join-Path $appDir 'app\build\outputs\apk\release'
Get-ChildItem $apkDir -ErrorAction SilentlyContinue |
    Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } } | Format-Table -AutoSize
Write-Output "APK 输出目录: $apkDir"
