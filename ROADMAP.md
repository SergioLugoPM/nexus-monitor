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

### 3. Red local (LAN)
Mapa de tu propia red doméstica: qué dispositivos están conectados, tráfico
por dispositivo, puertos abiertos, servicios expuestos (cámaras IP, IoT,
NAS). Esto es reconocimiento de red pasivo sobre tu propia infraestructura —
mismo principio que el resto del dashboard (visibilidad, no intrusión).

#### 3b. Radar por WiFi (CSI sensing) — decidido, pendiente de implementar

Investigado y decidido: integrar **[wifi-densepose](https://github.com/yangsuzhou/wifi-densepose)**
para presencia/movimiento a través de paredes usando señales WiFi, sin
cámara. Comparado contra `ESPectre` (GPLv3, atado a Home Assistant) y
`esp-csi` de Espressif (solo el toolkit crudo, habría que construir la
detección desde cero) — wifi-densepose ganó por licencia MIT y por exponer
una API REST + WebSocket en JSON, el mismo patrón que ya usa `server.js`
para vuelos/sismos/satélites.

**Modo elegido: sin hardware nuevo.** Con WiFi normal (RSSI, sin hardware
CSI dedicado) da presencia/movimiento "grueso" — detecta que hay alguien y
se mueve, no pose completa. Suficiente para prototipar el panel sin comprar
nada. La ruta con hardware (malla de 3-6 ESP32-S3, ~$8-54) que da pose
completa (17 keypoints), respiración y ritmo cardíaco queda para más
adelante si el modo RSSI resulta útil.

**Cuando se retome, el plan técnico es:**
1. Levantar wifi-densepose por separado (Docker: `docker pull
   ruvnet/wifi-densepose:latest`, expone REST en :3000 y WebSocket en :3001)
2. En `server.js`, agregar un endpoint tipo `/wifiradar` que haga proxy/cache
   de `GET http://localhost:3000/api/v1/sensing/latest` — mismo patrón de
   cache con TTL que ya usan `/events`, `/flights`, etc.
3. En `dashboard.html`, nuevo panel o modo del radar existente (`NEXUS
   RADAR`) que dibuje las detecciones de presencia — reutiliza el canvas de
   radar que ya existe en vez de construir uno nuevo
4. Encaja en Pilar 3 (red LAN) porque literalmente usa la infraestructura
   WiFi de la casa como sensor, sin hardware de vigilancia dedicado

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
- Log de auditoría de cada acción que el agente ejecuta (qué, cuándo, por
  qué lo decidió)
- Lista de rutas/comandos explícitamente prohibidos, no solo permitidos
- Modo "deshacer" o backup automático antes de operaciones destructivas
  donde sea posible
- El agente corre con el mismo usuario de Windows que ya tiene la sesión —
  no hay elevación de privilegios adicional

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

**Pilar 2 (OSINT global) — sin tocar desde el roadmap original:**
- Más fuentes por categoría, correlación de eventos, búsqueda histórica
  (hoy todo es "últimas 24h en vivo", sin memoria)

**Pilar 3 (red LAN) — sin empezar:**
- Mapa de dispositivos en la red doméstica, tráfico, puertos, servicios
  expuestos (cámaras IP, IoT, NAS)
- Radar por WiFi (wifi-densepose, modo sin hardware) — investigado y
  decidido, plan técnico documentado arriba (§3b), pendiente de implementar

**Agente IA — falta:**
- Nivel 2 (comandos con confirmación explícita)
- Nivel 3 (control total autónomo dentro de límites configurados)
- Los "requisitos técnicos antes de Nivel 2+" del roadmap (log de auditoría,
  lista de rutas prohibidas, modo deshacer) — ninguno existe todavía

**Resuelto:** `master`/WE ya no se congela ni se mergea completo —
cherry-pick selectivo. Lo universal (backend, fixes de bugs, fórmulas
puras) cruza a master; lo atado a teclado real/APIs de Electron (Agent,
Explorer, Proc, atajos) se queda solo en `electron-shell`. El tab AGENT ya
está gateado (`window.nexusShell`) para no aparecer roto en WE.

## Próximos pasos sugeridos (sin orden fijo — elegir según lo que se quiera)

- **Radar por WiFi** (§3b) — ya investigado y decidido, plan técnico listo
- **Requisitos del Agente Nivel 2** — log de auditoría + lista de rutas
  prohibidas, antes de dar cualquier capacidad de ejecutar comandos

---
*Documento vivo — actualizar conforme se decida qué construir en cada
sesión.*
