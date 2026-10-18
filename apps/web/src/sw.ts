import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

// Minimal typing: this file runs in a ServiceWorker (DOM lib used for the build of the rest of the app).
declare const self: any;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//, /^\/ws/, /^\/m\//] }));

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
      // No notification if the app is already open in the foreground: the user sees the reply arrive.
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.some((w: any) => w.visibilityState === 'visible' && w.focused)) return;
      await self.registration.showNotification(data.title, {
        body: data.body,
        tag: data.tag, // a single notification per chat
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
