import { randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  AgentConfig,
  AgentEvent,
  Capabilities,
  ConnStatus,
  Job,
  Message,
  SendInput,
  ModelOption,
  Session,
  Skill,
  Usage,
  SubAgent,
} from '@agentui/shared';
import type { AgentAdapter, RunHandle } from './types.js';

type GatewayConfig = Extract<AgentConfig, { type: 'gateway' }>;
type Json = Record<string, any>;

/** Server-side WebSocket (subset of `ws` used here). */
export interface GatewaySocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', cb: (raw: unknown) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
}

/** Media pushed by a plugin (base64), stored until RunManager records it. */
export interface GatewayMedia {
  name: string;
  mimeType: string;
  data: Buffer;
}

/** Proactive message (cron, send tool…) received outside any run. */
export interface GatewayOutbound {
  conversationId?: string;
  /** Proposed title if the chat has to be created (e.g. name of the cron task). */
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

/** Event queue of a run, consumed by RunManager (async iterable). */
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
  /** Plugin cut: fails if no reconnection resumes it within the grace period. */
  orphanTimer?: NodeJS.Timeout;
}

export const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
   * Agent linked by a channel plugin (AgentUI Channel Protocol v1, see plugins/protocol/PROTOCOL.md):
   * the plugin installed in the platform (Hermes, OpenClaw…) connects to AgentUI on /gateway.
   * The AgentUI conversation on the platform side is identified by `remote_session_id` (= conversationId of the protocol).
 */
export class GatewayAdapter implements AgentAdapter {
  readonly id: string;
  readonly name: string;
  private socket?: GatewaySocket;
  private hello?: Json;
  private state: { status: ConnStatus; detail?: string } = { status: 'disconnected', detail: 'waiting for the plugin' };
  private listeners: Array<(s: ConnStatus, d?: string) => void> = [];
  private runs = new Map<string, PendingRun>();
  private media = new Map<string, GatewayMedia>();
  private rpcs = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ping?: NodeJS.Timeout;
  /** Wired by the server: records a proactive message in the right conversation. */
  onOutbound?: (msg: GatewayOutbound) => void | Promise<void>;
  /** Miniapp operation requested by the plugin for its agent (frame `miniapp.op`); the result goes back in `miniapp.result`. */
  onMiniappOp?: (op: string, args: unknown) => Promise<unknown>;
  onMiniappOpError?: (e: unknown) => string;
  /** Push notification requested by the plugin (frame `notify`); the result goes back in `notify.result`. */
  onNotify?: (n: { title: string; body?: string; url?: string }) => Promise<unknown>;

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
    // Nothing to open: the plugin is the one that connects (see attach).
  }

  async close(): Promise<void> {
    clearInterval(this.ping);
    this.socket?.close(1001, 'shutdown');
  }

  // ---------- Plugin connection ----------

  /** Attaches the connection of an authenticated plugin (hello already validated by the server). */
  attach(socket: GatewaySocket, hello: Json) {
    if (hello.mode === 'send-only') {
      // One-off connection (cron outside the gateway, CLI): does not replace the main connection.
      socket.send(JSON.stringify({ type: 'welcome', protocol: 1, ...(this.onMiniappOp ? { miniapps: true } : {}), ...(this.onNotify ? { notify: true } : {}) }));
      socket.on('message', (raw) => void this.onFrame(raw, socket));
      return;
    }
    if (this.socket && this.socket !== socket) this.socket.close(4000, 'replaced by a new connection');
    this.socket = socket;
    this.hello = hello;
    socket.send(JSON.stringify({ type: 'welcome', protocol: 1, ...(this.onMiniappOp ? { miniapps: true } : {}), ...(this.onNotify ? { notify: true } : {}) }));
    const version = hello.agent?.version ? ` ${hello.agent.version}` : '';
    this.setState('connected', `${hello.agent?.type ?? 'plugin'}${version}`);

    // Runs in progress before the cut: those the plugin no longer knows will not come back.
    const alive = new Set<string>((hello.activeRuns ?? []).map((r: Json) => String(r.runId)));
    for (const [runId, run] of this.runs) {
      clearTimeout(run.orphanTimer);
      run.orphanTimer = undefined;
      if (!alive.has(runId)) this.fail(runId, 'run lost during the plugin disconnection');
    }

    socket.on('message', (raw) => void this.onFrame(raw, socket));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      clearInterval(this.ping);
      this.setState('disconnected', 'plugin disconnected');
      for (const [runId, run] of this.runs) {
        run.orphanTimer ??= setTimeout(() => this.fail(runId, 'plugin disconnected'), RECONNECT_GRACE_MS);
      }
      for (const [id, p] of this.rpcs) {
        clearTimeout(p.timer);
        p.reject(new Error('plugin disconnected'));
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
      case 'miniapp.op': {
        if (from !== this.socket) return;
        const id = String(msg.id);
        if (!this.onMiniappOp) return this.write({ type: 'miniapp.result', id, ok: false, error: 'Miniapps are not available on this server.' });
        try {
          this.write({ type: 'miniapp.result', id, ok: true, result: await this.onMiniappOp(String(msg.op), msg.args) });
        } catch (e) {
          this.write({ type: 'miniapp.result', id, ok: false, error: this.onMiniappOpError?.(e) ?? (e as Error).message });
        }
        return;
      }
      case 'notify': {
        if (from !== this.socket) return;
        const id = String(msg.id);
        const title = typeof msg.title === 'string' ? msg.title.trim().slice(0, 80) : '';
        if (!this.onNotify) return this.write({ type: 'notify.result', id, ok: false, error: 'Notifications are not available on this server.' });
        if (!title) return this.write({ type: 'notify.result', id, ok: false, error: 'The title is empty.' });
        try {
          const body = typeof msg.body === 'string' ? msg.body.slice(0, 300) : undefined;
          const url = typeof msg.url === 'string' && msg.url.trim() ? msg.url.trim() : undefined;
          if (url && !/^\/(?![/\\])/.test(url) && !/^https:\/\/\S+$/.test(url)) return this.write({ type: 'notify.result', id, ok: false, error: 'The url must be an AgentUI path starting with "/" or an https:// URL.' });
          this.write({ type: 'notify.result', id, ok: true, result: await this.onNotify({ title, body, url }) });
        } catch (e) {
          this.write({ type: 'notify.result', id, ok: false, error: (e as Error).message });
        }
        return;
      }
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
        return; // pong, unknown fields: ignored
    }
  }

  private onEvent(runId: string, ev: Json) {
    const run = this.runs.get(runId);
    if (!run || typeof ev.type !== 'string') return;
    let out = ev as AgentEvent;
    if (ev.type === 'message.media') {
      // The plugin pushes the content; RunManager fetches it via fetchMedia as for the other agents.
      const key = `${MEDIA_PREFIX}${randomUUID()}`;
      this.media.set(key, toMedia(ev));
      out = { type: 'message.media', url: key, name: String(ev.name ?? 'media'), mimeType: ev.mimeType };
    } else if (ev.type === 'subagent.start') {
      // No remote session tracking through the channel: the plugin sends subagent.end itself.
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
      if (!this.write({ type: 'rpc', id, method, params })) return reject(new Error('plugin not connected'));
      const timer = setTimeout(() => {
        this.rpcs.delete(id);
        reject(new Error(`rpc ${method}: timed out`));
      }, 10_000);
      this.rpcs.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  // ---------- AgentAdapter ----------

  async send(sessionId: string | undefined, input: SendInput): Promise<RunHandle> {
    if (!this.socket) throw new Error(`${this.name}: plugin not connected`);
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
      throw new Error(`${this.name}: plugin not connected`);
    }
    return { runId, sessionId: conversationId, events: queue.iterate() };
  }

  /** After an AgentUI restart: the run continues if the plugin still declares it active on reconnection. */
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
      run.orphanTimer = setTimeout(() => this.fail(runId, 'run interrupted (plugin did not reconnect)'), RECONNECT_GRACE_MS);
    }
    return { runId, sessionId, events: queue.iterate() };
  }

  async abort(runId: string, sessionId: string): Promise<void> {
    if (!this.write({ type: 'abort', conversationId: this.runs.get(runId)?.conversationId ?? sessionId, runId })) {
      this.fail(runId, 'plugin not connected');
    }
  }

  async resolveApproval(runId: string, approvalId: string, approve: boolean): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error('Unknown run');
    if (!this.write({ type: 'approval', conversationId: run.conversationId, runId, id: approvalId, approve, ...(approve ? { scope: 'once' } : {}) })) {
      throw new Error('plugin not connected');
    }
  }

  async reply(runId: string, sessionId: string, text: string): Promise<void> {
    if (!this.write({ type: 'reply', conversationId: this.runs.get(runId)?.conversationId ?? sessionId, runId, text })) {
      throw new Error('plugin not connected');
    }
  }

  async fetchMedia(url: string): Promise<{ data: Buffer; mimeType: string }> {
    const m = this.media.get(url);
    if (!m) throw new Error('media expired');
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

  async readSkill(skillId: string, subAgentId?: string): Promise<string> {
    if (!this.capabilities().skills) throw Object.assign(new Error('Not supported by this plugin'), { statusCode: 501 });
    return (await this.rpc<{ content: string }>('readSkill', { skillId, ...(subAgentId ? { subAgentId } : {}) })).content;
  }

  async listJobs(subAgentId?: string): Promise<Job[]> {
    if (!this.capabilities().jobs) return [];
    return this.rpc<Job[]>('listJobs', subAgentId ? { subAgentId } : {});
  }

  async jobAction(jobId: string, action: 'pause' | 'resume' | 'run' | 'delete', subAgentId?: string): Promise<void> {
    if (!this.capabilities().jobControl) throw Object.assign(new Error('Not supported by this plugin'), { statusCode: 501 });
    await this.rpc('jobAction', { jobId, action, ...(subAgentId ? { subAgentId } : {}) });
  }

  /** Deletes the platform session of a chat; the plugin announces `sessionDelete`. */
  async listModels(): Promise<ModelOption[]> {
    if (!this.capabilities().models) return [];
    return this.rpc<ModelOption[]>('listModels', {});
  }
  async setModel(sessionId: string, model: string, provider?: string, subAgentId?: string) {
    if (!this.capabilities().models) throw Object.assign(new Error(`${this.name}: this plugin cannot change the model`), { statusCode: 501 });
    try {
      return await this.rpc<{ model: string; provider?: string; message?: string }>('setModel', { conversationId: sessionId, model, ...(provider ? { provider } : {}), ...(subAgentId ? { subAgentId } : {}) });
    } catch (e) {
      throw Object.assign(new Error((e as Error).message), { statusCode: 502 });
    }
  }
  async sessionUsage(sessionId: string, subAgentId?: string): Promise<Usage | undefined> {
    if (!this.capabilities().models) return undefined;
    return (await this.rpc<Usage | null>('sessionUsage', { conversationId: sessionId, ...(subAgentId ? { subAgentId } : {}) })) ?? undefined;
  }
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.capabilities().sessionDelete) {
      throw Object.assign(new Error(`${this.name}: this plugin cannot delete its sessions`), { statusCode: 501 });
    }
    try {
      await this.rpc('deleteSession', { conversationId: sessionId });
    } catch (e) {
      throw Object.assign(new Error(`${this.name}: ${(e as Error).message}`), { statusCode: 502 });
    }
  }

  async listSessions(): Promise<Session[]> {
    return []; // the history lives in the AgentUI database
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
