; ============================================================
;  NEXUS MONITOR  -  Inno Setup 6 Script
;  - Backend como servicio Windows (NSSM)
;  - Detecta Wallpaper Engine automaticamente
;  - Excepcion de firewall en puerto 3000
; ============================================================

#define AppName      "Nexus Monitor"
#define AppVersion   "1.0.0"
#define AppPublisher "Nexus Monitor"
#define AppURL       "https://github.com/nexus-monitor"
#define AppExeName   "nexus-monitor.exe"
#define ServiceName  "NexusMonitor"
#define Port         "3000"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
AllowNoIcons=yes
OutputDir=output
OutputBaseFilename=NexusMonitorSetup-v{#AppVersion}
SetupIconFile=assets\icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Crear icono en el escritorio"; GroupDescription: "Iconos adicionales:"

[Files]
Source: "..\dist\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "assets\nssm.exe";       DestDir: "{app}"; Flags: ignoreversion
Source: "..\dashboard.html";     DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md";          DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
Name: "{group}\{#AppName} Dashboard";   Filename: "http://localhost:{#Port}"; IconFilename: "{app}\{#AppExeName}"
Name: "{group}\Desinstalar {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}";       Filename: "http://localhost:{#Port}"; IconFilename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{sys}\cmd.exe"; Parameters: "/c mkdir ""{app}\logs"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "install {#ServiceName} ""{app}\{#AppExeName}"""; Flags: runhidden waituntilterminated; StatusMsg: "Instalando servicio de Windows..."
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} DisplayName ""Nexus Monitor Backend"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} Description ""Monitor de hardware en tiempo real - dashboard en localhost:3000"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} Start SERVICE_AUTO_START"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} AppRestartDelay 5000"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} AppStdout ""{app}\logs\stdout.log"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} AppStderr ""{app}\logs\stderr.log"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} AppRotateFiles 1"; Flags: runhidden waituntilterminated
Filename: "{sys}\sc.exe"; Parameters: "start {#ServiceName}"; Flags: runhidden waituntilterminated; StatusMsg: "Iniciando servicio Nexus Monitor..."
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Nexus Monitor"" dir=in action=allow protocol=TCP localport={#Port}"; Flags: runhidden waituntilterminated; StatusMsg: "Configurando firewall..."
Filename: "http://localhost:{#Port}"; Description: "Abrir Nexus Monitor en el navegador"; Flags: nowait postinstall shellexec skipifsilent

[UninstallRun]
Filename: "{sys}\sc.exe";    Parameters: "stop {#ServiceName}";           Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "remove {#ServiceName} confirm";  Flags: runhidden waituntilterminated
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Nexus Monitor"""; Flags: runhidden waituntilterminated

[Code]
var
  WEPath: String;

function GetWallpaperEnginePath(): String;
var
  SteamPath: String;
  WEDir: String;
begin
  Result := '';
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Valve\Steam', 'InstallPath', SteamPath) then
  begin
    WEDir := SteamPath + '\steamapps\common\wallpaper_engine';
    if DirExists(WEDir) then
    begin
      Result := WEDir;
      Exit;
    end;
  end;
  if RegQueryStringValue(HKCU, 'SOFTWARE\Valve\Steam', 'SteamPath', SteamPath) then
  begin
    WEDir := SteamPath + '\steamapps\common\wallpaper_engine';
    if DirExists(WEDir) then
    begin
      Result := WEDir;
      Exit;
    end;
  end;
end;

procedure WriteProjectJson(DestDir: String);
var
  JsonPath: String;
  JsonContent: String;
begin
  JsonPath := DestDir + '\project.json';
  JsonContent := '{' + #13#10;
  JsonContent := JsonContent + #9 + '"file" : "dashboard.html",' + #13#10;
  JsonContent := JsonContent + #9 + '"general" : { "properties" : { "schemecolor" : { "order":0, "text":"ui_browse_properties_scheme_color", "type":"color", "value":"0 0 0" } } },' + #13#10;
  JsonContent := JsonContent + #9 + '"title" : "Nexus Monitor",' + #13#10;
  JsonContent := JsonContent + #9 + '"type" : "web",' + #13#10;
  JsonContent := JsonContent + #9 + '"version" : 0' + #13#10;
  JsonContent := JsonContent + '}';
  SaveStringToFile(JsonPath, JsonContent, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  WEProject: String;
  AppHtml: String;
begin
  if CurStep = ssPostInstall then
  begin
    WEPath := GetWallpaperEnginePath();
    if WEPath <> '' then
    begin
      WEProject := WEPath + '\projects\myprojects\nexus_monitor';
      if not DirExists(WEProject) then
        CreateDir(WEProject);
      AppHtml := ExpandConstant('{app}\dashboard.html');
      if FileExists(AppHtml) then
        FileCopy(AppHtml, WEProject + '\dashboard.html', False);
      WriteProjectJson(WEProject);
      MsgBox(
        'Wallpaper Engine detectado.' + #13#10 +
        'El wallpaper Nexus Monitor fue configurado automaticamente.' + #13#10 + #13#10 +
        'Abre Wallpaper Engine > Mis Proyectos y activa "Nexus Monitor".',
        mbInformation, MB_OK
      );
    end;
  end;
end;
