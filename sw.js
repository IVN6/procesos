const CACHE_NAME = 'organizate-pwa-v1';

// Solo guardamos los archivos críticos de ESTE proyecto
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/1f427.svg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting(); 
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Promise.allSettled evita que toda la instalación falle si un archivo no carga
      return Promise.allSettled(
        ASSETS_TO_CACHE.map(url => cache.add(new Request(url, { mode: 'no-cors' })).catch(err => console.warn('Fallo al cachear:', url, err)))
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim()) 
  );
});

self.addEventListener('fetch', (event) => {
  // Ignorar peticiones al backend (Apps Script)
  if (event.request.url.includes('script.google.com')) return;

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse; // 1. Retorna desde la memoria (Offline Fast)
      }
      return fetch(event.request).then((networkResponse) => {
        // Opcional: Cachear dinámicamente nuevos archivos
        return caches.open(CACHE_NAME).then((cache) => {
          if (event.request.method === 'GET' && !event.request.url.startsWith('chrome-extension')) {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        });
      }).catch(() => {
        // 2. Si no hay red y no está en caché, fuerza la vista principal
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('./index.html');
        }
      });
    })
  );
});
