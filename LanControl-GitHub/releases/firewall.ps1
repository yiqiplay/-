# LanControl firewall helper.
#
# Why this file exists: adding/reading Windows Firewall rules REQUIRES administrator
# rights ("The requested operation requires elevation"). Plain .cmd scripts cannot
# raise a UAC prompt, so they delegate to this script with -Elevate, which re-launches
# itself elevated (the user only has to click "Yes" once).
#
# Usage:
#   powershell -File firewall.ps1 -Action add    [-Port 8848] [-Elevate]
#   powershell -File firewall.ps1 -Action remove [-Elevate]
#   powershell -File firewall.ps1 -Action status            (needs admin to read rules)
#
# ASCII only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI).
param(
    [ValidateSet('add', 'remove', 'status')]
    [string]$Action = 'status',
    [int]$Port = 8848,
    [switch]$Elevate,
    # internal: set when this instance is the elevated child (keeps it from re-elevating)
    [switch]$Wait
)

$ErrorActionPreference = 'Continue'

function Test-Admin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        # fallback for constrained environments
        $out = & fltmc 2>&1
        return ($LASTEXITCODE -eq 0)
    }
}

$isAdmin = Test-Admin

if ($Elevate -and -not $isAdmin) {
    Write-Host '  Requesting administrator rights (a UAC prompt will appear - click Yes)...'
    $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
                   '-Action', $Action, '-Port', "$Port", '-Wait')
    try {
        $p = Start-Process -FilePath 'powershell' -ArgumentList $childArgs -Verb RunAs -PassThru
        # Do NOT use -Wait here: if nobody answers the UAC prompt we must be able to
        # time out and tell the user about the no-admin alternative.
        $deadline = (Get-Date).AddSeconds(90)
        while (-not $p.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
        if (-not $p.HasExited) {
            Write-Host '  [!] The elevated process did not finish in 90s.'
            Write-Host '      If a UAC prompt is still on screen, click Yes and check the result.'
            exit 4
        }
        Write-Host ('  Elevated run finished with exit code ' + $p.ExitCode)
        exit $p.ExitCode
    } catch {
        Write-Host '  [X] Elevation was refused or unavailable: ' + $_.Exception.Message
        Write-Host ''
        Write-Host '      Easiest alternative (no admin needed):'
        Write-Host '        1. start the server (start script)'
        Write-Host '        2. the first time it listens, Windows shows "Windows Security Alert"'
        Write-Host '        3. tick "Private networks" and click "Allow access"'
        exit 3
    }
}

$tcpRule = 'LanControl Server TCP'
$udpRule = 'LanControl Server UDP'

switch ($Action) {
    'add' {
        if (-not $isAdmin) {
            Write-Host '  [X] Not running as administrator - firewall rules cannot be changed.'
            Write-Host '      Re-run with -Elevate to get a UAC prompt.'
            exit 3
        }
        & netsh advfirewall firewall delete rule name="$tcpRule" 2>&1 | Out-Null
        $r1 = & netsh advfirewall firewall add rule name="$tcpRule" dir=in action=allow protocol=TCP localport=$Port profile=private,domain 2>&1
        $ok1 = ($LASTEXITCODE -eq 0)
        & netsh advfirewall firewall delete rule name="$udpRule" 2>&1 | Out-Null
        $r2 = & netsh advfirewall firewall add rule name="$udpRule" dir=in action=allow protocol=UDP localport=8849 profile=private,domain 2>&1
        $ok2 = ($LASTEXITCODE -eq 0)

        Write-Host ("    TCP $Port  : " + $(if ($ok1) { 'OK' } else { 'FAILED - ' + ($r1 -join ' ') }))
        Write-Host ("    UDP 8849   : " + $(if ($ok2) { 'OK' } else { 'FAILED - ' + ($r2 -join ' ') }))
        if ($ok1 -and $ok2) {
            Write-Host '  Firewall rules added. Phones on the same LAN can now connect.'
            exit 0
        }
        Write-Host '  Some rules could not be added. Group policy or a security suite may block it.'
        exit 1
    }

    'remove' {
        if (-not $isAdmin) {
            Write-Host '  [X] Not running as administrator - firewall rules cannot be changed.'
            exit 3
        }
        & netsh advfirewall firewall delete rule name="$tcpRule" 2>&1 | Out-Null
        & netsh advfirewall firewall delete rule name="$udpRule" 2>&1 | Out-Null
        Write-Host '  Firewall rules removed (if they existed).'
        exit 0
    }

    'status' {
        if (-not $isAdmin) {
            Write-Host '    FIREWALL: cannot read rules without administrator rights.'
            Write-Host '    FIREWALL: this does NOT mean the rules are missing.'
            Write-Host '    FIREWALL: run the deploy script and accept the UAC prompt to add them.'
            exit 4
        }
        $t = & netsh advfirewall firewall show rule name="$tcpRule" 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host '    FIREWALL: TCP rule present'
            $t | Where-Object { $_ -match 'LocalPort|Profiles|Enabled' } | ForEach-Object { Write-Host ('              ' + $_.Trim()) }
        } else {
            Write-Host '    FIREWALL: TCP rule MISSING'
        }
        $u = & netsh advfirewall firewall show rule name="$udpRule" 2>&1
        if ($LASTEXITCODE -eq 0) { Write-Host '    FIREWALL: UDP rule present' }
        else { Write-Host '    FIREWALL: UDP rule MISSING' }
        Write-Host ''
        & netsh advfirewall show allprofiles | Where-Object { $_ -match 'Profile Settings|State|Firewall Policy' } |
            ForEach-Object { Write-Host ('    ' + $_.Trim()) }
        exit 0
    }
}
