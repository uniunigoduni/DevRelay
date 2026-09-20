@echo off
setlocal
cd /d "%~dp0"
wscript.exe //nologo "%~dp0internal\gui\launch.vbs" https
exit /b 0
