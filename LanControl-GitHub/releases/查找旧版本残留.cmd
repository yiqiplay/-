@echo off
rem ===========================================================
rem  LanControl - 找出这台电脑上的所有旧版本残留（只看，不删）
rem
rem  会列出：正在运行的被控端进程、指向旧版本的快捷方式、
rem          开机自启项、防火墙规则、以及各处残留的程序目录。
rem ===========================================================
setlocal
cd /d "%~dp0"

if not exist "LanControlServer.exe" (
  echo [错误] 本目录下没有 LanControlServer.exe，请把本脚本放在新版程序目录里运行。
  echo.
  pause
  exit /b 1
)

echo ===========================================================
echo   正在排查旧版本残留（不会删除任何东西）
echo ===========================================================
echo.
LanControlServer.exe --scan-old --show-report
echo.
echo 若确认要删除上面列出的旧版本（保留当前目录）：
echo     双击「清理旧版本.cmd」
echo.
pause
exit /b 0

