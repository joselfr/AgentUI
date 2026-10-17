import type { AgentConfig } from '@agentui/shared';
import type { AgentAdapter } from './types.js';
import { GatewayAdapter } from './gateway.js';

/** Pour ajouter un agent : écrire un adapter et l'enregistrer ici (clé = `type` du fichier de conf). */
export interface AdapterContext {
  dataDir: string;
}

const factories: Record<string, (cfg: any, ctx: AdapterContext) => AgentAdapter> = {
  gateway: (cfg) => new GatewayAdapter(cfg),
};

export function createAdapter(cfg: AgentConfig, ctx: AdapterContext): AgentAdapter {
  const f = factories[cfg.type];
  if (!f) throw new Error(`Type d'agent non implémenté : ${cfg.type}`);
  return f(cfg, ctx);
}
