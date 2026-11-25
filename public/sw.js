// Minimal PWA Service Worker: enables Add-to-Home-Screen installability
// without interfering with live SSH/SFTP/SSE API traffic.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp')) {
    return;
  }
  event.respondWith(fetch(event.request));
});
