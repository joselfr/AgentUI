import { randomUUID } from 'node:crypto';
import type { AgentEvent, Message, OutgoingAttachment, ServerPush, ToolCall, SubAgentRun } from '@agentui/shared';
import type { DB } from './db.js';
import type { AgentAdapter } from './agents/types.js';
import { ASK_INSTRUCTIONS } from './interactive.js';
import { prepareAttachments, type AttachmentStore } from './attachments.js';

export interface ConversationRow {
  id: string;
  agent_id: string;
  sub_agent_id: string | null;
  remote_session_id: string | null;
  title: string;
  created_at: number;
  updated_at: number;
}

/** Clé de session synthétique des messages proactifs rangés dans une discussion « maison » (voir `deliver`). */
const HOME_SESSION = 'home';
/** Attente maximale de la fin d'un run avant de supprimer sa discussion. */
const ABORT_GRACE_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Listener = (push: ServerPush) => void;

/**
 * Orchestre les runs côté serveur : les flux d'agent sont consommés ici, persistés,
 * puis diffusés aux clients WS. Un run continue même si plus aucun client n'est connecté.
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
      .prepare('INSERT INTO conversations (id, agent_id, sub_agent_id, remote_session_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, agentId, subAgentId ?? null, remoteSessionId ?? null, title, now, now);
    return this.getConversation(id)!;
  }
  getConversation(id: string): ConversationRow | undefined {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as unknown as ConversationRow | undefined;
  }
  listConversations(agentId?: string): ConversationRow[] {
    const sql = `SELECT * FROM conversations ${agentId ? 'WHERE agent_id = ?' : ''} ORDER BY updated_at DESC LIMIT 500`;
    return (agentId ? this.db.prepare(sql).all(agentId) : this.db.prepare(sql).all()) as unknown as ConversationRow[];
  }
  /** Conversation AgentUI rattachée à une session distante (ex. discussion dédiée d'une tâche cron). */
  findByRemoteSession(agentId: string, remoteSessionId: string): ConversationRow | undefined {
    return this.db
      .prepare('SELECT * FROM conversations WHERE agent_id = ? AND remote_session_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(agentId, remoteSessionId) as unknown as ConversationRow | undefined;
  }
  /**
   * Supprime une discussion, **session de plateforme comprise** : on demande d'abord au plugin canal
   * d'effacer sa session, et on n'efface localement que s'il a confirmé (sinon la discussion est conservée
   * telle quelle). Une discussion sans session distante réelle (jamais utilisée, ou messages proactifs
   * rangés dans la session `home`) n'a rien à supprimer côté agent.
   */
  async deleteConversation(id: string): Promise<void> {
    const conv = this.getConversation(id);
    if (!conv) return;
    // Un run vivant écrit encore dans des lignes qu'on s'apprête à effacer, et la plateforme refuse de
    // supprimer une session active : on l'arrête et on attend sa fin (le run se termine par un événement
    // terminal du plugin, consommé ici même).
    if (this.active.has(id)) {
      await this.abort(id);
      const deadline = Date.now() + ABORT_GRACE_MS;
      while (this.active.has(id) && Date.now() < deadline) await sleep(50);
      if (this.active.has(id)) throw Object.assign(new Error('Le run n’a pas pu être arrêté'), { statusCode: 502 });
    }
    const sessionId = conv.remote_session_id;
    if (sessionId && sessionId !== HOME_SESSION) {
      const adapter = this.adapters.get(conv.agent_id);
      if (!adapter?.deleteSession) {
        throw Object.assign(
          new Error(`${adapter?.name ?? conv.agent_id} : la suppression de la session côté agent n’est pas supportée`),
          { statusCode: 501 },
        );
      }
      await adapter.deleteSession(sessionId); // échec → rien n'est effacé localement
    }
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    this.files?.removeConversation(id);
  }
  renameConversation(id: string, title: string) {
    this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
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
      reasoning: r.reasoning ?? undefined,
      createdAt: r.created_at,
      runId: r.run_id ?? undefined,
      status: r.status ?? undefined,
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

  /** Médias qui apparaissent dans le transcript de l'agent peu après la fin du run (relevés espacés, ~25 s). */
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

  /** Récupère un média produit par l'agent et l'enregistre comme pièce jointe du message. */
  private async attachMedia(conv: ConversationRow, messageId: string, ev: Extract<AgentEvent, { type: 'message.media' }>) {
    const ad = this.adapters.get(conv.agent_id);
    if (!ad?.fetchMedia || !this.files) return undefined;
    try {
      const { data, mimeType } = await ad.fetchMedia(ev.url);
      return this.files.save(messageId, conv.id, [{ name: ev.name, mimeType: ev.mimeType ?? mimeType, data }])[0];
    } catch (e) {
      console.error('[media] échec du téléchargement :', (e as Error).message);
      return undefined;
    }
  }

  /** Un run terminé ne laisse ni outil ni sous-agent « en cours » (leur événement de fin peut ne jamais arriver). */
  private closeRunning(messageId: string, status: 'done' | 'failed', now: number) {
    this.db.prepare("UPDATE tool_calls SET status = ?, ended_at = ? WHERE message_id = ? AND status = 'running'").run(status, now, messageId);
    this.db.prepare("UPDATE subagent_runs SET status = ?, ended_at = ? WHERE message_id = ? AND status = 'running' AND session_id IS NULL").run(status, now, messageId);
  }

  private following = new Set<string>();

  /** Suit la session d'un sous-agent (qui peut finir après le run principal) et synchronise raisonnement, outils et réponse. */
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
  async start(convId: string, text: string, attachments: OutgoingAttachment[] = [], opts: { interactive?: boolean } = {}): Promise<{ runId: string; messageId: string }> {
    const conv = this.getConversation(convId);
    if (!conv) throw new Error('Conversation inconnue');
    if (this.active.has(convId)) throw new Error('Un run est déjà en cours dans cette conversation');
    const adapter = this.adapters.get(conv.agent_id);
    if (!adapter) throw new Error('Agent inconnu');

    // Validation AVANT toute écriture : une erreur de pièce jointe ne laisse rien derrière elle.
    const prepared = prepareAttachments(text, attachments, adapter.capabilities());
    // Convention « ask » : déclarée à l'agent une seule fois, dans le premier message du fil.
    const first = !(this.db.prepare('SELECT 1 AS x FROM messages WHERE conversation_id = ? LIMIT 1').get(convId));
    if (opts.interactive && first) prepared.agentText = `${ASK_INSTRUCTIONS}\n\n${prepared.agentText}`;
    const now = Date.now();
    const userMsgId = randomUUID();
    this.db
      .prepare('INSERT INTO messages (id, conversation_id, role, text, status, created_at) VALUES (?,?,?,?,?,?)')
      .run(userMsgId, convId, 'user', text, 'done', now);
    if (prepared.stored.length) this.files?.save(userMsgId, convId, prepared.stored);
    if (conv.title === 'Nouvelle conversation') {
      const label = text.replace(/\s+/g, ' ').trim() || prepared.stored[0]?.name || 'Pièce jointe';
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
   * Au démarrage : rattache les runs restés « streaming » (serveur redémarré en plein run).
   * Impossible de reprendre → le message est marqué interrompu au lieu de tourner indéfiniment.
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
        this.db.prepare("UPDATE messages SET status = 'failed', text = text || ? WHERE id = ?").run('\n\n⚠️ Run interrompu (AgentUI a redémarré, reprise impossible).', r.message_id);
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
   * Message proactif d'un agent (cron, envoi spontané) : rangé dans la conversation correspondant à la session
   * distante, ou dans la discussion « maison » de l'agent (créée au besoin), puis notifié comme une réponse.
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
      conv = this.createConversation(agentId, undefined, title ?? (key === HOME_SESSION ? `Messages de ${agentName}` : 'Message de l’agent'), key);
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

  async approve(convId: string, approvalId: string, approve: boolean) {
    const a = this.active.get(convId);
    if (!a) throw new Error('Aucun run actif');
    const ad = this.adapters.get(a.agentId);
    if (!ad?.resolveApproval) throw new Error('Approbations non supportées');
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
    // Flux terminé sans événement terminal explicite
    const st = this.db.prepare('SELECT status FROM messages WHERE id = ?').get(messageId) as { status: string };
    if (st.status === 'streaming') {
      this.db.prepare("UPDATE messages SET status = 'done' WHERE id = ?").run(messageId);
      emit({ type: 'run.completed' });
    }
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conv.id);
    this.active.delete(conv.id);
    void this.lateMedia(conv, runId, messageId, mediaSeen, emit);
    this.onRunFinished?.(conv, outcome, text.slice(0, 140));
  }

  /** Applique un événement à l'état persistant du message assistant. */
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
