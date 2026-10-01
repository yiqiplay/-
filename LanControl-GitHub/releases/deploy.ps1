# ============================================================
#  LanControl - deploy / undeploy / status  (one file does it all)
#
#  Why this exists: the .cmd + firewall-helper chain could hang
#  forever when the UAC prompt was not answered, and a .cmd cannot
#  raise UAC by itself. This script:
#    * asks for elevation ONCE (only when it really needs it)
#    * never blocks forever - every elevation has a timeout
#    * prints a step-by-step result you can copy back
#
#  Usage (normal user):
#     powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1
#     powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 -Action undeploy
#     powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 -Action status
#     powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 -NoFirewall
#
#  ASCII only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI).
# ============================================================
param(
    [ValidateSet('deploy', 'undeploy', 'status')]
    [string]$Action = 'deploy',
    [int]$Port = 8848,
    [switch]$NoFirewall,
    [switch]$NoElevate,
    # internal: set in the elevated child so it does not re-elevate
    [switch]$Elevated
)

$ErrorActionPreference = 'Continue'
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$exe = Join-Path $here 'LanControlServer.exe'
$logFile = Join-Path $here 'deploy-log.txt'

function Say([string]$m) {
    Write-Host $m
    try { Add-Content -Path $logFile -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -ErrorAction SilentlyContinue } catch { }
}
function Step([string]$m) { Say ''; Say ('== ' + $m) }

function Test-Admin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

$isAdmin = Test-Admin

# ---------------- elevation ----------------
function Invoke-Elevated {
    param([string[]]$ExtraArgs)
    $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
                   '-Action', $Action, '-Port', "$Port", '-Elevated') + $ExtraArgs
    Say '  A UAC prompt should appear now - please click "Yes".'
    Say '  (If nothing appears within 30s, the prompt may be behind other windows.)'
    try {
        $p = Start-Process -FilePath 'powershell' -ArgumentList $childArgs -Verb RunAs -PassThru
    } catch {
        Say ('  [X] Could not request administrator rights: ' + $_.Exception.Message)
        Say '      Continuing WITHOUT firewall changes - see the notes at the end.'
        return $false
    }
    $deadline = (Get-Date).AddSeconds(180)
    while (-not $p.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (-not $p.HasExited) {
        Say '  [!] The elevated window is still running after 180s - leaving it alone.'
        return $false
    }
    Say ('  Elevated part finished with exit code ' + $p.ExitCode)
    return ($p.ExitCode -eq 0)
}

# ---------------- shared helpers ----------------
function New-Shortcut {
    param([string]$LnkPath, [string]$Target, [string]$Arguments, [string]$WorkDir, [string]$Desc)
    try {
        $dir = Split-Path -Parent $LnkPath
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $sh = New-Object -ComObject WScript.Shell
        $lnk = $sh.CreateShortcut($LnkPath)
        $lnk.TargetPath = $Target
        $lnk.Arguments = $Arguments
        $lnk.WorkingDirectory = $WorkDir
        $lnk.Description = $Desc
        $lnk.Save()
        if (Test-Path $LnkPath) { return $null } else { return 'file was not created' }
    } catch { return $_.Exception.Message }
}

function Get-LanControlShortcuts {
    $result = @()
    $roots = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('CommonDesktopDirectory'),
        [Environment]::GetFolderPath('Programs'),
        [Environment]::GetFolderPath('CommonPrograms')
    ) | Where-Object { $_ -and (Test-Path $_) }
    try { $sh = New-Object -ComObject WScript.Shell } catch { return $result }
    foreach ($r in $roots) {
        Get-ChildItem -Path $r -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
            $t = ''
            try { $t = $sh.CreateShortcut($_.FullName).TargetPath } catch { }
            if ($t -like '*LanControl*') { $result += , @{ Path = $_.FullName; Target = $t } }
        }
    }
    return $result
}

# ---------------- actions ----------------
function Do-Status {
    Step 'status'
    Say ('  folder      : ' + $here)
    Say ('  executable  : ' + $exe + '  (exists: ' + (Test-Path $exe) + ')')
    Say ('  admin       : ' + $isAdmin)

    $up = $false
    try {
        $r = Invoke-WebRequest -Uri ("http://127.0.0.1:$Port/ping") -TimeoutSec 2 -UseBasicParsing
        $up = ($r.StatusCode -eq 200)
    } catch { }
    Say ('  server      : ' + $(if ($up) { "UP on port $Port" } else { 'not answering' }))

    $lnks = Get-LanControlShortcuts
    Say ('  shortcuts   : ' + $lnks.Count + ' pointing at LanControl')
    foreach ($l in $lnks) { Say ('                ' + $l.Path) }

    $run = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).LanControlServer
    Say ('  auto-start  : ' + $(if ($run) { $run } else { '(not set)' }))

    if ($isAdmin) {
        $t = & netsh advfirewall firewall show rule name="LanControl Server TCP" 2>&1
        Say ('  firewall TCP: ' + $(if ($LASTEXITCODE -eq 0) { 'present' } else { 'MISSING' }))
    } else {
        Say '  firewall TCP: cannot read without administrator rights (this does NOT mean it is missing)'
    }
}

function Do-Deploy {
    Step 'deploy: shortcuts + auto-start'
    if (-not (Test-Path $exe)) {
        Say ('  [X] not found: ' + $exe)
        Say '      Keep this script together with the program files.'
        return 1
    }

    $desktop = [Environment]::GetFolderPath('Desktop')
    $lnk = Join-Path $desktop 'LanControl.lnk'
    $err = New-Shortcut -LnkPath $lnk -Target $exe -Arguments "--show --port $Port" -WorkDir $here -Desc 'LanControl remote control server'
    if ($err) { Say ('  [X] desktop shortcut: ' + $err) } else { Say ('  [OK] desktop shortcut: ' + $lnk) }

    $programs = [Environment]::GetFolderPath('Programs')
    $lnk2 = Join-Path $programs 'LanControl.lnk'
    $err2 = New-Shortcut -LnkPath $lnk2 -Target $exe -Arguments "--show --port $Port" -WorkDir $here -Desc 'LanControl remote control server'
    if ($err2) { Say ('  [X] start-menu shortcut: ' + $err2) } else { Say ('  [OK] start-menu shortcut: ' + $lnk2) }

    try {
        Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'LanControlServer' `
            -Value ('"' + $exe + '" --port ' + $Port + ' --silent') -ErrorAction Stop
        Say '  [OK] auto-start registered (current user, silent)'
    } catch { Say ('  [X] auto-start: ' + $_.Exception.Message) }

    try {
        New-Item -Path 'HKCU:\Software\LanControl' -Force | Out-Null
        Set-ItemProperty -Path 'HKCU:\Software\LanControl' -Name 'Port' -Value "$Port"
    } catch { }

    Step 'deploy: Windows Firewall'
    if ($NoFirewall) {
        Say '  skipped (-NoFirewall)'
        Say '  Remember: the first time the server listens, Windows pops up'
        Say '  "Windows Security Alert" - tick "Private networks" and Allow access.'
    } elseif ($isAdmin) {
        & netsh advfirewall firewall delete rule name="LanControl Server TCP" 2>&1 | Out-Null
        $r1 = & netsh advfirewall firewall add rule name="LanControl Server TCP" dir=in action=allow protocol=TCP localport=$Port profile=private,domain 2>&1
        $ok1 = ($LASTEXITCODE -eq 0)
        & netsh advfirewall firewall delete rule name="LanControl Server UDP" 2>&1 | Out-Null
        $r2 = & netsh advfirewall firewall add rule name="LanControl Server UDP" dir=in action=allow protocol=UDP localport=8849 profile=private,domain 2>&1
        $ok2 = ($LASTEXITCODE -eq 0)
        Say ('  TCP ' + $Port + ' : ' + $(if ($ok1) { 'OK' } else { 'FAILED - ' + ($r1 -join ' ') }))
        Say ('  UDP 8849  : ' + $(if ($ok2) { 'OK' } else { 'FAILED - ' + ($r2 -join ' ') }))
        if (-not ($ok1 -and $ok2)) {
            Say '  Group policy or a security suite may be blocking firewall changes.'
            Say '  Workaround: start the server and accept the Windows Firewall prompt.'
        }
    } else {
        Say '  needs administrator rights - asking for them now'
        $ok = Invoke-Elevated -ExtraArgs @('-NoFirewall:$false')
        if (-not $ok) {
            Say '  Firewall rules were NOT changed.'
            Say '  No-admin alternative: start the server, then in the Windows Security'
            Say '  Alert tick "Private networks" and click "Allow access".'
        }
    }

    Step 'deploy: starting the server'
    $up = $false
    try {
        $r = Invoke-WebRequest -Uri ("http://127.0.0.1:$Port/ping") -TimeoutSec 2 -UseBasicParsing
        $up = ($r.StatusCode -eq 200)
    } catch { }
    if ($up) {
        Say '  server is already running - asking it to show its control panel'
        try {
            $h = [System.Threading.EventWaitHandle]::OpenExisting("Global\LanControlServer.ShowWindow.Port$Port")
            $h.Set(); $h.Dispose()
        } catch { }
    } else {
        try {
            Start-Process -FilePath $exe -ArgumentList @('--show', '--port', "$Port") -WorkingDirectory $here | Out-Null
            Say '  launched'
            for ($i = 0; $i -lt 20; $i++) {
                Start-Sleep -Milliseconds 500
                try {
                    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:$Port/ping") -TimeoutSec 2 -UseBasicParsing
                    if ($r.StatusCode -eq 200) { $up = $true; break }
                } catch { }
            }
            Say ('  server answering: ' + $up)
        } catch { Say ('  [X] could not start: ' + $_.Exception.Message) }
    }

    Step 'result'
    Say ('  program folder : ' + $here)
    Say ('  server up      : ' + $up)
    $ips = @()
    try {
        $ips = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
                Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
                Select-Object -ExpandProperty IPAddress)
    } catch {
        foreach ($line in (ipconfig | Select-String 'IPv4')) {
            $ips += (($line.Line -split ':')[-1]).Trim()
        }
    }
    foreach ($ip in $ips) { Say ('  phone URL      : http://' + $ip + ':' + $Port + '/') }
    Say ''
    Say '  Next:'
    Say '    * The control panel window shows the 6-digit pairing code.'
    Say '    * If the tray icon is hidden by Windows: click the tray-icon button'
    Say '      in that window, or drag it out of the hidden-icons area.'
    Say '    * Phone: install LanControl-Android.apk, or open the phone URL above.'
    Say ''
    Say ('  Full log: ' + $logFile)
    if ($up) { return 0 } else { return 1 }
}

function Do-Undeploy {
    Step 'undeploy: stop server'
    if (Test-Path (Join-Path $here 'launch-helper.ps1')) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'launch-helper.ps1') -Action stop | Out-Null
        Say '  stop signal sent'
    }
    Get-Process -Name 'LanControlServer' -ErrorAction SilentlyContinue | ForEach-Object {
        Say ('  killing PID ' + $_.Id); Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }

    Step 'undeploy: remove shortcuts'
    $lnks = Get-LanControlShortcuts
    if ($lnks.Count -eq 0) { Say '  none found' }
    foreach ($l in $lnks) {
        try { Remove-Item -LiteralPath $l.Path -Force -ErrorAction Stop; Say ('  removed ' + $l.Path) }
        catch { Say ('  [X] could not remove ' + $l.Path + ': ' + $_.Exception.Message) }
    }

    Step 'undeploy: auto-start'
    try {
        Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'LanControlServer' -ErrorAction Stop
        Say '  removed'
    } catch { Say '  nothing to remove' }

    Step 'undeploy: firewall rules'
    if ($isAdmin) {
        & netsh advfirewall firewall delete rule name="LanControl Server TCP" 2>&1 | Out-Null
        & netsh advfirewall firewall delete rule name="LanControl Server UDP" 2>&1 | Out-Null
        Say '  rules removed (if they existed)'
    } else {
        Say '  needs administrator rights - asking for them now'
        [void](Invoke-Elevated -ExtraArgs @())
    }

    Step 'verify'
    $left = Get-LanControlShortcuts
    Say ('  shortcuts still pointing at LanControl: ' + $left.Count)
    Say '  program files were NOT deleted - remove the folder manually if you want.'
    return 0
}

# ---------------- main ----------------
Say ('LanControl deploy tool - action=' + $Action + ' port=' + $Port + ' admin=' + $isAdmin)
Say ('folder: ' + $here)

switch ($Action) {
    'status'   { Do-Status; exit 0 }
    'deploy'   { exit (Do-Deploy) }
    'undeploy' { exit (Do-Undeploy) }
}
