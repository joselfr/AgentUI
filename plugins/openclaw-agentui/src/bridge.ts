// Pont AgentUI ↔ runtime OpenClaw : un `inbound` devient un tour de canal (comme un message Telegram), et ce que
// produit le tour (deltas, outils, approbations, réponse, médias, fin) repart vers AgentUI en `event`.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { toInboundMediaFacts } from 'openclaw/plugin-sdk/channel-inbound';
import { deleteSessionEntry, getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import type { AgentUIClient } from './client.js';
import type { AgentEvent, GatewayMessage, Media, Usage } from './protocol.js';
import { getAgentUIRuntime } from './runtime.js';
import { listSubAgents } from './agents.js';
import { jobAction, listJobs } from './cron.js';
import { randomBytes } from 'node:crypto';
import type { AskHost, AskResult } from './asks.js';
import { resolveQuestion } from './question.js';
import { askReplyText, askWidget, parseAskQuestions, type AskQuestion } from './ask.js';

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
  subAgentId?: string;
  /** Questions de l'outil `ask_user` en cours (arguments de l'outil) : le prompt du cœur devient un widget. */
  askQuestions?: AskQuestion[];
  /** Identifiant de la question `ask_user` en attente (fourni avec son prompt) : c'est par lui qu'on la résout. */
  askQuestionId?: string;
  /** Appel d'outil `ask_user` en cours : sa fin (réponse, annulation, délai) ferme la question. */
  askToolId?: string;
  /** Question d'un outil interactif (`agentui_ask`…) en attente : sa réponse (trame `reply`) débloque l'outil. */
  toolAsk?: { id: string; answer: (text: string) => void; cancel: () => void };
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

/** « fournisseur/modèle » → { provider, id } (un identifiant sans « / » n'a pas de fournisseur). */
function splitRef(ref: string): { provider?: string; id: string } {
  const i = ref.indexOf('/');
  return i > 0 ? { provider: ref.slice(0, i), id: ref.slice(i + 1) } : { id: ref };
}

const APPROVE_RE = /\/approve\s+([A-Za-z0-9_-]+)\s+allow-once/;

const ASK_TIMEOUT_MS = 30 * 60_000;

export class AgentUIBridge implements AskHost {
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
      case 'reply':
        return this.onReply(msg);
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
      subAgentId: msg.subAgentId,
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
      if (run.abort.signal.aborted) this.finishWithUsage(run, msg, { type: 'run.aborted' });
      else if (run.outcome === 'failed') this.finishWithUsage(run, msg, { type: 'run.failed', error: 'échec du run OpenClaw' });
      else this.finishWithUsage(run, msg, { type: 'run.completed' });
    } catch (e) {
      if (run.abort.signal.aborted) this.finishWithUsage(run, msg, { type: 'run.aborted' });
      else this.finishWithUsage(run, msg, { type: 'run.failed', error: e instanceof Error ? e.message : String(e) });
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
    /** Commande de contrôle (/model…) : les réponses livrées sont recueillies ici au lieu d'être affichées. */
    capture?: string[];
  }) {
    const rt = getAgentUIRuntime();
    const { cfg, accountId } = this.p;
    const { conversationId, messageId, text, run, capture } = params;
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
              if (capture) {
                if (typeof payload.text === 'string' && payload.text.trim()) capture.push(payload.text);
                return;
              }
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

  /**
   * Réponse à une question de l'agent (`ask_user`) en plein run. Le cœur enregistre la question comme cible du prochain
   * message texte de la session : on l'injecte comme n'importe quel message, il la capte et le run reprend (pas de nouveau tour).
   */
  private async onReply(msg: Extract<GatewayMessage, { type: 'reply' }>): Promise<void> {
    const run = this.runs.get(msg.runId);
    if (!run || run.terminal) return this.p.log(`réponse sans run en cours (${msg.runId})`);
    if (run.toolAsk) return run.toolAsk.answer(msg.text);
    const text = run.askQuestions ? askReplyText(run.askQuestions, msg.text) : msg.text;
    if (run.askQuestionId) {
      const id = run.askQuestionId;
      try {
        await resolveQuestion(id, text, `${CHANNEL}:${msg.conversationId}`);
        this.closeQuestion(run, id);
      } catch (e) {
        this.p.log(`réponse à la question ${id} en échec : ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    const capture: string[] = [];
    const result = await this.dispatch({
      conversationId: msg.conversationId,
      messageId: `reply-${msg.runId}-${Date.now()}`,
      text,
      subAgentId: run.subAgentId,
      media: [],
      capture,
    }).catch((e) => this.p.log(`réponse ${msg.runId} en échec : ${String(e)}`));
    if (result && capture.length) this.p.log(`réponse ${msg.runId} : le cœur a répondu « ${capture.join(' ').slice(0, 200)} »`);
  }

  /**
   * Outil interactif : affiche le widget `key` puis attend la réponse de l'utilisateur. La question est annoncée avant le
   * widget (AgentUI sait alors qu'une réponse est attendue) et fermée à la réponse, à l'arrêt, à la fin du run ou au délai.
   */
  askBlocking(conversationId: string, key: string, args: Json, signal?: AbortSignal): Promise<AskResult> | undefined {
    const run = [...this.runs.values()].find((r) => r.conversationId === conversationId && !r.terminal);
    if (!run) return undefined;
    if (run.toolAsk) return Promise.resolve({ error: "Une question est déjà en attente de réponse : attends-la avant d'en poser une autre." });
    return new Promise<AskResult>((resolve) => {
      const id = `ui_${randomBytes(6).toString('hex')}`;
      const timer = setTimeout(() => settle({ error: "Pas de réponse de l'utilisateur (délai dépassé)." }), ASK_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = () => settle({ error: 'Échange interrompu.' });
      const settle = (res: AskResult) => {
        if (run.toolAsk?.id !== id) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        run.toolAsk = undefined;
        this.emit(run, { type: 'question.resolved', id });
        resolve(res);
      };
      run.toolAsk = { id, answer: (answer) => settle({ answer }), cancel: () => settle({ error: 'Échange interrompu.' }) };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.emit(run, { type: 'question.requested', id });
      this.appendBlock(run, '```widget\n' + JSON.stringify({ type: key, arguments: args }) + '\n```');
    });
  }

  /** Ajoute un bloc de texte à la réponse en cours, après ce qui a déjà été écrit. */
  private appendBlock(run: Run, block: string): void {
    const flushed = !!run.partial;
    if (flushed) {
      run.segments.push(run.partial);
      run.partial = '';
    }
    run.segments.push(block);
    if (run.delivered.length) {
      run.delivered.push(block);
      this.emit(run, { type: 'message.final', text: run.delivered.join('\n\n') });
    } else {
      this.emit(run, { type: 'message.delta', text: (flushed ? '\n\n' : '') + block });
    }
  }

  /** La question n'attend plus de réponse : AgentUI rend la main au composer. */
  private closeQuestion(run: Run, id: string): void {
    if (run.askQuestionId !== id) return;
    run.askQuestionId = undefined;
    this.emit(run, { type: 'question.resolved', id });
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

  // ── Modèle d'une discussion ──────────────────────────────────────────────

  /** Route d'une discussion pour un agent : même résolution que `dispatch`, elle fixe la clé de session. */
  private routeOf(conversationId: string, agentId?: string) {
    const rt = getAgentUIRuntime();
    const { cfg, accountId } = this.p;
    return rt.channel.routing.resolveAgentRoute({
      cfg,
      channel: CHANNEL,
      accountId,
      peer: { kind: 'direct', id: conversationId },
      dmScope: 'per-channel-peer',
      ...(agentId ? { defaultAgentId: agentId } : {}),
    });
  }

  /** Session d'une discussion : celle du sous-agent demandé, sinon la plus récemment utilisée parmi les agents. */
  private sessionOf(conversationId: string, subAgentId?: string): { agentId: string; entry?: Json } {
    const agents = subAgentId ? [subAgentId] : listSubAgents(this.p.cfg).map((a) => a.id);
    let best: { agentId: string; entry?: Json; at: number } | undefined;
    for (const id of agents) {
      const route = this.routeOf(conversationId, id);
      const entry = route?.sessionKey ? (getSessionEntry({ agentId: route.agentId ?? id, sessionKey: route.sessionKey }) as Json | undefined) : undefined;
      const at = Number(entry?.updatedAt ?? 0);
      if (entry && (!best || at > best.at)) best = { agentId: route.agentId ?? id, entry, at };
    }
    return best ?? { agentId: agents[0] ?? 'main' };
  }

  /** Modèle par défaut d'un agent : sa configuration, sinon celle de `agents.defaults`. */
  private defaultModelOf(agentId: string): { provider?: string; id?: string } {
    const cfg = this.p.cfg as Json;
    const primary = (m: unknown) => (typeof m === 'string' ? m : typeof (m as Json)?.primary === 'string' ? (m as Json).primary : undefined);
    const ref = primary(cfg.agents?.list?.find((a: Json) => a.id === agentId)?.model) ?? primary(cfg.agents?.defaults?.model);
    return ref ? splitRef(ref) : {};
  }

  /** Modèle courant (choix de la session, sinon dernier utilisé, sinon défaut de l'agent) et tokens d'une discussion. */
  usageOf(conversationId: string, subAgentId?: string): Usage | undefined {
    if (!conversationId) throw new Error('conversationId manquant');
    const { agentId, entry } = this.sessionOf(conversationId, subAgentId);
    if (!entry) return undefined;
    const fallback = this.defaultModelOf(agentId);
    const model = (entry.modelOverride as string | undefined) ?? (entry.model as string | undefined) ?? fallback.id;
    const provider = (entry.providerOverride as string | undefined) ?? (entry.modelProvider as string | undefined) ?? fallback.provider;
    return {
      inputTokens: Number(entry.inputTokens ?? 0),
      outputTokens: Number(entry.outputTokens ?? 0),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    };
  }

  /** Modèles proposés : ceux déclarés par les fournisseurs, la liste d'autorisation des agents et les modèles par défaut. */
  listModels(): Array<{ provider: string; providerName: string; id: string }> {
    const cfg = this.p.cfg as Json;
    const out = new Map<string, { provider: string; providerName: string; id: string }>();
    const add = (provider: string | undefined, id: string | undefined) => {
      if (!provider || !id) return;
      const key = `${provider}/${id}`;
      if (!out.has(key)) out.set(key, { provider, providerName: provider.charAt(0).toUpperCase() + provider.slice(1), id });
    };
    for (const [provider, def] of Object.entries((cfg.models?.providers ?? {}) as Record<string, Json>)) {
      for (const m of (def?.models ?? []) as Array<Json | string>) add(provider, typeof m === 'string' ? m : (m.id as string | undefined));
    }
    for (const ref of Object.keys((cfg.agents?.defaults?.models ?? {}) as Record<string, unknown>)) {
      const r = splitRef(ref);
      add(r.provider, r.id);
    }
    for (const a of listSubAgents(this.p.cfg)) {
      const r = this.defaultModelOf(a.id);
      add(r.provider, r.id);
    }
    return [...out.values()];
  }

  /**
   * Fixe le modèle de la session d'une discussion avec la commande /model … -s d'OpenClaw (limitée à la session),
   * dont la réponse est recueillie. Le succès est vérifié sur l'état réel de la session, pas sur le texte.
   */
  async setModel(conversationId: string, model: string, provider: string | undefined, subAgentId?: string) {
    if (!conversationId || !model.trim()) throw new Error('conversationId et model sont requis');
    if ([...this.runs.values()].some((r) => !r.terminal && r.conversationId === conversationId)) {
      throw new Error('un run est en cours dans cette discussion');
    }
    const { agentId } = this.sessionOf(conversationId, subAgentId);
    const ref = provider ? `${provider}/${model}` : model;
    const capture: string[] = [];
    const result = await this.dispatch({
      conversationId,
      messageId: `model-${Date.now()}`,
      text: `/model ${ref} -s`,
      subAgentId: subAgentId ?? agentId,
      media: [],
      capture,
    });
    const reply = capture.join('\n\n').trim();
    if (!result.dispatched) throw new Error(reply || 'commande /model non admise par OpenClaw');
    const now = this.usageOf(conversationId, subAgentId ?? agentId);
    if (!now || now.model !== model || (provider && now.provider && now.provider !== provider)) {
      throw new Error(reply || `le modèle ${ref} n'a pas été retenu`);
    }
    return { model: now.model, ...(now.provider ? { provider: now.provider } : {}), message: reply };
  }

  /** Termine le run en joignant la consommation de la session (même interrompu, des tokens ont pu être utilisés). */
  private finishWithUsage(run: Run, msg: Extract<GatewayMessage, { type: 'inbound' }>, event: AgentEvent): void {
    try {
      const usage = this.usageOf(msg.conversationId, msg.subAgentId);
      if (usage) this.emit(run, { type: 'usage', usage });
    } catch (e) {
      this.p.log(`consommation illisible : ${String(e)}`);
    }
    this.finish(run, event);
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
    } else if (msg.method === 'listModels' || msg.method === 'sessionUsage' || msg.method === 'setModel') {
      try {
        const conv = String(params.conversationId ?? '');
        const sub = typeof params.subAgentId === 'string' && params.subAgentId ? params.subAgentId : undefined;
        const result =
          msg.method === 'listModels'
            ? this.listModels()
            : msg.method === 'sessionUsage'
              ? this.usageOf(conv, sub) ?? null
              : await this.setModel(conv, String(params.model ?? ''), typeof params.provider === 'string' ? params.provider : undefined, sub);
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
    run.toolAsk?.cancel(); // l'outil interactif en attente rend la main sans réponse
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
        if (d.name === 'ask_user') {
          run.askQuestions = parseAskQuestions(d.args);
          run.askToolId = id;
        }
        this.emit(run, { type: 'tool.started', id, name: String(d.name ?? 'tool'), args: d.args });
      } else if (d.phase === 'result') {
        if (id === run.askToolId && run.askQuestionId) this.closeQuestion(run, run.askQuestionId); // répondue, annulée ou expirée
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
    // Prompt d'une question de l'agent (ask_user) : un widget à la place du texte « Reply with the number… ».
    const askUser = payload.channelData?.askUser as { questionId?: unknown } | undefined;
    if (askUser) {
      if (typeof askUser.questionId === 'string' && askUser.questionId !== run.askQuestionId) {
        run.askQuestionId = askUser.questionId;
        // Avant le prompt : au moment où le widget arrive, AgentUI sait déjà que la réponse est attendue.
        this.emit(run, { type: 'question.requested', id: askUser.questionId });
      }
      if (run.askQuestions) text = askWidget(run.askQuestions) ?? text;
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
