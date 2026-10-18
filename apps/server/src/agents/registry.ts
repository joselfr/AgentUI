import type { AgentConfig } from '@agentui/shared';
import type { AgentAdapter } from './types.js';
import { GatewayAdapter } from './gateway.js';

/** To add an agent: write an adapter and register it here (key = `type` of the config file). */
export interface AdapterContext {
  dataDir: string;
}

const factories: Record<string, (cfg: any, ctx: AdapterContext) => AgentAdapter> = {
  gateway: (cfg) => new GatewayAdapter(cfg),
};

export function createAdapter(cfg: AgentConfig, ctx: AdapterContext): AgentAdapter {
  const f = factories[cfg.type];
  if (!f) throw new Error(`Agent type not implemented: ${cfg.type}`);
  return f(cfg, ctx);
}
