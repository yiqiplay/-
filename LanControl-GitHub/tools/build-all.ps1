# 一键全量构建 + 自检（可复现）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File build-all.ps1
# 说明: 本文件保持纯 ASCII，避免 Windows PowerShell 5.1 按 ANSI 解析 .ps1 造成中文乱码。
$ErrorActionPreference = 'Stop'
$root = 'D:\Deepseekharness'
$fail = 0

function Step($name, $block) {
    Write-Output ''
    Write-Output ("====== " + $name + " ======")
    try {
        & $block
        if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { throw "exit code $LASTEXITCODE" }
    } catch {
        Write-Warning ($name + " FAILED: " + $_.Exception.Message)
        $script:fail++
    }
}

Step 'PC server build' {
    & cmd /c (Join-Path $root 'tools\build-pcserver.cmd')
}

Step 'Android APK build' {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\build-apk.ps1')
}

Step 'Installer build (both variants)' {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\build-installer.ps1')
}

Step 'Tray repro tool build' {
    & cmd /c (Join-Path $root 'tools\build-traytest.cmd')
}

Step 'Portable package build' {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\build-portable.ps1')
}

Step 'Normalize .cmd line endings (CRLF, no BOM)' {
    & node (Join-Path $root 'tools\fix-cmd-encoding.mjs') (Join-Path $root 'LanControl\Portable') (Join-Path $root 'dist') (Join-Path $root 'tools')
}

Step 'APK signature verification' {
    $env:JAVA_HOME = Join-Path $root 'tools\jdk17'
    $apk = Join-Path $root 'dist\LanControl-Android.apk'
    & (Join-Path $root 'tools\android-sdk\build-tools\34.0.0\apksigner.bat') verify --verbose $apk
}

Step 'Runtime self-test (server + protocol + discovery)' {
    $exe = Join-Path $root 'dist\LanControlServer.exe'
    $sim = Join-Path $root '.cache\sim-install'
    New-Item -ItemType Directory -Force -Path $sim | Out-Null
    Copy-Item (Join-Path $root 'dist\LanControlServer*') $sim -Force
    $p = Start-Process -FilePath $exe -ArgumentList '--port', '8848', '--code', '123456', '--files', $sim -PassThru `
        -RedirectStandardOutput (Join-Path $root '.cache\buildall.out.txt') `
        -RedirectStandardError (Join-Path $root '.cache\buildall.err.txt')
    try {
        Start-Sleep -Seconds 4
        & node (Join-Path $root 'tools\test-full.mjs') 'http://127.0.0.1:8848' '123456'
        & node (Join-Path $root 'tools\test-discovery.mjs')
    } finally {
        if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
    }
}

Write-Output ''
Write-Output ("====== SUMMARY: " + $(if ($fail -eq 0) { 'ALL STEPS OK' } else { "$fail STEP(S) FAILED" }) + " ======")
Get-ChildItem (Join-Path $root 'dist') -Recurse -File | Sort-Object FullName |
    Select-Object @{n = 'file'; e = { $_.FullName.Replace($root + '\', '') } }, @{n = 'KB'; e = { [math]::Round($_.Length / 1KB, 1) } } |
    Format-Table -AutoSize
exit $fail
