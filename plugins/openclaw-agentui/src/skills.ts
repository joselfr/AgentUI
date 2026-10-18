// Skills OpenClaw exposées à AgentUI (page « Skills ») : celles que l'agent peut utiliser (éligibles, non désactivées).
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { listSkillCommandsForAgents } from 'openclaw/plugin-sdk/skill-commands-runtime';

export function listSkills(cfg: OpenClawConfig, subAgentId?: string) {
  return listSkillCommandsForAgents({ cfg, ...(subAgentId ? { agentIds: [subAgentId] } : {}) }).map((s) => ({
    id: s.skillName,
    name: s.displayName ?? s.skillName,
    description: s.description || undefined,
    category: s.skillSource === 'bundled' ? 'Fournies' : s.skillSource === 'workspace' ? 'Espace de travail' : undefined,
    enabled: true,
  }));
}
