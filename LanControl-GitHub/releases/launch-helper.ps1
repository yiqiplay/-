# LanControl portable helper: start / stop / restart / status / kill.
#
# Deliberately simple and dependency-free:
#   * no Add-Type / inline C# (compiling inside the script can hang on locked-down machines)
#   * every network call has a short timeout
#   * the server itself writes a status file, so failures have a readable reason
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File launch-helper.ps1 -Action start
#   ... -Action stop | restart | status | kill      [-Port 8848]
param(
    [int]$Port = 8848,
    [ValidateSet('start', 'stop', 'restart', 'status', 'kill')]
    [string]$Action = 'start'
)

$ErrorActionPreference = 'Continue'
# PSScriptRoot is the reliable way to locate the script's own folder
# ($MyInvocation.MyCommand.Path is empty when the script is dot-sourced or wrapped).
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$exe = Join-Path $here 'LanControlServer.exe'
$showEventName = "Global\LanControlServer.ShowWindow.Port$Port"
$exitEventName = "Global\LanControlServer.ExitRequest.Port$Port"
$statusFile = Join-Path $env:TEMP "lancontrol-status-$Port.txt"

function Test-ServerUp {
    param([int]$p, [int]$tries = 25)
    for ($i = 0; $i -lt $tries; $i++) {
        try {
            $r = Invoke-WebRequest -Uri ("http://127.0.0.1:$p/ping") -TimeoutSec 2 -UseBasicParsing
            if ($r.StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

function Get-Diag {
    param([int]$p)
    try {
        $d = Invoke-WebRequest -Uri ("http://127.0.0.1:$p/diag") -TimeoutSec 3 -UseBasicParsing
        return ($d.Content | ConvertFrom-Json)
    } catch { return $null }
}

function Get-PortOwner {
    param([int]$p)
    try {
        $line = netstat -ano -p tcp | Select-String -Pattern (":$p\s") | Select-String -Pattern 'LISTENING' | Select-Object -First 1
        if ($line) { return ($line.Line -split '\s+' | Where-Object { $_ } | Select-Object -Last 1) }
    } catch { }
    return $null
}

function Show-Status {
    $owner = Get-PortOwner -p $Port
    if (-not $owner) {
        Write-Host "    STATUS : server is not running on port $Port"
        return 1
    }
    $diag = Get-Diag -p $Port
    if (-not $diag) {
        Write-Host "    STATUS : port $Port is taken by PID $owner but it does not answer /ping"
        return 1
    }
    Write-Host ("    STATUS : UP on port $Port (PID " + $diag.pid + ", version " + $diag.version + ")")
    Write-Host ("    PROCESS: " + (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName)
    if ($diag.inputInjectionOk -eq $false) {
        Write-Host '    [!] input injection is BLOCKED in this session:'
        Write-Host ('        ' + $diag.inputInjectionMessage)
    }
    return 0
}

function Show-FailureDetails {
    if (Test-Path $statusFile) {
        Write-Host '  ---- server status file ----'
        Get-Content $statusFile | ForEach-Object { Write-Host ('    ' + $_) }
        Write-Host '  ----------------------------'
    }
    $logFile = Join-Path $env:LOCALAPPDATA 'LanControl\server.log'
    if (Test-Path $logFile) {
        Write-Host '  ---- last log lines ----'
        Get-Content $logFile -Tail 12 | ForEach-Object { Write-Host ('    ' + $_) }
        Write-Host '  ------------------------'
    }
}

switch ($Action) {
    'status' { exit (Show-Status) }

    'kill' {
        Write-Host "  Force-stopping everything on port $Port ..."
        $owner = Get-PortOwner -p $Port
        if ($owner) {
            Write-Host "    killing PID $owner"
            & taskkill /f /pid $owner 2>&1 | Out-Null
        } else {
            Write-Host '    nothing is listening on that port'
        }
        Get-Process -Name 'LanControlServer' -ErrorAction SilentlyContinue |
            ForEach-Object { Write-Host ('    killing stray PID ' + $_.Id); Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 800
        exit (Show-Status)
    }

    'stop' {
        Write-Host '  Asking the running instance to exit...'
        try {
            $h = [System.Threading.EventWaitHandle]::OpenExisting($exitEventName)
            $h.Set(); $h.Dispose()
        } catch { Write-Host '    (no running instance answered)' }
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 400
            if (-not (Get-Process -Name 'LanControlServer' -ErrorAction SilentlyContinue)) { break }
        }
        $left = Get-Process -Name 'LanControlServer' -ErrorAction SilentlyContinue
        if ($left) {
            Write-Host '  Instance did not exit by itself, forcing it...'
            $left | ForEach-Object { Write-Host ('    killing PID ' + $_.Id); Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Milliseconds 800
        }
        if (Get-Process -Name 'LanControlServer' -ErrorAction SilentlyContinue) {
            Write-Host '    RESULT : still running, please end it from Task Manager'
            exit 1
        }
        Write-Host '    RESULT : server stopped, port released'
        exit 0
    }

    'restart' {
        & $PSCommandPath -Port $Port -Action stop | Out-Null
        Start-Sleep -Milliseconds 500
        & $PSCommandPath -Port $Port -Action start
        exit $LASTEXITCODE
    }
}

# ---------------- start ----------------
function Invoke-Start {
    if (-not (Test-Path $exe)) {
        Write-Host "  [X] not found: $exe"
        return 1
    }

    if (Test-ServerUp -p $Port -tries 2) {
        Write-Host '  LanControl is ALREADY RUNNING.'
        Write-Host '  Asking the running instance to show its control panel.'
        try {
            $h = [System.Threading.EventWaitHandle]::OpenExisting($showEventName)
            $h.Set(); $h.Dispose()
        } catch { Write-Host '    (could not signal the running instance)' }
        Start-Sleep -Seconds 2
        return (Show-Status)
    }

    $owner = Get-PortOwner -p $Port
    if ($owner) {
        Write-Host "  [X] Port $Port is already used by another program (PID $owner)."
        Write-Host '      Close it, or change PORT inside the launcher .cmd.'
        return 2
    }

    Write-Host '  What to do next:'
    Write-Host '    1. A blue monitor icon should appear in the system tray (bottom-right,'
    Write-Host '       maybe hidden under the small up-arrow). Double-click it to see the'
    Write-Host '       access URL and the 6-digit pairing code.'
    Write-Host '    2. If Windows Firewall asks on first run, tick "Private networks" and'
    Write-Host '       click "Allow access", otherwise your phone cannot connect.'
    Write-Host ('    3. On the phone: install LanControl-Android.apk, or open http://THIS-PC-IP:' + $Port + '/')
    Write-Host ''
    Write-Host '  Closing this window does NOT stop the server.'
    Write-Host '  To quit: run the stop script in this folder, or right-click the tray icon.'
    Write-Host '==========================================================='
    Write-Host ''

    if (Test-Path $statusFile) { Remove-Item $statusFile -Force -ErrorAction SilentlyContinue }
    Start-Process -FilePath $exe -ArgumentList @('--port', "$Port", '--status-file', $statusFile) -WorkingDirectory $here | Out-Null

    if (Test-ServerUp -p $Port) {
        Write-Host "  Started successfully. Listening on port $Port."
        Show-Status | Out-Null
        return 0
    }

    Write-Host "  [X] The server did not answer on port $Port."
    Show-FailureDetails
    Write-Host '  Run the diagnostics script in this folder for a full report.'
    return 1
}

exit (Invoke-Start)
