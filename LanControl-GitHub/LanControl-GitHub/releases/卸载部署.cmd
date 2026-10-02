@echo off
rem LanControl - undo the deployment (shortcuts / auto-start / firewall rules).
setlocal
cd /d "%~dp0"
if not exist "deploy.ps1" (
  echo [ERROR] deploy.ps1 is missing - keep it next to this file.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" -Action undeploy
echo.
pause
exit /b 0
