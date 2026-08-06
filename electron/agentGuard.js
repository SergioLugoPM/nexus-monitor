// Lista de rutas/extensiones/apps explícitamente prohibidas para el agente
// — segundo de los tres requisitos técnicos del roadmap antes de Nivel 2.
// Esto es una lista de DENEGACIÓN además de lo que cada herramienta ya
// restringe por diseño (open_path solo abre con la app default, no ejecuta
// comandos arbitrarios) — el propósito es atrapar los casos que ese diseño
// no cubrió, no ser la única capa de seguridad.
//
// Deliberadamente de solo lectura desde el renderer — no hay ningún IPC
// para escribir o modificar esta lista, ni desde el agente ni desde la UI.
// Vive en el proceso principal siguiendo el mismo principio que
// auditlog.js: la fuente de verdad no depende de que el renderer se porte
// bien.
const { ipcMain } = require('electron');
const path = require('path');
const os = require('os');

const home = os.homedir();

// Prefijos de ruta (normalizados a minúsculas) que el agente nunca debe
// tocar, sin importar la extensión del archivo.
const FORBIDDEN_PATH_PREFIXES = [
  'c:\\windows',
  'c:\\programdata',
  path.join(home, '.ssh').toLowerCase(),
  path.join(home, 'appdata', 'roaming', 'microsoft', 'credentials').toLowerCase(),
  path.join(home, 'appdata', 'local', 'microsoft', 'credentials').toLowerCase(),
  // El propio config del agente (tiene la API key de Anthropic) y su log de
  // auditoría (que el agente no debe poder alterar) — viven junto a
  // server.js, en la raíz del proyecto.
  path.join(__dirname, '..', 'nexus.config.json').toLowerCase(),
  path.join(__dirname, '..', 'agent-audit.log').toLowerCase(),
];

// Extensiones que nunca debe "abrir" — para estas, abrir equivale a
// ejecutar (shell.openPath dispara la app asociada, que para un
// .exe/.bat/.ps1 es correrlo). El tool se llama open_path pero para estos
// tipos es indistinguible de un run_command, que Nivel 1 no tiene.
const FORBIDDEN_EXTENSIONS = [
  '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.jse', '.wsf', '.wsh',
  '.msi', '.msc', '.scr', '.com', '.reg', '.jar', '.cpl', '.lnk',
];

// Apps administrativas que un humano puede abrir con un clic sin pensarlo
// dos veces, pero que no tiene sentido que un agente de IA abra por su
// cuenta — no ejecutan nada por sí solas, pero facilitan cambios de
// sistema serios si alguien las usa después sin saber por qué se abrieron.
const FORBIDDEN_APP_PATTERNS = [
  /regedit/i, /registry editor/i, /editor del registro/i,
  /group policy/i, /directiva de grupo/i,
  /computer management/i, /administraci[oó]n de equipos/i,
  /disk management/i, /administraci[oó]n de discos/i,
  /power ?shell/i, /símbolo del sistema/i, /command prompt/i, /^cmd(\.exe)?$/i,
];

function normalize(p) {
  return path.resolve(p || '').toLowerCase();
}

function checkPath(targetPath) {
  const norm = normalize(targetPath);
  const ext = path.extname(norm);
  if (FORBIDDEN_EXTENSIONS.includes(ext)) {
    return { blocked: true, reason: `Extensión "${ext}" bloqueada — abrirla equivale a ejecutarla, fuera del alcance de Nivel 1.` };
  }
  for (const prefix of FORBIDDEN_PATH_PREFIXES) {
    if (norm === prefix || norm.startsWith(prefix + path.sep)) {
      return { blocked: true, reason: `Ruta protegida — el agente tiene prohibido tocar "${prefix}".` };
    }
  }
  return { blocked: false };
}

function checkApp(name) {
  const n = (name || '').trim();
  for (const re of FORBIDDEN_APP_PATTERNS) {
    if (re.test(n)) {
      return { blocked: true, reason: `"${n}" está en la lista de apps administrativas que el agente no puede abrir por su cuenta.` };
    }
  }
  return { blocked: false };
}

function registerAgentGuardHandlers() {
  ipcMain.handle('agent:checkPath', (event, targetPath) => checkPath(targetPath));
  ipcMain.handle('agent:checkApp', (event, name) => checkApp(name));
}

module.exports = { registerAgentGuardHandlers, checkPath, checkApp };
