@echo off
rem LanControl - add only the Windows Firewall rules (asks for admin rights once).
setlocal
set PORT=8848
cd /d "%~dp0"
echo ===========================================================
echo   Add Windows Firewall rules (port %PORT%)
echo   A UAC prompt will appear - click "Yes".
echo ===========================================================
echo.
if exist "firewall.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0firewall.ps1" -Action add -Port %PORT% -Elevate
) else (
  echo [ERROR] firewall.ps1 is missing.
)
echo.
pause
exit /b 0
