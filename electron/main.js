const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const { registerFsHandlers } = require('./fsapi');
const { registerAppsHandlers } = require('./appsapi');

// Boots the existing Express backend in-process (same server.js used by the
// Wallpaper Engine build on master — untouched, just required instead of run
// standalone via `node server.js`).
process.chdir(path.join(__dirname, '..'));
require('../server.js');

const PORT = process.env.NEXUS_PORT || 19234;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`http://localhost:${PORT}/dashboard.html`);

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  registerFsHandlers();
  registerAppsHandlers();
  createWindow();

  // Kiosk mode traps the user on a fullscreen window with no OS chrome —
  // without an explicit escape hatch, a bug in the page can lock them out
  // of their own desktop. Ctrl+Shift+Q always quits, no matter what.
  globalShortcut.register('Control+Shift+Q', () => app.quit());

  // Spotlight/Start-menu style app launcher overlay, toggled from anywhere.
  globalShortcut.register('Control+Space', () => {
    if (mainWindow) mainWindow.webContents.send('launcher:toggle');
  });

  // Esc drops out of kiosk/fullscreen — but only via a renderer-initiated IPC
  // call (dashboard.html), never a globalShortcut. A global Escape hotkey
  // would fire even while the app launcher overlay is open and also using
  // Escape to close itself, dropping kiosk mode as an unwanted side effect
  // every time the user backs out of a search. The renderer only asks to
  // exit kiosk when Escape reaches it with the launcher already closed.
  ipcMain.on('shell:exitKiosk', () => {
    if (mainWindow) {
      mainWindow.setKiosk(false);
      mainWindow.setFullScreen(false);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
