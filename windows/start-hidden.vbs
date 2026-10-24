' Starts soundpad-rpc without a console window.
' Node path: windows\node-path.txt (written by install-autostart.ps1),
' otherwise the standard install folder, otherwise node.exe from PATH.
Option Explicit
Dim sh, fso, here, appDir, node, cfg, f
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
appDir = fso.GetParentFolderName(here)

node = ""
cfg = here & "\node-path.txt"
If fso.FileExists(cfg) Then
  Set f = fso.OpenTextFile(cfg, 1)
  If Not f.AtEndOfStream Then node = Trim(f.ReadLine)
  f.Close
End If
If node = "" Or Not fso.FileExists(node) Then
  node = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
  If Not fso.FileExists(node) Then node = "node.exe"
End If

sh.CurrentDirectory = appDir
sh.Run """" & node & """ """ & appDir & "\index.js""", 0, False
