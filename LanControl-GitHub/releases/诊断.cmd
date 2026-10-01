@echo off
rem ===========================================================
rem  LanControl diagnostics. Double-click, no admin needed.
rem  ASCII-only on purpose (cmd parses .cmd in the OEM code page).
rem ===========================================================
setlocal
cd /d "%~dp0"
set PORT=8848

echo ===========================================================
echo   LanControl diagnostics
echo ===========================================================
echo.

echo [1] Program files in this folder
if exist "LanControlServer.exe" (echo     OK    LanControlServer.exe) else (echo     MISS  LanControlServer.exe)
if exist "LanControlServer.dll" (echo     OK    LanControlServer.dll) else (echo     MISS  LanControlServer.dll)
if exist "LanControlServer.deps.json" (echo     OK    LanControlServer.deps.json) else (echo     MISS  LanControlServer.deps.json)
if exist "LanControlServer.runtimeconfig.json" (echo     OK    LanControlServer.runtimeconfig.json) else (echo     MISS  LanControlServer.runtimeconfig.json)
if exist "launch-helper.ps1" (echo     OK    launch-helper.ps1) else (echo     MISS  launch-helper.ps1)
echo.

echo [2] .NET 8 Desktop Runtime
set "DOTNETDIR="
if exist "%ProgramFiles%\dotnet\shared\Microsoft.WindowsDesktop.App\8.*" set "DOTNETDIR=%ProgramFiles%\dotnet\shared\Microsoft.WindowsDesktop.App"
if not defined DOTNETDIR if exist "%ProgramFiles(x86)%\dotnet\shared\Microsoft.WindowsDesktop.App\8.*" set "DOTNETDIR=%ProgramFiles(x86)%\dotnet\shared\Microsoft.WindowsDesktop.App"
if not defined DOTNETDIR if exist "%LOCALAPPDATA%\Microsoft\dotnet\shared\Microsoft.WindowsDesktop.App\8.*" set "DOTNETDIR=%LOCALAPPDATA%\Microsoft\dotnet\shared\Microsoft.WindowsDesktop.App"
if defined DOTNETDIR echo     OK    found: %DOTNETDIR%
if not defined DOTNETDIR echo     MISS  not found - install "Desktop Runtime x64" from
if not defined DOTNETDIR echo           https://dotnet.microsoft.com/download/dotnet/8.0/runtime
echo.

echo [3] Firewall rules created by LanControl
rem 重要：读取防火墙规则同样需要管理员权限。
rem 非管理员时 netsh advfirewall show 一定会失败，必须与"规则不存在"区分开，
rem 否则会把"读不到"误报成"没放行"（上一版就踩了这个坑）。
if exist "firewall.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0firewall.ps1" -Action status
) else (
  echo     UNKNOWN - firewall.ps1 missing, cannot determine rule state
)
echo     To add the rules: double-click 放行防火墙_双击即可.cmd
echo.

echo [4] Firewall profile state
rem 同样需要管理员权限才读得到，失败时不要误判
netsh advfirewall show allprofiles state >nul 2>nul
if errorlevel 1 (
  echo     UNKNOWN - needs administrator rights to read
) else (
  netsh advfirewall show allprofiles state
)
echo.

echo [5] Server state (uses launch-helper.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-helper.ps1" -Port %PORT% -Action status
echo.

echo [5b] Listening sockets on port %PORT%
netstat -ano | findstr /c:":%PORT% " | findstr /i "LISTENING"
echo     (nothing printed above means nothing is listening)
echo.

echo [6] Local HTTP test
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/ping' -TimeoutSec 5 -UseBasicParsing; Write-Host ('    OK    ' + $r.Content) } catch { Write-Host ('    FAIL  ' + $_.Exception.Message) }"
echo.

echo [7] This PC IPv4 addresses
ipconfig | findstr /i /c:"IPv4"
echo.

echo [8] LAN HTTP test, simulates the phone reaching this PC
set "LANIP="
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /i "IPv4"') do (
  if not defined LANIP set "LANIP=%%A"
)
if defined LANIP set "LANIP=%LANIP: =%"
if not defined LANIP (
  echo     no LAN IPv4 address found
) else (
  echo     testing http://%LANIP%:%PORT%/ping
  powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://%LANIP%:%PORT%/ping' -TimeoutSec 5 -UseBasicParsing; Write-Host ('    OK    LAN reachable, HTTP ' + $r.StatusCode) } catch { Write-Host ('    FAIL  ' + $_.Exception.Message) }"
)

echo.
echo ===========================================================
echo   How to read this report
echo     [5]/[6] OK but phone cannot connect
echo         -^> firewall rule missing in [3], or the Wi-Fi has
echo            client isolation enabled (common in offices).
echo     [8] FAIL on a LAN IP while [6] is OK
echo         -^> Windows Firewall is blocking incoming connections.
echo            Run 一键部署_以管理员身份运行.cmd as administrator.
echo     [2] MISS
echo         -^> install the .NET 8 Desktop Runtime first.
echo     tray icon missing but [5] says UP
echo         -^> the icon may be hidden under the small up-arrow near
echo            the clock; or run 结束被控端.cmd and start again.
echo     no picture on the phone
echo         -^> look at the small diagnostic line under
echo            "building video channel" on the phone screen.
echo ===========================================================
echo.
pause
exit /b 0
