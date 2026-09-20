@echo off
setlocal
cd /d "%~dp0"
title DevRelay ChatGPT
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0internal\scripts\DevRelay-Launcher.ps1"
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo DevRelay ChatGPT exited with code %EXITCODE%.
  pause
)
exit /b %EXITCODE%
