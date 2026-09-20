@echo off
setlocal
cd /d "%~dp0"
wscript.exe //nologo "%~dp0internal\gui\launch.vbs" chatgpt
exit /b 0
