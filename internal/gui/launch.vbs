Option Explicit

Dim shell, fso, guiPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

guiPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "devrelay-gui.mjs")
command = "node.exe " & Chr(34) & guiPath & Chr(34)
shell.CurrentDirectory = fso.GetParentFolderName(guiPath)
shell.Run command, 0, False
