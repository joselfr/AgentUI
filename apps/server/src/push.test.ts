import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDb } from './db.js';
import { PushService, type PushSubscriptionJson } from './push.js';

const sub = (n: number): PushSubscriptionJson => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'a' } });
const user = (db: ReturnType<typeof openDb>) => db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('u','x',1)").run().lastInsertRowid as number;

test('VAPID keys generated once then kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentui-'));
  const a = new PushService(openDb(dir));
  const b = new PushService(openDb(dir));
  expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  expect(b.publicKey).toBe(a.publicKey);
});

test('notify: sends to each subscriber, purges expired subscriptions (410), keeps temporary errors', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const uid = user(db);
  const got: string[] = [];
  const push = new PushService(db, async (s, payload) => {
    if (s.endpoint.endsWith('/2')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    if (s.endpoint.endsWith('/3')) throw Object.assign(new Error('boom'), { statusCode: 500 });
    got.push(s.endpoint + ' ' + JSON.parse(payload).title);
  });
  [1, 2, 3].forEach((n) => push.subscribe(uid, sub(n)));
  push.subscribe(uid, sub(1)); // idempotent
  expect(push.count()).toBe(3);

  const r = await push.notify({ title: 'Hermes replied', body: 'b', url: '/?c=x', tag: 'x' });
  expect(r).toEqual({ sent: 1, removed: 1 });
  expect(got).toEqual(['https://push.example/1 Hermes replied']);
  expect(push.count()).toBe(2);
  push.unsubscribe(sub(1).endpoint);
  expect(push.count()).toBe(1);
});
