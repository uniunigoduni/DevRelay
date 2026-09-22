Option Explicit

Dim shell, fso, guiDir, bootstrapPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

guiDir = fso.GetParentFolderName(WScript.ScriptFullName)
bootstrapPath = fso.BuildPath(guiDir, "Bootstrap-DevRelayGui.ps1")
command = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & bootstrapPath & Chr(34)
shell.CurrentDirectory = fso.GetParentFolderName(guiDir)
shell.Run command, 0, False
