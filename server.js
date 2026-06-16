const express = require('express');
const cors = require('cors');
const si = require('systeminformation');
const app = express();
const PORT = 3000;
app.use(cors());
app.use(express.static(__dirname));

// ── NEXUS LOG BUFFER ──────────────────────────────────────────────────────────
const LOG_BUF = [];
function nxLog(msg, type='info'){
  const ts=new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const entry={ts,msg,type};
  LOG_BUF.push(entry);
  if(LOG_BUF.length>120) LOG_BUF.shift();
  console.log(`[${ts}][${type.toUpperCase()}] ${msg}`);
}

// ── TIMEOUT WRAPPER ───────────────────────────────────────────────────────────
// Prevents any systeminformation call from hanging the entire /stats endpoint.
// If the promise doesn't resolve within `ms` milliseconds it resolves with `fallback`.
function withTimeout(promise, ms, fallback, label='') {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      nxLog(`TIMEOUT (${ms}ms): ${label} — usando valor de respaldo`, 'warn');
      resolve(fallback);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── NETWORK BYTES (native — evita WMI PerfData que puede colgarse) ───────────
// Usa `netstat -e` que es instantáneo y no depende de Win32_PerfRawData_Tcpip_NetworkInterface.
const { execSync } = require('child_process');
let _lastNetBytes = { rx: 0, tx: 0, ts: 0 };
let _prevNetBytes = null;

function getNetworkMbps() {
  try {
    const out = execSync('netstat -e', { timeout: 2000, encoding: 'utf8', windowsHide: true });
    const lines = out.split(/\r?\n/);
    // La línea de Bytes tiene formato: "Bytes   <rx>   <tx>"
    const byteLine = lines.find(l => /Bytes/i.test(l) && /\d{4,}/.test(l));
    if (!byteLine) return { upload: 0, download: 0 };
    const nums = byteLine.match(/\d+/g);
    if (!nums || nums.length < 2) return { upload: 0, download: 0 };
    const rx = parseInt(nums[0]), tx = parseInt(nums[1]);
    const now = Date.now();
    let upload = 0, download = 0;
    if (_prevNetBytes && now - _prevNetBytes.ts < 5000) {
      const dtSec = (now - _prevNetBytes.ts) / 1000;
      download = parseFloat(((rx - _prevNetBytes.rx) / dtSec / 1048576).toFixed(2));
      upload   = parseFloat(((tx - _prevNetBytes.tx) / dtSec / 1048576).toFixed(2));
      if (download < 0) download = 0;
      if (upload   < 0) upload   = 0;
    }
    _prevNetBytes = { rx, tx, ts: now };
    return { upload, download };
  } catch(e) {
    nxLog('netstat -e error: '+e.message, 'warn');
    return { upload: 0, download: 0 };
  }
}

// ── STATS CACHE (evita saturar PowerShell con peticiones frecuentes) ──────────
const STATS_CACHE_TTL = 2000; // ms
let _statsCache = null;
let _statsCacheTs = 0;
let _statsInFlight = null; // deduplicación: una sola promesa en vuelo

app.get('/logs',(req,res)=>res.json({logs:LOG_BUF.slice(-50)}));

nxLog('NEXUS MONITOR backend iniciado en puerto '+PORT,'ok');

// ── DISK HELPER ───────────────────────────────────────────────────────────────
function isRealDisk(d) {
  if (!d || !d.size || d.size < 100*1024*1024) return false;
  const m = String(d.mount || d.fs || '');
  // Windows: C:, D:\, C:\Users, etc.
  if (/^[A-Za-z]:[\\\/]/.test(m) || /^[A-Za-z]:$/.test(m)) return true;
  if (/^[A-Za-z]:/.test(m)) return true;
  // Linux/Mac real partitions
  const type = String(d.type || '');
  if (m.startsWith('/') && !['tmpfs','devtmpfs','9p','squashfs','overlay','proc','sysfs','devpts','cgroup'].includes(type) && String(d.fs||'')!=='none' && !m.includes('/proc') && !m.includes('/sys') && !m.includes('/run/')) return true;
  return false;
}

// ── STATS ─────────────────────────────────────────────────────────────────────
async function fetchStats() {
  const [cpu, mem, gpuData, disk, osInfo, processes] = await Promise.all([
    withTimeout(si.currentLoad(),  5000, {currentLoad:0, cpus:[]},   'currentLoad'),
    withTimeout(si.mem(),          5000, {used:0, total:0},           'mem'),
    withTimeout(si.graphics(),     6000, {controllers:[]},            'graphics'),
    withTimeout(si.fsSize(),       5000, [],                          'fsSize'),
    withTimeout(si.osInfo(),       5000, {hostname:'unknown'},        'osInfo'),
    withTimeout(si.processes(),    6000, {all:0},                     'processes'),
  ]);
  // Red: usa netstat -e nativo (no WMI, instantáneo)
  const net = getNetworkMbps();
  const gpu = gpuData.controllers[0] || {};
  const seen = new Set();
  const rawDisks = disk.filter(isRealDisk);
  nxLog('Discos detectados: '+rawDisks.length+' → '+rawDisks.map(d=>d.mount||d.fs).join(', '),'info');
  const disks = rawDisks.map(d=>{
    const total=d.size, avail=d.available||0;
    const used = d.used>0 ? d.used : Math.max(0, total-avail);
    return { mount:String(d.mount||d.fs||'?').replace(/[\\\/]+$/,''), used:parseFloat((used/1073741824).toFixed(1)), total:parseFloat((total/1073741824).toFixed(0)), percent:Math.round(d.use)||Math.round(used/total*100)||0 };
  }).filter(d=>{ const k=(d.mount.charAt(0)||'?').toUpperCase(); if(seen.has(k))return false; seen.add(k); return true; });
  nxLog('Stats: CPU='+Math.round(cpu.currentLoad)+'% RAM='+parseFloat((mem.used/1073741824).toFixed(1))+'GB disks='+disks.length,'info');
  return {
    cpu:{load:Math.round(cpu.currentLoad),cores:(cpu.cpus||[]).map(c=>Math.round(c.load))},
    mem:{used:parseFloat((mem.used/1073741824).toFixed(1)),total:parseFloat((mem.total/1073741824).toFixed(1)),percent:Math.round(mem.used/mem.total*100)},
    gpu:{load:gpu.utilizationGpu||0,temp:gpu.temperatureGpu||0},
    disks,
    net,
    os:{hostname:osInfo.hostname},
    processes:processes.all,
    uptime:Math.floor(si.time().uptime||0)
  };
}

app.get('/stats', async (req, res) => {
  try {
    const now = Date.now();
    // Sirve caché si tiene menos de STATS_CACHE_TTL ms
    if (_statsCache && now - _statsCacheTs < STATS_CACHE_TTL) {
      return res.json(_statsCache);
    }
    // Deduplica: si ya hay una consulta en vuelo, espera la misma promesa
    if (!_statsInFlight) {
      _statsInFlight = fetchStats().then(data => {
        _statsCache = data;
        _statsCacheTs = Date.now();
        _statsInFlight = null;
        return data;
      }).catch(e => {
        _statsInFlight = null;
        throw e;
      });
    }
    const data = await _statsInFlight;
    res.json(data);
  } catch(e){nxLog('ERROR stats: '+e.message,'error');res.status(500).json({error:e.message});}
});

app.get('/network', async (req,res)=>{
  try{
    const[ifaces,ping]=await Promise.all([si.networkInterfaces(),si.inetLatency()]);
    const main=ifaces.find(i=>!i.internal&&i.ip4)||ifaces[0]||{};
    nxLog('Network: IP='+main.ip4+' ping='+Math.round(ping)+'ms','info');
    res.json({ip:main.ip4||'127.0.0.1',ping:Math.round(ping)||0});
  }catch(e){nxLog('ERROR network: '+e.message,'error');res.status(500).json({error:e.message});}
});

app.get('/weather', async (req,res)=>{
  try{
    nxLog('Fetching weather CDMX...','info');
    const r=await fetch('https://wttr.in/Mexico_City?format=j1',{signal:AbortSignal.timeout(8000), headers: {'User-Agent': 'curl/7.88.1'}});
    const d=await r.json();
    const cur=d.current_condition[0],today=d.weather[0];
    nxLog('Weather OK: '+cur.temp_C+'°C '+cur.weatherDesc[0].value,'ok');
    res.json({temp:parseInt(cur.temp_C),desc:cur.weatherDesc[0].value,humidity:parseInt(cur.humidity),wind:parseInt(cur.windspeedKmph),uv:parseInt(cur.uvIndex),high:parseInt(today.maxtempC),low:parseInt(today.mintempC)});
  }catch(e){nxLog('ERROR weather: '+e.message,'error');res.status(500).json({error:e.message});}
});

app.get('/crypto', async (req,res)=>{
  try{
    nxLog('Fetching crypto prices...','info');
    const[r1,r2]=await Promise.allSettled([
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true',{signal:AbortSignal.timeout(8000)}),
      fetch('https://api.frankfurter.app/latest?from=USD&to=MXN',{signal:AbortSignal.timeout(6000)})
    ]);
    const c=r1.status==='fulfilled'?await r1.value.json():{};
    let usdmxn=null;
    if(r2.status==='fulfilled'){try{const fx=await r2.value.json();usdmxn=parseFloat((fx.rates?.MXN||0).toFixed(2));}catch(_){}}
    nxLog('Crypto OK: BTC=$'+Math.round(c.bitcoin?.usd||0)+' USD/MXN='+usdmxn,'ok');
    res.json({btc:{price:Math.round(c.bitcoin?.usd||0),change:parseFloat((c.bitcoin?.usd_24h_change||0).toFixed(2))},eth:{price:Math.round(c.ethereum?.usd||0),change:parseFloat((c.ethereum?.usd_24h_change||0).toFixed(2))},sol:{price:Math.round(c.solana?.usd||0),change:parseFloat((c.solana?.usd_24h_change||0).toFixed(2))},usdmxn});
  }catch(e){nxLog('ERROR crypto: '+e.message,'error');res.status(500).json({error:e.message});}
});

app.get('/news', async (req,res)=>{
  nxLog('Fetching news feeds...','info');
  const FEEDS=[
    {url:'https://www.eluniversal.com.mx/rss.xml',name:'El Universal'},
    {url:'https://www.proceso.com.mx/?feed=rss2',name:'Proceso'},
    {url:'https://feeds.bbci.co.uk/mundo/rss.xml',name:'BBC Mundo'},
    {url:'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',name:'NYT World'},
    {url:'https://feeds.bbci.co.uk/news/world/rss.xml',name:'BBC World'},
    {url:'https://www.24horas.mx/feed/',name:'24 Horas MX'},
  ];
  const items=[], seen=new Set();
  for(const feed of FEEDS){
    if(items.length>=12) break;
    // Try rss2json
    try{
      const url='https://api.rss2json.com/v1/api.json?rss_url='+encodeURIComponent(feed.url)+'&count=6';
      const r=await fetch(url,{signal:AbortSignal.timeout(5000)});
      if(!r.ok) throw new Error('HTTP '+r.status);
      const j=await r.json();
      if(j.status==='ok'&&j.items?.length){
        const before=items.length;
        for(const it of j.items){const t=(it.title||'').trim().replace(/&amp;/g,'&').replace(/&lt;/g,'<');if(t.length>8&&!seen.has(t)){seen.add(t);items.push(t);}}
        nxLog(feed.name+': +'+( items.length-before)+' items (rss2json)','ok');
        continue;
      }
    }catch(e){ nxLog(feed.name+' rss2json fail: '+e.message,'warn'); }
    // Direct RSS fallback
    try{
      const r=await fetch(feed.url,{signal:AbortSignal.timeout(5000),headers:{'User-Agent':'Mozilla/5.0'}});
      if(!r.ok) throw new Error('HTTP '+r.status);
      const xml=await r.text();
      const m=[...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)];
      const before=items.length;
      m.slice(1,8).forEach(x=>{const t=x[1].replace(/<[^>]+>/g,'').trim().replace(/&amp;/g,'&');if(t.length>8&&!seen.has(t)){seen.add(t);items.push(t);}});
      nxLog(feed.name+': +'+(items.length-before)+' items (direct)','ok');
    }catch(e){ nxLog(feed.name+' direct fail: '+e.message,'warn'); }
  }
  nxLog('News total: '+items.length+' items','ok');
  res.json({items:items.length?items:['Sin noticias disponibles por ahora']});
});

// ── FIRE LAND-FILTER ─────────────────────────────────────────────────────────
// NASA FIRMS / VIIRS satellites detect ALL surface heat sources, including:
//   • Offshore oil platform gas flares (very common false positives)
//   • Ship engine exhausts on the ocean
// We filter out known offshore gas-flare zones and low-confidence detections.
//
// OCEAN EXCLUSION ZONES: [latMin, latMax, lonMin, lonMax]
const OCEAN_FIRE_ZONES = [
  [56, 62,  -3,   8],  // North Sea oil platforms (UK/Norway/Netherlands)
  [25, 30, -96, -84],  // Gulf of Mexico deep-water oil fields
  [-2,  6,   3,  12],  // Gulf of Guinea offshore (Nigeria/Angola gas flares)
  [25, 27,  50,  57],  // Persian Gulf offshore oil platforms
  [39, 43,  50,  53],  // Caspian Sea offshore
  [-6,  2,  95, 115],  // South-East Asian straits / Java Sea offshore
];

function isValidLandFire(f) {
  const lat = parseFloat(f.lat), lon = parseFloat(f.lng || f.lon);
  if (isNaN(lat) || isNaN(lon)) return false;
  // Drop low-confidence satellite detections (MODIS: 'low'; VIIRS: 'l')
  const conf = String(f.confidence || '').toLowerCase();
  if (conf === 'l' || conf === 'low') return false;
  // Drop points inside known offshore gas-flare / oil-platform zones
  for (const [la, lb, lo, lp] of OCEAN_FIRE_ZONES) {
    if (lat >= la && lat <= lb && lon >= lo && lon <= lp) return false;
  }
  return true;
}

app.get('/events', async (req,res)=>{
  const events=[];
  
  // 1. Earthquakes (Osiris or USGS fallback)
  try {
    nxLog('Fetching Osiris earthquakes...', 'info');
    const r = await fetch('https://osirisai.live/api/earthquakes', { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    const list = d.earthquakes || d || [];
    list.slice(0, 25).forEach(e => {
      events.push({
        type: 'quake',
        lat: parseFloat(e.lat),
        lon: parseFloat(e.lng || e.lon),
        label: `M${parseFloat(e.magnitude).toFixed(1)}`,
        mag: parseFloat(e.magnitude),
        place: e.place,
        info: `Depth: ${e.depth}km | Place: ${e.place}`
      });
    });
    nxLog('Osiris Earthquakes: ' + list.length + ' fetched', 'ok');
  } catch (e) {
    nxLog('ERROR Osiris earthquakes: ' + e.message + ', trying USGS fallback...', 'warn');
    try {
      const r = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson', { signal: AbortSignal.timeout(6000) });
      const d = await r.json();
      (d.features || []).slice(0, 20).forEach(f => {
        events.push({
          type: 'quake',
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
          label: 'M' + f.properties.mag.toFixed(1),
          mag: f.properties.mag,
          place: f.properties.place,
          info: `Depth: ${f.geometry.coordinates[2]}km | Place: ${f.properties.place}`
        });
      });
      nxLog('USGS Fallback: ' + (d.features || []).length + ' sismos', 'ok');
    } catch(err) {
      nxLog('ERROR USGS fallback: ' + err.message, 'error');
    }
  }

  // 2. Satellites (Osiris or ISS fallback)
  try {
    nxLog('Fetching Osiris satellites...', 'info');
    const r = await fetch('https://osirisai.live/api/satellites', { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    const list = d.satellites || [];
    list.slice(0, 15).forEach(sat => {
      events.push({
        type: sat.name.toLowerCase() === 'iss' ? 'iss' : 'satellite',
        lat: parseFloat(sat.lat),
        lon: parseFloat(sat.lng),
        label: sat.name,
        info: `Alt: ${sat.alt}km | Mission: ${sat.mission}`
      });
    });
    nxLog('Osiris Satellites: ' + list.length + ' fetched', 'ok');
  } catch (e) {
    nxLog('ERROR Osiris satellites: ' + e.message + ', trying ISS fallback...', 'warn');
    try {
      const r = await fetch('http://api.open-notify.org/iss-now.json', { signal: AbortSignal.timeout(5000) });
      const d = await r.json();
      if (d.iss_position) {
        events.push({
          type: 'iss',
          lat: parseFloat(d.iss_position.latitude),
          lon: parseFloat(d.iss_position.longitude),
          label: 'ISS',
          info: 'International Space Station'
        });
        nxLog('ISS Fallback OK: lat=' + d.iss_position.latitude + ' lon=' + d.iss_position.longitude, 'ok');
      }
    } catch(err) {
      nxLog('ERROR ISS fallback: ' + err.message, 'error');
    }
  }

  // 3. Wildfires (Osiris)
  try {
    nxLog('Fetching Osiris fires...', 'info');
    const r = await fetch('https://osirisai.live/api/fires', { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    const list = d.fires || [];
    const filtered = list.filter(isValidLandFire);
    const sorted = filtered.slice().sort((a, b) => (b.frp || 0) - (a.frp || 0));
    sorted.slice(0, 25).forEach(f => {
      events.push({
        type: 'fire',
        lat: parseFloat(f.lat),
        lon: parseFloat(f.lng || f.lon),
        label: 'FIRE',
        info: `Brightness: ${f.brightness || 'N/A'}K | FRP: ${f.frp || 'N/A'}MW | Conf: ${f.confidence || 'nominal'}`
      });
    });
    nxLog('Osiris Fires: ' + list.length + ' fetched', 'ok');
  } catch (e) {
    nxLog('ERROR Osiris fires: ' + e.message, 'error');
  }

  // 5. Geolocated News (Osiris)
  try {
    nxLog('Fetching Osiris news...', 'info');
    const r = await fetch('https://osirisai.live/api/news', { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    const list = d.news || d || [];
    const geolocated = list.filter(item => item.coords && item.coords.length === 2 && !item.coords_default);
    geolocated.slice(0, 20).forEach(item => {
      events.push({
        type: 'news',
        lat: parseFloat(item.coords[0]),
        lon: parseFloat(item.coords[1]),
        label: 'NEWS',
        title: item.title,
        source: item.source,
        link: item.link,
        info: `${item.title} (${item.source})`
      });
    });
    nxLog('Osiris Geolocated News: ' + geolocated.length + ' fetched', 'ok');
  } catch (e) {
    nxLog('ERROR Osiris news: ' + e.message, 'error');
  }

  res.json({events,ts:Date.now()});
});

app.get('/debug/disks', async (req,res)=>{
  try{const d=await si.fsSize();res.json({all:d,filtered:d.filter(isRealDisk)});}catch(e){res.status(500).json({error:e.message});}
});

app.get('/health',(req,res)=>{nxLog('Health check OK','ok');res.json({ok:true});});

app.listen(PORT,()=>{
  nxLog('Servidor escuchando en http://localhost:'+PORT,'ok');
  console.log('\n  ┌─────────────────────────────────┐');
  console.log('  │   NEXUS MONITOR BACKEND v2.1    │');
  console.log('  │   http://localhost:'+PORT+'           │');
  console.log('  └─────────────────────────────────┘\n');
});
