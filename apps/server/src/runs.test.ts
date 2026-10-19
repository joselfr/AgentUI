import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@agentui/shared';
import { expect, test, vi } from 'vitest';
import { openDb } from './db.js';
import type { AgentAdapter } from './agents/types.js';
import { RunManager } from './runs.js';
import { hashPassword, verifyPassword } from './auth.js';

test('run: persistence of text and tools, replayable events', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  async function* events() {
    yield { type: 'run.started' as const };
    yield { type: 'tool.started' as const, id: 't1', name: 'terminal', args: 'ls' };
    yield { type: 'tool.completed' as const, id: 't1', name: 'terminal' };
    yield { type: 'message.delta' as const, text: 'Bon' };
    yield { type: 'message.delta' as const, text: 'jour' };
    yield { type: 'message.final' as const, text: 'Bonjour' };
    yield { type: 'run.completed' as const };
  }
  const adapter = {
    id: 'h',
    name: 'H',
    type: 'fake',
    capabilities: () => ({}),
    send: async () => ({ runId: 'r1', sessionId: 'sess', events: events() }),
    abort: async () => {},
  } as unknown as AgentAdapter;
  const runs = new RunManager(db, new Map([['h', adapter]]));
  const finished = new Promise<string>((r) => (runs.onRunFinished = (_c, o) => r(o)));

  const conv = runs.createConversation('h');
  await runs.start(conv.id, 'salut');
  expect(await finished).toBe('completed');

  const msgs = runs.getMessages(conv.id);
  expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(msgs[1]!.text).toBe('Bonjour');
  expect(msgs[1]!.status).toBe('done');
  expect(msgs[1]!.toolCalls).toMatchObject([{ name: 'terminal', status: 'done', args: 'ls' }]);
  expect(runs.eventsSince(0).length).toBe(7);
  expect(runs.isRunning(conv.id)).toBe(false);
});

test('widget event: travels as the answer of the live session (agentui_widget_custom_wait), tagged with the widget, stored hidden', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const replies: string[] = [];
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  const push = (e: AgentEvent) => { queue.push(e); wake?.(); };
  const adapter = {
    capabilities: () => ({}),
    async send() {
      async function* events() {
        for (;;) {
          while (!queue.length) await new Promise<void>((r) => (wake = r));
          const e = queue.shift()!;
          yield e;
          if (e.type === 'run.completed') return;
        }
      }
      return { runId: 'r1', sessionId: 's1', events: events() };
    },
    async reply(_runId: string, _sessionId: string, text: string) { replies.push(text); },
  } as unknown as AgentAdapter;
  const runs = new RunManager(db, new Map([['a', adapter]]));
  const conv = runs.createConversation('a');
  await runs.start(conv.id, 'play chess');
  push({ type: 'question.requested', id: 'w1' }); // the agent is in agentui_widget_custom_wait
  await vi.waitFor(() => expect(runs.awaitingReply(conv.id)).toBe(true));
  await runs.reply(conv.id, 'move e2e4', { token: '[[agentui:a1b2c3]]' });
  expect(JSON.parse(replies[0]!)).toEqual({ agentui: 'widget-event', widget: '[[agentui:a1b2c3]]', text: 'move e2e4' });
  const msgs = runs.getMessages(conv.id);
  expect(msgs.filter((m) => m.role === 'user').map((m) => [m.text, m.hidden])).toEqual([['play chess', undefined], ['move e2e4', true]]);
  push({ type: 'run.completed' });
});

test('scrypt passwords', () => {
  const h = hashPassword('secret123');
  expect(verifyPassword('secret123', h)).toBe(true);
  expect(verifyPassword('nope', h)).toBe(false);
});

test('recover: a "streaming" run is resumed, or marked interrupted if resuming is impossible', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const mk = (resume: unknown) =>
    ({ id: 'a', name: 'A', type: 'fake', resume, abort: async () => {} }) as unknown as import('./agents/types.js').AgentAdapter;
  const events = async function* () {
    yield { type: 'message.final' as const, text: 'repris !' };
    yield { type: 'run.completed' as const };
  };
  const seed = (runs: RunManager) => {
    const conv = runs.createConversation('a', undefined, 't', 'sess');
    db.prepare("INSERT INTO messages (id, conversation_id, role, text, run_id, status, created_at) VALUES ('m-' || ?, ?, 'assistant', 'start', 'r', 'streaming', 1)").run(conv.id, conv.id);
    return conv.id;
  };

  const ok = new RunManager(db, new Map([['a', mk(async () => ({ runId: 'r', sessionId: 'sess', events: events() }))]]));
  const c1 = seed(ok);
  const done = new Promise((r) => (ok.onRunFinished = () => r(0)));
  expect(await ok.recover()).toBe(1);
  await done;
  expect(ok.getMessages(c1)[0]).toMatchObject({ status: 'done', text: 'repris !' });

  const ko = new RunManager(db, new Map([['a', mk(undefined)]]));
  const c2 = seed(ko);
  expect(await ko.recover()).toBe(0);
  expect(ko.getMessages(c2)[0]).toMatchObject({ status: 'failed' });
  expect(ko.getMessages(c2)[0]!.text).toContain('interrupted');
});

test('deletion: the platform session is deleted before the chat', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const calls: string[] = [];
  const adapter = {
    id: 'a',
    name: 'A',
    type: 'fake',
    async deleteSession(sessionId: string) {
      calls.push(`delete:${sessionId}`);
    },
  } as unknown as AgentAdapter;
  const runs = new RunManager(db, new Map([['a', adapter]]));
  const conv = runs.createConversation('a', undefined, 't', 'sess-1');
  db.prepare("INSERT INTO messages (id, conversation_id, role, text, status, created_at) VALUES ('m1', ?, 'user', 'salut', 'done', 1)").run(conv.id);

  await runs.deleteConversation(conv.id);
  expect(calls).toEqual(['delete:sess-1']);
  expect(runs.getConversation(conv.id)).toBeUndefined();
  expect(runs.getMessages(conv.id)).toEqual([]);
  await runs.deleteConversation(conv.id); // chat already absent: no effect, no new call
  expect(calls).toEqual(['delete:sess-1']);
});

test('deletion: plugin refusal or agent without deletion → the chat is kept', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const keep = (runs: RunManager, conv: string) => {
    expect(runs.getConversation(conv)).toBeTruthy();
    expect(runs.getMessages(conv)).toHaveLength(1);
  };
  const seed = (runs: RunManager) => {
    const conv = runs.createConversation('a', undefined, 't', 'sess-1');
    db.prepare("INSERT INTO messages (id, conversation_id, role, text, status, created_at) VALUES (?, ?, 'user', 'salut', 'done', 1)").run(`m-${conv.id}`, conv.id);
    return conv.id;
  };

  const refusing = {
    id: 'a',
    name: 'Agent',
    type: 'fake',
    async deleteSession() {
      throw Object.assign(new Error('Agent : session active'), { statusCode: 502 });
    },
  } as unknown as AgentAdapter;
  const runs = new RunManager(db, new Map([['a', refusing]]));
  const c1 = seed(runs);
  await expect(runs.deleteConversation(c1)).rejects.toThrow('session active');
  keep(runs, c1);

  const silent = { id: 'a', name: 'Agent', type: 'fake' } as unknown as AgentAdapter;
  const runs2 = new RunManager(db, new Map([['a', silent]]));
  const c2 = seed(runs2);
  await expect(runs2.deleteConversation(c2)).rejects.toThrow(/is not supported/);
  keep(runs2, c2);
});

test('deletion: "home" chat or chat without remote session → local deletion only', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const calls: string[] = [];
  const adapter = {
    id: 'a',
    name: 'A',
    type: 'fake',
    async deleteSession(sessionId: string) {
      calls.push(`delete:${sessionId}`);
    },
  } as unknown as AgentAdapter;
  const runs = new RunManager(db, new Map([['a', adapter]]));

  const home = runs.deliver('a', undefined, 'Reminder', [], 'A'); // proactive messages: "home" session
  expect(home.remote_session_id).toBe('home');
  await runs.deleteConversation(home.id);
  expect(runs.getConversation(home.id)).toBeUndefined();

  const bare = runs.createConversation('a'); // never used: no session on the agent side
  await runs.deleteConversation(bare.id);
  expect(runs.getConversation(bare.id)).toBeUndefined();
  expect(calls).toEqual([]);
});

test('deletion: a running run is stopped before the deletion', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const ctrl = new AbortController();
  const calls: string[] = [];
  const adapter = {
    id: 'a',
    name: 'A',
    type: 'fake',
    capabilities: () => ({ attachments: { images: true, files: true, maxBytes: 1024 } }),
    async send() {
      const events = (async function* () {
        await new Promise<void>((r) => ctrl.signal.addEventListener('abort', () => r(), { once: true }));
        yield { type: 'run.aborted' as const };
      })();
      return { runId: 'r1', sessionId: 'sess-1', events };
    },
    async abort() {
      calls.push('abort');
      ctrl.abort();
    },
    async deleteSession(sessionId: string) {
      calls.push(`delete:${sessionId}`);
    },
  } as unknown as AgentAdapter;
  const runs = new RunManager(db, new Map([['a', adapter]]));
  const conv = runs.createConversation('a');
  await runs.start(conv.id, 'salut');
  expect(runs.isRunning(conv.id)).toBe(true);

  await runs.deleteConversation(conv.id);
  expect(calls).toEqual(['abort', 'delete:sess-1']);
  expect(runs.getConversation(conv.id)).toBeUndefined();
  expect(runs.isRunning(conv.id)).toBe(false);
});

test('unread: a finished agent message more recent than the last read', () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const runs = new RunManager(db, new Map());
  const unread = (id: string) => !!runs.getConversation(id)!.unread;
  const pushes: string[] = [];
  runs.subscribe((p) => p.type === 'conversation.read' && pushes.push(p.conversationId));

  // A chat the user has just created is not unread
  const mine = runs.createConversation('a');
  expect(unread(mine.id)).toBe(false);
  db.prepare('UPDATE conversations SET last_read_at = 1000 WHERE id = ?').run(mine.id); // read a long time ago

  // Reply being streamed: not unread yet; finished: unread
  const add = (conv: string, role: string, status: string, at: number) =>
    db.prepare('INSERT INTO messages (id, conversation_id, role, text, status, created_at) VALUES (?,?,?,?,?,?)').run(`m${at}${role}`, conv, role, 'x', status, at);
  const t = 2000;
  add(mine.id, 'user', 'done', t);
  add(mine.id, 'assistant', 'streaming', t + 1);
  expect(unread(mine.id)).toBe(false);
  db.prepare("UPDATE messages SET status = 'done' WHERE id = ?").run(`m${t + 1}assistant`);
  expect(unread(mine.id)).toBe(true);
  expect(runs.listConversations('a').find((c) => c.id === mine.id)!.unread).toBe(1);

  // User messages do not count
  const other = runs.createConversation('a');
  db.prepare('UPDATE conversations SET last_read_at = 1000 WHERE id = ?').run(other.id);
  add(other.id, 'user', 'done', t + 5);
  expect(unread(other.id)).toBe(false);

  // Mark read: no more unread, and the other devices are notified
  runs.markRead(mine.id);
  expect(unread(mine.id)).toBe(false);
  expect(pushes).toEqual([mine.id]);
});

test('unread: proactive message in an existing chat or one created by the agent', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const runs = new RunManager(db, new Map());
  const first = runs.deliver('a', 'cron-x', 'Result 1', [], 'A', '⏰ x');
  expect(!!runs.getConversation(first.id)!.unread).toBe(true); // created by the agent: unread from the start
  runs.markRead(first.id);
  expect(!!runs.getConversation(first.id)!.unread).toBe(false);
  await new Promise((r) => setTimeout(r, 5));
  runs.deliver('a', 'cron-x', 'Result 2', [], 'A', '⏰ x');
  expect(!!runs.getConversation(first.id)!.unread).toBe(true); // new message after the read
  expect(runs.listConversations('a')).toHaveLength(1);
});

test('search: titles and messages, case- and accent-insensitive, all words required, highlighted excerpt', () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const runs = new RunManager(db, new Map());
  const a = runs.deliver('a', 's1', 'On se voit cet été à Lisbonne pour le déjeuner', [], 'A', 'Vacances');
  const b = runs.deliver('a', 's2', 'Rien à voir avec le sujet', [], 'A', 'Été au Portugal');
  runs.deliver('a', 's3', 'Un sujet sans rapport', [], 'A', 'Autre');
  // accents and case ignored; the title comes before the messages
  expect(runs.search('ETE').map((h) => h.id)).toEqual([b.id, a.id]);
  const inTitle = runs.search('ete')[0]!;
  expect(inTitle.inTitle).toBe(true);
  // all words must appear (in the title, or in a single message)
  expect(runs.search('ete lisbonne').map((h) => h.id)).toEqual([a.id]);
  expect(runs.search('lisbonne portugal')).toEqual([]);
  // excerpt around the word found, ranges to highlight in the excerpt
  const hit = runs.search('lisbonne')[0]!;
  expect(hit.inTitle).toBe(false);
  expect(hit.snippet).toContain('Lisbonne');
  expect(hit.marks!.map(([i, n]) => hit.snippet!.slice(i, i + n))).toEqual(['Lisbonne']);
  // query too short or empty
  expect(runs.search('e')).toEqual([]);
  expect(runs.search('   ')).toEqual([]);
});

test('archiving: the flag is stored, kept and returned with the chats', () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const runs = new RunManager(db, new Map());
  const c = runs.deliver('a', 's1', 'Bonjour archive', [], 'A', 'À ranger');
  expect(!!runs.getConversation(c.id)!.archived).toBe(false);
  runs.setArchived(c.id, true);
  expect(!!runs.getConversation(c.id)!.archived).toBe(true);
  expect(runs.listConversations('a').find((x) => x.id === c.id)!.archived).toBe(1);
  expect(runs.search('archive')[0]!.archived).toBe(true); // found by the search, flagged archived
  runs.setArchived(c.id, false);
  expect(!!runs.getConversation(c.id)!.archived).toBe(false);
});

test('consumption: the usage event is stored, rebroadcast and does not disturb the message', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const usage = { model: 'deepseek-flash', provider: 'deepseek', inputTokens: 1200, outputTokens: 340, costUsd: 0.0123, costEstimated: true };
  const adapter = {
    id: 'a', name: 'A', capabilities: () => ({}),
    send: async () => ({
      runId: 'r1', sessionId: 's1',
      events: (async function* () {
        yield { type: 'message.final', text: 'Bonjour' } as const;
        yield { type: 'usage', usage } as const;
        yield { type: 'run.completed' } as const;
      })(),
    }),
  } as unknown as AgentAdapter;
  const runs = new RunManager(db, new Map([['a', adapter]]));
  const pushes: any[] = [];
  runs.subscribe((p) => pushes.push(p));
  const conv = runs.createConversation('a');
  const finished = new Promise<string>((r) => (runs.onRunFinished = (_c, o) => r(o)));
  await runs.start(conv.id, 'salut');
  expect(await finished).toBe('completed');
  expect(JSON.parse(runs.getConversation(conv.id)!.usage!)).toEqual(usage);
  expect(runs.getMessages(conv.id).at(-1)).toMatchObject({ role: 'assistant', text: 'Bonjour', status: 'done' });
  expect(pushes.filter((p) => p.type === 'event').map((p) => p.event.type)).toEqual(['message.final', 'usage', 'run.completed']);
  // remote session identifier created on demand (model choice before the first message), then kept
  const fresh = runs.createConversation('a');
  const sid = runs.ensureRemoteSession(fresh.id);
  expect(sid).toBeTruthy();
  expect(runs.ensureRemoteSession(fresh.id)).toBe(sid);
});

test('agent question: the answer resumes the current run, without opening another one', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const replies: string[] = [];
  let push!: (e: AgentEvent) => void;
  let end!: () => void;
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  push = (e) => { queue.push(e); wake?.(); };
  end = () => push({ type: 'run.completed' });
  const adapter = {
    capabilities: () => ({}),
    async send() {
      async function* events() {
        for (;;) {
          while (!queue.length) await new Promise<void>((r) => (wake = r));
          const e = queue.shift()!;
          yield e;
          if (e.type === 'run.completed') return;
        }
      }
      return { runId: 'r1', sessionId: 's1', events: events() };
    },
    async reply(_runId: string, _sessionId: string, text: string) { replies.push(text); },
  } as unknown as AgentAdapter;
  const runs = new RunManager(db, new Map([['a', adapter]]));
  const finished = new Promise<string>((r) => (runs.onRunFinished = (_c, o) => r(o)));
  const conv = runs.createConversation('a');
  await runs.start(conv.id, 'redo a form');
  expect(runs.awaitingReply(conv.id)).toBe(false);
  await expect(runs.reply(conv.id, 'x')).rejects.toThrow(); // no pending question → no answer
  push({ type: 'question.requested', id: 'q1' });
  await vi.waitFor(() => expect(runs.awaitingReply(conv.id)).toBe(true));
  expect(runs.getMessages(conv.id).at(-1)!.pendingQuestion).toBe('q1'); // persisted: a page reload finds it again

  await runs.reply(conv.id, 'Another theme');
  expect(replies).toEqual(['Another theme']);
  push({ type: 'question.resolved', id: 'q1' });
  await vi.waitFor(() => expect(runs.awaitingReply(conv.id)).toBe(false));
  expect(runs.getMessages(conv.id).at(-1)!.pendingQuestion).toBeUndefined();
  push({ type: 'message.delta', text: 'Voici' });
  end();
  expect(await finished).toBe('completed');
  const msgs = runs.getMessages(conv.id);
  expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']); // a single run, the answer is recorded
  expect(msgs[1]!.text).toBe('Voici');
  expect(msgs[2]!.text).toBe('Another theme');
});
