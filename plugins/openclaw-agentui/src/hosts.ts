// Pont entre les outils du plugin (`agentui_ask`…, `agentui_image`) et le bridge d'un compte : l'outil s'exécute dans le
// processus de la gateway, le bridge détient le run et la connexion à AgentUI.
import type { Media } from './protocol.js';

export type AskResult = { answer: string } | { error: string };

export interface RunHost {
  /** `undefined` si ce bridge n'a aucun run en cours pour la discussion. */
  askBlocking(conversationId: string, key: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AskResult> | undefined;
  /** Pousse un média dans le run en cours de la discussion ; `false` si aucun run n'est en cours. */
  emitMedia(conversationId: string, media: Media): boolean;
}

/** Bridges des comptes connectés (accountId → bridge). */
export const runHosts = new Map<string, RunHost>();

export function askUser(conversationId: string, key: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AskResult> {
  for (const host of runHosts.values()) {
    const pending = host.askBlocking(conversationId, key, args, signal);
    if (pending) return pending;
  }
  return Promise.resolve({ error: "Ce composant n'existe que dans un échange AgentUI en cours ; pose ta question dans ta réponse." });
}

export function emitMedia(conversationId: string, media: Media): boolean {
  for (const host of runHosts.values()) if (host.emitMedia(conversationId, media)) return true;
  return false;
}
