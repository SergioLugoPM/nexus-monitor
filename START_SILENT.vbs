' NEXUS MONITOR - Auto Start (silent)
' Put shortcut to this file in:
' C:\Users\%USERNAME%\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup
'
' OpenSky credentials are configured via the Settings modal (⚙) in the dashboard.
' They are stored in nexus.config.json in this folder — no env vars needed.

Dim fso, sFolder
Set fso = CreateObject("Scripting.FileSystemObject")
sFolder = fso.GetParentFolderName(WScript.ScriptFullName)
Set WshShell = CreateObject("WScript.Shell")

WshShell.Run "cmd /c cd /d """ & sFolder & """ && ""C:\Program Files\nodejs\node.exe"" server.js", 0, False
WScript.Sleep 2000
