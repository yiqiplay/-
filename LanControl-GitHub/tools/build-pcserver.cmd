@echo off
rem Build PC server (.NET 8, framework-dependent, no NuGet access needed)
setlocal

set ROOT=D:\Deepseekharness
set DOTNET_ROOT=%ROOT%\tools\dotnet-sdk
set DOTNET_CLI_HOME=%ROOT%\.cache\dotnet-cli
set APPDATA=%ROOT%\.cache\dotnet-cli\AppData\Roaming
set LOCALAPPDATA=%ROOT%\.cache\dotnet-cli\AppData\Local
set USERPROFILE=%ROOT%\.cache\dotnet-cli\profile
set DOTNET_CLI_TELEMETRY_OPTOUT=1
set DOTNET_NOLOGO=1
set DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
set NUGET_PACKAGES=%ROOT%\.cache\nuget

if not exist "%APPDATA%\NuGet" mkdir "%APPDATA%\NuGet" >nul 2>nul
if not exist "%APPDATA%\NuGet\NuGet.Config" (
  >"%APPDATA%\NuGet\NuGet.Config" echo ^<?xml version="1.0" encoding="utf-8"?^>
  >>"%APPDATA%\NuGet\NuGet.Config" echo ^<configuration^>
  >>"%APPDATA%\NuGet\NuGet.Config" echo ^<packageSources^>^<clear /^>^</packageSources^>
  >>"%APPDATA%\NuGet\NuGet.Config" echo ^</configuration^>
)

if exist "%ROOT%\dist\pc" rmdir /s /q "%ROOT%\dist\pc"

echo == publish PC server ==
"%DOTNET_ROOT%\dotnet.exe" publish "%ROOT%\LanControl\PcServer\LanControlServer.csproj" -c Release --self-contained false -p:PublishSingleFile=false -p:PublishTrimmed=false -p:DebugType=none -o "%ROOT%\.cache\pc-build"
if errorlevel 1 exit /b 1

echo == output ==
dir /b "%ROOT%\dist\pc"
exit /b 0
