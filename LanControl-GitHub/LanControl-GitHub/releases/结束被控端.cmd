@echo off
rem ===========================================================
rem  LanControl - stop the running server properly.
rem  It asks the running instance to shut down (which releases the
rem  listening port); if that fails it force-kills the process.
rem  No administrator rights needed.
rem ===========================================================
setlocal
cd /d "%~dp0"

echo ===========================================================
echo   Stopping LanControl server
echo ===========================================================
echo.

if not exist "launch-helper.ps1" (
  echo [ERROR] launch-helper.ps1 is missing. It must sit next to this file.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-helper.ps1" -Action stop
set RC=%ERRORLEVEL%

echo.
echo   Port check:
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-helper.ps1" -Action status
echo.
pause
exit /b %RC%
