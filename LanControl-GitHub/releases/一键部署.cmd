@echo off
rem ===========================================================
rem  LanControl - one-click deploy (ASCII name so it always runs).
rem
rem  Double-click this file. It does everything through deploy.ps1:
rem    * desktop + start-menu shortcuts
rem    * auto-start for the current user
rem    * Windows Firewall rules (asks for admin rights once)
rem    * starts the server and prints the phone URL + pairing code
rem
rem  It never hangs: if the UAC prompt is not answered it times out
rem  and tells you what to do instead.
rem ===========================================================
setlocal
cd /d "%~dp0"

if not exist "deploy.ps1" (
  echo [ERROR] deploy.ps1 is missing - keep it next to this file.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" -Action deploy
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" echo (exit code %RC% - see the messages above and deploy-log.txt)
echo.
pause
exit /b %RC%
