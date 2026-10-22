import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from './agents/types.js';
import { openDb } from './db.js';
import { RunManager } from './runs.js';
import { cleanTitle, createTitler, generateTitle, titleConfigFromEnv } from './titles.js';

describe('titleConfigFromEnv', () => {
  it('is off unless a provider is chosen', () => {
    expect(titleConfigFromEnv({})).toEqual({});
    expect(titleConfigFromEnv({ TITLE_PROVIDER: 'off', DEEPSEEK_API_KEY: 'k' })).toEqual({});
  });
  it('reads the provider, its usual key variable and the options', () => {
    const r = titleConfigFromEnv({ TITLE_PROVIDER: 'DeepSeek', DEEPSEEK_API_KEY: 'k', TITLE_MODEL: 'deepseek-flash', TITLE_LANGUAGE: 'French' });
    expect(r.config).toEqual({ provider: 'deepseek', model: 'deepseek-flash', apiKey: 'k', baseUrl: undefined, language: 'French' });
    expect(titleConfigFromEnv({ TITLE_PROVIDER: 'openai', TITLE_API_KEY: 'x', OPENAI_API_KEY: 'y', TITLE_BASE_URL: 'http://llm:8000/v1' }).config).toMatchObject({ apiKey: 'x', baseUrl: 'http://llm:8000/v1' });
  });
  it('reports a bad setting instead of throwing', () => {
    expect(titleConfigFromEnv({ TITLE_PROVIDER: 'nope' }).error).toMatch(/unknown/);
    expect(titleConfigFromEnv({ TITLE_PROVIDER: 'anthropic' }).error).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe('cleanTitle', () => {
  it('keeps a plain label and strips the usual decorations', () => {
    expect(cleanTitle('Partie d\'échecs en direct')).toBe('Partie d\'échecs en direct');
    expect(cleanTitle('Title: "Chess game".')).toBe('Chess game');
    expect(cleanTitle('**Titre : Plan de la semaine**\nAutre ligne')).toBe('Plan de la semaine');
    expect(cleanTitle('<think>hmm</think>\nRecette de crêpes')).toBe('Recette de crêpes');
  });
  it('refuses what is not a title', () => {
    for (const bad of ['', '  ', 'OK', 'done.', 'pong']) expect(cleanTitle(bad)).toBeUndefined();
  });
  it('cuts a long answer at a word', () => {
    const t = cleanTitle('mot '.repeat(40))!;
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t.endsWith('mot')).toBe(true);
  });
});

describe('generateTitle', () => {
  it('sends both sides of the exchange, the language rule and a timeout, and cleans the answer', async () => {
    const run = vi.fn(async () => ({ text: 'Title: Chess game' })) as unknown as typeof generateText;
    const title = await generateTitle('model' as never, { user: 'Allez partie d\'echecs', assistant: 'Voici le plateau', language: 'French' }, run);
    expect(title).toBe('Chess game');
    const arg = (run as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg.prompt).toContain('Allez partie d\'echecs');
    expect(arg.prompt).toContain('Voici le plateau');
    expect(arg.system).toContain('Write the title in French');
    expect(arg.abortSignal).toBeInstanceOf(AbortSignal);
  });
  it('lets a provider error through', async () => {
    const run = (async () => { throw new Error('401'); }) as unknown as typeof generateText;
    await expect(generateTitle('m' as never, { user: 'a', assistant: 'b' }, run)).rejects.toThrow('401');
  });
  it('createTitler builds the model of the provider', async () => {
    const run = vi.fn(async () => ({ text: 'Plan du voyage' })) as unknown as typeof generateText;
    const titler = createTitler({ provider: 'deepseek', model: 'deepseek-flash', apiKey: 'k' }, run);
    expect(await titler('a', 'b')).toBe('Plan du voyage');
    const model = (run as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0].model;
    expect(model.modelId).toBe('deepseek-flash');
  });
});

describe('automatic title of a conversation', () => {
  const setup = (answer: string, titler: (u: string, a: string) => Promise<string | undefined>) => {
    const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
    let n = 0;
    const adapter = {
      capabilities: () => ({}),
      send: async () => ({ runId: `r${++n}`, sessionId: 's', events: (async function* () { yield { type: 'message.final' as const, text: answer }; yield { type: 'run.completed' as const }; })() }),
    } as unknown as AgentAdapter;
    const runs = new RunManager(db, new Map([['a', adapter]]));
    runs.titler = titler;
    const done = () => new Promise<void>((r) => (runs.onRunFinished = () => r()));
    return { runs, done };
  };

  it('replaces the first message with the generated title, once the answer is in', async () => {
    const titler = vi.fn(async () => 'Partie d\'échecs');
    const { runs, done } = setup('Voici le plateau [[agentui:a1b2c3]]', titler);
    const conv = runs.createConversation('a');
    const finished = done();
    await runs.start(conv.id, 'Allez partie d\'echecs');
    await finished;
    await vi.waitFor(() => expect(runs.getConversation(conv.id)!.title).toBe('Partie d\'échecs'));
    expect(titler).toHaveBeenCalledWith('Allez partie d\'echecs', 'Voici le plateau');
  });

  it('never touches a title set by the user or the agent', async () => {
    const titler = vi.fn(async () => 'Autre titre');
    const { runs, done } = setup('Réponse', titler);
    const conv = runs.createConversation('a');
    const finished = done();
    await runs.start(conv.id, 'Bonjour');
    runs.renameConversation(conv.id, 'Mon titre'); // before the model answers
    await finished;
    await new Promise((r) => setTimeout(r, 30));
    expect(runs.getConversation(conv.id)!.title).toBe('Mon titre');
  });

  it('keeps the first message when the model fails, and does not break the run', async () => {
    const errors: unknown[] = [];
    const { runs, done } = setup('Réponse', async () => { throw new Error('boom'); });
    runs.onTitleError = (e) => errors.push(e);
    const conv = runs.createConversation('a');
    const finished = done();
    await runs.start(conv.id, 'Bonjour');
    await finished;
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(runs.getConversation(conv.id)!.title).toBe('Bonjour');
  });
});
