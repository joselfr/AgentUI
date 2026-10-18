import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { AgentInfo, ServerPush, Usage } from '@agentui/shared';
import { env, loadConfig } from './config.js';
import { openDb } from './db.js';
import { changePassword, ensureAdmin, login, logout, RateLimiter, userFromToken, type AuthUser } from './auth.js';
import { createAdapter } from './agents/registry.js';
import { GatewayAdapter, sameToken, type GatewaySocket } from './agents/gateway.js';
import type { AgentAdapter } from './agents/types.js';
import { RunManager } from './runs.js';
import { PushService } from './push.js';
import { AttachmentError, AttachmentStore } from './attachments.js';
import { createReadStream } from 'node:fs';
import { AppData } from './miniapps/data.js';
import { registerMiniApps } from './miniapps/routes.js';
import { AppError, MiniAppStore } from './miniapps/store.js';
import { handleAppOp, isAppOp, opError } from './miniapps/ops.js';

const COOKIE = 'agentui_session';

async function main() {
  const db = openDb(env.dataDir);
  ensureAdmin(db, env.adminUser, env.adminPassword);

  const adapters = new Map<string, AgentAdapter>();
  for (const cfg of loadConfig().agents) adapters.set(cfg.id, createAdapter(cfg, { dataDir: env.dataDir }));
  const files = new AttachmentStore(db, env.dataDir);
  const runs = new RunManager(db, adapters, files);
  const push = new PushService(db);
  runs.onRunFinished = (conv, outcome, preview) => {
    if (outcome === 'aborted') return;
    const fresh = runs.getConversation(conv.id) ?? conv;
    const agent = adapters.get(conv.agent_id)?.name ?? conv.agent_id;
    void push
      .notify({
        title: outcome === 'failed' ? `${agent}: failed` : `${agent} replied`,
        body: preview ? `${fresh.title} — ${preview}` : fresh.title,
        url: `/c/${conv.id}`,
        tag: conv.id,
      })
      .catch((e) => app.log.warn({ err: e }, 'push send failed'));
  };

  const app = Fastify({ logger: true, trustProxy: true });
  const secret = env.cookieSecret || randomBytes(32).toString('hex');
  if (!env.cookieSecret) app.log.warn('COOKIE_SECRET missing: ephemeral secret (sessions invalidated on restart)');
  await app.register(fastifyCookie, { secret });
  await app.register(fastifyWebsocket);

  const limiter = new RateLimiter();
  const userOf = (cookies: Record<string, string | undefined>): AuthUser | null => {
    const raw = cookies[COOKIE];
    const unsigned = raw ? app.unsignCookie(raw) : undefined;
    return userFromToken(db, unsigned?.valid ? (unsigned.value ?? undefined) : undefined);
  };

  // Authentication guard + CSRF protection (SameSite + custom header) on /api
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/auth/login') || req.url === '/api/health') return;
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'agentui') {
      return reply.code(403).send({ error: 'csrf' });
    }
    if (!userOf(req.cookies)) return reply.code(401).send({ error: 'unauthorized' });
  });

  // Validation errors (zod) → readable 400 rather than 500
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues.map((i) => i.message).join(' ; ') });
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.message });
    const e = err as { statusCode?: number; message?: string };
    const code = e.statusCode ?? 500;
    if (code >= 500) app.log.error(err);
    return reply.code(code).send({ error: e.message ?? 'Internal error' });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  // ---------- Auth ----------
  app.post('/api/auth/login', async (req, reply) => {
    if (req.headers['x-requested-with'] !== 'agentui') return reply.code(403).send({ error: 'csrf' });
    const body = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    const key = `${req.ip}|${body.username}`;
    if (limiter.blocked(key)) return reply.code(429).send({ error: 'Too many attempts, try again later' });
    const res = login(db, body.username, body.password);
    if (!res) {
      limiter.fail(key);
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    limiter.reset(key);
    reply.setCookie(COOKIE, res.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: env.secureCookies,
      signed: true,
      path: '/',
      maxAge: 30 * 24 * 3600,
    });
    return { user: res.user };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies[COOKIE];
    const u = raw ? app.unsignCookie(raw) : undefined;
    if (u?.valid) logout(db, u.value ?? undefined);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/auth/me', async (req) => ({ user: userOf(req.cookies) }));
  app.post('/api/auth/password', async (req, reply) => {
    const body = z.object({ oldPassword: z.string(), newPassword: z.string().min(8) }).parse(req.body);
    const user = userOf(req.cookies)!;
    if (!changePassword(db, user.id, body.oldPassword, body.newPassword)) return reply.code(400).send({ error: 'Current password is incorrect' });
    return { ok: true };
  });

  // ---------- Notifications push ----------
  app.get('/api/push/key', async () => ({ publicKey: push.publicKey }));
  app.post('/api/push/subscribe', async (req) => {
    const sub = z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).parse(req.body);
    push.subscribe(userOf(req.cookies)!.id, sub);
    return { ok: true };
  });
  app.post('/api/push/unsubscribe', async (req) => {
    push.unsubscribe(z.object({ endpoint: z.string() }).parse(req.body).endpoint);
    return { ok: true };
  });

  // ---------- Agents ----------
  const info = (a: AgentAdapter): AgentInfo => ({
    id: a.id,
    name: a.name,
    type: a.type,
    status: a.status().status,
    statusDetail: a.status().detail,
    capabilities: a.capabilities(),
  });
  const adapterOf = (id: string): AgentAdapter => {
    const a = adapters.get(id);
    if (!a) throw Object.assign(new Error('Unknown agent'), { statusCode: 404 });
    return a;
  };

  app.get('/api/agents', async () => [...adapters.values()].map(info));
  app.get<{ Params: { id: string } }>('/api/agents/:id/subagents', async (req) => adapterOf(req.params.id).listSubAgents());
  app.get<{ Params: { id: string }; Querystring: { sub?: string } }>('/api/agents/:id/skills', async (req) =>
    adapterOf(req.params.id).listSkills(req.query.sub),
  );
  app.get<{ Params: { id: string; skillId: string }; Querystring: { sub?: string } }>('/api/agents/:id/skills/:skillId', async (req, reply) => {
    const a = adapterOf(req.params.id);
    if (!a.readSkill) return reply.code(501).send({ error: 'Not supported' });
    return { content: await a.readSkill(req.params.skillId, req.query.sub) };
  });
  app.get<{ Params: { id: string }; Querystring: { sub?: string } }>('/api/agents/:id/jobs', async (req) =>
    // Link to the chat that receives the results of each task, when it already exists.
    (await adapterOf(req.params.id).listJobs(req.query.sub)).map((j) => {
      const conv = j.deliverTo ? runs.findByRemoteSession(req.params.id, j.deliverTo) : undefined;
      return conv ? { ...j, conversationId: conv.id } : j;
    }),
  );
  app.post<{ Params: { id: string; jobId: string; action: string }; Querystring: { sub?: string } }>(
    '/api/agents/:id/jobs/:jobId/:action',
    async (req, reply) => {
      const a = adapterOf(req.params.id);
      const action = z.enum(['pause', 'resume', 'run', 'delete']).parse(req.params.action);
      if (!a.jobAction) return reply.code(501).send({ error: 'Not supported' });
      await a.jobAction(req.params.jobId, action, req.query.sub);
      return { ok: true };
    },
  );

  // ---------- Conversations ----------
  const convDto = (c: ReturnType<RunManager['listConversations']>[number]) => ({
    id: c.id,
    agentId: c.agent_id,
    subAgentId: c.sub_agent_id ?? undefined,
    title: c.title,
    updatedAt: c.updated_at,
    running: runs.isRunning(c.id),
    unread: !!c.unread,
    favorite: !!c.favorite,
    archived: !!c.archived,
    usage: c.usage ? (JSON.parse(c.usage) as Usage) : undefined,
    cron: !!c.remote_session_id?.startsWith('cron-'), // chat dedicated to a scheduled task
    lastReadAt: c.last_read_at ?? 0, // previous read: used to spot unread messages at opening
  });
  app.get<{ Querystring: { agentId?: string } }>('/api/conversations', async (req) =>
    runs.listConversations(req.query.agentId).map(convDto),
  );
  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) =>
    runs.search(z.string().max(100).catch('').parse(req.query.q)),
  );
  // ---------- Model and cost ----------
  app.get<{ Params: { id: string } }>('/api/agents/:id/models', async (req) => {
    const a = adapterOf(req.params.id);
    return a.listModels ? a.listModels() : [];
  });
  /** Refreshes the consumption of a chat from the agent (current model, tokens, cost), e.g. at opening. */
  app.get<{ Params: { id: string } }>('/api/conversations/:id/usage', async (req, reply) => {
    const c = runs.getConversation(req.params.id);
    if (!c) return reply.code(404).send({ error: 'not found' });
    const a = adapterOf(c.agent_id);
    if (!a.sessionUsage || !c.remote_session_id) return c.usage ? JSON.parse(c.usage) : null;
    const usage = await a.sessionUsage(c.remote_session_id, c.sub_agent_id ?? undefined).catch(() => undefined);
    if (usage) runs.setUsage(c.id, usage);
    return usage ?? (c.usage ? JSON.parse(c.usage) : null);
  });
  /** Changes the model of a chat. A never-used chat first gets its session identifier. */
  app.put<{ Params: { id: string } }>('/api/conversations/:id/model', async (req, reply) => {
    const b = z.object({ model: z.string().min(1).max(200), provider: z.string().max(100).optional() }).parse(req.body);
    const c = runs.getConversation(req.params.id);
    if (!c) return reply.code(404).send({ error: 'not found' });
    const a = adapterOf(c.agent_id);
    if (!a.setModel) return reply.code(501).send({ error: 'This agent cannot change the model' });
    if (runs.isRunning(c.id)) return reply.code(409).send({ error: 'A reply is in progress: wait for it to finish before changing the model' });
    const sessionId = runs.ensureRemoteSession(c.id);
    const r = await a.setModel(sessionId, b.model, b.provider, c.sub_agent_id ?? undefined);
    const usage = (await a.sessionUsage?.(sessionId, c.sub_agent_id ?? undefined).catch(() => undefined)) ?? { ...(c.usage ? JSON.parse(c.usage) : { inputTokens: 0, outputTokens: 0 }), model: r.model, provider: r.provider };
    runs.setUsage(c.id, { ...usage, model: r.model, provider: r.provider ?? usage.provider });
    return { ...r, usage: runs.getConversation(c.id)?.usage ? JSON.parse(runs.getConversation(c.id)!.usage!) : undefined };
  });
  app.post('/api/conversations', async (req) => {
    const b = z.object({ agentId: z.string(), subAgentId: z.string().optional() }).parse(req.body);
    adapterOf(b.agentId);
    return convDto(runs.createConversation(b.agentId, b.subAgentId));
  });
  app.get<{ Params: { id: string } }>('/api/conversations/:id/messages', async (req, reply) => {
    const c = runs.getConversation(req.params.id);
    if (!c) return reply.code(404).send({ error: 'not found' });
    return { conversation: convDto(c), messages: runs.getMessages(c.id) };
  });
  app.post<{ Params: { id: string } }>('/api/conversations/:id/read', async (req, reply) => {
    if (!runs.getConversation(req.params.id)) return reply.code(404).send({ error: 'not found' });
    runs.markRead(req.params.id);
    return { ok: true };
  });
  app.patch<{ Params: { id: string } }>('/api/conversations/:id', async (req) => {
    const b = z.object({ title: z.string().min(1).max(200).optional(), favorite: z.boolean().optional(), archived: z.boolean().optional() }).parse(req.body);
    if (b.title !== undefined) runs.renameConversation(req.params.id, b.title);
    if (b.favorite !== undefined) runs.setFavorite(req.params.id, b.favorite);
    if (b.archived !== undefined) runs.setArchived(req.params.id, b.archived);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req) => {
    await runs.deleteConversation(req.params.id); // the platform session is deleted by the channel plugin
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/conversations/:id/send', { bodyLimit: 40 * 1024 * 1024 }, async (req, reply) => {
    const b = z
      .object({
        text: z.string().max(100_000).default(''),
        attachments: z.array(z.object({ name: z.string().min(1).max(300), mimeType: z.string().max(200).default(''), data: z.string() })).max(20).default([]),
      })
      .refine((v) => v.text.trim() || v.attachments.length, { message: 'Message vide' })
      .parse(req.body);
    try {
      // During an agent question (question.requested), the message is the answer: it resumes the current run.
      if (runs.awaitingReply(req.params.id)) {
        if (b.attachments.length) return reply.code(400).send({ error: 'No attachment in an answer' });
        return await runs.reply(req.params.id, b.text);
      }
      return await runs.start(req.params.id, b.text, b.attachments);
    } catch (e) {
      return reply.code(e instanceof AttachmentError ? 400 : 409).send({ error: (e as Error).message });
    }
  });
  app.get<{ Params: { id: string } }>('/api/attachments/:id', async (req, reply) => {
    const f = files.get(req.params.id);
    if (!f) return reply.code(404).send({ error: 'not found' });
    // Only verified images are displayed inline; everything else is downloaded, never interpreted by the browser.
    const inline = /^image\/(png|jpeg|gif|webp)$/.test(f.mimeType);
    return reply
      .header('Content-Type', inline ? f.mimeType : 'application/octet-stream')
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=86400')
      .send(createReadStream(f.path));
  });
  app.post<{ Params: { id: string } }>('/api/conversations/:id/abort', async (req) => {
    await runs.abort(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/conversations/:id/approval', async (req) => {
    const b = z.object({ approvalId: z.string(), approve: z.boolean() }).parse(req.body);
    await runs.approve(req.params.id, b.approvalId, b.approve);
    return { ok: true };
  });

  // ---------- Mini-apps (created by the agents, shown in the Apps tab) ----------
  const apps = new MiniAppStore(db, env.dataDir);
  apps.onChange = (id, kind) => runs.broadcast({ type: 'app.changed', appId: id, removed: kind === 'removed' });
  registerMiniApps(app, {
    store: apps,
    data: new AppData(db),
    secret,
    userOf,
    runtimeDir: resolve(process.env.APP_RUNTIME_DIST ?? '../../packages/app-runtime/dist'),
  });

  // ---------- WebSocket ----------
  app.get('/ws', { websocket: true }, (socket, req) => {
    if (!userOf(req.cookies)) {
      socket.close(4401, 'unauthorized');
      return;
    }
    const send = (p: ServerPush) => socket.readyState === 1 && socket.send(JSON.stringify(p));
    for (const a of adapters.values()) send({ type: 'agent.status', agentId: a.id, status: a.status().status, detail: a.status().detail });
    // Live events are only sent after the "resume" to avoid duplicates/gaps
    let live = false;
    const queue: ServerPush[] = [];
    const unsub = runs.subscribe((p) => (live ? send(p) : queue.push(p)));
    socket.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw)) as { type: string; since?: number };
        if (m.type === 'resume') {
          let last = m.since ?? 0;
          for (const p of runs.eventsSince(last)) {
            send(p);
            if (p.type === 'event') last = p.seq;
          }
          for (const p of queue.splice(0)) if (p.type !== 'event' || p.seq > last) send(p);
          live = true;
        }
      } catch {
        /* ignored */
      }
    });
    socket.on('close', unsub);
    socket.on('error', unsub);
  });

  // ---------- Plugin channel gateway (Hermes, OpenClaw…) ----------
  // The plugin installed in the platform connects here; authentication by the agent's token (first message).
  const gateways = [...adapters.values()].filter((a): a is GatewayAdapter => a instanceof GatewayAdapter);
  for (const g of gateways) {
    g.onAppOp = async (op, args) => {
      if (!isAppOp(op)) throw new AppError(`Unknown app operation "${op}".`);
      return handleAppOp(apps, g.id, op, args);
    };
    g.onAppOpError = opError;
    g.onOutbound = (m) => {
      const conv = runs.deliver(g.id, m.conversationId, m.text, m.media, g.name, m.title);
      app.log.info({ agent: g.id, conversation: conv.id }, 'proactive message received');
    };
  }
  app.get('/gateway', { websocket: true }, (socket) => {
    const ws = socket as unknown as GatewaySocket;
    const timer = setTimeout(() => ws.close(4001, 'hello attendu'), 10_000);
    socket.once('message', (raw) => {
      clearTimeout(timer);
      let hello: Record<string, any>;
      try {
        hello = JSON.parse(String(raw));
      } catch {
        return ws.close(4001, 'invalid hello');
      }
      if (hello.type !== 'hello' || typeof hello.token !== 'string') return ws.close(4001, 'hello attendu');
      const g = gateways.find((x) => sameToken(x.token, hello.token));
      if (!g) {
        app.log.warn('gateway: token rejected');
        return ws.close(4001, 'invalid token');
      }
      if (hello.protocol !== 1) return ws.close(4002, 'unsupported protocol');
      app.log.info({ agent: g.id, plugin: hello.agent, mode: hello.mode }, 'channel plugin connected');
      g.attach(ws, hello);
    });
  });

  const connections: Promise<unknown>[] = [];
  for (const a of adapters.values()) {
    a.onStatus((status, detail) => runs.broadcast({ type: 'agent.status', agentId: a.id, status, detail }));
    connections.push(a.connect().catch((e) => app.log.error({ err: e, agent: a.id }, 'agent connection failed')));
  }
  // Resume the runs interrupted by a restart, once the agents are (re)connected
  void Promise.allSettled(connections).then(() => runs.recover()).then((n) => n && app.log.info(`${n} run(s) resumed after restart`));

  // ---------- Front statique (build web) ----------
  const webDist = resolve(process.env.WEB_DIST ?? '../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') || req.url.startsWith('/a/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'),
    );
  }

  await app.listen({ port: env.port, host: env.host });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
