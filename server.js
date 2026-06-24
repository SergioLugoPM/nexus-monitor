const express = require('express');
const cors = require('cors');
const si = require('systeminformation');
const satLib = require('satellite.js');
const app = express();
const PORT = process.env.NEXUS_PORT || 3000;

// Allow browser testing (http://localhost) and Wallpaper Engine (file://, origin=null)
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin === 'null' || /^http:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
    cb(new Error('CORS blocked: ' + origin));
  }
}));
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

// Response caches
let _weatherCache = null, _weatherTs = 0;
let _cryptoCache  = null, _cryptoTs  = 0;
let _eventsCache  = null, _eventsTs  = 0;
let _newsCache    = null, _newsTs    = 0;
const TTL_WEATHER = 5  * 60 * 1000;  // 5 min
const TTL_CRYPTO  = 30 * 1000;        // 30 s
const TTL_EVENTS  = 2  * 60 * 1000;  // 2 min
const TTL_NEWS    = 10 * 60 * 1000;  // 10 min

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
  const [cpu, mem, gpuData, disk, osInfo, processes, tempData] = await Promise.all([
    withTimeout(si.currentLoad(),  5000, {currentLoad:0, cpus:[]},   'currentLoad'),
    withTimeout(si.mem(),          5000, {used:0, total:0},           'mem'),
    withTimeout(si.graphics(),     6000, {controllers:[]},            'graphics'),
    withTimeout(si.fsSize(),       5000, [],                          'fsSize'),
    withTimeout(si.osInfo(),       5000, {hostname:'unknown'},        'osInfo'),
    withTimeout(si.processes(),    6000, {all:0},                     'processes'),
    withTimeout(si.cpuTemperature(), 4000, {main: null}, 'cpuTemp'),
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
    cpu:{load:Math.round(cpu.currentLoad),cores:(cpu.cpus||[]).map(c=>Math.round(c.load)),temp:tempData?.main?Math.round(tempData.main):null},
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

const WEATHER_CITY = process.env.NEXUS_CITY || 'Mexico_City';

app.get('/weather', async (req,res)=>{
  try{
    const city = req.query.city || WEATHER_CITY;
    const now = Date.now();
    if (!req.query.city && _weatherCache && now - _weatherTs < TTL_WEATHER) return res.json(_weatherCache);
    nxLog('Fetching weather: '+city,'info');
    const r=await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`,{signal:AbortSignal.timeout(8000), headers: {'User-Agent': 'curl/7.88.1'}});
    const d=await r.json();
    const cur=d.current_condition[0],today=d.weather[0];
    nxLog('Weather OK: '+cur.temp_C+'°C '+cur.weatherDesc[0].value,'ok');
    const result = {temp:parseInt(cur.temp_C),desc:cur.weatherDesc[0].value,humidity:parseInt(cur.humidity),wind:parseInt(cur.windspeedKmph),uv:parseInt(cur.uvIndex),high:parseInt(today.maxtempC),low:parseInt(today.mintempC)};
    if (!req.query.city) { _weatherCache = result; _weatherTs = Date.now(); }
    res.json(result);
  }catch(e){nxLog('ERROR weather: '+e.message,'error');res.status(500).json({error:e.message});}
});

app.get('/crypto', async (req,res)=>{
  try{
    const now = Date.now();
    if (_cryptoCache && now - _cryptoTs < TTL_CRYPTO) return res.json(_cryptoCache);
    nxLog('Fetching crypto prices...','info');
    const[r1,r2]=await Promise.allSettled([
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true',{signal:AbortSignal.timeout(8000)}),
      fetch('https://api.frankfurter.app/latest?from=USD&to=MXN',{signal:AbortSignal.timeout(6000)})
    ]);
    const c=r1.status==='fulfilled'?await r1.value.json():{};
    let usdmxn=null;
    if(r2.status==='fulfilled'){try{const fx=await r2.value.json();usdmxn=parseFloat((fx.rates?.MXN||0).toFixed(2));}catch(_){}}
    nxLog('Crypto OK: BTC=$'+Math.round(c.bitcoin?.usd||0)+' USD/MXN='+usdmxn,'ok');
    const result = {btc:{price:Math.round(c.bitcoin?.usd||0),change:parseFloat((c.bitcoin?.usd_24h_change||0).toFixed(2))},eth:{price:Math.round(c.ethereum?.usd||0),change:parseFloat((c.ethereum?.usd_24h_change||0).toFixed(2))},sol:{price:Math.round(c.solana?.usd||0),change:parseFloat((c.solana?.usd_24h_change||0).toFixed(2))},usdmxn};
    _cryptoCache = result; _cryptoTs = Date.now();
    res.json(result);
  }catch(e){nxLog('ERROR crypto: '+e.message,'error');res.status(500).json({error:e.message});}
});

// ── GEO LOOKUP — country/city name → coordinates ─────────────────────────────
// Sorted longest-first so "New York" matches before "York", "South Korea" before "Korea".
const GEO_TABLE = [
  // High-frequency news regions / conflict zones
  ['West Bank',31.95,35.29],['Gaza Strip',31.42,34.35],['Gaza',31.50,34.47],
  ['Donbas',48.10,37.80],['Crimea',45.35,34.10],['Kashmir',34.08,74.80],
  ['Sahel',15.0,5.0],['Horn of Africa',8.0,48.0],['South China Sea',15.0,115.0],
  ['Taiwan Strait',24.5,119.0],['Korean Peninsula',37.5,127.5],
  ['Nagorno-Karabakh',39.82,46.76],['Xinjiang',41.18,85.63],
  ['Hong Kong',22.32,114.17],['Taiwan',23.69,120.96],
  // Americas
  ['United States',37.09,-95.71],['Canada',56.13,-106.35],['Mexico',23.63,-102.55],
  ['Brazil',-14.24,-51.93],['Argentina',-38.42,-63.62],['Colombia',4.57,-74.30],
  ['Venezuela',6.42,-66.59],['Chile',-35.68,-71.54],['Peru',-9.19,-75.01],
  ['Ecuador',-1.83,-78.18],['Bolivia',-16.29,-63.59],['Paraguay',-23.44,-58.44],
  ['Uruguay',-32.52,-55.77],['Cuba',21.52,-77.78],['Haiti',18.97,-72.29],
  ['Dominican Republic',18.74,-70.16],['Puerto Rico',18.22,-66.59],
  ['Guatemala',15.78,-90.23],['Honduras',15.20,-86.24],['El Salvador',13.79,-88.90],
  ['Nicaragua',12.87,-85.21],['Costa Rica',9.75,-83.75],['Panama',8.54,-80.78],
  ['Washington',38.89,-77.03],['New York',40.71,-74.01],['Los Angeles',34.05,-118.24],
  ['Chicago',41.88,-87.63],['Miami',25.77,-80.19],['Houston',29.76,-95.37],
  ['Toronto',43.65,-79.38],['São Paulo',-23.55,-46.63],['Buenos Aires',-34.60,-58.38],
  ['Bogotá',4.71,-74.07],['Lima',-12.05,-77.04],['Santiago',-33.45,-70.67],
  ['Caracas',10.48,-66.88],['Havana',23.14,-82.36],['Port-au-Prince',18.54,-72.34],
  // Europe
  ['Russia',61.52,105.32],['Ukraine',48.37,31.17],['Germany',51.17,10.45],
  ['France',46.23,2.21],['United Kingdom',55.38,-3.44],['Italy',41.87,12.57],
  ['Spain',40.46,-3.75],['Poland',51.92,19.15],['Netherlands',52.13,5.29],
  ['Belgium',50.50,4.47],['Sweden',60.13,18.64],['Norway',60.47,8.47],
  ['Finland',61.92,25.75],['Denmark',56.26,9.50],['Switzerland',46.82,8.23],
  ['Austria',47.52,14.55],['Czechia',49.82,15.47],['Slovakia',48.67,19.70],
  ['Hungary',47.16,19.50],['Romania',45.94,24.97],['Bulgaria',42.73,25.49],
  ['Serbia',44.02,21.01],['Croatia',45.10,15.20],['Greece',39.07,21.82],
  ['Portugal',39.40,-8.22],['Ireland',53.41,-8.24],['Belarus',53.71,27.95],
  ['Moldova',47.41,28.37],['Georgia',42.32,43.36],['Armenia',40.07,45.04],
  ['Azerbaijan',40.14,47.58],['Kosovo',42.60,20.90],['Bosnia',44.00,17.50],
  ['Albania',41.15,20.17],['North Macedonia',41.61,21.75],['Montenegro',42.71,19.37],
  ['Estonia',58.60,25.01],['Latvia',56.88,24.60],['Lithuania',55.17,23.88],
  ['Luxembourg',49.82,6.13],['Malta',35.94,14.37],['Cyprus',35.13,33.43],
  ['Iceland',64.96,-19.02],['Slovenia',46.15,15.00],
  ['Moscow',55.75,37.62],['Kyiv',50.45,30.52],['Kharkiv',49.99,36.23],
  ['Mariupol',47.10,37.54],['Odesa',46.48,30.73],['London',51.51,-0.13],
  ['Paris',48.85,2.35],['Berlin',52.52,13.41],['Rome',41.90,12.50],
  ['Madrid',40.42,-3.70],['Warsaw',52.23,21.01],['Kyiv',50.45,30.52],
  ['Athens',37.98,23.73],['Bucharest',44.43,26.10],['Belgrade',44.79,20.46],
  // Middle East
  ['Israel',31.05,34.85],['Palestine',31.95,35.29],['Lebanon',33.85,35.86],
  ['Syria',34.80,38.99],['Iraq',33.22,43.68],['Iran',32.43,53.69],
  ['Saudi Arabia',23.89,45.08],['Yemen',15.55,48.52],['Oman',21.51,55.92],
  ['Qatar',25.35,51.18],['Kuwait',29.31,47.48],['Bahrain',25.93,50.64],
  ['Jordan',30.59,36.24],['Turkey',38.96,35.24],['Egypt',26.82,30.80],
  ['UAE',23.42,53.85],['Afghanistan',33.93,67.71],
  ['Tehran',35.69,51.39],['Baghdad',33.34,44.40],['Damascus',33.51,36.29],
  ['Beirut',33.89,35.50],['Riyadh',24.69,46.72],['Jerusalem',31.77,35.22],
  ['Tel Aviv',32.08,34.78],['Istanbul',41.01,28.95],['Ankara',39.93,32.85],
  ['Kabul',34.53,69.17],['Sanaa',15.35,44.21],
  // Africa
  ['Nigeria',9.08,8.68],['Ethiopia',9.14,40.49],['Egypt',26.82,30.80],
  ['South Africa',-30.56,22.94],['Kenya',-1.29,36.82],['Tanzania',-6.37,34.89],
  ['Sudan',15.55,32.53],['South Sudan',7.86,29.69],['Somalia',5.15,46.20],
  ['Morocco',31.79,-7.09],['Algeria',28.03,1.66],['Tunisia',33.89,9.54],
  ['Libya',26.34,17.23],['Ghana',7.95,-1.02],['Senegal',14.50,-14.45],
  ['Mali',17.57,-3.99],['Niger',17.61,8.08],['Burkina Faso',12.36,-1.56],
  ['Chad',15.45,18.73],['Cameroon',3.85,11.50],['Congo',4.04,21.76],
  ['DRC',-4.04,21.76],['Angola',-11.20,17.87],['Mozambique',-18.67,35.53],
  ['Zimbabwe',-19.02,29.15],['Zambia',-13.13,27.85],['Uganda',1.37,32.29],
  ['Rwanda',-1.94,29.87],['Madagascar',-18.77,46.87],['Ivory Coast',7.54,-5.55],
  ['Cape Verde',14.93,-23.51],['Sahara',23.0,-13.0],
  ['Lagos',6.46,3.39],['Nairobi',-1.29,36.82],['Cairo',30.04,31.24],
  ['Khartoum',15.55,32.53],['Addis Ababa',9.02,38.75],['Mogadishu',2.05,45.34],
  ['Johannesburg',-26.20,28.04],['Tripoli',32.90,13.18],['Tunis',36.82,10.18],
  ['Kinshasa',-4.32,15.32],['Luanda',-8.84,13.23],['Bamako',12.65,-8.00],
  ['Ouagadougou',12.37,-1.52],['N\'Djamena',12.11,15.04],
  // Asia
  ['China',35.86,104.20],['India',20.59,78.96],['Japan',36.20,138.25],
  ['South Korea',35.91,127.77],['North Korea',40.34,127.51],
  ['Pakistan',30.38,69.35],['Bangladesh',23.68,90.36],['Sri Lanka',7.87,80.77],
  ['Myanmar',21.91,95.96],['Thailand',15.87,100.99],['Vietnam',14.06,108.28],
  ['Indonesia',-0.79,113.92],['Philippines',12.88,121.77],['Malaysia',4.21,108.00],
  ['Singapore',1.35,103.82],['Cambodia',12.57,104.99],['Laos',19.86,102.50],
  ['Mongolia',46.86,103.85],['Nepal',28.39,84.12],['Bhutan',27.51,90.43],
  ['Maldives',3.20,73.22],['Papua New Guinea',-6.31,143.96],
  ['Uzbekistan',41.38,64.59],['Kazakhstan',48.02,66.92],['Kyrgyzstan',41.20,74.76],
  ['Tajikistan',38.86,71.28],['Turkmenistan',38.97,59.56],
  ['Beijing',39.91,116.39],['Shanghai',31.22,121.46],['Taipei',25.03,121.57],
  ['Tokyo',35.68,139.69],['Seoul',37.57,126.98],['Pyongyang',39.03,125.75],
  ['New Delhi',28.61,77.21],['Mumbai',19.08,72.88],['Islamabad',33.72,73.06],
  ['Karachi',24.86,67.01],['Dhaka',23.81,90.41],['Colombo',6.93,79.84],
  ['Bangkok',13.75,100.52],['Jakarta',-6.21,106.85],['Manila',14.60,120.98],
  ['Hanoi',21.03,105.85],['Naypyidaw',19.76,96.08],['Kathmandu',27.71,85.31],
  ['Almaty',43.26,76.95],['Tashkent',41.30,69.24],
  // Oceania
  ['Australia',-25.27,133.78],['New Zealand',-40.90,174.89],['Fiji',-17.71,178.07],
  ['Papua New Guinea',-6.31,143.96],
  ['Sydney',-33.87,151.21],['Melbourne',-37.81,144.96],['Auckland',-36.87,174.77],
].sort((a,b) => b[0].length - a[0].length); // longest names first → greedy match

function geolocate(text) {
  if (!text) return null;
  const t = ' ' + text.toLowerCase() + ' ';
  for (const [name, lat, lon] of GEO_TABLE) {
    // word-boundary-ish match: check spaces/punctuation around the name
    const n = name.toLowerCase();
    const idx = t.indexOf(n);
    if (idx === -1) continue;
    const before = t[idx - 1];
    const after  = t[idx + n.length];
    if (/[\w]/.test(before) || /[\w]/.test(after)) continue; // not a word boundary
    return { lat, lon, name };
  }
  return null;
}

async function getGeolocatedNews() {
  // Use cached news if fresh enough
  const raw = (_newsCache && Date.now() - _newsTs < TTL_NEWS) ? _newsCache.items : null;
  const titles = raw || [];

  // If cache is empty, do a quick parallel fetch of all feeds
  if (!titles.length) {
    const results = await Promise.allSettled(FEEDS.map(f => fetchOneFeed(f)));
    for (const r of results) {
      if (r.status === 'fulfilled') titles.push(...r.value);
    }
  }

  const events = [];
  const seen = new Set();
  for (const title of titles) {
    if (seen.has(title)) continue;
    seen.add(title);
    const geo = geolocate(title);
    if (!geo) continue;
    events.push({ title, lat: geo.lat, lon: geo.lon, name: geo.name });
    if (events.length >= 20) break;
  }
  nxLog('Geolocated news: ' + events.length + ' items', 'ok');
  return events;
}

// ── NEWS FEEDS — global coverage ─────────────────────────────────────────────
// One feed per major region so headlines aren't skewed toward any single area.
const FEEDS = [
  // Americas
  {url:'https://feeds.bbci.co.uk/mundo/rss.xml',        name:'BBC Mundo'},
  {url:'https://www.eluniversal.com.mx/rss.xml',         name:'El Universal MX'},
  {url:'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', name:'NYT World'},
  // Europe
  {url:'https://feeds.bbci.co.uk/news/world/rss.xml',    name:'BBC World'},
  {url:'https://rss.dw.com/rdf/rss-en-all',              name:'DW (Germany)'},
  {url:'https://www.france24.com/en/rss',                name:'France 24'},
  // Middle East / Africa
  {url:'https://www.aljazeera.com/xml/rss/all.xml',      name:'Al Jazeera'},
  {url:'https://rss.nytimes.com/services/xml/rss/nyt/Africa.xml', name:'NYT Africa'},
  // Asia-Pacific
  {url:'https://japantoday.com/feed',                    name:'Japan Today'},
  {url:'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', name:'Times of India'},
  {url:'https://rss.nytimes.com/services/xml/rss/nyt/AsiaPacific.xml', name:'NYT Asia'},
];

async function fetchOneFeed(feed) {
  const titles = [];
  // Try rss2json first (handles CORS + encoding well)
  try {
    const url = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(feed.url) + '&count=4';
    const r = await fetch(url, {signal: AbortSignal.timeout(5000)});
    if (r.ok) {
      const j = await r.json();
      if (j.status === 'ok' && j.items?.length) {
        j.items.forEach(it => {
          const t = (it.title || '').trim().replace(/&amp;/g,'&').replace(/&lt;/g,'<');
          if (t.length > 8) titles.push(t);
        });
        nxLog(feed.name + ': +' + titles.length + ' (rss2json)', 'ok');
        return titles;
      }
    }
  } catch(_) {}
  // Direct RSS fallback
  try {
    const r = await fetch(feed.url, {signal: AbortSignal.timeout(5000), headers: {'User-Agent': 'Mozilla/5.0'}});
    if (r.ok) {
      const xml = await r.text();
      const m = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)];
      m.slice(1, 5).forEach(x => {
        const t = x[1].replace(/<[^>]+>/g, '').trim().replace(/&amp;/g, '&');
        if (t.length > 8) titles.push(t);
      });
      nxLog(feed.name + ': +' + titles.length + ' (direct)', 'ok');
    }
  } catch(e) { nxLog(feed.name + ' fail: ' + e.message, 'warn'); }
  return titles;
}

app.get('/news', async (req, res) => {
  const now = Date.now();
  if (_newsCache && now - _newsTs < TTL_NEWS) return res.json(_newsCache);
  nxLog('Fetching news feeds (parallel)...', 'info');
  const results = await Promise.allSettled(FEEDS.map(fetchOneFeed));
  const seen = new Set();
  const items = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const t of r.value) {
      if (!seen.has(t)) { seen.add(t); items.push(t); }
      if (items.length >= 20) break;
    }
    if (items.length >= 20) break;
  }
  nxLog('News total: ' + items.length + ' items', 'ok');
  const result = {items: items.length ? items : ['Sin noticias disponibles por ahora']};
  _newsCache = result; _newsTs = Date.now();
  res.json(result);
});

// ── SATELLITE TLE HELPERS ─────────────────────────────────────────────────────
// TLEs are valid for days — cache 1 h to avoid hammering Celestrak.
let _tleCache = null;
let _tleCacheTs = 0;
const TLE_TTL = 60 * 60 * 1000;

// Parse 3-line TLE text into [{name, tle1, tle2}]
function parseTLEs(text) {
  const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i].replace(/^0 /, '').trim();
    if (lines[i+1].startsWith('1 ') && lines[i+2].startsWith('2 ')) {
      out.push({ name, tle1: lines[i+1], tle2: lines[i+2] });
    }
  }
  return out;
}

// Compute current geodetic position from TLE using satellite.js
function propagateSat(tle1, tle2) {
  try {
    const satrec = satLib.twoline2satrec(tle1, tle2);
    const now = new Date();
    const { position } = satLib.propagate(satrec, now);
    if (!position || typeof position.x !== 'number' || isNaN(position.x)) return null;
    const gmst = satLib.gstime(now);
    const geo  = satLib.eciToGeodetic(position, gmst);
    return {
      lat: parseFloat(satLib.radiansToDegrees(geo.latitude).toFixed(3)),
      lon: parseFloat(satLib.radiansToDegrees(geo.longitude).toFixed(3)),
      alt: Math.round(geo.height)
    };
  } catch { return null; }
}

async function getTLEs() {
  const now = Date.now();
  if (_tleCache && now - _tleCacheTs < TLE_TTL) return _tleCache;
  nxLog('Refreshing TLE cache from Celestrak...', 'info');
  // stations = ISS, CSS (Tiangong), etc.  visual = 100 brightest objects
  const [r1, r2] = await Promise.allSettled([
    fetch('https://celestrak.org/SATCAT/tle.php?GROUP=stations', { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' } }),
    fetch('https://celestrak.org/SATCAT/tle.php?GROUP=visual',   { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' } }),
  ]);
  const tles = [];
  const seen = new Set();
  for (const r of [r1, r2]) {
    if (r.status !== 'fulfilled' || !r.value.ok) continue;
    for (const sat of parseTLEs(await r.value.text())) {
      if (!seen.has(sat.name)) { seen.add(sat.name); tles.push(sat); }
    }
  }
  if (tles.length > 0) {
    _tleCache = tles;
    _tleCacheTs = now;
    nxLog('TLE cache: ' + tles.length + ' satellites', 'ok');
  }
  return tles;
}

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

app.get('/events', async (req, res) => {
  const now = Date.now();
  if (_eventsCache && now - _eventsTs < TTL_EVENTS) return res.json(_eventsCache);
  // Run all independent fetches in parallel
  const [quakeRes, satRes, fireRes, geoNewsRes, cycloneRes] = await Promise.allSettled([

    // ── 1. EARTHQUAKES — USGS GeoJSON (M4.5+, last 24 h) ─────────────────────
    fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson',
      { signal: AbortSignal.timeout(8000) })
      .then(r => r.json()),

    // ── 2. SATELLITES — Celestrak TLE + satellite.js ──────────────────────────
    getTLEs(),

    // ── 3. WILDFIRES — NASA FIRMS VIIRS NOAA-20, last 24 h ───────────────────
    fetch('https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv',
      { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0' } })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }),

    // ── 4. GEOLOCATED NEWS — RSS feeds + city/country geo-lookup
    getGeolocatedNews(),

    // ── 5. CYCLONES — GDACS global disaster feed
    fetch('https://www.gdacs.org/xml/rss.xml', { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.text()),
  ]);

  const events = [];

  // 1. Earthquakes
  if (quakeRes.status === 'fulfilled') {
    const features = quakeRes.value.features || [];
    features.slice(0, 25).forEach(f => {
      events.push({
        type: 'quake',
        lat:  f.geometry.coordinates[1],
        lon:  f.geometry.coordinates[0],
        label: 'M' + f.properties.mag.toFixed(1),
        mag:   f.properties.mag,
        place: f.properties.place,
        info:  `Depth: ${f.geometry.coordinates[2]}km | ${f.properties.place}`
      });
    });
    nxLog('USGS: ' + features.length + ' quakes', 'ok');
  } else {
    nxLog('ERROR USGS: ' + quakeRes.reason?.message, 'error');
  }

  // 2. Satellites
  if (satRes.status === 'fulfilled' && satRes.value.length > 0) {
    let count = 0;
    for (const sat of satRes.value) {
      const pos = propagateSat(sat.tle1, sat.tle2);
      if (!pos) continue;
      const isStation = /ISS|ZARYA|TIANGONG|CSS|TIANHE/i.test(sat.name);
      events.push({
        type:  isStation ? 'iss' : 'satellite',
        lat:   pos.lat,
        lon:   pos.lon,
        label: sat.name,
        info:  `Alt: ${pos.alt} km | ${sat.name}`
      });
      if (++count >= 20) break;
    }
    nxLog('Celestrak: ' + count + ' satellites propagated', 'ok');
  } else {
    // Last-resort: ISS only from wheretheiss.at
    nxLog('Celestrak unavailable, trying wheretheiss.at...', 'warn');
    try {
      const r = await fetch('https://api.wheretheiss.at/v1/satellites/25544', { signal: AbortSignal.timeout(5000) });
      const d = await r.json();
      events.push({ type: 'iss', lat: d.latitude, lon: d.longitude, label: 'ISS', info: `Alt: ${Math.round(d.altitude)} km | ISS` });
      nxLog('wheretheiss.at fallback OK', 'ok');
    } catch(e) { nxLog('ERROR ISS fallback: ' + e.message, 'error'); }
  }

  // 3. Wildfires
  if (fireRes.status === 'fulfilled') {
    const csv = fireRes.value;
    // CSV cols: latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight
    const fires = csv.split('\n').slice(1).filter(Boolean)
      .map(l => { const c = l.split(','); return { lat: c[0], lon: c[1], frp: parseFloat(c[12]) || 0, brightness: parseFloat(c[2]) || 0, confidence: c[9] }; })
      .filter(f => isValidLandFire({ lat: f.lat, lng: f.lon, confidence: f.confidence }))
      .sort((a, b) => b.frp - a.frp)
      .slice(0, 25);
    fires.forEach(f => {
      events.push({
        type: 'fire',
        lat:  parseFloat(f.lat),
        lon:  parseFloat(f.lon),
        label: 'FIRE',
        info: `Brightness: ${f.brightness.toFixed(0)} K | FRP: ${f.frp} MW | Conf: ${f.confidence}`
      });
    });
    nxLog('NASA FIRMS: ' + fires.length + ' fires', 'ok');
  } else {
    nxLog('ERROR NASA FIRMS: ' + fireRes.reason?.message, 'error');
  }

  // 4. Geolocated news (RSS + geo-lookup)
  if (geoNewsRes.status === 'fulfilled' && geoNewsRes.value?.length) {
    geoNewsRes.value.forEach(item => {
      events.push({
        type:  'news',
        lat:   item.lat,
        lon:   item.lon,
        label: 'NEWS',
        title: item.title,
        info:  `${item.title} [${item.name}]`
      });
    });
  }

  // 5. Cyclones (GDACS)
  if (cycloneRes.status === 'fulfilled') {
    const xml = cycloneRes.value;
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    let cycCount = 0;
    items.forEach(item => {
      const content = item[1];
      const evtype = (content.match(/<gdacs:eventtype[^>]*>(.*?)<\/gdacs:eventtype>/) || [])[1];
      if (evtype !== 'TC') return;
      const lat  = parseFloat((content.match(/<gdacs:latitude[^>]*>(.*?)<\/gdacs:latitude>/) || [])[1]);
      const lon  = parseFloat((content.match(/<gdacs:longitude[^>]*>(.*?)<\/gdacs:longitude>/) || [])[1]);
      const name = ((content.match(/<gdacs:eventname[^>]*>(.*?)<\/gdacs:eventname>/) || [])[1] || 'CYCLONE').toUpperCase();
      const sev  = (content.match(/<gdacs:severity[^>]*>([^<]*)<\/gdacs:severity>/) || [])[1] || '';
      if (isNaN(lat) || isNaN(lon)) return;
      events.push({ type:'storm', lat, lon, label: name, classification:'TC', classLabel:'TROPICAL CYCLONE', info:`${name} | ${sev.trim()}` });
      cycCount++;
    });
    nxLog('GDACS cyclones: ' + cycCount, cycCount > 0 ? 'ok' : 'info');
  } else {
    nxLog('GDACS unavailable: ' + cycloneRes.reason?.message, 'warn');
  }

  const response = { events, ts: Date.now() };
  _eventsCache = response; _eventsTs = Date.now();
  res.json(response);
});

let _flightsCache = null, _flightsTs = 0;
const FLIGHTS_TTL = 30 * 1000;

app.get('/flights', async (req, res) => {
  try {
    const now = Date.now();
    if (_flightsCache && now - _flightsTs < FLIGHTS_TTL) return res.json(_flightsCache);
    nxLog('Fetching OpenSky flights...', 'info');
    const r = await fetch('https://opensky-network.org/api/states/all', {
      signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    // State vector cols: icao24[0], callsign[1], country[2], lon[5], lat[6], baro_alt[7], on_ground[8], velocity[9], heading[10], geo_alt[13]
    const flights = (d.states || [])
      .filter(s => s[5] !== null && s[6] !== null && s[8] === false)
      .map(s => ({
        icao:     s[0],
        callsign: (s[1] || '').trim() || s[0].toUpperCase(),
        country:  s[2] || '',
        lon:  s[5], lat: s[6],
        alt:  Math.round((s[7] || s[13] || 0) * 3.281), // meters → feet
        speed: Math.round((s[9] || 0) * 1.944),          // m/s → knots
        heading: Math.round(s[10] || 0)
      }))
      .slice(0, 250);
    nxLog('OpenSky: ' + flights.length + ' flights', 'ok');
    const result = { flights, ts: Date.now() };
    _flightsCache = result; _flightsTs = now;
    res.json(result);
  } catch(e) {
    nxLog('ERROR /flights: ' + e.message, 'warn');
    res.json(_flightsCache || { flights: [], ts: Date.now() });
  }
});

let _spaceCache = null, _spaceTs = 0;
const SPACE_TTL = 5 * 60 * 1000;

app.get('/space', async (req, res) => {
  try {
    const now = Date.now();
    if (_spaceCache && now - _spaceTs < SPACE_TTL) return res.json(_spaceCache);
    const [kpRes, crewRes] = await Promise.allSettled([
      fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', { signal: AbortSignal.timeout(6000) }).then(r => r.json()),
      fetch('http://api.open-notify.org/astros.json', { signal: AbortSignal.timeout(5000) }).then(r => r.json())
    ]);
    let kp = null;
    if (kpRes.status === 'fulfilled') {
      const arr = kpRes.value;
      // arr is [[datetime, kp, observed, class], ...] — last row is most recent
      for (let i = arr.length - 1; i >= 0; i--) {
        const v = parseFloat(arr[i][1]);
        if (!isNaN(v)) { kp = { value: v, class: arr[i][3] || '' }; break; }
      }
    }
    let crew = [];
    if (crewRes.status === 'fulfilled') {
      crew = (crewRes.value?.people || []).filter(p => p.craft === 'ISS').map(p => p.name);
    }
    nxLog(`Space: Kp=${kp?.value ?? 'N/A'} ISS crew=${crew.length}`, 'ok');
    const result = { kp, crew };
    _spaceCache = result; _spaceTs = now;
    res.json(result);
  } catch(e) {
    nxLog('ERROR /space: ' + e.message, 'error');
    res.json(_spaceCache || { kp: null, crew: [] });
  }
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
