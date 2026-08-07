# NEXUS MONITOR — Roadmap: Modo "Ojo de Dios"

Visión a largo plazo del proyecto, documentada para avanzar por partes. Este
documento vive en la rama `electron-shell` — es la base sobre la que se
construye todo lo de aquí en adelante (el wallpaper de WE en `master` se
mantiene como baseline estable y separado).

## Visión

Nexus Monitor deja de ser solo un dashboard decorativo y se convierte en una
capa de visibilidad total: tu sistema, tu red, y el mundo, todo consultable
desde un mismo panel — y eventualmente, operable por un agente de IA con
control real sobre el shell.

## Los tres pilares de vigilancia

### 1. Sistema local (PC)
Visibilidad en tiempo real de lo que pasa en la máquina, más allá de
CPU/RAM/disco que ya existen:
- Procesos corriendo (lista completa, no solo el conteo)
- Ventanas abiertas (título, proceso dueño, si está en foco)
- Conexiones de red activas por proceso (qué app habla con qué IP/puerto)
- Actividad de archivos reciente (qué se abrió/modificó/creó)

**Ya existe una base para esto**: `electron/fsapi.js` (lectura de filesystem)
y `electron/appsapi.js` (enumeración de apps instaladas) corren en el
proceso principal de Electron con acceso nativo — el mismo patrón se
extiende para procesos/ventanas/red vía `systeminformation` (ya es
dependencia) o Win32 API directa.

### 2. OSINT global (expandir lo que ya hay)
Ya existen: sismos (USGS), clima, cripto, noticias geolocalizadas, vuelos
(OpenSky), satélites (TLE), incendios (NASA FIRMS), ciclones (GDACS), ISS.

Dirección de crecimiento:
- Más fuentes por categoría (no solo un feed de noticias por región)
- Correlación de eventos (¿el sismo M6 coincide con actividad volcánica
  cercana? ¿el pico de vuelos coincide con algo?)
- Búsqueda/consulta histórica — hoy todo es "últimas 24h en vivo y ya", no
  hay forma de preguntar "qué pasó la semana pasada en tal región"

### 3. Red local (LAN) — ✅ implementado

Mapa de tu propia red doméstica vía tab RED (⌥R): dispositivos activos
(ping sweep + `arp -a`), fabricante por MAC OUI (api.macvendors.com,
cacheado indefinidamente), hostname (PowerShell Resolve-DnsName, cubre
mDNS .local), nombres personalizados por dispositivo (localStorage,
doble clic para renombrar). Universal — vive en `server.js`, funciona
igual en WE y en Electron. Detalles técnicos e implementación en
`server.js` (`/lan/devices`) y `dashboard.html` (tab `lan`).

#### 3b. Radar por WiFi (CSI sensing) — investigado a fondo, requiere hardware real

**Corrección importante a la investigación original de este documento:**
"sin hardware nuevo" NO es un modo real. Se probó wifi-densepose en
Docker directamente (`docker pull ruvnet/wifi-densepose:latest`) antes
de construir nada — sin un ESP32/MediaTek/Qualcomm/RTL8720F real
mandando frames CSI por UDP al :5005, el servidor devuelve datos 100%
**simulados** (`source:"simulated"` en cada respuesta, confirmado
directamente en `/api/v1/sensing/latest`: persona inventada, pose
completa fabricada, ritmo cardíaco y respiración generados — nada real).
No existe un modo RSSI intermedio que use el WiFi normal de la PC para
presencia real; eso fue una suposición incorrecta de una sesión anterior.

**Lo que SÍ está listo para cuando haya hardware:**
- `server.js` ya tiene `/wifiradar`, que hace proxy a
  `http://localhost:3000/api/v1/sensing/latest` y pasa el flag `source`
  del upstream tal cual — nunca lo oculta, así el frontend nunca muestra
  datos falsos como reales
- `dashboard.html` (tab RED) ya consume ese endpoint: si no está
  disponible o `source==="simulated"`, muestra un banner claro ("sin
  hardware conectado"); en cuanto `live:true` (un ESP32 real enviando
  frames), renderiza personas/vital signs reales — cero cambios de
  código necesarios, solo conectar el hardware

**Para activarlo cuando llegue el ESP32-S3 (~$8 USD):**
1. `docker run -d -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 -p 5005:5005/udp -e RUVIEW_ALLOW_UNAUTHENTICATED=1 ruvnet/wifi-densepose:latest`
   (el bind restringido a 127.0.0.1 en el mapeo de puertos de Docker,
   NO en la app vía `RUVIEW_BIND_ADDR`, que la deja inalcanzable desde
   fuera del contenedor — verificado a mano)
2. Conectar el ESP32-S3 enviando frames CSI al puerto UDP 5005 del host
3. Listo — el tab RED promueve automáticamente a datos reales

## Agente de IA — control total, con capa de permisos

El objetivo final es un agente tipo Jarvis: puede ejecutar comandos, mover y
gestionar archivos, cambiar configuración, operar el explorador y el
launcher — control real, no solo lectura.

**Esto no se construye como acceso sin restricciones desde el día uno.** Un
agente con control total de un sistema real necesita una escalera de
confianza, no un interruptor binario:

```
Nivel 0 — Consulta       El agente lee el estado del dashboard y responde
                          preguntas. Cero capacidad de ejecutar nada.

Nivel 1 — Acciones seguras   Puede abrir apps (launcher) y navegar/abrir
                          archivos (explorer) — mismo alcance que ya tienen
                          esos módulos, nada nuevo destructivo.

Nivel 2 — Comandos con confirmación   Puede correr comandos de shell o
                          mover/borrar archivos, pero cada acción con
                          efecto real pide confirmación explícita antes de
                          ejecutar — igual que este mismo asistente (Claude
                          Code) opera contigo ahora.

Nivel 3 — Control total autónomo   Ejecuta sin pedir confirmación caso por
                          caso, dentro de límites configurados (ej. no
                          tocar C:\Windows, no borrar sin papelera, log de
                          auditoría de todo lo que hace).
```

Por qué esto importa concretamente: `/exec` en `server.js` ya tuvo una
vulnerabilidad real de inyección de comandos (corregida) precisamente porque
ejecutar comandos arbitrarios sin control estricto es peligroso incluso
cuando el "atacante" es benigno — un LLM que alucina un comando destructivo
es el mismo tipo de riesgo. La arquitectura de niveles existe para que
"control total" sea usable sin que un error de razonamiento del modelo se
traduzca en pérdida de datos real.

**Requisitos técnicos antes de llegar a Nivel 2+:**
- ✅ Log de auditoría de cada acción que el agente ejecuta (qué, cuándo, por
  qué lo decidió) — `electron/auditlog.js`, JSON Lines en `agent-audit.log`,
  panel "📋 Historial" en el tab Agent. Verificado en vivo.
- ✅ Lista de rutas/comandos explícitamente prohibidos — `electron/agentGuard.js`,
  denylist de solo lectura (sin IPC de escritura): rutas de sistema/
  credenciales/config del propio agente, extensiones ejecutables para
  open_path, apps administrativas para launch_app. `agentExecuteTool()`
  consulta esto antes de ejecutar; un bloqueo también queda auditado.
  Verificado con 10/10 casos unitarios + el round-trip real de IPC.
- ✅ Modo "deshacer" o backup automático antes de operaciones destructivas
  — `electron/undoManager.js`: `safeDelete()` nunca borra de verdad, manda
  a la Papelera de Windows (`shell.trashItem`, deshacer = Restaurar en la
  Papelera, sin sistema paralelo); `backupBeforeWrite()`/`restoreBackup()`
  guardan copia con timestamp antes de sobrescribir, restaurable por ID
  (tope 100 respaldos). Verificado en vivo: archivo real modificado y
  restaurado byte a byte; archivo real borrado y confirmado recuperable
  en la Papelera vía Shell.Application COM.
- El agente corre con el mismo usuario de Windows que ya tiene la sesión —
  no hay elevación de privilegios adicional

**Nivel 2: implementado.** Tres herramientas nuevas — move_path,
delete_path, run_command (whitelist de solo lectura reutilizada de
`/exec`) — cada una detenida por una tarjeta de confirmación en el chat
antes de ejecutar. Ver detalle completo abajo en "Estado actual".

## Estado actual (lo ya construido en `electron-shell`)

- ✅ Shell independiente de Wallpaper Engine (Electron, kiosko, bandeja del
  sistema, atajo global Ctrl+Shift+N para recuperar foco)
- ✅ Explorador de archivos (lectura/navegación, abrir con app default)
- ✅ Lanzador de apps estilo Spotlight (`Ctrl+Space`)
- ✅ `/exec` seguro (whitelist + sin inyección de shell)
- ✅ Radar de eventos sin fugas de memoria/acumulación
- ✅ **Pilar 1 (casi completo)**: panel de procesos + ventanas + conexiones de
  red (tab PROC) — top CPU, memoria, foco de ventana, terminar proceso con
  confirmación, y qué proceso habla con qué IP:puerto (vía `netstat -ano`,
  no WMI — `Get-NetTCPConnection` resultó estar roto en esta máquina)
- ✅ **Agente IA — Nivel 0** (consulta): responde sobre el estado del
  dashboard vía Claude, con voz (entrada y salida), reacciona visualmente en
  el Neural Core mientras piensa. Cero capacidad de ejecutar nada
- ✅ **Agente IA — Nivel 1** (acciones seguras): tool_use de Claude con dos
  herramientas — `launch_app` (busca coincidencia parcial contra apps
  instaladas y lanza vía `nexusApps.launch()`) y `open_path` (abre
  archivo/carpeta con la app default vía `nexusFS.openPath()`). Round-trip
  multi-turno server↔cliente (el servidor no ejecuta nada él mismo, solo
  decide qué herramienta llamar; el cliente Electron ejecuta y devuelve el
  resultado). Verificado en vivo: apertura real de 7-Zip File Manager
  confirmada por proceso corriendo; falla honesta reportada al pedir
  "calculadora"/"bloc de notas" porque son apps UWP sin acceso directo desde
  el escaneo de accesos directos del launcher (limitación preexistente de
  `appsapi.js`, no del agente)
- ✅ Atajos de teclado sin colisión con juegos ni con composición de acentos
  (Alt+letra para vistas, F2 para voz, Ctrl+Shift+N para refoco)
- ✅ Estabilidad: cache de 2s en sysmon (procesos/ventanas) y de 20s en stats
  lentos (GPU/disco/temp) — eliminó ráfagas de hasta 20 procesos powershell.exe
  concurrentes
- ✅ Fix: discos que desaparecían del panel (contención WMI entre stats
  lentos ejecutados en paralelo — ahora corren secuencial en background)
- ✅ Fix: proyección del mapa — el paquete del mapa usa Robinson, no
  equirectangular; `ll2xy()` reescrito con la tabla de interpolación
  estándar, verificado con 8 puntos de referencia en todo el mapa
- ✅ Fix: pin de HOME duplicado en el mapa — el pin del clima
  (`#mx-weather-group`) y el anillo de radar (`#radar-g`) ya compartían un
  punto fijo hardcodeado (428,442) desde antes del fix de Robinson; se
  había añadido un tercer marcador (diamante `_homeCoords`) que terminó
  desincronizado de los otros dos. Se eliminó el diamante duplicado — el
  radar+clima (el punto que el usuario reconoce como su ubicación real)
  queda como único indicador de "home" en el mapa
- ✅ **Pilar 1 completo**: actividad de archivos reciente — 4ª columna del
  tab PROC, dos fuentes: "abiertos" (carpeta shell Recent de Windows,
  `.lnk` resueltos vía WScript.Shell) y "creados/modificados" (`fs.watch`
  recursivo sobre Desktop/Documents/Downloads/Pictures, buffer en
  memoria). Electron-only, igual que Explorer/Proc/Agent
- ✅ **Pilar 3 (LAN) — mapa de dispositivos**: tab RED (⌥R), universal
  (`server.js`, funciona igual en WE y Electron). Ping sweep + `arp -a`
  + fabricante por MAC OUI + hostname (mDNS .local vía PowerShell) +
  nombres personalizados. Verificado contra la red real: 22 dispositivos
  descubiertos. Ver detalles y decisiones de diseño en el commit
  `feat: mapa de dispositivos LAN`
- ✅ **Radar por WiFi — investigado a fondo, listo para hardware**: se
  probó wifi-densepose en Docker antes de construir nada; sin ESP32 real
  no existe modo "sin hardware" (era una suposición incorrecta del
  roadmap original) — solo simula. `/wifiradar` en `server.js` + banner
  claro en el tab RED cuando no hay hardware; se promueve solo a datos
  reales en cuanto se conecte un ESP32-S3. Ver §3b para el procedimiento
  exacto de activación
- ✅ **Log de auditoría del agente** (primer requisito para Nivel 2):
  `electron/auditlog.js`, JSON Lines en `agent-audit.log` (gitignored) —
  qué herramienta, con qué input, por qué lo decidió Claude (el texto
  que antes se descartaba en silencio), la pregunta original, éxito/
  fallo, resultado. Panel "📋 Historial" en el tab Agent. Verificado en
  vivo: acción real ejecutada y registrada correctamente
- ✅ **Lista de rutas/apps prohibidas del agente** (segundo requisito para
  Nivel 2): `electron/agentGuard.js`, denylist de solo lectura (rutas de
  sistema/credenciales, extensiones ejecutables, apps administrativas).
  `agentExecuteTool()` la consulta antes de ejecutar; un bloqueo también
  queda auditado. El system prompt del agente ahora menciona las
  categorías prohibidas para que decline en texto en vez de intentar y
  chocar con el bloqueo. Verificado: 10/10 casos unitarios + round-trip
  real de IPC con la app corriendo
- ✅ **Modo deshacer del agente** (tercer y último requisito para Nivel 2):
  `electron/undoManager.js` — `safeDelete()` manda a la Papelera de
  Windows en vez de borrar de verdad; `backupBeforeWrite()`/
  `restoreBackup()` respaldan un archivo antes de sobrescribirlo,
  restaurable por ID. Verificado en vivo con archivos reales (backup+
  restauración byte a byte, borrado confirmado recuperable en la
  Papelera vía COM)
- ✅ **Agente IA — Nivel 2** (comandos con confirmación explícita): tres
  herramientas nuevas — `move_path` (usa agentGuard + backupBeforeWrite
  antes de sobrescribir el destino), `delete_path` (usa agentGuard +
  safeDelete, nunca borra de verdad), `run_command` (reutiliza la
  whitelist ya probada de `/exec`/tab TERM — dir, tasklist, ipconfig,
  netstat, ping, whoami, etc., nada destructivo). Cada una se detiene
  en una tarjeta de confirmación (Confirmar/Cancelar) en el chat antes
  de ejecutar — Claude propone, el usuario decide. Hallazgo importante:
  el primer intento falló porque Claude preguntaba "¿confirmas?" en
  texto plano en vez de llamar la herramienta (así la tarjeta real
  nunca aparecía) — el system prompt tuvo que ser explícito: "llama la
  herramienta directo, el sistema maneja la confirmación, tú no
  preguntes". Verificado en vivo, las tres herramientas de punta a
  punta con la app real (archivo movido, archivo enviado a la Papelera,
  comando ejecutado con salida real) y el flujo de cancelación
  (ninguna se ejecuta si el usuario cancela, queda auditado igual)
- ✅ **Agente IA — Nivel 3** (control total autónomo): toggle 🔒/🔓 en el
  tab Agent — activo, move_path/delete_path/run_command se ejecutan sin
  la tarjeta de confirmación de Nivel 2. Deliberadamente NO persistido
  (arranca apagado en cada carga de la app, nunca "prendido solo" entre
  sesiones). Solo se salta la confirmación humana — agentGuard y
  undoManager siguen aplicando exactamente igual (mismo código de
  agentExecuteTool, sin condicional de por medio). El límite de 5 hops
  que ya tenía el loop de agentAsk sirve de tope natural, no hizo falta
  un rate-limit nuevo. Cada acción queda marcada con su modo real
  (nivel1/confirmado/autónomo/cancelado) en el audit log. Verificado en
  vivo: con Nivel 3 activo, un comando corrió de inmediato sin tarjeta
  de confirmación ni clic humano, auditado como mode:"autonomo" con la
  salida real. **Con esto, los cuatro niveles de la escalera de
  confianza del agente están completos.**
- ✅ **Pilar 2 — más fuentes de noticias** (primera de las 3 direcciones
  pedidas): 4 feeds regionales nuevos, verificados a mano antes de
  agregarlos — Buenos Aires Times (Sudamérica, antes solo México
  representaba Latinoamérica), Moscow Times (Rusia/Europa del Este,
  cobertura cero antes — se descartó RT por ser medio estatal del
  Kremlin, poco confiable para OSINT neutral), Channel News Asia
  (sudeste asiático), ABC Australia (Oceanía, cobertura cero antes).
  De paso se encontraron y arreglaron dos bugs reales en el agregador
  (`server.js` `/news`): el armado final tomaba los primeros 20
  titulares en orden de array — con 5+ feeds ya se llenaba el tope
  completo con solo Américas/Europa, así que Asia-Pacífico/Oceanía/
  África nunca aparecían (ya pasaba con los 11 feeds originales, no
  solo con los nuevos) — ahora es round-robin, una vuelta por feed. Y
  el fallback de RSS directo confundía el `<title>` del feed (o de su
  `<image>`) con un artículo real cuando rss2json fallaba — "NYT >
  World News", "BBC Mundo", "Latest News" aparecían como si fueran
  noticias. Ahora extrae títulos solo de dentro de `<item>` reales.
  Verificado en vivo: 20/20 titulares reales tras el fix (antes 6+ de
  20 eran basura), con las 4 regiones nuevas representadas. Universal
  (server.js) — cruzó a `master` también

## Despliegue a Wallpaper Engine (hallazgo importante — leer antes de tocar el mapa/HOME)

`dashboard.html`/`server.js` en este repo (`F:\Descargas\nexus-monitor`)
**no son lo que WE renderiza**. Wallpaper Engine tiene su propia copia
independiente en:

```
E:\Archivos de programa\Steam\steamapps\common\wallpaper_engine\projects\myprojects\nexus_monitor\
```

(`project.json` ahí apunta a `"file": "dashboard.html"` — un archivo
local, no una URL). Confirmar cuál carpeta es la activa vía
`config.json` en la raíz de instalación de WE si hay dudas (hay una
carpeta vieja abandonada, `nexus-monitor` con guion en vez de guion
bajo, sin `project.json` válido — no confundir).

Para que un cambio en `dashboard.html`/`server.js` llegue a WE:
1. `cp` el archivo desde este repo (rama `master`) a la carpeta de WE
2. Cerrar Wallpaper Engine por completo (bandeja → Salir) — reaplicar o
   cambiar de wallpaper y volver **no** fuerza una recarga real
3. Borrar `Cache` y `Code Cache` (NO `Local Storage`/`IndexedDB`, ahí
   vive la config guardada) dentro de cada
   `wallpaper_engine\ui\wpcache\monitor*\base\` — WE mantiene un perfil
   de Chromium completo por monitor que cachea el JS compilado
   indefinidamente, incluso para `file://`
4. Reabrir Wallpaper Engine

## Qué falta

**Pilar 1 (sistema local): completo.**

**Pilar 2 (OSINT global) — en progreso, el usuario pidió las 3 direcciones:**
- ✅ Más fuentes de noticias (primera de las 3) — ver "Estado actual"
- Correlación de eventos (¿el sismo M6 coincide con actividad volcánica
  cercana? ¿el pico de vuelos coincide con algo?)
- Búsqueda/consulta histórica — hoy todo es "últimas 24h en vivo", sin
  memoria (el más grande de los tres, necesita empezar a persistir datos)

**Pilar 3 (red LAN):** mapa de dispositivos completo. Falta:
- Tráfico por dispositivo, puertos abiertos, servicios expuestos
  (cámaras IP, IoT, NAS) — nada de esto empezado
- Radar por WiFi: bloqueado en hardware, no en código — comprar un
  ESP32-S3 (~$8 USD) es el único paso pendiente, ver §3b

**Agente IA: los cuatro niveles de la escalera de confianza están implementados.**

**Resuelto:** `master`/WE ya no se congela ni se mergea completo —
cherry-pick selectivo. Lo universal (backend, fixes de bugs, fórmulas
puras) cruza a master; lo atado a teclado real/APIs de Electron (Agent,
Explorer, Proc, atajos) se queda solo en `electron-shell`. El tab AGENT ya
está gateado (`window.nexusShell`) para no aparecer roto en WE.

## Próximos pasos sugeridos (sin orden fijo — elegir según lo que se quiera)

- **Pilar 2 — correlación de eventos** (2ª de 3, más fuentes ✅ lista)
- **Pilar 2 — búsqueda histórica** (3ª de 3 — la más grande, necesita
  empezar a persistir datos que hoy son solo "últimas 24h en vivo")
- **Pilar 3** — tráfico por dispositivo / puertos / servicios expuestos
- **Radar por WiFi** (§3b) — comprar el ESP32-S3, el código ya está listo

---
*Documento vivo — actualizar conforme se decida qué construir en cada
sesión.*
