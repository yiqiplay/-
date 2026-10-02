@echo off
rem ===========================================================
rem  LanControl Server - portable launcher (no install, no admin)
rem  Double-click this file to start.
rem
rem  All real work is done by the bundled PowerShell helper
rem  (launch-helper.ps1): cmd.exe pipelines are fragile here and
rem  the server itself refuses to start twice (single instance).
rem
rem  To change the port, edit the PORT line below.
rem ===========================================================
setlocal
set PORT=8848
cd /d "%~dp0"

if not exist "LanControlServer.exe" (
  echo [ERROR] LanControlServer.exe not found in this folder.
  echo         Keep the program files together with this launcher.
  echo.
  pause
  exit /b 1
)

if not exist "launch-helper.ps1" (
  echo [ERROR] launch-helper.ps1 is missing. It must sit next to this file.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-helper.ps1" -Port %PORT% -Action start
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo   Something went wrong. Run 诊断.cmd for a full report.
  echo.
  pause
)
exit /b %RC%
