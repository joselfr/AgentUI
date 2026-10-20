// Bridge between the plugin's tools (`agentui_ask`…, `agentui_widget_image`) and an account's bridge: the tool runs in the
// gateway process, the bridge holds the run and the connection to AgentUI.
import type { Media } from './protocol.js';

export type AskResult = { answer: string } | { error: string };

export interface RunHost {
  /** `undefined` if this bridge has no running run for the chat. */
  askBlocking(conversationId: string, key: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AskResult> | undefined;
  /** Pushes a media into the chat's running run; `false` if no run is in progress. */
  emitMedia(conversationId: string, media: Media): boolean;
  /** Renames the chat through the running run; `false` if no run is in progress. */
  setTitle(conversationId: string, title: string): boolean;
  /** Current title of the chat; `undefined` if this bridge is not connected. */
  getTitle(conversationId: string): Promise<{ title: string }> | undefined;
  /** Miniapp operation on the AgentUI server; `undefined` if this bridge is not connected. */
  miniappOp(op: string, args: unknown): Promise<unknown> | undefined;
  /** Push notification to the user's devices; `undefined` if this bridge is not connected. */
  notify(title: string, body?: string, url?: string): Promise<unknown> | undefined;
}

/** Bridges of the connected accounts (accountId → bridge). */
export const runHosts = new Map<string, RunHost>();

export function askUser(conversationId: string, key: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AskResult> {
  for (const host of runHosts.values()) {
    const pending = host.askBlocking(conversationId, key, args, signal);
    if (pending) return pending;
  }
  return Promise.resolve({ error: "This component only exists within an ongoing AgentUI exchange; ask your question in your reply." });
}

export function emitMedia(conversationId: string, media: Media): boolean {
  for (const host of runHosts.values()) if (host.emitMedia(conversationId, media)) return true;
  return false;
}

export function setThreadTitle(conversationId: string, title: string): boolean {
  for (const host of runHosts.values()) if (host.setTitle(conversationId, title)) return true;
  return false;
}

export function getThreadTitle(conversationId: string): Promise<{ title: string }> {
  for (const host of runHosts.values()) {
    const pending = host.getTitle(conversationId);
    if (pending) return pending;
  }
  return Promise.reject(new Error('AgentUI is not connected.'));
}

/** Runs a miniapp operation (`create`, `write`…) on the AgentUI server through the first connected account. */
export function miniappOp(op: string, args: unknown): Promise<unknown> {
  for (const host of runHosts.values()) {
    const pending = host.miniappOp(op, args);
    if (pending) return pending;
  }
  return Promise.reject(new Error('AgentUI is not connected.'));
}

/** Sends a push notification through the first connected account. */
export function notifyUser(title: string, body?: string, url?: string): Promise<unknown> {
  for (const host of runHosts.values()) {
    const pending = host.notify(title, body, url);
    if (pending) return pending;
  }
  return Promise.reject(new Error('AgentUI is not connected.'));
}
