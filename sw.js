/* ═══════════════════════════════════════════════════════
   CSLTC Attendance Tracker — Service Worker
   Strategy: Cache-First for app shell, Network-First for API
════════════════════════════════════════════════════════ */

'use strict';

const CACHE_NAME    = 'csltc-attend-v1';
const CACHE_DYNAMIC = 'csltc-dynamic-v1';

// App shell — these files are cached on install
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  // html5-qrcode from CDN
  '[unpkg.com](https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js)',
];

/* ── INSTALL ────────────────────────────────────────── */
self.addEventListener('install', (event) => {
  console.log('[SW] Installing…');

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching app shell…');
      // Use individual adds so one failure doesn't block the rest
      return Promise.allSettled(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) =>
            console.warn(`[SW] Failed to cache ${url}:`, err)
          )
        )
      );
    }).then(() => self.skipWaiting())
  );
});

/* ── ACTIVATE ───────────────────────────────────────── */
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating…');

  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== CACHE_DYNAMIC)
          .map((key) => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

/* ── FETCH ──────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // ── Never intercept Apps Script API calls ───────────
  // Let those go straight to the network (sync engine handles failures)
  if (url.hostname.includes('script.google.com')) {
    event.respondWith(fetch(request));
    return;
  }

  // ── Never intercept non-GET requests ────────────────
  if (request.method !== 'GET') {
    event.respondWith(fetch(request));
    return;
  }

  // ── Cache-first for app shell ────────────────────────
  if (isAppShellRequest(url, request)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // ── Network-first with dynamic cache fallback ────────
  event.respondWith(networkFirstWithCache(request));
});

/* ── STRATEGIES ─────────────────────────────────────── */

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Return a basic offline fallback page if HTML navigation
    if (request.destination === 'document') {
      const fallback = await caches.match('./index.html');
      if (fallback) return fallback;
    }
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function networkFirstWithCache(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_DYNAMIC);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

/* ── HELPERS ────────────────────────────────────────── */

function isAppShellRequest(url, request) {
  // Same-origin HTML/JS/CSS or manifest
  if (url.origin === self.location.origin) return true;
  // CDN-hosted QR library
  if (url.hostname === 'unpkg.com') return true;
  return false;
}

/* ── BACKGROUND SYNC (experimental, optional) ───────── */
self.addEventListener('sync', (event) => {
  if (event.tag === 'csltc-sync') {
    // The main thread handles sync; this is a belt-and-suspenders hook
    // If your browser supports Background Sync API, it will retry here
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) =>
          client.postMessage({ type: 'TRIGGER_SYNC' })
        );
      })
    );
  }
});
