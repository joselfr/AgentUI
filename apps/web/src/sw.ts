import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { ExpirationPlugin } from 'workbox-expiration';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';

// Minimal typing: this file runs in a ServiceWorker (DOM lib used for the build of the rest of the app).
declare const self: any;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// `/public/…` is the public entry point (OAuth return, webhooks) of the miniapps: the browser must reach the
// server directly, never the app shell, otherwise it shows an empty conversation instead of the handler's response. `/close.html` is the static page that closes the tab after such a redirect.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//, /^\/ws/, /^\/m\//, /^\/w\//, /^\/public\//, /^\/close(\.html)?(\?|$)/] }));

// Files of the chat's widgets (`/w/<hash>/<token>/…`, content-addressed), fetched by the page (see components/widgetOffline.ts) and kept for a week
// so the widgets still open offline. The token changes on every build and expires, so the cache key ignores it. `att/` (media, byte ranges) is left out.
registerRoute(
  ({ url }: any) => url.origin === self.location.origin && /^\/w\/[^/]+\/[^/]+\/(?!att\/)/.test(url.pathname),
  new NetworkFirst({
    cacheName: 'widgets',
    plugins: [
      { cacheKeyWillBeUsed: async ({ request }: any) => { const u = new URL(request.url); u.pathname = u.pathname.replace(/^(\/w\/[^/]+)\/[^/]+\//, '$1/'); u.search = ''; return u.href; } },
      new ExpirationPlugin({ maxAgeSeconds: 7 * 24 * 3600, maxEntries: 400, purgeOnQuotaError: true }),
    ],
  }),
);

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
      if (new URL(url).origin !== self.location.origin) return void (await self.clients.openWindow(url));
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
