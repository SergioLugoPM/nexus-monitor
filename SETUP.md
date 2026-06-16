# NEXUS MONITOR — Setup Guide

## OPCIÓN 1: Inicio automático (recomendado)

1. Copia START_SILENT.vbs a tu carpeta Startup de Windows:
   Presiona Win+R, escribe: shell:startup
   Copia el archivo ahí.

2. El servidor arrancará solo cada vez que inicies Windows.
   Sin ventana, sin nada visible.

## OPCIÓN 2: Wallpaper Engine

1. Abre Wallpaper Engine
2. Botón "Crear wallpaper" → "Wallpaper web"  
3. Selecciona dashboard.html de esta carpeta
4. Activa "Permitir scripts"
5. Resolución: la de tu monitor (ej: 1920x1080)
6. Guarda y aplica

Para que el dashboard funcione como wallpaper, el servidor DEBE estar corriendo.
Con el VBS en Startup, esto es automático.

## OPCIÓN 3: Compilar a .exe (avanzado)

Desde PowerShell en esta carpeta:
  npm install -g pkg
  pkg server.js --targets node18-win-x64 --output nexus-server.exe

Luego pon nexus-server.exe en Startup en lugar del VBS.

## Verificar que funciona

Abre Chrome y ve a: http://localhost:3000/health
Debe responder: {"ok":true}
