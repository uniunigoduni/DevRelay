Option Explicit

Dim shell, fso, mode, guiPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

mode = "https"
If WScript.Arguments.Count > 0 Then
  mode = LCase(WScript.Arguments(0))
End If
If mode <> "chatgpt" Then mode = "https"

guiPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "devrelay-gui.mjs")
command = "node.exe " & Chr(34) & guiPath & Chr(34) & " --mode=" & mode
shell.CurrentDirectory = fso.GetParentFolderName(guiPath)
shell.Run command, 0, False
