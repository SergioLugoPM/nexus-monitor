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
  sistema)
- ✅ Explorador de archivos (lectura/navegación, abrir con app default)
- ✅ Lanzador de apps estilo Spotlight (`Ctrl+Space`)
- ✅ `/exec` seguro (whitelist + sin inyección de shell)
- ✅ Radar de eventos sin fugas de memoria/acumulación

## Próximos pasos sugeridos (en orden)

1. **Panel de procesos + ventanas** (Pilar 1, la pieza que falta más
   básica) — nuevo tab junto a EXPLORER, usando `systeminformation.processes()`
   y enumeración de ventanas vía Win32
2. **Nivel 0 del agente** (solo consulta) — conectar un LLM al estado actual
   del dashboard (eventos, stats, contactos del radar) sin ninguna capacidad
   de ejecutar nada; valida la integración antes de dar cualquier permiso
3. A partir de ahí, decidir con datos reales de uso si vale la pena subir de
   nivel

---
*Documento vivo — actualizar conforme se decida qué construir en cada
sesión.*
