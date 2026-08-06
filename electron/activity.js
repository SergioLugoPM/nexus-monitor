// IPC handlers backing the "recent file activity" panel — what was recently
// opened (via Windows' own shell "Recent" tracking) and what was recently
// created/modified in a few common user folders (via fs.watch). Same
// PowerShell-script-to-tempfile pattern as sysmon.js/appsapi.js for
// resolving .lnk shortcuts — never -Command with interpolated data.
const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function runPS(script, timeout) {
  return new Promise(resolve => {
    const tmpFile = path.join(os.tmpdir(), 'nexus-ps-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.ps1');
    fs.writeFileSync(tmpFile, script, 'utf8');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
      { timeout: timeout || 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        fs.unlink(tmpFile, () => {});
        if (err || !stdout || !stdout.trim()) return resolve(null);
        resolve(stdout);
      }
    );
  });
}

// ── RECENTLY OPENED (Windows shell "Recent" folder) ────────────────────────
// Every .lnk in this folder is created by SHAddToRecentDocs, which most
// Windows apps call automatically on open (Explorer, Office, browsers,
// media players, editors, PDF readers, etc.) — the same list behind
// Explorer's own Quick Access "Recent files". Resolving .lnk targets needs
// WScript.Shell COM, so it's one batched PowerShell call, not per-file.
const RECENT_SCRIPT = `
$sh = New-Object -ComObject WScript.Shell
$dir = [Environment]::GetFolderPath('Recent')
Get-ChildItem -Path $dir -Filter *.lnk -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 40 |
  ForEach-Object {
    try {
      $target = $sh.CreateShortcut($_.FullName).TargetPath
      if ($target -and (Test-Path $target -PathType Leaf)) {
        [PSCustomObject]@{ path = $target; name = [System.IO.Path]::GetFileName($target); ts = $_.LastWriteTime.ToString('o') }
      }
    } catch {}
  } | ConvertTo-Json -Compress
`.trim();

const OPENED_TTL = 5000;
let _openedCache = null, _openedCacheTs = 0, _openedInFlight = null;

async function listRecentOpened() {
  const now = Date.now();
  if (_openedCache && now - _openedCacheTs < OPENED_TTL) return _openedCache;
  if (!_openedInFlight) {
    _openedInFlight = (async () => {
      const out = await runPS(RECENT_SCRIPT, 6000);
      let result = [];
      if (out) {
        try {
          let parsed = JSON.parse(out);
          if (!Array.isArray(parsed)) parsed = [parsed]; // ConvertTo-Json omits the array wrapper for a single result
          result = parsed.filter(f => f && f.path);
        } catch (e) {}
      }
      _openedCache = result; _openedCacheTs = Date.now(); _openedInFlight = null;
      return result;
    })();
  }
  return _openedInFlight;
}

// ── RECENTLY CREATED/MODIFIED (fs.watch on common folders) ─────────────────
// Windows has no shell-level tracking for creates/modifies like it does for
// opens, so this is watched directly. A rolling in-memory buffer that starts
// empty at app launch and fills in as changes happen live — not a query
// against file timestamps (those get touched by all kinds of things unrelated
// to real user activity, e.g. sync clients, indexers).
const WATCH_DIRS = ['Desktop', 'Documents', 'Downloads', 'Pictures']
  .map(d => path.join(os.homedir(), d))
  .filter(d => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });

const IGNORE_RE = /(^\.|~\$|\.tmp$|\.crdownload$|\.part$)/i;
const MAX_BUF = 60;
const CHANGE_BUF = [];
const _debounce = new Map(); // path -> timer, collapses rapid-fire duplicate events from a single save

// fs.watch's own eventType is the only honest signal for created-vs-modified
// here — Windows fires 'rename' for create/delete/rename-in-place and
// 'change' for content writes. A debounce window collapses the burst of
// events a single save typically produces (rename once, then 1-2 change
// events) into one entry, labeled by whichever type showed up in that burst
// (rename wins if present, since a bare 'change' burst with no 'rename'
// means the file already existed before this app started watching).
const _sawRename = new Set();

function pushChange(filePath, eventType) {
  const name = path.basename(filePath);
  if (IGNORE_RE.test(name)) return;
  if (eventType === 'rename') _sawRename.add(filePath);
  const existing = _debounce.get(filePath);
  if (existing) clearTimeout(existing);
  _debounce.set(filePath, setTimeout(() => {
    _debounce.delete(filePath);
    const wasCreated = _sawRename.delete(filePath);
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) return; // deleted, or a directory — not activity we track
      CHANGE_BUF.unshift({ path: filePath, name, type: wasCreated ? 'creado' : 'modificado', ts: new Date().toISOString() });
      if (CHANGE_BUF.length > MAX_BUF) CHANGE_BUF.length = MAX_BUF;
    });
  }, 400));
}

function startWatchers() {
  for (const dir of WATCH_DIRS) {
    try {
      fs.watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        pushChange(path.join(dir, filename), eventType);
      });
    } catch (e) { /* some folders (e.g. redirected/cloud-backed) can refuse to watch — skip silently */ }
  }
}

function listRecentChanges() {
  return CHANGE_BUF.slice(0, 40);
}

function registerActivityHandlers() {
  startWatchers();
  ipcMain.handle('activity:opened', () => listRecentOpened());
  ipcMain.handle('activity:changes', () => Promise.resolve(listRecentChanges()));
}

module.exports = { registerActivityHandlers };
