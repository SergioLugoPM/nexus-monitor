// IPC handlers backing the file-explorer panel. All filesystem access happens
// here in the main process — the renderer only ever gets plain data back
// through the contextBridge in preload.js, never a live fs handle.
const { ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

function listDrives() {
  if (process.platform !== 'win32') return ['/'];
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c) + ':\\';
    try { fs.accessSync(letter); drives.push(letter); } catch (_) {}
  }
  return drives;
}

function listDir(dirPath) {
  const resolved = path.resolve(dirPath);
  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    const full = path.join(resolved, e.name);
    let size = 0, mtime = null;
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch (_) { /* permission-denied entries (e.g. System Volume Information) are skipped from stat but still listed */ }
    items.push({
      name: e.name,
      isDir: e.isDirectory(),
      size,
      mtime,
      ext: e.isDirectory() ? '' : path.extname(e.name).slice(1).toLowerCase(),
    });
  }
  // Directories first, then alphabetical
  items.sort((a, b) => (a.isDir === b.isDir) ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1));
  return { path: resolved, parent: path.dirname(resolved) !== resolved ? path.dirname(resolved) : null, items };
}

function registerFsHandlers() {
  ipcMain.handle('fs:homeDir', () => os.homedir());

  ipcMain.handle('fs:listDrives', () => listDrives());

  ipcMain.handle('fs:listDir', (event, dirPath) => {
    try { return { ok: true, ...listDir(dirPath) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // Opens with the OS default application (Explorer's own file-type
  // association) — never executes anything Nexus itself decides to run.
  ipcMain.handle('fs:openPath', async (event, targetPath) => {
    const err = await shell.openPath(path.resolve(targetPath));
    return { ok: !err, error: err || null };
  });

  ipcMain.handle('fs:showInExplorer', (event, targetPath) => {
    shell.showItemInFolder(path.resolve(targetPath));
    return { ok: true };
  });

  // Backs the agent's Nivel 2 move_path tool (and could back a future
  // human-facing move in the Explorer tab, though nothing calls it yet).
  // Callers are expected to have already run agentGuard's checkPath() and
  // undoManager's backupBeforeWrite() on the destination — this handler
  // only does the raw move, no policy or safety-net logic of its own.
  ipcMain.handle('fs:movePath', (event, sourcePath, destPath) => {
    const src = path.resolve(sourcePath);
    const dst = path.resolve(destPath);
    try {
      if (!fs.existsSync(src)) return { ok: false, error: 'No existe: ' + src };
      fs.renameSync(src, dst);
      return { ok: true };
    } catch (e) {
      // renameSync can't move across drives (EXDEV) — fall back to
      // copy+delete, but only for files; a recursive directory copy is out
      // of scope here and riskier to get right under time pressure.
      if (e.code === 'EXDEV') {
        try {
          if (!fs.statSync(src).isFile()) return { ok: false, error: 'Mover carpetas entre unidades distintas no está soportado.' };
          fs.copyFileSync(src, dst);
          fs.unlinkSync(src);
          return { ok: true };
        } catch (e2) { return { ok: false, error: e2.message }; }
      }
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { registerFsHandlers };
