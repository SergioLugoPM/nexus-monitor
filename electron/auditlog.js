// Audit log de cada acción que el agente ejecuta — el primer requisito
// técnico del roadmap antes de subir el agente a Nivel 2 (comandos con
// confirmación). Registra qué se ejecutó, cuándo, y por qué lo decidió
// Claude (el texto que acompaña al tool_use, cuando lo hay) — no cada
// pregunta/respuesta de texto de Nivel 0/1, solo acciones REALES.
//
// Log de solo-anexar en JSON Lines (una entrada por línea) — simple de
// escribir sin bloquear, simple de leer con un split('\n'). Vive fuera del
// repo (gitignored, como nexus.config.json) porque puede contener rutas de
// archivos y nombres de apps del uso real de la persona.
const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const AUDIT_LOG_PATH = path.join(__dirname, '..', 'agent-audit.log');
const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const KEEP_LINES_ON_TRIM = 2000;

function trimIfNeeded() {
  try {
    const stat = fs.statSync(AUDIT_LOG_PATH);
    if (stat.size <= MAX_BYTES) return;
    const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(AUDIT_LOG_PATH, lines.slice(-KEEP_LINES_ON_TRIM).join('\n') + '\n', 'utf8');
  } catch (e) { /* missing file, race with another trim, etc. — not worth failing over */ }
}

function appendEntry(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, line, 'utf8');
    if (Math.random() < 0.02) trimIfNeeded(); // check occasionally, not on every write
  } catch (e) { console.error('audit log write error:', e.message); }
}

function listRecent(limit) {
  try {
    const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-(limit || 50)).reverse().map(l => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; } // no log yet — nothing executed
}

function registerAuditHandlers() {
  ipcMain.handle('audit:log', (event, entry) => { appendEntry(entry || {}); return { ok: true }; });
  ipcMain.handle('audit:list', (event, limit) => listRecent(limit));
}

module.exports = { registerAuditHandlers };
