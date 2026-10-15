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
import { parseSse } from './sse.js';

type HermesConfig = Extract<AgentConfig, { type: 'hermes' }>;
type Json = Record<string, any>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asArray = (v: unknown, ...keys: string[]): any[] => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') for (const k of keys) if (Array.isArray((v as Json)[k])) return (v as Json)[k];
  return [];
};
const toMs = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
};

/** Sépare le texte des images Markdown intégrées `![alt](data:image/…;base64,…)`. */
export function splitInlineImages(content: string): { text: string; images: string[] } {
  const images: string[] = [];
  const text = content
    .replace(/!\[[^\]]*\]\((data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+)\)/gi, (_m, url: string) => (images.push(url.replace(/\s+/g, '')), ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, images };
}

export class HermesAdapter implements AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly type = 'hermes';
  private state: { status: ConnStatus; detail?: string } = { status: 'disconnected' };
  private listeners: Array<(s: ConnStatus, d?: string) => void> = [];
  private timer?: NodeJS.Timeout;
  private runProfile = new Map<string, string>();
  private abortedRuns = new Set<string>(); // le flux session ne signale pas l'interruption : on la déduit de la demande d'arrêt

  constructor(private cfg: HermesConfig) {
    this.id = cfg.id;
    this.name = cfg.name;
  }

  private features: Json = {};

  capabilities(): Capabilities {
    const f = this.features;
    return {
      sessions: true,
      abort: f.run_stop !== false,
      approvals: f.run_approval_response === true,
      subagents: true,
      reasoning: true,
      toolDetails: false, // l'API n'expose que nom + aperçu + durée, pas d'arguments ni de résultat
      skills: f.skills_api !== false,
      jobs: true,
      jobControl: f.jobs_admin === true,
      // Images en data URL (format OpenAI) ; pas de fichiers binaires (400 côté Hermes)
      attachments: { images: true, files: false, maxBytes: 20 * 1024 * 1024 },
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

  /** Hermes est sans connexion persistante : on sonde /health périodiquement. */
  async connect(): Promise<void> {
    await this.probe();
    this.timer = setInterval(() => void this.probe(), 15000);
    this.timer.unref();
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }
  private async probe() {
    try {
      const r = await fetch(`${this.base()}/health`, { signal: AbortSignal.timeout(5000) });
      if (r.ok && !Object.keys(this.features).length) {
        this.features = ((await this.json('/v1/capabilities').catch(() => ({}))) as Json).features ?? {};
      }
      this.setStatus(r.ok ? 'connected' : 'error', r.ok ? undefined : `HTTP ${r.status}`);
    } catch (e) {
      this.setStatus('disconnected', (e as Error).message);
    }
  }

  private base(profile?: string): string {
    const root = this.cfg.url.replace(/\/+$/, '');
    return profile && profile !== 'default' ? `${root}/p/${encodeURIComponent(profile)}` : root;
  }

  private async req(path: string, init: RequestInit = {}, profile?: string): Promise<Response> {
    const res = await fetch(`${this.base(profile)}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) throw new Error(`Hermes ${init.method ?? 'GET'} ${path} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res;
  }
  private async json(path: string, init?: RequestInit, profile?: string): Promise<any> {
    return (await this.req(path, init, profile)).json();
  }

  // ---------- Listes ----------
  async listSubAgents(): Promise<SubAgent[]> {
    return this.cfg.profiles.map((p, i) => ({ id: p, name: p, description: 'Profil Hermes', isDefault: i === 0 }));
  }

  async listSkills(subAgentId?: string): Promise<Skill[]> {
    const data = await this.json('/v1/skills', undefined, subAgentId);
    return asArray(data, 'skills', 'data').map((s: Json) => ({
      id: str(s.id) ?? str(s.name) ?? '?',
      name: str(s.name) ?? str(s.id) ?? '?',
      description: str(s.description),
      category: str(s.category),
      enabled: typeof s.enabled === 'boolean' ? s.enabled : undefined,
    }));
  }

  async listJobs(subAgentId?: string): Promise<Job[]> {
    const data = await this.json('/api/jobs', undefined, subAgentId);
    return asArray(data, 'jobs', 'data').map((j: Json) => ({
      id: String(j.id ?? j.job_id),
      name: str(j.name) ?? String(j.id),
      schedule:
        typeof j.schedule === 'string'
          ? j.schedule
          : str(j.schedule?.display) ?? str(j.schedule_display) ?? str(j.schedule?.expr) ?? JSON.stringify(j.schedule ?? ''),
      mode: j.no_agent ? 'script' : 'agent',
      prompt: j.no_agent ? undefined : str(j.prompt),
      script: str(j.script),
      enabled: j.enabled !== false && j.state !== 'paused' && !j.paused_at,
      nextRunAt: toMs(j.next_run_at),
      lastRunAt: toMs(j.last_run_at),
      lastStatus: str(j.last_status) ?? undefined,
    }));
  }

  async jobAction(jobId: string, action: 'pause' | 'resume' | 'run' | 'delete', subAgentId?: string) {
    const p = `/api/jobs/${encodeURIComponent(jobId)}`;
    if (action === 'delete') await this.req(p, { method: 'DELETE' }, subAgentId);
    else await this.req(`${p}/${action}`, { method: 'POST', body: '{}' }, subAgentId);
  }

  async listSessions(): Promise<Session[]> {
    const data = await this.json('/api/sessions');
    return asArray(data, 'sessions', 'data')
      .filter((x: Json) => !x.hidden && !x.archived)
      .map((x: Json) => ({
        id: String(x.id),
        title: str(x.title) ?? str(x.preview) ?? `Session ${String(x.id).slice(0, 8)}`,
        updatedAt: toMs(x.last_active ?? x.ended_at ?? x.started_at) ?? 0,
      }));
  }

  /** Historique : les messages `assistant` (tool_calls) et `tool` d'un même tour sont fusionnés en un message. */
  async getMessages(sessionId: string): Promise<Message[]> {
    const data = await this.json(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
    const out: Message[] = [];
    const calls = new Map<string, ToolCall>();
    let cur: Message | undefined;
    for (const m of asArray(data, 'data', 'messages') as Json[]) {
      const ts = toMs(m.timestamp) ?? 0;
      if (m.role === 'user') {
        cur = undefined;
        out.push({ id: String(m.id), role: 'user', text: typeof m.content === 'string' ? m.content : '', createdAt: ts, status: 'done' });
      } else if (m.role === 'assistant') {
        if (!cur) {
          cur = { id: String(m.id), role: 'assistant', text: '', createdAt: ts, status: 'done', toolCalls: [] };
          out.push(cur);
        }
        if (typeof m.content === 'string' && m.content) cur.text += (cur.text ? '\n\n' : '') + m.content;
        const reasoning = str(m.reasoning_content) ?? str(m.reasoning);
        if (reasoning) cur.reasoning = (cur.reasoning ? cur.reasoning + '\n\n' : '') + reasoning;
        let tcs: Json[] = [];
        try {
          tcs = typeof m.tool_calls === 'string' ? JSON.parse(m.tool_calls) : Array.isArray(m.tool_calls) ? m.tool_calls : [];
        } catch {
          /* format non JSON : ignoré */
        }
        for (const tc of tcs) {
          let args: unknown = tc.function?.arguments;
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {
              /* garde la chaîne */
            }
          }
          const t: ToolCall = { id: String(tc.id ?? tc.call_id), name: String(tc.function?.name ?? tc.name ?? 'tool'), status: 'done', args, startedAt: ts };
          calls.set(t.id, t);
          cur.toolCalls!.push(t);
        }
      } else if (m.role === 'tool') {
        const t = calls.get(String(m.tool_call_id));
        if (t) {
          const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
          t.resultPreview = txt.slice(0, 20000);
          t.resultTruncated = txt.length > 20000;
          t.endedAt = ts;
          t.status = /"error"\s*:\s*"[^"]/.test(txt.slice(0, 400)) ? 'failed' : 'done';
        }
      }
    }
    return out;
  }

  async subSession(sessionId: string): Promise<{ messages: Message[]; ended: boolean }> {
    const [messages, info] = await Promise.all([this.getMessages(sessionId), this.json(`/api/sessions/${encodeURIComponent(sessionId)}`)]);
    return { messages, ended: !!info?.session?.ended_at };
  }

  // ---------- Chat via /v1/runs ----------
  async send(sessionId: string | undefined, input: SendInput): Promise<RunHandle> {
    const profile = input.subAgentId;
    const session = sessionId ?? `agentui-${crypto.randomUUID()}`;
    // Sans image en entrée : flux « session chat », seul à renvoyer les images `MEDIA:` intégrées (base64). Avec images : /v1/runs.
    if (!(input.attachments ?? []).some((a) => a.kind === 'image')) return this.sendSession(session, !sessionId, input, profile);
    const started = await this.json(
      '/v1/runs',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID(), 'X-Hermes-Session-Id': session },
        body: JSON.stringify({ input: this.buildInput(input), session_id: session }),
      },
      profile,
    );
    const runId = String(started.run_id ?? started.id);
    this.runProfile.set(runId, profile ?? 'default');
    return { runId, sessionId: session, events: this.stream(runId, profile) };
  }

  /** POST /api/sessions/{id}/chat/stream : le run démarre et le flux SSE est lu dans la même requête. */
  private async sendSession(session: string, create: boolean, input: SendInput, profile?: string): Promise<RunHandle> {
    if (create) await this.req('/api/sessions', { method: 'POST', body: JSON.stringify({ id: session }) }, profile);
    const startedAt = Date.now();
    const res = await this.req(
      `/api/sessions/${encodeURIComponent(session)}/chat/stream`,
      { method: 'POST', headers: { Accept: 'text/event-stream' }, body: JSON.stringify({ message: input.text }) },
      profile,
    );
    if (!res.body) throw new Error('Flux SSE vide');
    const it = parseSse(res.body)[Symbol.asyncIterator]();
    let runId = '';
    for (;;) {
      const n = await it.next();
      if (n.done) throw new Error('Hermes a fermé le flux avant le démarrage du run');
      let d: Json = {};
      try { d = JSON.parse(n.value.data); } catch { /* ignoré */ }
      if (/error|failed/.test(n.value.event)) throw new Error(str(d.error) ?? str(d.message) ?? 'Hermes a refusé le message');
      if (n.value.event === 'run.started' || str(d.run_id)) { runId = String(d.run_id); break; }
    }
    this.runProfile.set(runId, profile ?? 'default');
    return { runId, sessionId: session, events: this.streamSession(it, runId, session, startedAt, profile) };
  }

  /** Sous-agents créés par ce run : sessions `subagent` dont le parent est la session (le flux session n'émet pas d'événement dédié). */
  private async newChildren(session: string, since: number, known: Set<string>, profile?: string): Promise<AgentEvent[]> {
    const data = await this.json('/api/sessions?limit=50&include_children=true', undefined, profile).catch(() => null);
    const out: AgentEvent[] = [];
    for (const x of asArray(data, 'data', 'sessions') as Json[]) {
      const id = String(x.id);
      if (x.source !== 'subagent' || x.parent_session_id !== session || known.has(id) || (toMs(x.started_at) ?? 0) < since - 5000) continue;
      known.add(id);
      out.push({ type: 'subagent.start', id, name: 'subagent', sessionId: id });
    }
    return out;
  }

  private async *streamSession(it: AsyncIterator<{ event: string; data: string }>, runId: string, session: string, startedAt: number, profile?: string): AsyncGenerator<AgentEvent> {
    const running = new Map<string, string[]>();
    const children = new Set<string>();
    let n = 0;
    let expected = 0; // sous-agents annoncés par delegate_task (leur session apparaît quelques secondes plus tard)
    let streamed = false;
    let ended = false;
    let interrupted = false;
    try {
      for (;;) {
        const m = await it.next();
        if (m.done) break;
        const name = m.value.event;
        let d: Json;
        try { d = JSON.parse(m.value.data); } catch { continue; }
        if (name === 'assistant.delta') {
          const t = str(d.delta);
          if (t) { streamed = true; yield { type: 'message.delta', text: t }; }
        } else if (name === 'tool.progress') {
          if (d.tool_name === '_thinking' && str(d.delta)) yield { type: 'reasoning.delta', text: d.delta };
        } else if (name === 'tool.started') {
          const tool = str(d.tool_name) ?? 'tool';
          const id = `${runId}-t${++n}`;
          running.set(tool, [...(running.get(tool) ?? []), id]);
          yield { type: 'tool.started', id, name: tool, args: d.args ?? d.preview };
          if (tool === 'delegate_task' && Array.isArray(d.args?.tasks)) expected += d.args.tasks.length;
        } else if (name === 'tool.completed') {
          const tool = str(d.tool_name) ?? 'tool';
          yield { type: 'tool.completed', id: running.get(tool)?.shift() ?? `${runId}-t${++n}`, name: tool, failed: d.error === true };
          if (tool === 'delegate_task') yield* await this.newChildren(session, startedAt, children, profile);
        } else if (name === 'assistant.completed') {
          if (d.interrupted === true) interrupted = true;
          const { text, images } = splitInlineImages(str(d.content) ?? '');
          if (text || images.length || !streamed) yield { type: 'message.final', text };
          for (const url of images) yield { type: 'message.media', url, name: 'image', mimeType: url.slice(5, url.indexOf(';')) };
        } else if (name === 'run.completed') {
          for (let i = 0; i < 20; i++) {
            yield* await this.newChildren(session, startedAt, children, profile);
            if (children.size >= expected) break;
            await new Promise((r) => setTimeout(r, 1000));
          }
          ended = true;
          if (d.interrupted === true || this.abortedRuns.has(runId)) interrupted = true;
          yield interrupted ? { type: 'run.aborted' } : { type: 'run.completed' };
          return;
        } else {
          const ev = this.mapEvent(name, d);
          if (ev && (ev.type === 'approval.request' || ev.type === 'run.failed' || ev.type === 'run.aborted')) {
            yield ev;
            if (ev.type !== 'approval.request') { ended = true; return; }
          }
        }
      }
      if (!ended) yield interrupted || this.abortedRuns.has(runId) ? { type: 'run.aborted' } : { type: 'run.completed' };
    } finally {
      this.runProfile.delete(runId);
      this.abortedRuns.delete(runId);
    }
  }

  /** Les images renvoyées par Hermes sont intégrées au texte (`data:image/…;base64,…`) : on les décode ici. */
  async fetchMedia(url: string): Promise<{ data: Buffer; mimeType: string }> {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(url);
    if (!m) throw new Error('Média non pris en charge');
    const data = Buffer.from(m[2]!, 'base64');
    if (data.length > 20 * 1024 * 1024) throw new Error('Média trop volumineux');
    return { data, mimeType: m[1]! };
  }

  /** Texte seul → chaîne ; avec images → message multimodal au format OpenAI (validé sur Hermes v0.21). */
  private buildInput(input: SendInput): unknown {
    const images = (input.attachments ?? []).filter((a) => a.kind === 'image');
    if (!images.length) return input.text;
    return [
      {
        role: 'user',
        content: [
          { type: 'text', text: input.text || 'Voici une image.' },
          ...images.map((a) => ({ type: 'image_url', image_url: { url: `data:${a.mimeType};base64,${Buffer.from(a.data).toString('base64')}` } })),
        ],
      },
    ];
  }

  private async *stream(runId: string, profile?: string): AsyncGenerator<AgentEvent> {
    const res = await this.req(`/v1/runs/${runId}/events`, { headers: { Accept: 'text/event-stream' } }, profile);
    if (!res.body) throw new Error('Flux SSE vide');
    // Hermes n'envoie pas d'`event:` ni d'identifiant d'outil : on apparie début/fin par nom (FIFO).
    const running = new Map<string, string[]>();
    let n = 0;
    let streamed = false;
    try {
      for await (const m of parseSse(res.body)) {
        let d: Json;
        try {
          d = JSON.parse(m.data);
        } catch {
          continue;
        }
        const name = str(d.event) ?? m.event;
        if (name === 'tool.started') {
          const id = `${runId}-t${++n}`;
          running.set(d.tool, [...(running.get(d.tool) ?? []), id]);
          d = { ...d, id };
        } else if (name === 'tool.completed' || name === 'tool.failed') {
          d = { ...d, id: running.get(d.tool)?.shift() ?? `${runId}-t${++n}` };
        }
        const ev = this.mapEvent(name, d);
        if (!ev) continue;
        if (ev.type === 'message.delta') streamed = true;
        if (ev.type === 'run.completed' && !streamed && str(d.output)) yield { type: 'message.final', text: d.output };
        yield ev;
        if (ev.type === 'run.completed' || ev.type === 'run.failed' || ev.type === 'run.aborted') return;
      }
    } finally {
      this.runProfile.delete(runId);
    }
  }

  /** Mapping validé sur de vrais flux Hermes v0.21 (voir scripts/ et tests). */
  mapEvent(name: string, d: Json): AgentEvent | null {
    switch (name) {
      case 'message.delta':
        return { type: 'message.delta', text: str(d.delta) ?? str(d.text) ?? str(d.content) ?? '' };
      case 'message.interim':
        return { type: 'message.delta', text: (str(d.text) ?? str(d.content) ?? '') + '\n' };
      case 'reasoning.delta':
      case 'reasoning.available':
        return { type: 'reasoning.delta', text: str(d.delta) ?? str(d.text) ?? '' };
      case 'tool.started':
        return {
          type: 'tool.started',
          id: String(d.id ?? d.tool_call_id ?? d.call_id ?? crypto.randomUUID()),
          name: str(d.tool) ?? str(d.name) ?? 'tool',
          args: d.arguments ?? d.args ?? d.input ?? d.preview,
          parentSubAgentRunId: str(d.subagent_id),
        };
      case 'tool.completed':
      case 'tool.failed': {
        const result = d.result ?? d.output;
        const text = typeof result === 'string' ? result : result === undefined ? undefined : JSON.stringify(result);
        return {
          type: 'tool.completed',
          id: String(d.id ?? d.tool_call_id ?? d.call_id ?? ''),
          name: str(d.tool) ?? str(d.name),
          result: text?.slice(0, 20000),
          truncated: (text?.length ?? 0) > 20000,
          failed: name === 'tool.failed' || (d.error !== undefined && d.error !== false && d.error !== null) || d.is_error === true,
        };
      }
      case 'subagent.start':
        return { type: 'subagent.start', id: String(d.id ?? d.subagent_id ?? ''), name: str(d.name) ?? 'subagent', sessionId: str(d.child_session_id) };
      case 'subagent.complete':
        return { type: 'subagent.end', id: String(d.id ?? d.subagent_id ?? ''), failed: d.error !== undefined && d.error !== false };
      case 'approval.request':
        return {
          type: 'approval.request',
          id: String(d.id ?? d.approval_id ?? ''),
          description: str(d.description) ?? str(d.command) ?? 'Approbation requise',
          payload: d,
        };
      case 'run.completed':
        return { type: 'run.completed' };
      case 'run.interrupted':
      case 'run.cancelled':
        return { type: 'run.aborted' };
      case 'run.failed':
        return { type: 'run.failed', error: str(d.error) ?? 'Échec du run' };
      default:
        return null;
    }
  }

  /** Reprise après redémarrage : le flux SSE n'existe que pendant le run, on suit donc le statut (`GET /v1/runs/{id}`). */
  async resume(runId: string, sessionId: string, subAgentId?: string): Promise<RunHandle | null> {
    const first = await this.json(`/v1/runs/${runId}`, undefined, subAgentId).catch(() => null);
    if (!first) return null;
    this.runProfile.set(runId, subAgentId ?? 'default');
    const poll = async function* (self: HermesAdapter): AsyncGenerator<AgentEvent> {
      let st: Json = first;
      try {
        for (let i = 0; i < 900; i++) {
          const status = String(st.status);
          if (status === 'completed') {
            if (str(st.output)) yield { type: 'message.final', text: st.output };
            return void (yield { type: 'run.completed' });
          }
          if (status === 'failed') return void (yield { type: 'run.failed', error: str(st.error) ?? 'Échec du run' });
          if (status === 'cancelled' || status === 'interrupted' || status === 'stopped') return void (yield { type: 'run.aborted' });
          await new Promise((r) => setTimeout(r, 2000));
          st = await self.json(`/v1/runs/${runId}`, undefined, subAgentId);
        }
        yield { type: 'run.failed', error: 'Run toujours en cours après 30 min : suivi abandonné' };
      } finally {
        self.runProfile.delete(runId);
      }
    };
    return { runId, sessionId, events: poll(this) };
  }

  async abort(runId: string): Promise<void> {
    this.abortedRuns.add(runId);
    await this.req(`/v1/runs/${runId}/stop`, { method: 'POST', body: '{}' }, this.runProfile.get(runId));
  }

  async resolveApproval(runId: string, approvalId: string, approve: boolean): Promise<void> {
    await this.req(
      `/v1/runs/${runId}/approval`,
      { method: 'POST', body: JSON.stringify({ approval_id: approvalId, approved: approve, decision: approve ? 'approve' : 'deny' }) },
      this.runProfile.get(runId),
    );
  }
}
