// IPC handlers backing the PROCESSES panel — running processes (via the
// systeminformation dep already used by server.js) and open windows (via a
// small Win32 P/Invoke script, same pattern as appsapi.js: script written to
// a temp .ps1 and run with -File, never -Command with interpolated data).
const { ipcMain } = require('electron');
const si = require('systeminformation');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIN_ENUM_SCRIPT = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class NexusWinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static List<object> Get() {
    var result = new List<object>();
    IntPtr fg = GetForegroundWindow();
    EnumWindows((hWnd, lp) => {
      if (!IsWindowVisible(hWnd)) return true;
      int len = GetWindowTextLength(hWnd);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(hWnd, sb, sb.Capacity);
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      result.Add(new object[] { sb.ToString(), (int)pid, hWnd == fg });
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
"@
[NexusWinEnum]::Get() | ForEach-Object {
  $proc = Get-Process -Id $_[1] -ErrorAction SilentlyContinue
  [PSCustomObject]@{
    title = $_[0]
    pid = $_[1]
    processName = if ($proc) { $proc.ProcessName } else { '?' }
    foreground = $_[2]
  }
} | ConvertTo-Json -Compress
`.trim();

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

async function listWindows() {
  const out = await runPS(WIN_ENUM_SCRIPT, 8000);
  if (!out) return [];
  try {
    let parsed = JSON.parse(out);
    if (!Array.isArray(parsed)) parsed = [parsed]; // ConvertTo-Json omits the array wrapper for a single result
    return parsed.filter(w => w && w.title);
  } catch (e) { return []; }
}

async function listProcesses() {
  const data = await si.processes();
  return (data.list || [])
    .filter(p => (p.cpu || 0) > 0 || (p.mem || 0) > 0.1)
    .sort((a, b) => (b.cpu || 0) - (a.cpu || 0))
    .slice(0, 80)
    .map(p => ({
      pid: p.pid,
      name: p.name,
      cpu: parseFloat((p.cpu || 0).toFixed(1)),
      mem: parseFloat((p.mem || 0).toFixed(1)),
      memMb: Math.round((p.memRss || 0) / 1024),
    }));
}

function registerSysmonHandlers() {
  ipcMain.handle('sysmon:processes', () => listProcesses());
  ipcMain.handle('sysmon:windows', () => listWindows());

  // Brings another app's window to the foreground — AppActivate is the
  // simplest reliable cross-process way to do this without holding a raw
  // HWND handle in the renderer.
  ipcMain.handle('sysmon:focusWindow', async (event, pid) => {
    const script = `[void][System.Reflection.Assembly]::LoadWithPartialName('Microsoft.VisualBasic'); try { [Microsoft.VisualBasic.Interaction]::AppActivate(${parseInt(pid, 10)}); 'ok' } catch { 'err' }`;
    const out = await runPS(script, 4000);
    return { ok: (out || '').trim() === 'ok' };
  });

  // User-initiated only (a button click in the PROCESSES panel, confirmed
  // in the renderer before this ever fires) — not something an automated
  // agent gets to call directly. See ROADMAP.md's trust-level ladder.
  ipcMain.handle('sysmon:killProcess', (event, pid) => {
    try { process.kill(parseInt(pid, 10)); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
}

module.exports = { registerSysmonHandlers };
