// Bridge between the plugin's tools (`agentui_ask`…, `agentui_image`) and an account's bridge: the tool runs in the
// gateway process, the bridge holds the run and the connection to AgentUI.
import type { Media } from './protocol.js';

export type AskResult = { answer: string } | { error: string };

export interface RunHost {
  /** `undefined` if this bridge has no running run for the chat. */
  askBlocking(conversationId: string, key: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AskResult> | undefined;
  /** Pushes a media into the chat's running run; `false` if no run is in progress. */
  emitMedia(conversationId: string, media: Media): boolean;
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
