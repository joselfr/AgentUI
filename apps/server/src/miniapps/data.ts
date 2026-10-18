import { randomBytes } from 'node:crypto';
import type { DB } from '../db.js';
import { APP_LIMITS, AppError } from './store.js';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
type Doc = Record<string, unknown>;

const matches = (doc: Doc, filter: Doc): boolean =>
  Object.entries(filter).every(([k, v]) => JSON.stringify(doc[k]) === JSON.stringify(v));

/** Data of the mini-apps (document collections + key/value), always scoped by `app_id`. */
export class AppData {
  constructor(private db: DB) {}

  private col(name: unknown): string {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new AppError('Invalid collection name.');
    return name;
  }
  private json(doc: Doc): string {
    const s = JSON.stringify(doc);
    if (s.length > APP_LIMITS.maxDocBytes) throw new AppError('Document too large.');
    return s;
  }
  private out(id: string, json: string, created: number, updated: number): Doc {
    return { ...(JSON.parse(json) as Doc), id, _createdAt: created, _updatedAt: updated };
  }
  private clean(doc: unknown): Doc {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new AppError('A document must be an object.');
    const { id: _i, _createdAt: _c, _updatedAt: _u, ...rest } = doc as Doc;
    return rest;
  }

  find(appId: string, collection: unknown, filter?: Doc, opts?: { limit?: number; sort?: string; desc?: boolean }): Doc[] {
    const rows = this.db
      .prepare('SELECT id, json, created_at, updated_at FROM miniapp_docs WHERE app_id = ? AND collection = ? ORDER BY created_at, rowid')
      .all(appId, this.col(collection)) as unknown as { id: string; json: string; created_at: number; updated_at: number }[];
    let docs = rows.map((r) => this.out(r.id, r.json, r.created_at, r.updated_at));
    if (filter && typeof filter === 'object') docs = docs.filter((d) => matches(d, filter));
    const sort = opts?.sort;
    if (sort) {
      docs.sort((a, b) => {
        const x = a[sort] as any, y = b[sort] as any;
        return (x > y ? 1 : x < y ? -1 : 0) * (opts?.desc ? -1 : 1);
      });
    }
    return docs.slice(0, Math.min(Math.max(opts?.limit ?? 1000, 1), 5000));
  }

  get(appId: string, collection: unknown, id: unknown): Doc | null {
    const r = this.db
      .prepare('SELECT id, json, created_at, updated_at FROM miniapp_docs WHERE app_id = ? AND collection = ? AND id = ?')
      .get(appId, this.col(collection), String(id)) as unknown as { id: string; json: string; created_at: number; updated_at: number } | undefined;
    return r ? this.out(r.id, r.json, r.created_at, r.updated_at) : null;
  }

  insert(appId: string, collection: unknown, doc: unknown): Doc {
    const c = this.col(collection);
    const count = (this.db.prepare('SELECT COUNT(*) n FROM miniapp_docs WHERE app_id = ?').get(appId) as { n: number }).n;
    if (count >= APP_LIMITS.maxDocsPerApp) throw new AppError('Too many documents.');
    const body = this.clean(doc);
    const id = randomBytes(6).toString('hex');
    const now = Date.now();
    this.db.prepare('INSERT INTO miniapp_docs (app_id, collection, id, json, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(appId, c, id, this.json(body), now, now);
    return this.out(id, JSON.stringify(body), now, now);
  }

  /** Merges `patch` into the document; `null` if it does not exist. */
  update(appId: string, collection: unknown, id: unknown, patch: unknown): Doc | null {
    const cur = this.get(appId, collection, id);
    if (!cur) return null;
    const { id: _i, _createdAt, _updatedAt: _u, ...rest } = cur;
    const body = { ...rest, ...this.clean(patch) };
    const now = Date.now();
    this.db.prepare('UPDATE miniapp_docs SET json = ?, updated_at = ? WHERE app_id = ? AND collection = ? AND id = ?').run(this.json(body), now, appId, this.col(collection), String(id));
    return this.out(String(id), JSON.stringify(body), _createdAt as number, now);
  }

  remove(appId: string, collection: unknown, id: unknown): boolean {
    return Number(this.db.prepare('DELETE FROM miniapp_docs WHERE app_id = ? AND collection = ? AND id = ?').run(appId, this.col(collection), String(id)).changes) > 0;
  }

  kvGet(appId: string, key: unknown): unknown {
    const r = this.db.prepare('SELECT value FROM miniapp_kv WHERE app_id = ? AND key = ?').get(appId, String(key)) as { value: string } | undefined;
    return r ? JSON.parse(r.value) : null;
  }
  kvSet(appId: string, key: unknown, value: unknown): true {
    const s = JSON.stringify(value ?? null);
    if (s.length > APP_LIMITS.maxKvBytes) throw new AppError('Value too large.');
    this.db.prepare('INSERT INTO miniapp_kv (app_id, key, value) VALUES (?,?,?) ON CONFLICT(app_id, key) DO UPDATE SET value = excluded.value').run(appId, String(key).slice(0, 200), s);
    return true;
  }
  kvDelete(appId: string, key: unknown): true {
    this.db.prepare('DELETE FROM miniapp_kv WHERE app_id = ? AND key = ?').run(appId, String(key));
    return true;
  }
}
