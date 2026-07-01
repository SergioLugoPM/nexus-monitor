// IPC handlers backing the Spotlight/Start-menu style app launcher (Ctrl+Space).
// Enumerates installed apps by resolving .lnk shortcuts from the Start Menu —
// the same source Windows' own Start menu search reads from — via a short
// PowerShell script written to a temp .ps1 file and run with -File (never
// -Command with interpolated strings, which would reopen the same argv
// quoting/injection class of bug that /exec had before it was fixed).
const { ipcMain, shell, app } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let _appsCache = null;
let _appsCacheTs = 0;
const TTL = 15 * 60 * 1000;
let _scanInFlight = null;

const SCAN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject WScript.Shell
$paths = @(
  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs')
)
$results = New-Object System.Collections.Generic.List[object]
foreach ($p in $paths) {
  if (-not (Test-Path $p)) { continue }
  Get-ChildItem -Path $p -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $sc = $shell.CreateShortcut($_.FullName)
      $target = $sc.TargetPath
      if ($target -and (Test-Path $target) -and $target -match '\\.exe$') {
        $results.Add([PSCustomObject]@{
          name   = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
          target = $target
        })
      }
    } catch {}
  }
}
$results | Sort-Object -Property name -Unique | ConvertTo-Json -Compress
`.trim();

function scanApps() {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), 'nexus-appscan-' + Date.now() + '.ps1');
    fs.writeFileSync(tmpFile, SCAN_SCRIPT, 'utf8');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        fs.unlink(tmpFile, () => {});
        if (err || !stdout || !stdout.trim()) return resolve([]);
        try {
          let parsed = JSON.parse(stdout);
          if (!Array.isArray(parsed)) parsed = [parsed]; // ConvertTo-Json omits the array wrapper for a single result
          resolve(parsed.filter(a => a && a.name && a.target).map(a => ({ name: a.name, target: a.target })));
        } catch (e) { resolve([]); }
      }
    );
  });
}

async function getApps() {
  const now = Date.now();
  if (_appsCache && now - _appsCacheTs < TTL) return _appsCache;
  if (!_scanInFlight) {
    _scanInFlight = scanApps().then(list => {
      _appsCache = list;
      _appsCacheTs = Date.now();
      _scanInFlight = null;
      return list;
    });
  }
  return _scanInFlight;
}

function registerAppsHandlers() {
  ipcMain.handle('apps:list', () => getApps());

  // Launches via the same shell.openPath used by the file explorer — the OS
  // itself decides how to run the target, Nexus never builds a command line.
  ipcMain.handle('apps:launch', async (event, targetPath) => {
    const err = await shell.openPath(targetPath);
    return { ok: !err, error: err || null };
  });
}

module.exports = { registerAppsHandlers };
