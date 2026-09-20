const CACHE_PREFIX = 'vylk-shell-';
const LEGACY_CACHE = 'vylk-shell';
const revisionFromURL = new URL(self.location.href).searchParams.get('revision') || 'legacy';
const safeRevision = /^[A-Za-z0-9._-]{1,128}$/.test(revisionFromURL) ? revisionFromURL : 'legacy';
const CACHE = `${CACHE_PREFIX}${safeRevision}`;
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/js/ui/themes.js',
  '/js/ui/dashboard.js',
  '/js/ui/dashboard-controller.js',
  '/js/ui/auth.js',
  '/js/ui/preferences.js',
  '/js/ui/preferences-dialog.js',
  '/js/ui/preferences-store.js',
  '/js/ui/appearance.js',
  '/js/ui/modal.js',
  '/js/ui/conflict-resolver.js',
  '/js/ui/feedback.js',
  '/js/ui/panel-controller.js',
  '/js/ui/navigation-controller.js',
  '/js/app.js',
  '/js/core/http.js',
  '/js/core/api-client.js',
  '/js/core/routes.js',
  '/js/core/indexeddb.js',
  '/js/core/offline-store.js',
  '/js/core/sync-batch.js',
  '/js/sync/server-events.js',
  '/js/sync/conflict-actions.js',
  '/js/sync/compacted-operations.js',
  '/js/sync/conflict-workflow.js',
  '/js/sync/acknowledgements.js',
  '/js/sync/pusher.js',
  '/js/sync/preference-conflicts.js',
  '/js/sync/leadership.js',
  '/js/sync/remote-notes.js',
  '/js/sync/coordinator.js',
  '/js/editor/shortcuts.js',
  '/js/editor/shortcut-controller.js',
  '/js/editor/default-commands.js',
  '/js/editor/preview-content.js',
  '/js/editor/preview-dom.js',
  '/js/editor/preview-navigation.js',
  '/js/editor/preview-highlighter.js',
  '/js/editor/preview-worker-client.js',
  '/js/editor/preview-renderer.js',
  '/js/editor/preview-decoration.js',
  '/js/editor/preview-model.js',
  '/js/editor/preview-drag-layout.js',
  '/js/editor/preview-drag-controller.js',
  '/js/editor/interactive-preview.js',
  '/js/editor/interactive-preview-session.js',
  '/js/editor/markdown-formatting.js',
  '/js/editor/formatting-toolbar.js',
  '/js/editor/note-saver.js',
  '/js/editor/zen-editor.js',
  '/js/editor/source-adapter.js',
  '/js/editor/zen-overlays.js',
  '/js/editor/caret-controller.js',
  '/js/workers/preview-worker.js',
  '/js/editor/merge.js',
  '/vendor/marked.min.js',
  '/manifest.json',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png',
];
const SHELL_ASSETS = new Set(ASSETS);
const FONT_CACHE = 'vylk-fonts';
const FONT_ORIGINS = new Set(['https://fonts.googleapis.com', 'https://fonts.gstatic.com']);

async function normalizeShellResponse(response) {
  if (!response) return undefined;
  const headers = new Headers(response.headers);
  headers.delete('Content-Encoding');
  headers.delete('Content-Length');
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isShellCache(name) {
  return name === LEGACY_CACHE || name.startsWith(CACHE_PREFIX);
}

async function cachedShellResponse(request) {
  const cache = await caches.open(CACHE);
  if (request.mode === 'navigate')
    return normalizeShellResponse((await cache.match('/index.html')) || (await cache.match('/')));
  return normalizeShellResponse(await cache.match(request));
}

async function fetchShellAsset(request) {
  const response = await fetch(request, {cache: 'no-cache', headers: {'X-Vylk-Shell': '1'}});
  if (response.ok) {
    const url = new URL(request.url);
    if (!url.search && SHELL_ASSETS.has(url.pathname)) {
      const cache = await caches.open(CACHE);
      await cache.put(url.pathname, response.clone());
    }
  }
  return response;
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      // This cache is revision-specific, so a failed install cannot modify the
      // cache used by the active worker.
      const cache = await caches.open(CACHE);
      await Promise.all(
        ASSETS.map(async (asset) => {
          const response = await fetch(asset, {cache: 'no-cache', headers: {'X-Vylk-Shell': '1'}});
          if (!response.ok) throw new Error(`could not cache ${asset}`);
          await cache.put(asset, response);
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => isShellCache(key) && key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const {request} = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (FONT_ORIGINS.has(url.origin)) {
    e.respondWith(
      (async () => {
        let cache;
        try {
          cache = await caches.open(FONT_CACHE);
          const cached = await cache.match(request);
          if (cached) return cached;
        } catch (_) {
          // Cache storage is an optimization; it must not block the network.
          cache = undefined;
        }
        try {
          const response = await fetch(request);
          // gstatic can be returned as an opaque response in some browser modes.
          // It is still a valid cache entry for the browser's font loader.
          if (cache && (response.ok || response.type === 'opaque')) {
            await cache.put(request, response.clone()).catch(() => {});
          }
          return response;
        } catch (_) {
          try {
            const cached = await caches.match(request);
            if (cached) return cached;
          } catch (_) {}
          return new Response('', {status: 503, statusText: 'Offline'});
        }
      })(),
    );
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    e.respondWith(
      (async () => {
        const cached = await cachedShellResponse(request);
        if (cached) return cached;
        try {
          return await fetchShellAsset(request);
        } catch (_) {
          return new Response('The app is unavailable offline.', {
            status: 503,
            headers: {'Content-Type': 'text/plain; charset=utf-8'},
          });
        }
      })(),
    );
    return;
  }

  if (!SHELL_ASSETS.has(url.pathname) || url.search) return;
  e.respondWith(
    (async () => {
      const cached = await cachedShellResponse(request);
      if (cached) return cached;
      try {
        return await fetchShellAsset(request);
      } catch (_) {
        return new Response('', {status: 503, statusText: 'Offline'});
      }
    })(),
  );
});
