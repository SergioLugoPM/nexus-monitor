// Bridge between the renderer (dashboard.html, same as the WE build) and
// Electron/Node APIs. Nothing is exposed yet — this is the seam where the
// file-explorer and app-launcher APIs will be added later, via
// contextBridge.exposeInMainWorld, instead of turning on nodeIntegration.
