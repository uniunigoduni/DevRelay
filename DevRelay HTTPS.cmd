@echo off
setlocal
cd /d "%~dp0"
title DevRelay HTTPS
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0internal\scripts\DevRelay-Launcher.ps1" -HttpsDirect
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo DevRelay HTTPS exited with code %EXITCODE%.
  pause
)
exit /b %EXITCODE%
