const { contextBridge, ipcRenderer } = require('electron');

// The renderer (dashboard.html — same file used in the Wallpaper Engine
// build) only ever sees this narrow, promise-based surface. It never gets a
// require('fs') or require('child_process') of its own, even though
// nodeIntegration would technically allow it — contextIsolation keeps this
// bridge as the only door through to the main process.
//
// require('os') would ALSO break this file: with sandbox:true the preload
// runs in Electron's sandboxed context, whose shimmed `require` only exposes
// 'electron' plus a handful of polyfilled built-ins — 'os' isn't one of
// them, so calling it here throws and silently kills the entire
// contextBridge (window.nexusFS never gets exposed, with only a console
// warning to explain why). Everything, including the home directory, must
// go through IPC instead.
contextBridge.exposeInMainWorld('nexusFS', {
  getHomeDir: () => ipcRenderer.invoke('fs:homeDir'),
  listDrives: () => ipcRenderer.invoke('fs:listDrives'),
  listDir: (dirPath) => ipcRenderer.invoke('fs:listDir', dirPath),
  openPath: (targetPath) => ipcRenderer.invoke('fs:openPath', targetPath),
  showInExplorer: (targetPath) => ipcRenderer.invoke('fs:showInExplorer', targetPath),
});

contextBridge.exposeInMainWorld('nexusApps', {
  list: () => ipcRenderer.invoke('apps:list'),
  launch: (targetPath) => ipcRenderer.invoke('apps:launch', targetPath),
  // Registers cb to fire on Ctrl+Space (main process owns the global
  // shortcut since it must work even when the launcher isn't focused).
  onToggle: (cb) => ipcRenderer.on('launcher:toggle', cb),
});

contextBridge.exposeInMainWorld('nexusSys', {
  listProcesses: () => ipcRenderer.invoke('sysmon:processes'),
  listWindows: () => ipcRenderer.invoke('sysmon:windows'),
  listConnections: () => ipcRenderer.invoke('sysmon:connections'),
  focusWindow: (pid) => ipcRenderer.invoke('sysmon:focusWindow', pid),
  killProcess: (pid) => ipcRenderer.invoke('sysmon:killProcess', pid),
});

contextBridge.exposeInMainWorld('nexusActivity', {
  listOpened: () => ipcRenderer.invoke('activity:opened'),
  listChanges: () => ipcRenderer.invoke('activity:changes'),
});

contextBridge.exposeInMainWorld('nexusAudit', {
  log: (entry) => ipcRenderer.invoke('audit:log', entry),
  list: (limit) => ipcRenderer.invoke('audit:list', limit),
});

// Lets the renderer detect it's running inside the Electron shell (vs. the
// WE/browser build) without probing for window.nexusFS everywhere.
contextBridge.exposeInMainWorld('nexusShell', {
  isElectron: true,
  exitKiosk: () => ipcRenderer.send('shell:exitKiosk'),
});
