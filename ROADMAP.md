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
- ✅ **Pilar 1 (parcial)**: panel de procesos + ventanas (tab PROC) — top CPU,
  memoria, foco de ventana, terminar proceso con confirmación
- ✅ **Agente IA — Nivel 0** (consulta): responde sobre el estado del
  dashboard vía Claude, con voz (entrada y salida), reacciona visualmente en
  el Neural Core mientras piensa. Cero capacidad de ejecutar nada
- ✅ Atajos de teclado sin colisión con juegos ni con composición de acentos
  (Alt+letra para vistas, F2 para voz, Ctrl+Shift+N para refoco)
- ✅ Estabilidad: cache de 2s en sysmon (procesos/ventanas) y de 20s en stats
  lentos (GPU/disco/temp) — eliminó ráfagas de hasta 20 procesos powershell.exe
  concurrentes

## Qué falta

**Pilar 1 (sistema local) — falta:**
- Conexiones de red activas por proceso (qué app habla con qué IP/puerto)
- Actividad de archivos reciente (qué se abrió/modificó/creó)

**Pilar 2 (OSINT global) — sin tocar desde el roadmap original:**
- Más fuentes por categoría, correlación de eventos, búsqueda histórica
  (hoy todo es "últimas 24h en vivo", sin memoria)

**Pilar 3 (red LAN) — sin empezar:**
- Mapa de dispositivos en la red doméstica, tráfico, puertos, servicios
  expuestos (cámaras IP, IoT, NAS)
- Radar por WiFi (wifi-densepose, modo sin hardware) — investigado y
  decidido, plan técnico documentado arriba (§3b), pendiente de implementar

**Agente IA — falta todo lo posterior a Nivel 0:**
- Nivel 1 (acciones seguras: abrir apps/archivos desde el chat)
- Nivel 2 (comandos con confirmación explícita)
- Nivel 3 (control total autónomo dentro de límites configurados)
- Los "requisitos técnicos antes de Nivel 2+" del roadmap (log de auditoría,
  lista de rutas prohibidas, modo deshacer) — ninguno existe todavía

**Sin decidir:** si `master`/WE se sigue manteniendo en paralelo o se
congela como referencia — el shell es el uso principal desde hace varias
sesiones y master no ha recibido nada nuevo desde el merge del bug del
radar.

## Próximos pasos sugeridos (en orden)

1. **Decidir el destino de `master`/WE** antes de seguir acumulando drift
   entre ramas
2. **Conexiones de red por proceso** — cierra el Pilar 1, reutiliza el mismo
   patrón de `sysmon.js` (Win32 o `netstat`/`Get-NetTCPConnection` vía
   PowerShell con cache, aprendiendo del problema de ráfagas que ya se
   resolvió aquí)
3. **Agente Nivel 1** — el salto natural desde Nivel 0: dejar que el agente
   dispare `nexusApps.launch()` / `nexusFS.openPath()`, mismo alcance que ya
   tienen esos módulos vía clic humano, ahora vía lenguaje natural

---
*Documento vivo — actualizar conforme se decida qué construir en cada
sesión.*
