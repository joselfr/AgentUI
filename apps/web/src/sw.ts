import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

// Typage minimal : ce fichier s'exécute dans un ServiceWorker (lib DOM utilisée pour le build du reste de l'app).
declare const self: any;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//, /^\/ws/] }));

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e: any) => e.waitUntil(self.clients.claim()));

interface PushData {
  title: string;
  body: string;
  url: string;
  tag: string;
}

self.addEventListener('push', (event: any) => {
  let data: PushData;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'AgentUI', body: event.data?.text() ?? '', url: '/', tag: 'agentui' };
  }
  event.waitUntil(
    (async () => {
      // Pas de notification si l'application est déjà ouverte au premier plan : l'utilisateur voit la réponse arriver.
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.some((w: any) => w.visibilityState === 'visible' && w.focused)) return;
      await self.registration.showNotification(data.title, {
        body: data.body,
        tag: data.tag, // une seule notification par conversation
        icon: '/icon.svg',
        badge: '/icon.svg',
        data: { url: data.url },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event: any) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = wins[0];
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'open-conversation', url });
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
