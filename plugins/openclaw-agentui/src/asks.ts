// Pont entre les outils interactifs (`agentui_ask`, `agentui_confirm`, `agentui_form`) et le bridge d'un compte :
// l'outil s'exécute dans le processus de la gateway, le bridge détient le run et la connexion à AgentUI.
export type AskResult = { answer: string } | { error: string };

export interface AskHost {
  /** `undefined` si ce bridge n'a aucun run en cours pour la discussion. */
  askBlocking(conversationId: string, key: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AskResult> | undefined;
}

/** Bridges des comptes connectés (accountId → bridge). */
export const askHosts = new Map<string, AskHost>();

export function askUser(conversationId: string, key: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AskResult> {
  for (const host of askHosts.values()) {
    const pending = host.askBlocking(conversationId, key, args, signal);
    if (pending) return pending;
  }
  return Promise.resolve({ error: "Ce composant n'existe que dans un échange AgentUI en cours ; pose ta question dans ta réponse." });
}
