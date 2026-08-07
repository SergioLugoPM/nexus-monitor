// Modo "deshacer" — tercer y último requisito técnico del roadmap antes de
// Nivel 2 (comandos con confirmación explícita, incluyendo mover/borrar
// archivos). Nivel 1 no tiene ninguna herramienta destructiva todavía —
// este módulo existe listo para cuando Nivel 2 las agregue, verificado de
// forma independiente igual que agentGuard.js/auditlog.js lo fueron antes
// de tener un consumidor real.
//
// Dos mecanismos:
//   - safeDelete: nunca borra de verdad — manda a la Papelera de Windows
//     (shell.trashItem). "Deshacer" es literalmente clic derecho →
//     Restaurar en la Papelera; no hay que inventar un sistema paralelo
//     ni una UI de restauración propia para esto.
//   - backupBeforeWrite: antes de sobrescribir/mover un archivo existente,
//     guarda una copia con timestamp en una carpeta de respaldos dedicada
//     (agent-backups/, gitignored), restaurable por su ID. Con tope de
//     100 respaldos — es una red de seguridad de uso personal, no un
//     archivo histórico; los más viejos se borran del disco al pasar el
//     límite, no solo del índice.
const { ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const BACKUP_DIR = path.join(__dirname, '..', 'agent-backups');
const BACKUP_INDEX_PATH = path.join(BACKUP_DIR, 'index.json');
const MAX_BACKUPS = 100;

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(BACKUP_INDEX_PATH, 'utf8')); }
  catch (e) { return []; }
}

function saveIndex(index) {
  ensureBackupDir();
  fs.writeFileSync(BACKUP_INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
}

async function safeDelete(targetPath) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return { ok: false, error: 'No existe: ' + targetPath };
    await shell.trashItem(targetPath);
    return { ok: true, restoreHint: 'Enviado a la Papelera de reciclaje de Windows — restaurable desde ahí.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function backupBeforeWrite(targetPath) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return { ok: false, error: 'No existe: ' + targetPath };
    if (!fs.statSync(targetPath).isFile()) return { ok: false, error: 'Solo se respaldan archivos, no carpetas: ' + targetPath };
    ensureBackupDir();
    const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const backupPath = path.join(BACKUP_DIR, id + '-' + path.basename(targetPath));
    fs.copyFileSync(targetPath, backupPath);
    const index = loadIndex();
    index.unshift({ id, originalPath: targetPath, backupPath, ts: new Date().toISOString() });
    const dropped = index.slice(MAX_BACKUPS);
    for (const d of dropped) { try { fs.unlinkSync(d.backupPath); } catch (e) {} }
    saveIndex(index.slice(0, MAX_BACKUPS));
    return { ok: true, id, backupPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function listBackups(limit) {
  return loadIndex().slice(0, limit || 50);
}

function restoreBackup(id) {
  const entry = loadIndex().find(e => e.id === id);
  if (!entry) return { ok: false, error: 'No se encontró el respaldo ' + id };
  try {
    fs.copyFileSync(entry.backupPath, entry.originalPath);
    return { ok: true, restoredTo: entry.originalPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function registerUndoHandlers() {
  ipcMain.handle('undo:safeDelete', (event, targetPath) => safeDelete(targetPath));
  ipcMain.handle('undo:backupBeforeWrite', (event, targetPath) => backupBeforeWrite(targetPath));
  ipcMain.handle('undo:listBackups', (event, limit) => listBackups(limit));
  ipcMain.handle('undo:restoreBackup', (event, id) => restoreBackup(id));
}

module.exports = { registerUndoHandlers, safeDelete, backupBeforeWrite, listBackups, restoreBackup };
