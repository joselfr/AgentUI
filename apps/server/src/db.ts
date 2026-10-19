import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// createRequire: prevents Vite/vitest from stripping the `node:` prefix from node:sqlite
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type DB = DatabaseSyncType;

export function openDb(dataDir: string): DB {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'agentui.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      sub_agent_id TEXT,
      remote_session_id TEXT,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      reasoning TEXT,
      run_id TEXT,
      status TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      args TEXT,
      result_preview TEXT,
      result_truncated INTEGER NOT NULL DEFAULT 0,
      parent_subagent_run_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      PRIMARY KEY (message_id, id)
    );
    CREATE TABLE IF NOT EXISTS subagent_runs (
      id TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      PRIMARY KEY (message_id, id)
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_id);
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS miniapps (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'apps',
      description TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS miniapp_docs (
      app_id TEXT NOT NULL REFERENCES miniapps(id) ON DELETE CASCADE,
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, collection, id)
    );
    CREATE TABLE IF NOT EXISTS miniapp_fs (
      app_id TEXT NOT NULL REFERENCES miniapps(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      mode TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (app_id, path)
    );
    CREATE TABLE IF NOT EXISTS miniapp_kv (
      app_id TEXT NOT NULL REFERENCES miniapps(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (app_id, key)
    );
  `);
  try {
    // Last read of the chat (ms): agent messages more recent than this are "unread".
    db.exec('ALTER TABLE conversations ADD COLUMN last_read_at INTEGER');
    db.exec('UPDATE conversations SET last_read_at = updated_at'); // migration: existing rows are considered read
  } catch { /* column already present */ }
  try { db.exec('ALTER TABLE conversations ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0'); } catch { /* column already present */ }
  try { db.exec('ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0'); } catch { /* column already present */ }
  try { db.exec('ALTER TABLE conversations ADD COLUMN usage TEXT'); } catch { /* column already present */ }
  try { db.exec('ALTER TABLE messages ADD COLUMN pending_question TEXT'); } catch { /* column already present */ }
  for (const col of ['reasoning TEXT', 'summary TEXT', 'session_id TEXT']) {
    try { db.exec(`ALTER TABLE subagent_runs ADD COLUMN ${col}`); } catch { /* column already present */ }
  }
  return db;
}
