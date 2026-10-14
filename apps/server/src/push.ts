import webpush from 'web-push';
import type { DB } from './db.js';

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}
type Sender = (sub: PushSubscriptionJson, payload: string) => Promise<unknown>;

/** Notifications Web Push (VAPID). Les clés sont générées une fois puis conservées en base. */
export class PushService {
  readonly publicKey: string;
  private privateKey: string;

  constructor(private db: DB, private send?: Sender, subject = process.env.VAPID_SUBJECT ?? 'mailto:admin@agentui.local') {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'vapid'").get() as { value: string } | undefined;
    const keys = row ? (JSON.parse(row.value) as { publicKey: string; privateKey: string }) : webpush.generateVAPIDKeys();
    if (!row) db.prepare("INSERT INTO kv (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
    this.publicKey = keys.publicKey;
    this.privateKey = keys.privateKey;
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  }

  subscribe(userId: number, sub: PushSubscriptionJson) {
    this.db
      .prepare('INSERT INTO push_subscriptions (endpoint, user_id, data) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, data = excluded.data')
      .run(sub.endpoint, userId, JSON.stringify(sub));
  }
  unsubscribe(endpoint: string) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions').get() as { c: number }).c;
  }

  /** Envoie à tous les appareils abonnés ; purge ceux que le service push déclare expirés (404/410). */
  async notify(payload: PushPayload): Promise<{ sent: number; removed: number }> {
    const rows = this.db.prepare('SELECT endpoint, data FROM push_subscriptions').all() as { endpoint: string; data: string }[];
    const body = JSON.stringify(payload);
    const send: Sender = this.send ?? ((s, p) => webpush.sendNotification(s, p, { TTL: 3600, urgency: 'normal', topic: payload.tag.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '') || undefined }));
    let sent = 0;
    let removed = 0;
    await Promise.all(
      rows.map(async (r) => {
        try {
          await send(JSON.parse(r.data) as PushSubscriptionJson, body);
          sent++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) {
            this.unsubscribe(r.endpoint);
            removed++;
          }
        }
      }),
    );
    return { sent, removed };
  }
}
