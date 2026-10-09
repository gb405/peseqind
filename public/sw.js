/* Service Worker – nur fuer Web-Push ("du bist dran") und das Antippen der Benachrichtigung.
 * Bewusst KEIN Offline-Cache: das Spiel braucht ohnehin immer den Server. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Pesëqind';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'Du bist dran.',
    tag: data.tag || 'peseqind-turn',
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { await c.focus(); return; } // offenes Fenster nach vorn holen
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
