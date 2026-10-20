import { randomUUID } from 'node:crypto';
import type { AgentEvent, Message, OutgoingAttachment, SearchHit, ServerPush, ToolCall, SubAgentRun, Usage } from '@agentui/shared';
import type { DB } from './db.js';
import type { AgentAdapter } from './agents/types.js';
import { prepareAttachments, type AttachmentStore } from './attachments.js';

export interface ConversationRow {
  id: string;
  agent_id: string;
  sub_agent_id: string | null;
  remote_session_id: string | null;
  title: string;
  created_at: number;
  updated_at: number;
  /** Last read (ms). */
  last_read_at: number | null;
  /** 1 if the chat is pinned at the top of the list. */
  favorite?: number;
  /** 1 if the chat is archived (filed outside the main list). */
  archived?: number;
  /** Last known consumption of the session (`Usage` JSON). */
  usage?: string | null;
  /** 1 if a finished agent message is more recent than the last read. */
  unread?: number;
}

/** Synthetic session key of proactive messages filed in a "home" chat (see `deliver`). */
const HOME_SESSION = 'home';
/** Maximum wait for a run to end before deleting its chat. */
const ABORT_GRACE_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A message being streamed is not "unread": it becomes so when it finishes.
const UNREAD = `EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.role = 'assistant'
  AND COALESCE(m.status, 'done') != 'streaming' AND m.created_at > COALESCE(c.last_read_at, 0)) AS unread`;

/** Lowercase without accents: basis of the search ("ete" finds "Été"). */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Same, with the mapping of each character of the folded text to its position in the original text. */
function foldMap(s: string): { f: string; map: number[] } {
  let f = '';
  const map: number[] = [];
  let i = 0;
  for (const ch of s) {
    const n = fold(ch);
    for (let k = 0; k < n.length; k++) map.push(i);
    f += n;
    i += ch.length;
  }
  return { f, map };
}

/** Excerpt of about sixty characters around the first word found, and ranges to highlight. */
function makeSnippet(text: string, words: string[]): { snippet: string; marks: [number, number][] } {
  const { f, map } = foldMap(text);
  const first = Math.min(...words.map((w) => { const i = f.indexOf(w); return i < 0 ? Infinity : i; }));
  const at = Number.isFinite(first) ? map[first] ?? 0 : 0;
  const from = Math.max(0, at - 40);
  const to = Math.min(text.length, at + 110);
  const snippet = (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < text.length ? '…' : '');
  const sf = foldMap(snippet);
  const marks: [number, number][] = [];
  for (const w of words) {
    for (let i = sf.f.indexOf(w); i >= 0 && marks.length < 12; i = sf.f.indexOf(w, i + w.length)) {
      const start = sf.map[i]!;
      marks.push([start, (sf.map[i + w.length - 1] ?? start) + 1 - start]);
    }
  }
  marks.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[0] + last[1]) last[1] = Math.max(last[1], m[0] + m[1] - last[0]);
    else merged.push([...m]);
  }
  return { snippet, marks: merged };
}

type Listener = (push: ServerPush) => void;

/**
   * Orchestrates runs on the server side: agent streams are consumed here, persisted,
   * then broadcast to WS clients. A run continues even if no client is connected anymore.
 */
export class RunManager {
  private listeners = new Set<Listener>();
  private active = new Map<string, { agentId: string; runId: string; remoteSessionId: string; convId: string }>();
  onRunFinished?: (conv: ConversationRow, outcome: 'completed' | 'failed' | 'aborted', preview: string) => void;

  constructor(private db: DB, private adapters: Map<string, AgentAdapter>, private files?: AttachmentStore) {}

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  broadcast(p: ServerPush) {
    for (const l of this.listeners) {
      try {
        l(p);
      } catch {
        /* client mort */
      }
    }
  }

  // ---------- Conversations ----------
  createConversation(agentId: string, subAgentId?: string, title = 'Nouvelle conversation', remoteSessionId?: string): ConversationRow {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO conversations (id, agent_id, sub_agent_id, remote_session_id, title, created_at, updated_at, last_read_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, agentId, subAgentId ?? null, remoteSessionId ?? null, title, now, now, now);
    return this.getConversation(id)!;
  }
  getConversation(id: string): ConversationRow | undefined {
    return this.db.prepare(`SELECT c.*, ${UNREAD} FROM conversations c WHERE c.id = ?`).get(id) as unknown as ConversationRow | undefined;
  }
  listConversations(agentId?: string): ConversationRow[] {
    const sql = `SELECT c.*, ${UNREAD} FROM conversations c ${agentId ? 'WHERE c.agent_id = ?' : ''} ORDER BY c.favorite DESC, c.updated_at DESC LIMIT 500`;
    return (agentId ? this.db.prepare(sql).all(agentId) : this.db.prepare(sql).all()) as unknown as ConversationRow[];
  }
  /** AgentUI conversation attached to a remote session (e.g. dedicated chat of a cron task). */
  findByRemoteSession(agentId: string, remoteSessionId: string): ConversationRow | undefined {
    return this.db
      .prepare('SELECT * FROM conversations WHERE agent_id = ? AND remote_session_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(agentId, remoteSessionId) as unknown as ConversationRow | undefined;
  }
  /**
     * Deletes a chat, **platform session included**: the channel plugin is first asked
     * to erase its session, and local data is only erased once it confirmed (otherwise the chat is kept
     * as is). A chat without a real remote session (never used, or proactive messages
     * filed in the `home` session) has nothing to delete on the agent side.
   */
  async deleteConversation(id: string): Promise<void> {
    const conv = this.getConversation(id);
    if (!conv) return;
    // A live run still writes into rows we are about to erase, and the platform refuses to
    // delete an active session: we stop it and wait for it to end (the run ends with a terminal
    // event from the plugin, consumed right here).
    if (this.active.has(id)) {
      await this.abort(id);
      const deadline = Date.now() + ABORT_GRACE_MS;
      while (this.active.has(id) && Date.now() < deadline) await sleep(50);
      if (this.active.has(id)) throw Object.assign(new Error('The run could not be stopped'), { statusCode: 502 });
    }
    const sessionId = conv.remote_session_id;
    if (sessionId && sessionId !== HOME_SESSION) {
      const adapter = this.adapters.get(conv.agent_id);
      if (!adapter?.deleteSession) {
        throw Object.assign(
          new Error(`${adapter?.name ?? conv.agent_id}: deleting the session on the agent side is not supported`),
          { statusCode: 501 },
        );
      }
      await adapter.deleteSession(sessionId); // failure → nothing is erased locally
    }
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    this.files?.removeConversation(id);
  }
  /** Marks the chat read (all messages received so far) and notifies the other devices. */
  markRead(id: string) {
    // max(now, last agent message): a message dated slightly in the future ("now + 1" at the start of a run) is indeed read
    const r = this.db
      .prepare(`UPDATE conversations SET last_read_at = MAX(?, COALESCE((SELECT MAX(created_at) FROM messages WHERE conversation_id = conversations.id AND role = 'assistant'), 0)) WHERE id = ?`)
      .run(Date.now(), id);
    if (Number(r.changes)) this.broadcast({ type: 'conversation.read', conversationId: id });
  }
  /** Stores the consumption of the session (cumulative on the agent side) and notifies connected devices. */
  setUsage(id: string, usage: Usage) {
    this.db.prepare('UPDATE conversations SET usage = ? WHERE id = ?').run(JSON.stringify(usage), id);
  }
  /**
     * Remote session identifier of a chat, created if needed: allows acting on the agent's session
     * (model choice) before the first message. Channel plugins create the session on first use.
   */
  ensureRemoteSession(id: string): string {
    const c = this.getConversation(id);
    if (c?.remote_session_id) return c.remote_session_id;
    const sid = randomUUID();
    this.db.prepare('UPDATE conversations SET remote_session_id = ? WHERE id = ?').run(sid, id);
    return sid;
  }
  setArchived(id: string, archived: boolean) {
    this.db.prepare('UPDATE conversations SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  }
  setFavorite(id: string, favorite: boolean) {
    this.db.prepare('UPDATE conversations SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id);
  }
  /**
     * Full-text search in titles and messages (case- and accent-insensitive).
     * All words of the query must appear in the title, or in a single message. Titles first, then
     * most recent chats; the excerpt comes from the most recent matching message.
   */
  search(query: string, limit = 30): SearchHit[] {
    const words = [...new Set(fold(query).split(/\s+/).filter(Boolean))];
    if (!words.length || fold(query).length < 2) return [];
    const matches = (text: string) => { const f = fold(text); return words.every((w) => f.includes(w)); };
    const convs = this.db.prepare('SELECT id, agent_id, title, updated_at, favorite, archived FROM conversations').all() as any[];
    const hits = new Map<string, SearchHit>();
    for (const c of convs) {
      if (matches(c.title)) hits.set(c.id, { id: c.id, agentId: c.agent_id, title: c.title, updatedAt: c.updated_at, favorite: !!c.favorite, archived: !!c.archived, inTitle: true });
    }
    const info = new Map(convs.map((c) => [c.id as string, c]));
    // Messages from newest to oldest: the first one that matches provides the excerpt.
    const rows = this.db.prepare("SELECT conversation_id, text FROM messages WHERE role IN ('user','assistant') AND text != '' ORDER BY created_at DESC").all() as any[];
    const withSnippet = new Set<string>();
    for (const r of rows) {
      if (withSnippet.has(r.conversation_id) || !matches(r.text)) continue;
      withSnippet.add(r.conversation_id);
      const { snippet, marks } = makeSnippet(r.text, words);
      const c = info.get(r.conversation_id);
      if (!c) continue;
      const hit = hits.get(c.id) ?? { id: c.id, agentId: c.agent_id, title: c.title, updatedAt: c.updated_at, favorite: !!c.favorite, archived: !!c.archived, inTitle: false };
      hits.set(c.id, { ...hit, snippet, marks });
    }
    return [...hits.values()]
      .sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }
  renameConversation(id: string, title: string) {
    this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
    this.broadcast({ type: 'conversation.renamed', conversationId: id, title });
  }

  getMessages(convId: string): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid')
      .all(convId) as any[];
    const tools = this.db
      .prepare('SELECT t.* FROM tool_calls t JOIN messages m ON m.id = t.message_id WHERE m.conversation_id = ? ORDER BY t.started_at')
      .all(convId) as any[];
    const subs = this.db
      .prepare('SELECT s.* FROM subagent_runs s JOIN messages m ON m.id = s.message_id WHERE m.conversation_id = ? ORDER BY s.started_at')
      .all(convId) as any[];
    const atts = this.db
      .prepare('SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = ? ORDER BY a.rowid')
      .all(convId) as any[];
    return rows.map((r) => ({
      id: r.id,
      attachments: atts.filter((a) => a.message_id === r.id).map((a) => ({ id: a.id, name: a.name, mimeType: a.mime_type, size: a.size })),
      role: r.role,
      text: r.text,
      hidden: r.hidden ? true : undefined,
      reasoning: r.reasoning ?? undefined,
      createdAt: r.created_at,
      runId: r.run_id ?? undefined,
      status: r.status ?? undefined,
      pendingQuestion: r.pending_question ?? undefined,
      toolCalls: tools
        .filter((t) => t.message_id === r.id)
        .map<ToolCall>((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          args: t.args ? JSON.parse(t.args) : undefined,
          resultPreview: t.result_preview ?? undefined,
          resultTruncated: !!t.result_truncated,
          startedAt: t.started_at,
          endedAt: t.ended_at ?? undefined,
          parentSubAgentRunId: t.parent_subagent_run_id ?? undefined,
        })),
      subAgentRuns: subs
        .filter((s) => s.message_id === r.id)
        .map<SubAgentRun>((s) => ({ id: s.id, name: s.name, status: s.status, startedAt: s.started_at, endedAt: s.ended_at ?? undefined, reasoning: s.reasoning ?? undefined, summary: s.summary ?? undefined, sessionId: s.session_id ?? undefined })),
    }));
  }

  /** Media that appear in the agent's transcript shortly after the run ends (spaced polls, ~25 s). */
  private async lateMedia(conv: ConversationRow, runId: string, messageId: string, seen: Set<string>, emit: (e: AgentEvent) => void) {
    const ad = this.adapters.get(conv.agent_id);
    const sessionId = this.getConversation(conv.id)?.remote_session_id;
    if (!ad?.collectMedia || !sessionId) return;
    for (const delay of [1500, 3000, 6000, 12000]) {
      await new Promise((r) => setTimeout(r, delay));
      const found = await ad.collectMedia(runId, sessionId, seen).catch(() => []);
      for (const ev of found) {
        if (ev.type !== 'message.media') continue;
        const added = await this.attachMedia(conv, messageId, ev);
        if (added) emit({ type: 'attachment.added', attachment: added });
      }
    }
  }

  /** Fetches a media produced by the agent and records it as an attachment of the message. */
  private async attachMedia(conv: ConversationRow, messageId: string, ev: Extract<AgentEvent, { type: 'message.media' }>) {
    const ad = this.adapters.get(conv.agent_id);
    if (!ad?.fetchMedia || !this.files) return undefined;
    try {
      const { data, mimeType } = await ad.fetchMedia(ev.url);
      return this.files.save(messageId, conv.id, [{ name: ev.name, mimeType: ev.mimeType ?? mimeType, data }])[0];
    } catch (e) {
      console.error('[media] download failed:', (e as Error).message);
      return undefined;
    }
  }

  /** A finished run leaves no tool or sub-agent "running" (their end event may never arrive). */
  private closeRunning(messageId: string, status: 'done' | 'failed', now: number) {
    this.db.prepare('UPDATE messages SET pending_question = NULL WHERE id = ?').run(messageId);
    this.db.prepare("UPDATE tool_calls SET status = ?, ended_at = ? WHERE message_id = ? AND status = 'running'").run(status, now, messageId);
    this.db.prepare("UPDATE subagent_runs SET status = ?, ended_at = ? WHERE message_id = ? AND status = 'running' AND session_id IS NULL").run(status, now, messageId);
  }

  private following = new Set<string>();

  /** Tracks the session of a sub-agent (which may end after the main run) and syncs reasoning, tools and reply. */
  private async followSub(conv: ConversationRow, messageId: string, subId: string, sessionId: string) {
    const ad = this.adapters.get(conv.agent_id);
    const key = `${messageId}:${subId}`;
    if (!ad?.subSession || this.following.has(key)) return;
    this.following.add(key);
    let last = '';
    let ended = false;
    const deadline = Date.now() + 15 * 60_000;
    try {
      while (Date.now() < deadline) {
        const r = await ad.subSession(sessionId).catch(() => undefined);
        if (r) {
          const reasoning = r.messages.map((m) => m.reasoning).filter(Boolean).join('\n\n');
          const tools = r.messages.flatMap((m) => m.toolCalls ?? []);
          const answer = r.messages.filter((m) => m.role === 'assistant' && m.text).at(-1)?.text;
          const sig = JSON.stringify([reasoning, tools, answer, r.ended]);
          if (sig !== last) {
            last = sig;
            const now = Date.now();
            this.db.prepare('UPDATE subagent_runs SET reasoning = ?, summary = ? WHERE message_id = ? AND id = ?').run(reasoning || null, answer ?? null, messageId, subId);
            const ins = this.db.prepare('INSERT OR REPLACE INTO tool_calls (id, message_id, name, status, args, result_preview, result_truncated, parent_subagent_run_id, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
            for (const t of tools) {
              ins.run(`${subId}:${t.id}`, messageId, t.name, t.status, t.args === undefined ? null : JSON.stringify(t.args), t.resultPreview ?? null, t.resultTruncated ? 1 : 0, subId, t.startedAt, t.endedAt ?? null);
            }
            if (r.ended) {
              ended = true;
              this.db.prepare("UPDATE subagent_runs SET status = 'done', ended_at = ? WHERE message_id = ? AND id = ?").run(now, messageId, subId);
            }
            this.broadcast({ type: 'event', seq: 0, agentId: conv.agent_id, sessionId: conv.id, runId: '', event: { type: 'subagent.sync', id: subId } });
          }
          if (r.ended) break;
        }
        await new Promise((res) => setTimeout(res, 2000));
      }
    } finally {
      this.following.delete(key);
      if (!ended) {
        this.db.prepare("UPDATE subagent_runs SET status = 'failed', ended_at = ? WHERE message_id = ? AND id = ? AND status = 'running'").run(Date.now(), messageId, subId);
        this.broadcast({ type: 'event', seq: 0, agentId: conv.agent_id, sessionId: conv.id, runId: '', event: { type: 'subagent.sync', id: subId } });
      }
    }
  }

  eventsSince(seq: number): ServerPush[] {
    const rows = this.db
      .prepare('SELECT e.seq, e.payload, e.conversation_id, e.run_id, c.agent_id FROM events e JOIN conversations c ON c.id = e.conversation_id WHERE e.seq > ? ORDER BY e.seq LIMIT 5000')
      .all(seq) as any[];
    return rows.map((r) => ({
      type: 'event',
      seq: r.seq,
      agentId: r.agent_id,
      sessionId: r.conversation_id,
      runId: r.run_id,
      event: JSON.parse(r.payload) as AgentEvent,
    }));
  }

  isRunning(convId: string): boolean {
    return this.active.has(convId);
  }

  // ---------- Run ----------
  async start(convId: string, text: string, attachments: OutgoingAttachment[] = []): Promise<{ runId: string; messageId: string }> {
    const conv = this.getConversation(convId);
    if (!conv) throw new Error('Unknown conversation');
    if (this.active.has(convId)) throw new Error('A run is already in progress in this conversation');
    const adapter = this.adapters.get(conv.agent_id);
    if (!adapter) throw new Error('Unknown agent');

    // Validation BEFORE any write: an attachment error leaves nothing behind.
    const prepared = prepareAttachments(text, attachments, adapter.capabilities());
    const now = Date.now();
    const userMsgId = randomUUID();
    this.db
      .prepare('INSERT INTO messages (id, conversation_id, role, text, status, created_at) VALUES (?,?,?,?,?,?)')
      .run(userMsgId, convId, 'user', text, 'done', now);
    if (prepared.stored.length) this.files?.save(userMsgId, convId, prepared.stored);
    if (conv.title === 'Nouvelle conversation') {
      const label = text.replace(/\s+/g, ' ').trim() || prepared.stored[0]?.name || 'Attachment';
      this.renameConversation(convId, label.slice(0, 60));
    }

    const handle = await adapter.send(conv.remote_session_id ?? undefined, {
      text: prepared.agentText,
      subAgentId: conv.sub_agent_id ?? undefined,
      attachments: prepared.native,
    });
    this.db.prepare('UPDATE conversations SET remote_session_id = ?, updated_at = ? WHERE id = ?').run(handle.sessionId, now, convId);

    const messageId = randomUUID();
    this.db
      .prepare('INSERT INTO messages (id, conversation_id, role, text, run_id, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(messageId, convId, 'assistant', '', handle.runId, 'streaming', now + 1);
    this.active.set(convId, { agentId: conv.agent_id, runId: handle.runId, remoteSessionId: handle.sessionId, convId });

    void this.consume(conv, handle.runId, messageId, handle.events);
    return { runId: handle.runId, messageId };
  }

  /**
     * At startup: reattaches runs left "streaming" (server restarted mid-run).
     * Cannot resume → the message is marked interrupted instead of spinning forever.
   */
  async recover(): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT m.id AS message_id, m.run_id, m.text, c.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.role = 'assistant' AND m.status = 'streaming' AND m.run_id IS NOT NULL`,
      )
      .all() as any[];
    let resumed = 0;
    for (const r of rows) {
      const conv = r as unknown as ConversationRow;
      const adapter = this.adapters.get(conv.agent_id);
      let handle = null;
      try {
        if (adapter?.resume && conv.remote_session_id && !this.active.has(conv.id)) {
          handle = await adapter.resume(r.run_id, conv.remote_session_id, conv.sub_agent_id ?? undefined);
        }
      } catch {
        handle = null;
      }
      if (!handle) {
        this.db.prepare("UPDATE messages SET status = 'failed', text = text || ? WHERE id = ?").run('\n\n⚠️ Run interrupted (AgentUI restarted, cannot resume).', r.message_id);
        this.broadcast({ type: 'event', seq: 0, agentId: conv.agent_id, sessionId: conv.id, runId: r.run_id, event: { type: 'run.failed', error: 'Run interrompu' } });
        continue;
      }
      this.active.set(conv.id, { agentId: conv.agent_id, runId: r.run_id, remoteSessionId: conv.remote_session_id!, convId: conv.id });
      void this.consume(conv, r.run_id, r.message_id, handle.events, r.text as string);
      resumed++;
    }
    return resumed;
  }

  /**
     * Proactive message from an agent (cron, spontaneous send): filed in the conversation matching the remote
     * session, or in the agent's "home" chat (created if needed), then notified like a reply.
   */
  deliver(
    agentId: string,
    remoteSessionId: string | undefined,
    text: string,
    media: { name: string; mimeType: string; data: Buffer }[],
    agentName = agentId,
    title?: string,
  ): ConversationRow {
    const key = remoteSessionId ?? HOME_SESSION;
    let conv = this.findByRemoteSession(agentId, key);
    if (!conv) {
      conv = this.createConversation(agentId, undefined, title ?? (key === HOME_SESSION ? `Messages from ${agentName}` : 'Message from the agent'), key);
      this.db.prepare('UPDATE conversations SET last_read_at = 0 WHERE id = ?').run(conv.id); // created by the agent: unread from the start
    }
    const now = Date.now();
    const messageId = randomUUID();
    const runId = `outbound-${randomUUID()}`;
    this.db
      .prepare('INSERT INTO messages (id, conversation_id, role, text, run_id, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(messageId, conv.id, 'assistant', text, runId, 'done', now);
    if (media.length) this.files?.save(messageId, conv.id, media);
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conv.id);
    const event: AgentEvent = { type: 'message.added', messageId };
    const r = this.db
      .prepare('INSERT INTO events (conversation_id, run_id, payload, created_at) VALUES (?,?,?,?)')
      .run(conv.id, runId, JSON.stringify(event), now);
    this.broadcast({ type: 'event', seq: Number(r.lastInsertRowid), agentId, sessionId: conv.id, runId, event });
    this.onRunFinished?.(conv, 'completed', (text || media[0]?.name || '').slice(0, 140));
    return conv;
  }

  async abort(convId: string) {
    const a = this.active.get(convId);
    if (!a) return;
    await this.adapters.get(a.agentId)?.abort(a.runId, a.remoteSessionId);
  }

  /** True if the current run waits for a user answer (question.requested without question.resolved) and the agent can receive it. */
  awaitingReply(convId: string): boolean {
    const a = this.active.get(convId);
    if (!a || !this.adapters.get(a.agentId)?.reply) return false;
    return !!this.db
      .prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND run_id = ? AND pending_question IS NOT NULL LIMIT 1')
      .get(convId, a.runId);
  }

  /**
   * Passes the user's answer to the question asked by the agent; the current run continues. An event of a dynamic widget (`widget`) is
   * the same thing over the live session the agent keeps open with `agentui_widget_custom_wait`: the agent gets it tagged with the widget, and the
   * message is stored hidden (the widget shows its effect, the chat does not).
   */
  async reply(convId: string, text: string, widget?: { token?: string }): Promise<{ runId: string; messageId: string }> {
    const a = this.active.get(convId);
    if (!a || !this.awaitingReply(convId)) throw new Error('A run is already in progress in this conversation');
    await this.adapters.get(a.agentId)!.reply!(a.runId, a.remoteSessionId, widget ? JSON.stringify({ agentui: 'widget-event', widget: widget.token ?? null, text }) : text);
    this.db
      .prepare('INSERT INTO messages (id, conversation_id, role, text, status, created_at, hidden) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), convId, 'user', text, 'done', Date.now(), widget ? 1 : 0);
    const m = this.db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND run_id = ?').get(convId, a.runId) as { id: string };
    return { runId: a.runId, messageId: m.id };
  }

  async approve(convId: string, approvalId: string, approve: boolean) {
    const a = this.active.get(convId);
    if (!a) throw new Error('No active run');
    const ad = this.adapters.get(a.agentId);
    if (!ad?.resolveApproval) throw new Error('Approvals not supported');
    await ad.resolveApproval(a.runId, approvalId, approve);
  }

  private async consume(conv: ConversationRow, runId: string, messageId: string, events: AsyncIterable<AgentEvent>, initialText = '') {
    let outcome: 'completed' | 'failed' | 'aborted' = 'completed';
    let text = initialText;
    const mediaSeen = new Set<string>();
    const emit = (event: AgentEvent) => {
      const r = this.db
        .prepare('INSERT INTO events (conversation_id, run_id, payload, created_at) VALUES (?,?,?,?)')
        .run(conv.id, runId, JSON.stringify(event), Date.now());
      this.broadcast({ type: 'event', seq: Number(r.lastInsertRowid), agentId: conv.agent_id, sessionId: conv.id, runId, event });
    };
    try {
      for await (const ev of events) {
        if (ev.type === 'message.media') {
          mediaSeen.add(ev.url);
          const added = await this.attachMedia(conv, messageId, ev);
          if (added) emit({ type: 'attachment.added', attachment: added });
          continue;
        }
        if (ev.type === 'conversation.title') {
          const title = String(ev.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
          if (title) this.renameConversation(conv.id, title);
          continue;
        }
        if (ev.type === 'usage') { this.setUsage(conv.id, ev.usage); emit(ev); continue; }
        text = this.apply(messageId, ev, text);
        if (ev.type === 'run.failed') outcome = 'failed';
        if (ev.type === 'run.aborted') outcome = 'aborted';
        emit(ev);
        if (ev.type === 'subagent.start' && ev.sessionId) void this.followSub(conv, messageId, ev.id, ev.sessionId);
      }
    } catch (e) {
      outcome = 'failed';
      const ev: AgentEvent = { type: 'run.failed', error: (e as Error).message };
      this.apply(messageId, ev, text);
      emit(ev);
    }
    // Stream ended without an explicit terminal event
    const st = this.db.prepare('SELECT status FROM messages WHERE id = ?').get(messageId) as { status: string };
    if (st.status === 'streaming') {
      this.db.prepare("UPDATE messages SET status = 'done' WHERE id = ?").run(messageId);
      emit({ type: 'run.completed' });
    }
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conv.id);
    this.active.delete(conv.id);
    void this.lateMedia(conv, runId, messageId, mediaSeen, emit);
    this.onRunFinished?.(conv, outcome, text.replace(/\[\[agentui:[0-9a-f]+\]\]/g, '').trim().slice(0, 140));
  }

  /** Applies an event to the persistent state of the assistant message. */
  private apply(messageId: string, ev: AgentEvent, text: string): string {
    const now = Date.now();
    switch (ev.type) {
      case 'message.delta':
        this.db.prepare('UPDATE messages SET text = text || ? WHERE id = ?').run(ev.text, messageId);
        return text + ev.text;
      case 'message.final':
        this.db.prepare('UPDATE messages SET text = ? WHERE id = ?').run(ev.text, messageId);
        return ev.text;
      case 'reasoning.delta':
        this.db.prepare("UPDATE messages SET reasoning = COALESCE(reasoning, '') || ? WHERE id = ?").run(ev.text, messageId);
        return text;
      case 'tool.started':
        this.db
          .prepare('INSERT OR REPLACE INTO tool_calls (id, message_id, name, status, args, parent_subagent_run_id, started_at) VALUES (?,?,?,?,?,?,?)')
          .run(ev.id, messageId, ev.name, 'running', ev.args === undefined ? null : JSON.stringify(ev.args), ev.parentSubAgentRunId ?? null, now);
        return text;
      case 'tool.completed':
        this.db
          .prepare('UPDATE tool_calls SET status = ?, result_preview = ?, result_truncated = ?, ended_at = ? WHERE message_id = ? AND id = ?')
          .run(ev.failed ? 'failed' : 'done', ev.result ?? null, ev.truncated ? 1 : 0, now, messageId, ev.id);
        return text;
      case 'question.requested':
        this.db.prepare('UPDATE messages SET pending_question = ? WHERE id = ?').run(ev.id, messageId);
        return text;
      case 'question.resolved':
        this.db.prepare('UPDATE messages SET pending_question = NULL WHERE id = ? AND pending_question = ?').run(messageId, ev.id);
        return text;
      case 'subagent.start':
        this.db
          .prepare('INSERT OR REPLACE INTO subagent_runs (id, message_id, name, status, started_at, session_id) VALUES (?,?,?,?,?,?)')
          .run(ev.id, messageId, ev.name, 'running', now, ev.sessionId ?? null);
        return text;
      case 'subagent.end':
        this.db
          .prepare('UPDATE subagent_runs SET status = ?, ended_at = ? WHERE message_id = ? AND id = ?')
          .run(ev.failed ? 'failed' : 'done', now, messageId, ev.id);
        return text;
      case 'run.completed':
        this.db.prepare("UPDATE messages SET status = 'done' WHERE id = ?").run(messageId);
        this.closeRunning(messageId, 'done', now);
        return text;
      case 'run.aborted':
        this.db.prepare("UPDATE messages SET status = 'aborted' WHERE id = ?").run(messageId);
        this.closeRunning(messageId, 'failed', now);
        return text;
      case 'run.failed':
        this.closeRunning(messageId, 'failed', now);
        this.db
          .prepare("UPDATE messages SET status = 'failed', text = text || ? WHERE id = ?")
          .run(`\n\n⚠️ ${ev.error}`, messageId);
        return text;
      default:
        return text;
    }
  }
}
