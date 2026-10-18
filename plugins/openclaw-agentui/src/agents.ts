// OpenClaw agents exposed as sub-agents in AgentUI (same shape as the operator WebSocket adapter).
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { listAgentIds, resolveAgentConfig, resolveDefaultAgentId } from 'openclaw/plugin-sdk/agent-scope-runtime';

export interface SubAgentInfo {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
}

const modelOf = (model: unknown): string | undefined =>
  typeof model === 'string' ? model : typeof (model as { primary?: unknown })?.primary === 'string' ? (model as { primary: string }).primary : undefined;

export function listSubAgents(cfg: OpenClawConfig): SubAgentInfo[] {
  try {
    const def = resolveDefaultAgentId(cfg);
    const ids = listAgentIds(cfg);
    const defaults = (cfg as { agents?: { defaults?: { model?: unknown } } }).agents?.defaults;
    return [...new Set([def, ...ids])].map((id) => {
      const a = resolveAgentConfig(cfg, id);
      const model = modelOf(a?.model) ?? modelOf(defaults?.model);
      return {
        id,
        name: a?.name ?? (id === def ? 'OpenClaw' : id),
        ...(model ? { description: model } : {}),
        ...(id === def ? { isDefault: true } : {}),
      };
    });
  } catch {
    return [{ id: 'main', name: 'OpenClaw', isDefault: true }];
  }
}
