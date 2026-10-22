' NEXUS MONITOR - supervisor del backend (oculto)
'
' Lo lanza la tarea programada "NexusMonitorBackend" al iniciar sesion.
' Mantiene node server.js vivo: si el proceso muere lo vuelve a lanzar, y si el
' puerto ya esta ocupado (otra copia del backend) espera sin duplicar nada.
' Registro en watchdog.log (se recorta solo, esta ignorado por git).

Option Explicit

Const PORT = 19234
Const NODE_EXE = "C:\Program Files\nodejs\node.exe"

Dim fso, sh, folder, logPath
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
logPath = folder & "\watchdog.log"

Sub Log(msg)
  On Error Resume Next
  If fso.FileExists(logPath) Then
    If fso.GetFile(logPath).Size > 100000 Then fso.DeleteFile logPath, True
  End If
  Dim f
  Set f = fso.OpenTextFile(logPath, 8, True)
  f.WriteLine Now & "  " & msg
  f.Close
End Sub

' True si algo responde HTTP en el puerto (cualquier respuesta cuenta)
Function PortBusy()
  Dim http
  PortBusy = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1500, 1500, 1500, 4000
  http.open "GET", "http://127.0.0.1:" & PORT & "/storms", False
  http.send
  If Err.Number = 0 Then PortBusy = True
  Err.Clear
End Function

Dim t0, rc, secs
Log "watchdog iniciado"
Do
  If PortBusy() Then
    WScript.Sleep 15000
  Else
    t0 = Timer
    Log "lanzando node server.js"
    rc = sh.Run("cmd /c cd /d """ & folder & """ && """ & NODE_EXE & """ server.js", 0, True)
    secs = Timer - t0
    If secs < 0 Then secs = secs + 86400
    Log "node termino (codigo " & rc & ") tras " & Int(secs) & " s"
    ' si muere al instante (error de arranque) no martillar: espera mas
    If secs < 10 Then WScript.Sleep 30000 Else WScript.Sleep 4000
  End If
Loop
