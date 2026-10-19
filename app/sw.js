// Offline support: cache the app shell so SplatScout opens in basements with no signal.
const CACHE = 'splatscout-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/main.js', 'js/ui/dom.js', 'js/ui/home.js', 'js/ui/setup.js', 'js/ui/captureScreen.js', 'js/ui/review.js', 'js/ui/learn.js', 'js/ui/settingsScreen.js',
  'js/core/math.js', 'js/core/analyzer.js', 'js/core/coverage.js', 'js/core/keyframer.js', 'js/core/coach.js', 'js/core/plans.js',
  'js/core/score.js', 'js/core/motion.js', 'js/core/zip.js', 'js/core/formats.js',
  'js/sources/gpu.js', 'js/sources/common.js', 'js/sources/frameImage.js', 'js/sources/xrSource.js', 'js/sources/orientation.js',
  'js/sources/cameraSource.js', 'js/sources/demoScene.js', 'js/sources/demoSource.js',
  'js/capture/session.js', 'js/capture/overlay3d.js', 'js/capture/minimap.js', 'js/capture/audio.js',
  'js/data/store.js', 'js/data/settings.js', 'js/data/exporter.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// Network first (so updates arrive), falling back to the cache when offline.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
