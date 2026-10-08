// Copia local de la app para que abra sin conexión.
// La versión sube con cada publicación: al cambiar, se tira la copia anterior.
const VERSION = 'tareas-v24';
const SHELL = ['dashboard-supabase.html', 'app.css?v=23', 'app.js?v=23', 'apple-touch-icon.png?v=23', 'favicon.png?v=23', 'manifest.json?v=23'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const guardar = (req, res) => {
  if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {}); }
  return res;
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isShell = url.origin === location.origin;
  const isAsset = /cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.host);
  if (!isShell && !isAsset) return; // Supabase y calendarios siempre van a la red

  // Lo que lleva versión (?v=, librerías con número fijo, fuentes) no cambia nunca: directo de la copia
  if (isAsset || url.searchParams.has('v')) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => guardar(req, res))));
    return;
  }

  // La página, primero desde la red para recibir cambios; si la red tarda o falla, desde la copia
  const red = fetch(req).then(res => guardar(req, res));
  const copia = () => caches.match(req, { ignoreSearch: true })
    .then(hit => hit || caches.match('dashboard-supabase.html', { ignoreSearch: true }));
  e.respondWith(new Promise((resolve) => {
    let hecho = false;
    const usar = (r) => { if (!hecho && r) { hecho = true; resolve(r); } };
    const espera = setTimeout(() => copia().then(usar), 1500);
    red.then((res) => { clearTimeout(espera); usar(res); })
      .catch(() => { clearTimeout(espera); copia().then(hit => { usar(hit); if (!hecho) resolve(Response.error()); }); });
  }));
});
