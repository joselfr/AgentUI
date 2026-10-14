import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  ToolCall,
} from '@agentui/shared';
import type { AgentAdapter, RunHandle } from './types.js';

type OpenClawConfig = Extract<AgentConfig, { type: 'openclaw' }>;
type Json = Record<string, any>;

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SCOPES = ['operator.read', 'operator.write', 'operator.admin'];
const CLIENT = { id: 'cli', mode: 'cli', platform: 'linux', version: '0.1.0' } as const;
const MAX_RESULT = 20000;

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

interface DeviceIdentity {
  deviceId: string;
  publicKeyRaw: Buffer;
  privateKeyPem: string;
}

/** Identité Ed25519 persistante : l'appairage est lié à cette clé, ne pas la supprimer. */
function loadIdentity(dataDir: string): DeviceIdentity {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'openclaw-device.json');
  if (!existsSync(file)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    writeFileSync(
      file,
      JSON.stringify({
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      }),
      { mode: 0o600 },
    );
  }
  const { publicKeyPem, privateKeyPem } = JSON.parse(readFileSync(file, 'utf8')) as { publicKeyPem: string; privateKeyPem: string };
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const publicKeyRaw = der.subarray(SPKI_PREFIX.length);
  return { deviceId: crypto.createHash('sha256').update(publicKeyRaw).digest('hex'), publicKeyRaw, privateKeyPem };
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p: Json) => p?.type === 'text' && typeof p.text === 'string').map((p: Json) => p.text).join('');
};

export class OpenClawAdapter implements AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly type = 'openclaw';
  private state: { status: ConnStatus; detail?: string } = { status: 'disconnected' };
  private listeners: Array<(s: ConnStatus, d?: string) => void> = [];
  private ws?: WebSocket;
  private identity: DeviceIdentity;
  private seq = 1;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private eventSubs = new Set<(event: string, payload: Json) => void>();
  private closedByUs = false;
  private retryTimer?: NodeJS.Timeout;
  private retryDelay = 1000;
  private ready?: Promise<void>;

  constructor(private cfg: OpenClawConfig, dataDir: string) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.identity = loadIdentity(dataDir);
  }

  capabilities(): Capabilities {
    return {
      sessions: true,
      abort: true,
      approvals: false,
      subagents: false,
      reasoning: false,
      toolDetails: true,
      skills: true,
      jobs: true,
      jobControl: true,
      attachments: { images: true, files: true, maxBytes: 20 * 1024 * 1024 },
    };
  }

  status() {
    return this.state;
  }
  onStatus(cb: (s: ConnStatus, d?: string) => void) {
    this.listeners.push(cb);
  }
  private setStatus(status: ConnStatus, detail?: string) {
    if (this.state.status === status && this.state.detail === detail) return;
    this.state = { status, detail };
    this.listeners.forEach((l) => l(status, detail));
  }

  // ---------- Transport ----------
  async connect(): Promise<void> {
    this.closedByUs = false;
    this.ready = this.open();
    await this.ready.catch(() => undefined); // la reconnexion automatique prend le relais
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  private open(): Promise<void> {
    this.setStatus('connecting');
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (e: Error) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      };
      const ws = new WebSocket(this.cfg.url);
      this.ws = ws;
      const timeout = setTimeout(() => {
        fail(new Error('Délai de connexion dépassé'));
        ws.close();
      }, 30000);

      ws.onmessage = (m) => {
        let f: Json;
        try {
          f = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (f.type === 'event' && f.event === 'connect.challenge') {
          this.sendConnect(ws, f.payload.nonce as string, (err, hello) => {
            clearTimeout(timeout);
            if (err) {
              this.setStatus('error', err.message);
              fail(err);
              return ws.close();
            }
            this.retryDelay = 1000;
            this.setStatus('connected');
            settled = true;
            resolve();
            void this.rpc('sessions.subscribe', {}).catch(() => undefined);
            void hello;
          });
        } else if (f.type === 'res') {
          const p = this.pending.get(String(f.id));
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(String(f.id));
            if (f.ok) p.resolve(f.payload);
            else p.reject(new Error(`${f.error?.code ?? 'ERREUR'}: ${f.error?.message ?? 'échec RPC'}`));
          }
        } else if (f.type === 'event') {
          for (const s of this.eventSubs) s(f.event as string, (f.payload ?? {}) as Json);
        }
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        fail(new Error('Connexion fermée'));
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Connexion à OpenClaw perdue'));
          this.pending.delete(id);
        }
        for (const s of this.eventSubs) s('__closed', {});
        if (this.closedByUs) return this.setStatus('disconnected');
        if (this.state.status !== 'error') this.setStatus('disconnected', 'Connexion perdue, nouvelle tentative…');
        this.retryTimer = setTimeout(() => {
          this.ready = this.open();
          this.ready.catch(() => undefined);
        }, this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 30000);
      };
      ws.onerror = () => undefined; // onclose suit toujours
    });
  }

  private sendConnect(ws: WebSocket, nonce: string, done: (err: Error | null, hello?: Json) => void) {
    const token = this.cfg.auth.token ?? '';
    const signedAt = Date.now();
    const payload = ['v3', this.identity.deviceId, CLIENT.id, CLIENT.mode, 'operator', SCOPES.join(','), String(signedAt), token, nonce, CLIENT.platform, ''].join('|');
    const signature = b64u(crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(this.identity.privateKeyPem)));
    const id = 'connect';
    const timer = setTimeout(() => done(new Error('Pas de réponse au connect')), 30000);
    this.pending.set(id, {
      resolve: (hello) => (clearTimeout(timer), done(null, hello)),
      reject: (e) => (clearTimeout(timer), done(e)),
      timer,
    });
    ws.send(
      JSON.stringify({
        type: 'req',
        id,
        method: 'connect',
        params: {
          minProtocol: 4,
          maxProtocol: 4,
          client: CLIENT,
          role: 'operator',
          scopes: SCOPES,
          caps: ['tool-events'],
          auth: { token: this.cfg.auth.token, password: this.cfg.auth.password },
          device: { id: this.identity.deviceId, publicKey: b64u(this.identity.publicKeyRaw), signature, signedAt, nonce },
          locale: 'fr-FR',
          userAgent: 'agentui',
        },
      }),
    );
  }

  private async rpc<T = any>(method: string, params: Json = {}, timeoutMs = 30000): Promise<T> {
    if (this.state.status !== 'connected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`OpenClaw indisponible (${this.state.detail ?? this.state.status})`);
    }
    const id = String(++this.seq);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Délai dépassé : ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  // ---------- Listes ----------
  async listSubAgents(): Promise<SubAgent[]> {
    const r = await this.rpc('agents.list');
    return (r.agents ?? []).map((a: Json) => ({
      id: a.id,
      name: a.identity?.name ?? a.name ?? a.id,
      description: [a.identity?.emoji, a.model?.primary].filter(Boolean).join(' '),
      isDefault: a.id === r.defaultId,
    }));
  }

  async listSkills(subAgentId?: string): Promise<Skill[]> {
    const r = await this.rpc('skills.status', subAgentId ? { agentId: subAgentId } : {});
    return (r.skills ?? []).map((s: Json) => ({
      id: s.skillKey ?? s.name,
      name: s.name,
      description: s.description,
      category: s.source,
      enabled: !s.disabled && s.eligible !== false,
    }));
  }

  async listJobs(subAgentId?: string): Promise<Job[]> {
    const r = await this.rpc('cron.list', {});
    return (r.jobs ?? [])
      .filter((j: Json) => !subAgentId || !(j.agentId ?? j.effectiveAgentId) || (j.agentId ?? j.effectiveAgentId) === subAgentId)
      .map((j: Json) => ({
        id: j.id,
        name: j.displayName ?? j.name ?? j.id,
        schedule: this.scheduleLabel(j.schedule),
        prompt: str(j.payload?.message) ?? str(j.description),
        enabled: !!j.enabled,
        nextRunAt: j.state?.nextRunAtMs ?? j.nextRunAtMs,
        lastRunAt: j.state?.lastRunAtMs ?? j.lastRunAtMs,
        lastStatus: j.state?.lastStatus ?? j.lastRunStatus,
      }));
  }

  private scheduleLabel(s: Json | undefined): string {
    if (!s) return '';
    if (s.kind === 'cron') return s.tz ? `${s.expr} (${s.tz})` : String(s.expr);
    if (s.kind === 'every') {
      const m = Math.round(Number(s.everyMs) / 60000);
      return m >= 60 && m % 60 === 0 ? `toutes les ${m / 60} h` : `toutes les ${m} min`;
    }
    if (s.kind === 'at') return `le ${new Date(s.at ?? s.atMs).toLocaleString('fr-FR')}`;
    return JSON.stringify(s);
  }

  async jobAction(jobId: string, action: 'pause' | 'resume' | 'run' | 'delete') {
    if (action === 'delete') await this.rpc('cron.remove', { id: jobId });
    else if (action === 'run') await this.rpc('cron.run', { id: jobId, mode: 'force' });
    else await this.rpc('cron.update', { id: jobId, patch: { enabled: action === 'resume' } });
  }

  async listSessions(): Promise<Session[]> {
    const r = await this.rpc('sessions.list', {});
    return (r.sessions ?? []).map((s: Json) => ({
      id: s.key,
      title: s.displayName ?? s.label ?? s.key,
      subAgentId: s.agentId,
      updatedAt: s.updatedAt ?? 0,
    }));
  }

  /** Reconstruit l'historique normalisé (texte + appels d'outils) depuis le transcript. */
  async getMessages(sessionKey: string): Promise<Message[]> {
    const r = await this.rpc('chat.history', { sessionKey, limit: 200 });
    const out: Message[] = [];
    const tools = new Map<string, ToolCall>();
    let last: Message | undefined;
    const attach = (t: ToolCall) => {
      tools.set(t.id, t);
      if (!last || last.role !== 'assistant') {
        last = { id: crypto.randomUUID(), role: 'assistant', text: '', createdAt: t.startedAt, status: 'done', toolCalls: [] };
        out.push(last);
      }
      last.toolCalls = [...(last.toolCalls ?? []), t];
    };
    const result = (m: Json) => {
      const t = tools.get(String(m.toolCallId));
      if (!t) return;
      const txt = textOf(m.content);
      t.status = m.isError ? 'failed' : 'done';
      t.resultPreview = txt.slice(0, MAX_RESULT);
      t.resultTruncated = txt.length > MAX_RESULT;
      t.endedAt = m.timestamp;
    };
    for (const m of (r.messages ?? []) as Json[]) {
      const ts = Number(m.timestamp) || 0;
      if (m.role === 'user') {
        last = { id: m.__openclaw?.id ?? crypto.randomUUID(), role: 'user', text: textOf(m.content), createdAt: ts, status: 'done' };
        out.push(last);
      } else if (m.role === 'assistant') {
        const parts: Json[] = Array.isArray(m.content) ? m.content : [];
        last = { id: m.__openclaw?.id ?? crypto.randomUUID(), role: 'assistant', text: textOf(m.content), createdAt: ts, status: 'done', toolCalls: [] };
        for (const p of parts) {
          if (p.type === 'toolCall' || p.type === 'tool_use') {
            const t: ToolCall = { id: String(p.id), name: p.name, status: 'running', args: p.arguments ?? p.input, startedAt: ts };
            tools.set(t.id, t);
            last.toolCalls!.push(t);
          }
        }
        out.push(last);
      } else if (m.role === 'toolResult') {
        result(m);
      } else if (m.role === 'custom' && Array.isArray(m.content)) {
        for (const p of m.content as Json[]) {
          if (p.type === 'toolCall') attach({ id: String(p.id), name: p.name, status: 'running', args: p.arguments, startedAt: Number(p.timestamp) || ts });
          else if (p.type === 'toolResult') result({ ...p, toolCallId: p.toolCallId });
        }
      }
    }
    return out.filter((m) => m.text || m.toolCalls?.length);
  }

  // ---------- Chat ----------
  async send(sessionId: string | undefined, input: SendInput): Promise<RunHandle> {
    const agentId = input.subAgentId ?? 'main';
    const sessionKey = sessionId ?? `agent:${agentId}:agentui:${crypto.randomUUID()}`;
    // File d'événements ouverte AVANT chat.send : aucun événement ne peut être perdu.
    const feed = this.openFeed(sessionKey);
    try {
      await this.rpc('sessions.messages.subscribe', { key: sessionKey }).catch(() => undefined);
      const attachments = (input.attachments ?? []).map((a) => ({
        type: a.kind,
        mimeType: a.mimeType,
        fileName: a.name,
        content: Buffer.from(a.data).toString('base64'),
      }));
      const started = await this.rpc(
        'chat.send',
        { sessionKey, agentId, message: input.text, idempotencyKey: crypto.randomUUID(), ...(attachments.length ? { attachments } : {}) },
        120_000,
      );
      const runId = String(started.runId);
      return { runId, sessionId: sessionKey, events: this.stream(runId, sessionKey, feed) };
    } catch (e) {
      feed.dispose();
      throw e;
    }
  }

  /** Rattache un run en cours (ou terminé pendant l'absence) après redémarrage d'AgentUI. */
  async resume(runId: string, sessionKey: string): Promise<RunHandle | null> {
    if (!(await this.waitConnected(60_000))) return null;
    const feed = this.openFeed(sessionKey);
    await this.rpc('sessions.messages.subscribe', { key: sessionKey }).catch(() => undefined);
    const state = await this.runState(runId, sessionKey).catch(() => 'unknown' as const);
    if (state === 'unknown') {
      feed.dispose();
      return null;
    }
    return { runId, sessionId: sessionKey, events: this.stream(runId, sessionKey, feed) };
  }

  private openFeed(sessionKey: string) {
    const feed = {
      queue: [] as Json[],
      closed: false,
      wake: undefined as (() => void) | undefined,
      dispose: () => void this.eventSubs.delete(sub),
    };
    const sub = (event: string, p: Json) => {
      if (event === '__closed') feed.closed = true;
      else if ((event === 'chat' || event === 'agent') && p.sessionKey === sessionKey) feed.queue.push({ event, ...p });
      else return;
      feed.wake?.();
    };
    this.eventSubs.add(sub);
    return feed;
  }

  private async waitConnected(ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.state.status === 'connected' && this.ws?.readyState === WebSocket.OPEN) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /** `active` : le run tourne encore côté Gateway ; `ended` : terminé ; `unknown` : session introuvable. */
  private async runState(runId: string, sessionKey: string): Promise<'active' | 'ended' | 'unknown'> {
    const r = await this.rpc('sessions.list', {});
    const s = (r.sessions ?? []).find((x: Json) => x.key === sessionKey);
    if (!s) return 'unknown';
    return (s.activeRunIds ?? []).includes(runId) ? 'active' : 'ended';
  }

  private async *stream(
    runId: string,
    sessionKey: string,
    feed: { queue: Json[]; closed: boolean; wake?: () => void; dispose: () => void },
  ): AsyncGenerator<AgentEvent> {
    const seenTools = new Set<string>();
    const terminal = (ev: AgentEvent) => ev.type === 'run.completed' || ev.type === 'run.failed' || ev.type === 'run.aborted';
    try {
      for (;;) {
        while (feed.queue.length) {
          const p = feed.queue.shift()!;
          if (p.runId !== runId) continue;
          for (const ev of this.mapEvent(p)) {
            if (ev.type === 'tool.started') seenTools.add(ev.id);
            yield ev;
            if (terminal(ev)) return;
          }
        }
        if (feed.closed) {
          // Connexion perdue : le run continue côté Gateway. On attend la reconnexion puis on resynchronise.
          if (!(await this.waitConnected(5 * 60_000))) {
            return void (yield { type: 'run.failed', error: 'Connexion à OpenClaw perdue (reconnexion impossible)' });
          }
          feed.closed = false;
          await this.rpc('sessions.messages.subscribe', { key: sessionKey }).catch(() => undefined);
        }
        // Filet de sécurité : sans événement pendant 20 s (ou après reconnexion), on interroge l'état réel du run.
        const idle = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => ((feed.wake = undefined), resolve(true)), feed.queue.length ? 0 : 20_000);
          feed.wake = () => (clearTimeout(t), (feed.wake = undefined), resolve(false));
        });
        if (idle && !feed.queue.length && this.state.status === 'connected') {
          const st = await this.runState(runId, sessionKey).catch(() => 'active' as const);
          if (st === 'ended') {
            // Laisse un court délai aux derniers événements `final` en vol, puis reconstitue depuis l'historique.
            await new Promise((r) => setTimeout(r, 1500));
            if (feed.queue.some((q) => q.runId === runId && q.event === 'chat' && q.state !== 'delta')) continue;
            return void (yield* this.finalizeFromHistory(runId, sessionKey, seenTools));
          }
        }
      }
    } finally {
      feed.dispose();
    }
  }

  /** Reconstitue la fin d'un run manqué (texte final + outils non vus) depuis le transcript. */
  private async *finalizeFromHistory(runId: string, sessionKey: string, seen: Set<string>): AsyncGenerator<AgentEvent> {
    const r = await this.rpc('chat.history', { sessionKey, limit: 200 });
    const msgs = ((r.messages ?? []) as Json[]).filter((m) => (m.runId ?? m.__openclaw?.runId) === runId);
    const results = new Map<string, Json>();
    for (const m of msgs) {
      if (m.role === 'toolResult') results.set(String(m.toolCallId), m);
      if (m.role === 'custom' && Array.isArray(m.content)) for (const p of m.content) if (p.type === 'toolResult') results.set(String(p.toolCallId), p);
    }
    for (const m of msgs) {
      const parts: Json[] = m.role === 'custom' || m.role === 'assistant' ? (Array.isArray(m.content) ? m.content : []) : [];
      for (const p of parts) {
        if (p.type !== 'toolCall' || seen.has(String(p.id))) continue;
        yield { type: 'tool.started', id: String(p.id), name: String(p.name), args: p.arguments };
        const res = results.get(String(p.id));
        const txt = res ? textOf(res.content) : '';
        yield { type: 'tool.completed', id: String(p.id), result: txt.slice(0, MAX_RESULT), truncated: txt.length > MAX_RESULT, failed: !!res?.isError };
      }
    }
    const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant' && textOf(m.content));
    if (lastAssistant) yield { type: 'message.final', text: textOf(lastAssistant.content) };
    yield { type: 'run.completed' };
  }

  /** Mapping des événements `chat` et `agent` du Gateway (protocole v4, observés en conditions réelles). */
  mapEvent(p: Json): AgentEvent[] {
    if (p.event === 'chat') {
      switch (p.state) {
        case 'delta':
          return p.replace ? [{ type: 'message.final', text: textOf(p.message?.content) }] : p.deltaText ? [{ type: 'message.delta', text: String(p.deltaText) }] : [];
        case 'final': {
          const text = textOf(p.message?.content);
          return [...(text ? [{ type: 'message.final', text } as AgentEvent] : []), { type: 'run.completed' }];
        }
        case 'aborted':
          return [{ type: 'run.aborted' }];
        case 'error':
          return [{ type: 'run.failed', error: str(p.errorMessage) ?? str(p.error) ?? 'Erreur OpenClaw' }];
        default:
          return [];
      }
    }
    const d: Json = p.data ?? {};
    switch (p.stream) {
      case 'tool':
        if (d.phase === 'start') {
          return [{ type: 'tool.started', id: String(d.toolCallId), name: String(d.name ?? 'tool'), args: d.args }];
        }
        if (d.phase === 'result') {
          const txt = textOf(d.result?.content) || (d.result === undefined ? '' : JSON.stringify(d.result));
          return [{ type: 'tool.completed', id: String(d.toolCallId), name: str(d.name), result: txt.slice(0, MAX_RESULT), truncated: txt.length > MAX_RESULT, failed: !!d.isError }];
        }
        return [];
      case 'thinking':
      case 'reasoning':
        return d.delta || d.text ? [{ type: 'reasoning.delta', text: String(d.delta ?? d.text) }] : [];
      default:
        return [];
    }
  }

  async abort(runId: string, sessionKey: string): Promise<void> {
    await this.rpc('chat.abort', { sessionKey, runId });
  }
}
