import { generateText, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAI } from '@ai-sdk/openai';

/**
 * Titles of the conversations, written by a small LLM after the first exchange (the provisional title is the first message).
 * The provider layer is the Vercel AI SDK: any provider it supports can be added here with one line.
 */
export type TitleProvider = 'deepseek' | 'openai' | 'anthropic';

export interface TitleConfig {
  provider: TitleProvider;
  model: string;
  apiKey: string;
  /** Another endpoint for the provider (an OpenAI-compatible server, a proxy). */
  baseUrl?: string;
  /** Language of the titles (`French`, `English`…). Default: the language of the user's message. */
  language?: string;
}

const PROVIDERS: Record<TitleProvider, { keyVar: string; model: string }> = {
  deepseek: { keyVar: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' },
  openai: { keyVar: 'OPENAI_API_KEY', model: 'gpt-5-mini' },
  anthropic: { keyVar: 'ANTHROPIC_API_KEY', model: 'claude-haiku-5-5' },
};

/**
 * `TITLE_PROVIDER` (deepseek | openai | anthropic; unset or `off` = no generated titles), `TITLE_MODEL`, `TITLE_API_KEY` (default: the provider's usual
 * variable, e.g. `DEEPSEEK_API_KEY`), `TITLE_BASE_URL`, `TITLE_LANGUAGE`. Returns what is wrong in `error` instead of throwing: a bad setting must not stop AgentUI.
 */
export function titleConfigFromEnv(e: Record<string, string | undefined> = process.env): { config?: TitleConfig; error?: string } {
  const provider = (e.TITLE_PROVIDER ?? '').trim().toLowerCase();
  if (!provider || provider === 'off') return {};
  if (!(provider in PROVIDERS)) return { error: `TITLE_PROVIDER "${provider}" is unknown (${Object.keys(PROVIDERS).join(', ')} or off).` };
  const p = provider as TitleProvider;
  const apiKey = (e.TITLE_API_KEY || e[PROVIDERS[p].keyVar] || '').trim();
  if (!apiKey) return { error: `Generated titles are off: no API key (TITLE_API_KEY or ${PROVIDERS[p].keyVar}).` };
  return {
    config: { provider: p, model: (e.TITLE_MODEL || PROVIDERS[p].model).trim(), apiKey, baseUrl: e.TITLE_BASE_URL?.trim() || undefined, language: e.TITLE_LANGUAGE?.trim() || undefined },
  };
}

export function titleModel(c: TitleConfig): LanguageModel {
  const o = { apiKey: c.apiKey, ...(c.baseUrl ? { baseURL: c.baseUrl } : {}) };
  switch (c.provider) {
    case 'deepseek': return createDeepSeek(o)(c.model);
    case 'openai': return createOpenAI(o).chat(c.model);
    case 'anthropic': return createAnthropic(o)(c.model);
  }
}

const TRIVIAL = /^(?:pong|ping|yes|no|yep|nope|hi|hello|hey|thanks|thank you|merci|salut|bonjour|ok|okay|done|cool)$/i;

/** One clean title from the model's answer: no label, quotes, markdown or final period; `undefined` if it is not a usable title. */
export function cleanTitle(raw: string): string | undefined {
  const line = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  let s = line.replace(/^(?:[*_`~#>\s-]+)?(?:session\s+)?(?:title|titre)\s*:\s*/i, '').replace(/^[\s"'«»“”`*_~]+|[\s"'«»“”`*_~.!…]+$/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > 80) s = s.slice(0, 80).replace(/\s+\S*$/, '');
  if (!s || TRIVIAL.test(s)) return undefined;
  return s;
}

const SYSTEM = (language?: string) =>
  [
    'You name chat conversations. Write a short title for the conversation start below, from BOTH the user\'s message and the assistant\'s answer.',
    'Rules: 3 to 6 words, a topic label (a noun phrase), not a sentence; no quotes, markdown, emoji, final period or prefix such as "Title:".',
    'Name the topic, not the outcome: never "OK", "Done" or a description of what the assistant did.',
    language ? `Write the title in ${language}.` : 'Write the title in the language of the user\'s message.',
    'Answer with the title only.',
  ].join('\n');

type Run = typeof generateText;

/** Title for a first exchange, or `undefined` when the model gave nothing usable. Throws on a provider error. */
export async function generateTitle(
  model: LanguageModel,
  o: { user: string; assistant: string; language?: string },
  run: Run = generateText,
  timeoutMs = 15_000,
): Promise<string | undefined> {
  const { text } = await run({
    model,
    system: SYSTEM(o.language),
    prompt: `User message:\n${o.user.slice(0, 500)}\n\nAssistant answer:\n${o.assistant.slice(0, 500)}`,
    maxOutputTokens: 60,
    temperature: 0.2,
    abortSignal: AbortSignal.timeout(timeoutMs),
    maxRetries: 1,
    // DeepSeek thinks by default: the whole token budget would go to its reasoning and the title would come back empty. Other providers ignore this key.
    providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
  });
  return cleanTitle(text);
}

/** The function `RunManager` calls, from the settings; `undefined` when generated titles are off. */
export function createTitler(c: TitleConfig, run: Run = generateText): (user: string, assistant: string) => Promise<string | undefined> {
  const model = titleModel(c);
  return (user, assistant) => generateTitle(model, { user, assistant, language: c.language }, run);
}
