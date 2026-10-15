import { randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  AgentConfig,
  AgentEvent,
  Capabilities,
  ConnStatus,
  Job,
  Message,
  SendInput,
  Session,
  Skill,
  SubAgent,
} from '@agentui/shared';
import type { AgentAdapter, RunHandle } from './types.js';

type GatewayConfig = Extract<AgentConfig, { type: 'gateway' }>;
type Json = Record<string, any>;

/** Socket WebSocket côté serveur (sous-ensemble de `ws` utilisé ici). */
export interface GatewaySocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', cb: (raw: unknown) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
}

/** Média poussé par un plugin (base64), stocké le temps que RunManager l'enregistre. */
export interface GatewayMedia {
  name: string;
  mimeType: string;
  data: Buffer;
}

/** Message proactif (cron, outil d'envoi…) reçu hors de tout run. */
export interface GatewayOutbound {
  conversationId?: string;
  /** Titre proposé si la discussion doit être créée (ex. nom de la tâche cron). */
  title?: string;
  text: string;
  media: GatewayMedia[];
}

const MEDIA_PREFIX = 'gateway-media:';
const RECONNECT_GRACE_MS = 120_000;
const PING_MS = 30_000;
const TERMINAL = new Set(['run.completed', 'run.failed', 'run.aborted']);

const DEFAULT_CAPS: Capabilities = {
  sessions: true,
  abort: true,
  approvals: false,
  subagents: false,
  reasoning: false,
  toolDetails: false,
  skills: false,
  jobs: false,
  jobControl: false,
  attachments: { images: false, files: false, maxBytes: 0 },
};

/** File d'événements d'un run, consommée par RunManager (async iterable). */
class EventQueue {
  private items: AgentEvent[] = [];
  private waiter?: () => void;
  done = false;

  push(ev: AgentEvent) {
    if (this.done) return;
    this.items.push(ev);
    if (TERMINAL.has(ev.type)) this.done = true;
    this.waiter?.();
  }

  async *iterate(): AsyncGenerator<AgentEvent> {
    for (;;) {
      while (this.items.length) {
        const ev = this.items.shift()!;
        yield ev;
        if (TERMINAL.has(ev.type)) return;
      }
      await new Promise<void>((r) => (this.waiter = r));
      this.waiter = undefined;
    }
  }
}

interface PendingRun {
  conversationId: string;
  queue: EventQueue;
  /** Coupure du plugin : échec si pas de reconnexion le reprenant dans le délai. */
  orphanTimer?: NodeJS.Timeout;
}

export const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Agent relié par un plugin canal (AgentUI Channel Protocol v1, voir plugins/protocol/PROTOCOL.md) :
 * c'est le plugin installé dans la plateforme (Hermes, OpenClaw…) qui se connecte à AgentUI sur /gateway.
 * La conversation AgentUI côté plateforme est identifiée par `remote_session_id` (= conversationId du protocole).
 */
export class GatewayAdapter implements AgentAdapter {
  readonly id: string;
  readonly name: string;
  private socket?: GatewaySocket;
  private hello?: Json;
  private state: { status: ConnStatus; detail?: string } = { status: 'disconnected', detail: 'en attente du plugin' };
  private listeners: Array<(s: ConnStatus, d?: string) => void> = [];
  private runs = new Map<string, PendingRun>();
  private media = new Map<string, GatewayMedia>();
  private rpcs = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ping?: NodeJS.Timeout;
  /** Branché par le serveur : enregistre un message proactif dans la bonne conversation. */
  onOutbound?: (msg: GatewayOutbound) => void | Promise<void>;

  constructor(private cfg: GatewayConfig) {
    this.id = cfg.id;
    this.name = cfg.name;
  }

  get type(): string {
    return this.hello?.agent?.type ?? 'canal';
  }

  get token(): string {
    return this.cfg.token;
  }

  capabilities(): Capabilities {
    return (this.hello?.capabilities as Capabilities | undefined) ?? DEFAULT_CAPS;
  }

  status() {
    return this.state;
  }

  onStatus(cb: (s: ConnStatus, detail?: string) => void) {
    this.listeners.push(cb);
  }

  private setState(status: ConnStatus, detail?: string) {
    this.state = { status, detail };
    for (const l of this.listeners) l(status, detail);
  }

  async connect(): Promise<void> {
    // Rien à ouvrir : c'est le plugin qui se connecte (voir attach).
  }

  async close(): Promise<void> {
    clearInterval(this.ping);
    this.socket?.close(1001, 'arrêt');
  }

  // ---------- Connexion du plugin ----------

  /** Rattache la connexion d'un plugin authentifié (hello déjà validé par le serveur). */
  attach(socket: GatewaySocket, hello: Json) {
    if (hello.mode === 'send-only') {
      // Connexion ponctuelle (cron hors gateway, CLI) : ne remplace pas la connexion principale.
      socket.send(JSON.stringify({ type: 'welcome', protocol: 1 }));
      socket.on('message', (raw) => void this.onFrame(raw, socket));
      return;
    }
    if (this.socket && this.socket !== socket) this.socket.close(4000, 'remplacée par une nouvelle connexion');
    this.socket = socket;
    this.hello = hello;
    socket.send(JSON.stringify({ type: 'welcome', protocol: 1 }));
    const version = hello.agent?.version ? ` ${hello.agent.version}` : '';
    this.setState('connected', `${hello.agent?.type ?? 'plugin'}${version}`);

    // Runs en cours avant la coupure : ceux que le plugin ne connaît plus ne reviendront pas.
    const alive = new Set<string>((hello.activeRuns ?? []).map((r: Json) => String(r.runId)));
    for (const [runId, run] of this.runs) {
      clearTimeout(run.orphanTimer);
      run.orphanTimer = undefined;
      if (!alive.has(runId)) this.fail(runId, 'run perdu pendant la coupure du plugin');
    }

    socket.on('message', (raw) => void this.onFrame(raw, socket));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      clearInterval(this.ping);
      this.setState('disconnected', 'plugin déconnecté');
      for (const [runId, run] of this.runs) {
        run.orphanTimer ??= setTimeout(() => this.fail(runId, 'plugin déconnecté'), RECONNECT_GRACE_MS);
      }
      for (const [id, p] of this.rpcs) {
        clearTimeout(p.timer);
        p.reject(new Error('plugin déconnecté'));
        this.rpcs.delete(id);
      }
    });
    clearInterval(this.ping);
    this.ping = setInterval(() => this.write({ type: 'ping' }), PING_MS);
    this.ping.unref?.();
  }

  private write(msg: Json): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  private async onFrame(raw: unknown, from: GatewaySocket) {
    let msg: Json;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (msg.type) {
      case 'event':
        if (from === this.socket) this.onEvent(String(msg.runId), msg.event ?? {});
        return;
      case 'outbound':
        await this.onOutbound?.({
          conversationId: typeof msg.conversationId === 'string' ? msg.conversationId : undefined,
          title: typeof msg.title === 'string' && msg.title.trim() ? msg.title.trim().slice(0, 120) : undefined,
          text: typeof msg.text === 'string' ? msg.text : '',
          media: (Array.isArray(msg.media) ? msg.media : []).map(toMedia),
        });
        return;
      case 'rpc.result': {
        const p = this.rpcs.get(String(msg.id));
        if (!p) return;
        clearTimeout(p.timer);
        this.rpcs.delete(String(msg.id));
        if (msg.error) p.reject(new Error(String(msg.error)));
        else p.resolve(msg.result);
        return;
      }
      default:
        return; // pong, champs inconnus : ignorés
    }
  }

  private onEvent(runId: string, ev: Json) {
    const run = this.runs.get(runId);
    if (!run || typeof ev.type !== 'string') return;
    let out = ev as AgentEvent;
    if (ev.type === 'message.media') {
      // Le plugin pousse le contenu ; RunManager le récupère via fetchMedia comme pour les autres agents.
      const key = `${MEDIA_PREFIX}${randomUUID()}`;
      this.media.set(key, toMedia(ev));
      out = { type: 'message.media', url: key, name: String(ev.name ?? 'media'), mimeType: ev.mimeType };
    } else if (ev.type === 'subagent.start') {
      // Pas de suivi de session distante via le canal : le plugin envoie lui-même subagent.end.
      out = { type: 'subagent.start', id: String(ev.id), name: String(ev.name ?? 'sous-agent') };
    }
    run.queue.push(out);
    if (TERMINAL.has(out.type)) {
      clearTimeout(run.orphanTimer);
      this.runs.delete(runId);
    }
  }

  private fail(runId: string, error: string) {
    const run = this.runs.get(runId);
    if (!run) return;
    clearTimeout(run.orphanTimer);
    run.queue.push({ type: 'run.failed', error });
    this.runs.delete(runId);
  }

  private rpc<T>(method: string, params?: unknown): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      if (!this.write({ type: 'rpc', id, method, params })) return reject(new Error('plugin non connecté'));
      const timer = setTimeout(() => {
        this.rpcs.delete(id);
        reject(new Error(`rpc ${method} : délai dépassé`));
      }, 10_000);
      this.rpcs.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  // ---------- AgentAdapter ----------

  async send(sessionId: string | undefined, input: SendInput): Promise<RunHandle> {
    if (!this.socket) throw new Error(`${this.name} : plugin non connecté`);
    const conversationId = sessionId ?? randomUUID();
    const runId = randomUUID();
    const queue = new EventQueue();
    this.runs.set(runId, { conversationId, queue });
    const attachments = (input.attachments ?? []).map((a) => ({
      name: a.name,
      mimeType: a.mimeType,
      data: Buffer.from(a.data).toString('base64'),
    }));
    const sent = this.write({
      type: 'inbound',
      conversationId,
      runId,
      text: input.text,
      ...(input.subAgentId ? { subAgentId: input.subAgentId } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    if (!sent) {
      this.runs.delete(runId);
      throw new Error(`${this.name} : plugin non connecté`);
    }
    return { runId, sessionId: conversationId, events: queue.iterate() };
  }

  /** Après un redémarrage d'AgentUI : le run continue si le plugin le déclare encore actif à sa reconnexion. */
  async resume(runId: string, sessionId: string): Promise<RunHandle | null> {
    const queue = new EventQueue();
    const run: PendingRun = { conversationId: sessionId, queue };
    this.runs.set(runId, run);
    if (this.socket) {
      const alive = (this.hello?.activeRuns ?? []).some((r: Json) => String(r.runId) === runId);
      if (!alive) {
        this.runs.delete(runId);
        return null;
      }
    } else {
      run.orphanTimer = setTimeout(() => this.fail(runId, 'run interrompu (plugin non reconnecté)'), RECONNECT_GRACE_MS);
    }
    return { runId, sessionId, events: queue.iterate() };
  }

  async abort(runId: string, sessionId: string): Promise<void> {
    if (!this.write({ type: 'abort', conversationId: this.runs.get(runId)?.conversationId ?? sessionId, runId })) {
      this.fail(runId, 'plugin non connecté');
    }
  }

  async resolveApproval(runId: string, approvalId: string, approve: boolean): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error('Run inconnu');
    if (!this.write({ type: 'approval', conversationId: run.conversationId, runId, id: approvalId, approve, ...(approve ? { scope: 'once' } : {}) })) {
      throw new Error('plugin non connecté');
    }
  }

  async fetchMedia(url: string): Promise<{ data: Buffer; mimeType: string }> {
    const m = this.media.get(url);
    if (!m) throw new Error('média expiré');
    this.media.delete(url);
    return { data: m.data, mimeType: m.mimeType };
  }

  async listSubAgents(): Promise<SubAgent[]> {
    const fromHello = (this.hello?.subAgents ?? []) as SubAgent[];
    if (fromHello.length || !this.socket) return fromHello;
    return this.rpc<SubAgent[]>('listSubAgents').catch(() => []);
  }

  async listSkills(subAgentId?: string): Promise<Skill[]> {
    if (!this.capabilities().skills) return [];
    return this.rpc<Skill[]>('listSkills', subAgentId ? { subAgentId } : {});
  }

  async listJobs(subAgentId?: string): Promise<Job[]> {
    if (!this.capabilities().jobs) return [];
    return this.rpc<Job[]>('listJobs', subAgentId ? { subAgentId } : {});
  }

  async jobAction(jobId: string, action: 'pause' | 'resume' | 'run' | 'delete', subAgentId?: string): Promise<void> {
    if (!this.capabilities().jobControl) throw Object.assign(new Error('Non supporté par ce plugin'), { statusCode: 501 });
    await this.rpc('jobAction', { jobId, action, ...(subAgentId ? { subAgentId } : {}) });
  }

  /** Supprime la session de plateforme d'une discussion ; le plugin annonce `sessionDelete`. */
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.capabilities().sessionDelete) {
      throw Object.assign(new Error(`${this.name} : ce plugin ne sait pas supprimer ses sessions`), { statusCode: 501 });
    }
    try {
      await this.rpc('deleteSession', { conversationId: sessionId });
    } catch (e) {
      throw Object.assign(new Error(`${this.name} : ${(e as Error).message}`), { statusCode: 502 });
    }
  }

  async listSessions(): Promise<Session[]> {
    return []; // l'historique vit dans la base d'AgentUI
  }

  async getMessages(): Promise<Message[]> {
    return [];
  }
}

function toMedia(m: Json): GatewayMedia {
  return {
    name: String(m.name ?? 'media'),
    mimeType: String(m.mimeType ?? 'application/octet-stream'),
    data: Buffer.from(String(m.data ?? ''), 'base64'),
  };
}
