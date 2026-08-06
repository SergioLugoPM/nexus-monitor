const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, session } = require('electron');
const path = require('path');
const { registerFsHandlers } = require('./fsapi');
const { registerAppsHandlers } = require('./appsapi');
const { registerSysmonHandlers } = require('./sysmon');
const { registerActivityHandlers } = require('./activity');

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

// Boots the existing Express backend in-process (same server.js used by the
// Wallpaper Engine build on master — untouched, just required instead of run
// standalone via `node server.js`).
process.chdir(path.join(__dirname, '..'));
require('../server.js');

const PORT = process.env.NEXUS_PORT || 19234;

let mainWindow = null;
let tray = null;

function createWindow() {
  // Deliberately NOT fullscreen/kiosk yet at construction time — see the
  // comment above setSkipTaskbar below for why the ordering matters here.
  mainWindow = new BrowserWindow({
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0e14',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`http://localhost:${PORT}/dashboard.html`);

  // No taskbar button/Alt+Tab entry — this is meant to feel like a shell
  // layer, not another app window. The tray icon is what makes that safe:
  // without it, a kiosk window with no taskbar presence would be a dead end
  // if it ever lost focus behind something else.
  //
  // Ordering matters a lot here: kiosk:true + skipTaskbar:true together (as
  // constructor options, or toggling skipTaskbar on an already-kiosk window)
  // hits a Windows/Electron interaction where the window ends up minimized
  // off-screen at (-32000,-32000) — visible per Win32 but never actually on
  // screen, no error anywhere. The sequence that reliably avoids it: show
  // as a normal window first, apply skipTaskbar while still normal, THEN
  // switch to kiosk/fullscreen last.
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.setSkipTaskbar(true);
    mainWindow.setKiosk(true);
    mainWindow.setFullScreen(true);
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  if (process.env.NEXUS_DEBUG_SCREENSHOT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await mainWindow.webContents.capturePage();
          require('fs').writeFileSync(process.env.NEXUS_DEBUG_SCREENSHOT, img.toPNG());
        } catch (e) { console.log('DEBUG CAPTURE ERROR:', e.message); }
        app.quit();
      }, 3000);
    });
  }
}

function showAndFocus() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip('Nexus Monitor — Ctrl+Shift+N para enfocar');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mostrar / enfocar  (Ctrl+Shift+N)', click: showAndFocus },
    { label: 'Salir de kiosko (ventana)', click: () => { if (mainWindow) { mainWindow.setKiosk(false); mainWindow.setFullScreen(false); showAndFocus(); } } },
    { type: 'separator' },
    { label: 'Cerrar Nexus Monitor', click: () => app.quit() },
  ]));
  // Left-click (Windows convention) just shows/focuses — the menu above
  // covers everything else, so a click doesn't need to toggle/hide.
  tray.on('click', showAndFocus);
}

app.whenReady().then(() => {
  // Electron denies every media/permission request by default — the mic
  // (for the agent's voice input) would silently fail with no dialog and no
  // error otherwise. Only 'media' (mic/camera) is allowed; everything else
  // (geolocation, notifications, etc.) stays denied.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });

  registerFsHandlers();
  registerAppsHandlers();
  registerSysmonHandlers();
  registerActivityHandlers();
  createWindow();
  createTray();

  // Kiosk mode traps the user on a fullscreen window with no OS chrome —
  // without an explicit escape hatch, a bug in the page can lock them out
  // of their own desktop. Ctrl+Shift+Q always quits, no matter what.
  globalShortcut.register('Control+Shift+Q', () => app.quit());

  // Spotlight/Start-menu style app launcher overlay, toggled from anywhere.
  globalShortcut.register('Control+Space', () => {
    if (mainWindow) mainWindow.webContents.send('launcher:toggle');
  });

  // Pressing the Windows key and clicking the taskbar (or Alt+Tabbing to
  // another app, since skipTaskbar also drops Nexus out of that list) takes
  // focus away from Nexus with no keyboard way back — only a mouse click on
  // the tiny tray icon. This is that keyboard way back, from anywhere in
  // Windows, no matter what currently has focus. Global hotkeys are exempt
  // from Windows' normal foreground-focus-stealing prevention, so
  // showAndFocus() reliably works here even when e.g. the Start Menu is open.
  //
  // Deliberately NOT using Alt in this combo: on Windows, AltGr (used on
  // Spanish/Latin-American and many other layouts to type accented/special
  // characters) is reported to apps as Ctrl+Alt pressed together. A global
  // hotkey — registered system-wide via RegisterHotKey, not just within
  // Nexus's own window — would hijack that combo from every app in Windows,
  // breaking accented-character input everywhere, not just here.
  globalShortcut.register('Control+Shift+N', showAndFocus);

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
