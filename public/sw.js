const CACHE_NAME = 'absensi-v27-refresh';

// Daftar file lokal & pustaka CDN yang WAJIB disimpan di memori HP
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/admin.html',
  '/app.js',
  '/manifest.json',
  // Pustaka CDN Scanner Kamera & Generator QR yang di-cache untuk offline
  'https://unpkg.com/html5-qrcode',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
];

// 1. Install Event: Download dan Simpan Semua Aset ke Cache
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Caching app shell and external libraries...');
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// 2. Activate Event: Hapus Cache Lama jika ada pembaruan
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch Event: Ambil dari Cache jika Offline (Network-First dengan Cache Fallback)
self.addEventListener('fetch', (event) => {
  // Abaikan request API ke backend agar tidak tersimpan di cache statis
  if (event.request.url.includes('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Mengembalikan dari cache lokal
        return cachedResponse;
      }

      // Jika tidak ada di cache, ambil dari jaringan lalu simpan otomatis
      return fetch(event.request).then((response) => {
        // Cek jika response valid
        if (!response || response.status !== 200 || response.type !== 'basic' && response.type !== 'cors') {
          return response;
        }

        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return response;
      }).catch(() => {
        // Jika jaringan gagal/offline dan file tidak ditemukan
        console.log('[Service Worker] Fetch failed; returning offline fallback if available.');
      });
    })
  );
});