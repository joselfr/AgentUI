// Pont AgentUI ↔ runtime OpenClaw : un `inbound` devient un tour de canal (comme un message Telegram), et ce que
// produit le tour (deltas, outils, approbations, réponse, médias, fin) repart vers AgentUI en `event`.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { toInboundMediaFacts } from 'openclaw/plugin-sdk/channel-inbound';
import { deleteSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import type { AgentUIClient } from './client.js';
import type { AgentEvent, GatewayMessage, Media } from './protocol.js';
import { getAgentUIRuntime } from './runtime.js';
import { listSubAgents } from './agents.js';
import { jobAction, listJobs } from './cron.js';

export const CHANNEL = 'agentui';
export const HOME_CONVERSATION = 'home';
export const MAX_MEDIA = 20 * 1024 * 1024;
const MAX_RESULT = 20_000;
const ABORT_GRACE_MS = 5_000;

type Json = Record<string, any>;

interface Run {
  runId: string;
  conversationId: string;
  agentRunId?: string;
  abort: AbortController;
  /** Segments de texte déjà terminés (avant un outil) et segment en cours de streaming. */
  segments: string[];
  partial: string;
  /** Textes livrés par le cœur (blocs / réponse finale) : font foi pour `message.final`. */
  delivered: string[];
  tools: Set<string>;
  approvals: Set<string>;
  outcome?: 'completed' | 'failed';
  terminal: boolean;
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((p: Json) => p?.type === 'text' && typeof p.text === 'string').map((p: Json) => p.text).join('')
      : '';

const APPROVE_RE = /\/approve\s+([A-Za-z0-9_-]+)\s+allow-once/;

export class AgentUIBridge {
  private runs = new Map<string, Run>();

  constructor(
    private p: {
      cfg: OpenClawConfig;
      accountId: string;
      client: () => AgentUIClient | undefined;
      log: (msg: string) => void;
    },
  ) {}

  activeRuns(): Array<{ runId: string; conversationId: string }> {
    return [...this.runs.values()].filter((r) => !r.terminal).map((r) => ({ runId: r.runId, conversationId: r.conversationId }));
  }

  async handle(msg: GatewayMessage): Promise<void> {
    switch (msg.type) {
      case 'inbound':
        return this.onInbound(msg);
      case 'abort':
        return this.onAbort(msg.runId);
      case 'approval':
        return this.onApproval(msg);
      case 'rpc':
        return this.onRpc(msg);
      default:
        return;
    }
  }

  // ── AgentUI → OpenClaw ────────────────────────────────────────────────────

  private async onInbound(msg: Extract<GatewayMessage, { type: 'inbound' }>): Promise<void> {
    const run: Run = {
      runId: msg.runId,
      conversationId: msg.conversationId,
      abort: new AbortController(),
      segments: [],
      partial: '',
      delivered: [],
      tools: new Set(),
      approvals: new Set(),
      terminal: false,
    };
    this.runs.set(run.runId, run);
    const rt = getAgentUIRuntime();
    const unsubscribe = rt.events.onAgentEvent((evt) => {
      if (evt.runId === (run.agentRunId ?? run.runId)) this.onAgentEvent(run, evt.stream, evt.data ?? {});
    });
    try {
      const media = await this.saveAttachments(msg.attachments ?? []);
      const result = await this.dispatch({
        conversationId: msg.conversationId,
        messageId: msg.runId,
        text: msg.text,
        subAgentId: msg.subAgentId,
        media,
        run,
      });
      if (!result.dispatched) throw new Error('message non admis par OpenClaw');
      if (run.abort.signal.aborted) this.finish(run, { type: 'run.aborted' });
      else if (run.outcome === 'failed') this.finish(run, { type: 'run.failed', error: 'échec du run OpenClaw' });
      else this.finish(run, { type: 'run.completed' });
    } catch (e) {
      if (run.abort.signal.aborted) this.finish(run, { type: 'run.aborted' });
      else this.finish(run, { type: 'run.failed', error: e instanceof Error ? e.message : String(e) });
    } finally {
      unsubscribe();
      this.runs.delete(run.runId);
    }
  }

  /** Un tour de canal OpenClaw (même séquence que le canal Telegram : route → contexte → inbound.run). */
  private async dispatch(params: {
    conversationId: string;
    messageId: string;
    text: string;
    subAgentId?: string;
    media: Array<{ path: string; contentType?: string }>;
    run?: Run;
  }) {
    const rt = getAgentUIRuntime();
    const { cfg, accountId } = this.p;
    const { conversationId, messageId, text, run } = params;
    // Une discussion AgentUI = un pair direct = une session (dmScope forcé : sinon tous les DM partagent « main »).
    const route = rt.channel.routing.resolveAgentRoute({
      cfg,
      channel: CHANNEL,
      accountId,
      peer: { kind: 'direct', id: conversationId },
      dmScope: 'per-channel-peer',
      ...(params.subAgentId ? { defaultAgentId: params.subAgentId } : {}),
    });
    const isCommand = text.trim().startsWith('/');
    const ctxPayload = await rt.channel.inbound.buildContext({
      channel: CHANNEL,
      accountId,
      messageId,
      timestamp: Date.now(),
      from: `${CHANNEL}:${conversationId}`,
      sender: { id: 'agentui-owner', name: 'AgentUI' },
      conversation: { kind: 'direct', id: conversationId, label: conversationId },
      route: {
        agentId: route.agentId,
        accountId: route.accountId,
        dmScope: 'per-channel-peer',
        routeSessionKey: route.sessionKey,
        mainSessionKey: route.mainSessionKey,
      },
      reply: { to: conversationId },
      message: { body: text, rawBody: text, bodyForAgent: text, commandBody: text },
      access: { commands: { authorized: true } },
      ...(isCommand ? { command: { kind: 'text-slash' as const, authorized: true, body: text } } : {}),
      media: toInboundMediaFacts(params.media.map((m) => ({ path: m.path, contentType: m.contentType, messageId }))),
    });
    return rt.channel.inbound.run({
      channel: CHANNEL,
      accountId,
      raw: params,
      adapter: {
        ingest: () => ({ id: messageId, timestamp: Date.now(), rawText: text, textForAgent: text, textForCommands: text }),
        resolveTurn: () => ({
          cfg,
          channel: CHANNEL,
          accountId,
          route: { agentId: route.agentId, sessionKey: route.sessionKey, dmScope: 'per-channel-peer' as const },
          ctxPayload,
          delivery: {
            deliver: async (payload) => {
              if (run) await this.deliver(run, payload);
            },
            onError: (err, info) => this.p.log(`livraison ${info.kind} en échec : ${String(err)}`),
          },
          replyOptions: run
            ? {
                runId: run.runId,
                abortSignal: run.abort.signal,
                onAgentRunStart: (id: string) => {
                  run.agentRunId = id;
                },
                onAgentRunTerminalOutcome: (outcome: 'completed' | 'failed') => {
                  run.outcome = outcome;
                },
                onPartialReply: (p: { text?: string; delta?: string; replace?: true }) => this.onPartial(run, p),
                onAssistantMessageStart: () => this.segmentBreak(run),
                onApprovalEvent: (p: Json) => this.onApprovalEvent(run, p),
                // Les cartes d'outils viennent des événements d'agent : pas de messages de progression textuels.
                suppressDefaultToolProgressMessages: true,
                suppressToolProgressMessages: true,
              }
            : { suppressDefaultToolProgressMessages: true, suppressToolProgressMessages: true },
        }),
      },
    });
  }

  private onAbort(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || run.terminal) return;
    run.abort.abort();
    // Le run se termine normalement via son abortSignal ; filet de sécurité si le cœur ne rend pas la main.
    setTimeout(() => this.finish(run, { type: 'run.aborted' }), ABORT_GRACE_MS).unref?.();
  }

  private async onApproval(msg: Extract<GatewayMessage, { type: 'approval' }>): Promise<void> {
    const decision = !msg.approve ? 'deny' : msg.scope === 'always' ? 'allow-always' : 'allow-once';
    // Résolution « même chat » documentée par OpenClaw : /approve <id> <décision>. Réponse du cœur ignorée.
    await this.dispatch({
      conversationId: msg.conversationId,
      messageId: `approve-${msg.id}-${Date.now()}`,
      text: `/approve ${msg.id} ${decision}`,
      media: [],
    }).catch((e) => this.p.log(`approbation ${msg.id} en échec : ${String(e)}`));
  }

  /**
   * Supprime les sessions OpenClaw d'une discussion AgentUI (rpc deleteSession). Une discussion = un pair
   * direct = une entrée de session par agent : un tour lancé avec un sous-agent vit sous la clé de cet agent,
   * on efface donc toutes les clés candidates. Idempotent : une discussion inconnue n'est pas une erreur.
   */
  private async deleteSession(conversationId: string): Promise<void> {
    if (!conversationId) throw new Error('conversationId manquant');
    if ([...this.runs.values()].some((r) => !r.terminal && r.conversationId === conversationId)) {
      throw new Error('un run est en cours dans cette discussion');
    }
    const rt = getAgentUIRuntime();
    const { cfg, accountId } = this.p;
    const keys = new Set<string>();
    for (const agentId of listSubAgents(cfg).map((a) => a.id)) {
      // Même résolution de route que `dispatch` : c'est elle qui fixe la clé de session de la discussion.
      const route = rt.channel.routing.resolveAgentRoute({
        cfg,
        channel: CHANNEL,
        accountId,
        peer: { kind: 'direct', id: conversationId },
        dmScope: 'per-channel-peer',
        defaultAgentId: agentId,
      });
      if (route?.sessionKey) keys.add(route.sessionKey);
    }
    for (const sessionKey of keys) await deleteSessionEntry({ sessionKey });
  }

  private async onRpc(msg: Extract<GatewayMessage, { type: 'rpc' }>): Promise<void> {
    const client = this.p.client();
    const params = (msg.params ?? {}) as Json;
    if (msg.method === 'listJobs' || msg.method === 'jobAction') {
      try {
        const result =
          msg.method === 'listJobs'
            ? await listJobs(typeof params.subAgentId === 'string' ? params.subAgentId : undefined)
            : await jobAction(String(params.jobId ?? ''), String(params.action ?? ''));
        client?.send({ type: 'rpc.result', id: msg.id, result });
      } catch (e) {
        client?.send({ type: 'rpc.result', id: msg.id, error: e instanceof Error ? e.message : String(e) });
      }
    } else if (msg.method === 'listSubAgents') {
      client?.send({ type: 'rpc.result', id: msg.id, result: listSubAgents(this.p.cfg) });
    } else if (msg.method === 'deleteSession') {
      try {
        await this.deleteSession(String(params.conversationId ?? ''));
        client?.send({ type: 'rpc.result', id: msg.id, result: { ok: true } });
      } catch (e) {
        client?.send({ type: 'rpc.result', id: msg.id, error: e instanceof Error ? e.message : String(e) });
      }
    } else {
      client?.send({ type: 'rpc.result', id: msg.id, error: `méthode non supportée : ${msg.method}` });
    }
  }

  // ── OpenClaw → AgentUI ────────────────────────────────────────────────────

  private emit(run: Run, event: AgentEvent): void {
    if (run.terminal) return;
    this.p.client()?.send({ type: 'event', conversationId: run.conversationId, runId: run.runId, event });
  }

  private finish(run: Run, event: AgentEvent): void {
    if (run.terminal) return;
    if (!run.delivered.length && (run.segments.length || run.partial)) {
      this.emit(run, { type: 'message.final', text: [...run.segments, run.partial].filter(Boolean).join('\n\n') });
    }
    this.emit(run, event);
    run.terminal = true;
  }

  private onPartial(run: Run, p: { text?: string; delta?: string; replace?: true }): boolean {
    if (p.delta && !p.replace) {
      run.partial += p.delta;
      this.emit(run, { type: 'message.delta', text: p.delta });
    } else if (typeof p.text === 'string') {
      if (p.text.startsWith(run.partial) && !p.replace) {
        const delta = p.text.slice(run.partial.length);
        if (delta) this.emit(run, { type: 'message.delta', text: delta });
      } else {
        // Réécriture du segment : AgentUI remplace le texte accumulé.
        this.emit(run, { type: 'message.final', text: [...run.segments, p.text].join('\n\n') });
      }
      run.partial = p.text;
    }
    return true;
  }

  private segmentBreak(run: Run): boolean {
    if (run.partial) {
      run.segments.push(run.partial);
      run.partial = '';
      this.emit(run, { type: 'message.delta', text: '\n\n' });
    }
    return true;
  }

  private onAgentEvent(run: Run, stream: string, d: Json): void {
    if (stream === 'tool') {
      const id = String(d.toolCallId ?? '');
      if (!id) return;
      if (d.phase === 'start' && !run.tools.has(id)) {
        run.tools.add(id);
        this.emit(run, { type: 'tool.started', id, name: String(d.name ?? 'tool'), args: d.args });
      } else if (d.phase === 'result') {
        const txt = textOf(d.result?.content) || (d.result === undefined ? '' : JSON.stringify(d.result));
        this.emit(run, {
          type: 'tool.completed',
          id,
          name: typeof d.name === 'string' ? d.name : undefined,
          result: txt.slice(0, MAX_RESULT),
          truncated: txt.length > MAX_RESULT,
          failed: !!d.isError,
        });
      }
    } else if (stream === 'thinking' || stream === 'reasoning') {
      const text = d.delta ?? d.text;
      if (text) this.emit(run, { type: 'reasoning.delta', text: String(text) });
    }
  }

  private onApprovalEvent(run: Run, p: Json): boolean {
    const id = typeof p.approvalId === 'string' ? p.approvalId : undefined;
    if (!id || run.approvals.has(id) || /approved|denied|resolved|expired|allow|deny/i.test(String(p.status ?? ''))) return true;
    run.approvals.add(id);
    const head = p.title || p.reason || 'Approbation requise';
    this.emit(run, {
      type: 'approval.request',
      id,
      description: p.command ? `${head}\n\n\`\`\`\n${p.command}\n\`\`\`` : String(head),
      payload: p,
    });
    return true;
  }

  private async deliver(run: Run, payload: Json): Promise<void> {
    if (payload.isReasoning) {
      if (payload.text) this.emit(run, { type: 'reasoning.delta', text: String(payload.text) });
      return;
    }
    let text: string = typeof payload.text === 'string' ? payload.text : '';
    // Repli « même chat » du cœur : la consigne /approve devient une demande d'approbation AgentUI.
    const approve = APPROVE_RE.exec(text);
    if (approve?.[1]) {
      this.onApprovalEvent(run, { approvalId: approve[1], title: text.split('\n')[0] });
      text = '';
    }
    if (text.trim()) {
      run.delivered.push(text);
      this.emit(run, { type: 'message.final', text: run.delivered.join('\n\n') });
    }
    for (const media of await readPayloadMedia(payload)) this.emit(run, { type: 'message.media', ...media });
  }

  private async saveAttachments(attachments: Media[]): Promise<Array<{ path: string; contentType?: string }>> {
    const rt = getAgentUIRuntime();
    const saved = [];
    for (const a of attachments) {
      const s = await rt.channel.media.saveMediaBuffer(Buffer.from(a.data, 'base64'), a.mimeType, 'inbound', MAX_MEDIA, a.name);
      saved.push({ path: s.path, contentType: s.contentType ?? a.mimeType });
    }
    return saved;
  }
}

/** Médias d'un payload de réponse (chemins locaux ou URL) encodés pour le protocole. */
export async function readPayloadMedia(payload: Json, readLocal?: (path: string) => Promise<Buffer>): Promise<Media[]> {
  const urls: string[] = [...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []), ...(payload.mediaUrl ? [payload.mediaUrl] : [])];
  const out: Media[] = [];
  for (const url of [...new Set(urls)]) {
    try {
      out.push(await readMedia(url, readLocal));
    } catch {
      /* média inaccessible : ignoré */
    }
  }
  return out;
}

export async function readMedia(url: string, readLocal?: (path: string) => Promise<Buffer>): Promise<Media> {
  if (/^https?:\/\//.test(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_MEDIA) throw new Error('média trop volumineux');
    const mimeType = res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream';
    return { name: basename(new URL(url).pathname) || 'media', mimeType, data: data.toString('base64') };
  }
  const path = url.startsWith('file://') ? new URL(url).pathname : url;
  const data = readLocal ? await readLocal(path) : await readFile(path);
  if (data.length > MAX_MEDIA) throw new Error('média trop volumineux');
  return { name: basename(path), mimeType: mimeOf(path), data: data.toString('base64') };
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', txt: 'text/plain',
  md: 'text/markdown', json: 'application/json', csv: 'text/csv', zip: 'application/zip',
};
const mimeOf = (path: string) => MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
