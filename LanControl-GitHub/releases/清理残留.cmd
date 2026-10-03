@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
title LanControl 残留清理

echo ===========================================================
echo   局域网远程控制 - 残留清理
echo ===========================================================
echo.
echo 本工具会清除本程序在系统里留下的痕迹（注册表 + 残留目录）。
echo 不影响其他软件，可以重复运行。
echo.

echo [1/5] 结束可能仍在运行的被控端...
taskkill /im LanControlServer.exe /f >nul 2>&1
if errorlevel 1 (echo       没有正在运行的进程) else (echo       已结束)

echo.
echo [2/5] 清除开机自启项...
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v LanControlServer /f >nul 2>&1
if errorlevel 1 (echo       无此项) else (echo       已清除)

echo.
echo [3/5] 清除设置项...
for %%K in (LanControl LanControlServer) do (
  reg query "HKCU\Software\%%K" >nul 2>&1 && (
    reg delete "HKCU\Software\%%K" /f >nul 2>&1
    echo       已清除 HKCU\Software\%%K
  )
)

echo.
echo [4/5] 清除卸载记录...
set FOUND=0
for /f "tokens=*" %%K in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" 2^>nul') do (
  echo %%K | findstr /i "LanControl" >nul && (
    reg delete "%%K" /f >nul 2>&1
    echo       已清除 %%K
    set FOUND=1
  )
)
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{8F3A1C2E-5B7D-4A6F-9C21-7E4D5A8B1F30}_is1" /f >nul 2>&1
if "!FOUND!"=="0" echo       未发现 LanControl 的卸载记录（上面那句按已知 ID 兜底删除）

echo.
echo [5/5] 提示：残留目录请手动删除（如 D:\yuanchenlianjei\LanControl）
echo       本工具不自动删目录，避免误删你自己放进去的文件。
echo.
echo ===========================================================
echo   清理完成。可以用 Geek Uninstaller 再扫描确认。
echo ===========================================================
echo.
pause
exit /b 0