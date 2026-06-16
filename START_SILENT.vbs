' NEXUS MONITOR - Auto Start
' Put shortcut to this file in: 
' C:\Users\%USERNAME%\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup
Dim fso, sFolder
Set fso = CreateObject("Scripting.FileSystemObject")
sFolder = fso.GetParentFolderName(WScript.ScriptFullName)
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d """ & sFolder & """ && node server.js", 0, False
WScript.Sleep 2000
