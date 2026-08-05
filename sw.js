const CACHE_NAME = 'backlog-mind-v2';

// Incluimos todas las variaciones de la URL para evitar fallos de ruta
const ASSETS_TO_CACHE = [
  './',
  './log.html',
  './manifest.json',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@latest'
];

// 1. Instalación e intercambio de archivos a la caché local
self.addEventListener('install', (event) => {
  self.skipWaiting(); // Fuerza al SW activo a instalarse de inmediato
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Usamos Promise.allSettled para que si un CDN falla, no rompa la caché del HTML
      return Promise.allSettled(
        ASSETS_TO_CACHE.map(url => cache.add(new Request(url, { mode: 'no-cors' })).catch(() => {}))
      );
    })
  );
});

// 2. Activación y toma de control inmediata
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim()) // Toma control de la pestaña abierta inmediatamente
  );
});

// 3. Estrategia de respuesta para uso Offline
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).catch(() => {
        // Si no hay red y no está en caché, intenta entregar el log.html guardado
        return caches.match('./log.html');
      });
    })
  );
});
