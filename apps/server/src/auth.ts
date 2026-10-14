import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { DB } from './db.js';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface AuthUser {
  id: number;
  username: string;
}

export function ensureAdmin(db: DB, user?: string, password?: string): void {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (count > 0) return;
  if (!user || !password) {
    throw new Error('Aucun utilisateur : définir ADMIN_USER et ADMIN_PASSWORD au premier démarrage.');
  }
  db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run(
    user,
    hashPassword(password),
    Date.now(),
  );
}

export function login(db: DB, username: string, password: string): { token: string; user: AuthUser } | null {
  const row = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username) as
    | { id: number; username: string; password_hash: string }
    | undefined;
  // Coût constant même si l'utilisateur n'existe pas
  const ok = verifyPassword(password, row?.password_hash ?? 'scrypt$00$00');
  if (!row || !ok) return null;
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha(token),
    row.id,
    Date.now() + SESSION_TTL_MS,
  );
  return { token, user: { id: row.id, username: row.username } };
}

export function userFromToken(db: DB, token: string | undefined): AuthUser | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, s.expires_at FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(sha(token)) as { id: number; username: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, username: row.username };
}

export function logout(db: DB, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha(token));
}

export function changePassword(db: DB, userId: number, oldPw: string, newPw: string): boolean {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
    | { password_hash: string }
    | undefined;
  if (!row || !verifyPassword(oldPw, row.password_hash)) return false;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPw), userId);
  return true;
}

/** Limiteur simple en mémoire : max `limit` échecs par clé sur `windowMs`. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private limit = 8, private windowMs = 10 * 60 * 1000) {}
  blocked(key: string): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, arr);
    return arr.length >= this.limit;
  }
  fail(key: string): void {
    this.hits.set(key, [...(this.hits.get(key) ?? []), Date.now()]);
  }
  reset(key: string): void {
    this.hits.delete(key);
  }
}
