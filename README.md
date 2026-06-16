# NEXUS MONITOR

Dashboard de sistema con datos reales de tu PC, clima, crypto y noticias mundiales.

---

## REQUISITOS

- Node.js instalado → https://nodejs.org
- Wallpaper Engine (Steam) → para usarlo como fondo de pantalla

---

## INSTALACIÓN

1. Abre una terminal en esta carpeta
2. Corre: `npm install`
3. Eso es todo.

---

## USO

### Iniciar el backend
Doble click en `START.bat` — o desde terminal:
```
node server.js
```
Mantén esa ventana corriendo **siempre que quieras ver el dashboard**.

### Ver en browser (para probar)
Con el backend corriendo, abre `dashboard.html` directamente en Chrome/Edge.

### Como fondo de pantalla (Wallpaper Engine)
1. Abre Wallpaper Engine
2. Clic en "Crear wallpaper" → "Wallpaper web"
3. Selecciona el archivo `dashboard.html`
4. Resolución: la de tu monitor
5. Activa: "Permitir scripts"
6. Guarda y aplica

---

## CONFIGURACIÓN

### Ciudad del clima
En `server.js`, línea ~41, cambia:
```js
const city = req.query.city || 'Ecatepec,Mexico';
```

### Añadir más cryptos
El endpoint `/crypto` usa CoinGecko. Agrega IDs en la URL:
```
ids=bitcoin,ethereum,solana,cardano
```
Y añade la lógica correspondiente en el frontend.

### Intervalo de actualización
En `dashboard.html`, al final del script:
```js
setInterval(fetchStats,   3000);   // PC stats cada 3 seg
setInterval(fetchWeather, 300000); // Clima cada 5 min
setInterval(fetchCrypto,  30000);  // Crypto cada 30 seg
setInterval(fetchNews,    120000); // Noticias cada 2 min
```

---

## PALETAS

Clic en los círculos del header para cambiar entre:
- Verde Matrix
- Azul Deep Space  
- Amber Retro Terminal
- Purple Synthwave
- Rojo Threat Monitor

---

## NOTAS

- El backend debe estar corriendo para que los stats de PC funcionen
- Clima y crypto no requieren API keys
- Noticias vienen de BBC World RSS
- GPU load/temp solo funciona si tu driver lo expone (NVIDIA/AMD con drivers actualizados)
