// Client WebSocket vers la gateway AgentUI : handshake, reconnexion avec backoff, file d'envoi ordonnée.
// Sans dépendance à OpenClaw (WebSocket natif de Node ≥ 22).
import { PROTOCOL, type Capabilities, type GatewayMessage, type PluginMessage } from './protocol.js';

export interface ClientOptions {
  url: string;
  token: string;
  agent: { type: string; name: string; version?: string };
  capabilities: Capabilities;
  /** Runs encore en cours, renvoyés dans `hello` après une reconnexion. */
  activeRuns?: () => Array<{ runId: string; conversationId: string }>;
  /** Sous-agents annoncés dans `hello` (agents OpenClaw). */
  subAgents?: () => Array<{ id: string; name: string; description?: string; isDefault?: boolean }>;
  onMessage: (msg: GatewayMessage) => void | Promise<void>;
  onStatus?: (connected: boolean, detail?: string) => void;
  log?: (msg: string) => void;
  mode?: 'send-only';
}

const OUTBOX_LIMIT = 2000;

export class AgentUIClient {
  private ws?: WebSocket;
  private outbox: PluginMessage[] = [];
  private closed = false;
  private ready = false;
  private delay = 1000;
  private timer?: ReturnType<typeof setTimeout>;
  private welcomeWaiters: Array<() => void> = [];

  constructor(private opts: ClientOptions) {}

  start(): void {
    this.closed = false;
    this.open();
  }

  stop(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close(1000, 'arrêt');
  }

  /** Résolu au premier `welcome` (ou après `timeoutMs`). */
  waitReady(timeoutMs = 15000): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.welcomeWaiters.push(() => (clearTimeout(t), resolve(true)));
    });
  }

  /** Envoi ordonné ; conservé en file pendant une coupure. */
  send(msg: PluginMessage): void {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    if (this.outbox.length < OUTBOX_LIMIT) this.outbox.push(msg);
  }

  private open(): void {
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocol: PROTOCOL,
          token: this.opts.token,
          agent: this.opts.agent,
          capabilities: this.opts.capabilities,
          activeRuns: this.opts.activeRuns?.() ?? [],
          ...(this.opts.subAgents ? { subAgents: this.opts.subAgents() } : {}),
          ...(this.opts.mode ? { mode: this.opts.mode } : {}),
        } satisfies PluginMessage),
      );
    };
    ws.onmessage = (ev) => {
      let msg: GatewayMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!this.ready) {
        if (msg.type !== 'welcome') return;
        this.ready = true;
        this.delay = 1000;
        this.opts.onStatus?.(true);
        this.opts.log?.(`connecté à ${this.opts.url}`);
        for (const m of this.outbox.splice(0)) ws.send(JSON.stringify(m));
        for (const w of this.welcomeWaiters.splice(0)) w();
        return;
      }
      if (msg.type === 'ping') return this.send({ type: 'pong' });
      void Promise.resolve(this.opts.onMessage(msg)).catch((e) => this.opts.log?.(`trame en échec : ${String(e)}`));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ready = false;
      this.ws = undefined;
      if (ev.code === 4001 || ev.code === 4002) {
        this.opts.onStatus?.(false, `refusé par AgentUI (${ev.code} ${ev.reason})`);
        this.closed = true;
        return;
      }
      this.opts.onStatus?.(false, ev.reason || `fermeture ${ev.code}`);
      if (this.closed) return;
      this.opts.log?.(`connexion perdue, reconnexion dans ${this.delay / 1000} s`);
      this.timer = setTimeout(() => this.open(), this.delay);
      this.delay = Math.min(this.delay * 2, 30000);
    };
    ws.onerror = () => {
      /* suivi par onclose */
    };
  }
}
