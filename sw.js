// Copia local de la app para que abra sin conexión.
// La versión sube con cada publicación: al cambiar, se tira la copia anterior.
const VERSION = 'tareas-v13';
const SHELL = ['dashboard-supabase.html', 'app.css?v=13', 'app.js?v=13'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isShell = url.origin === location.origin;
  const isAsset = /cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.host);
  if (!isShell && !isAsset) return; // Supabase y calendarios siempre van a la red

  // La app primero desde la red, para recibir cambios; si falla, desde la copia
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(hit => hit || caches.match('dashboard-supabase.html', { ignoreSearch: true })))
  );
});
