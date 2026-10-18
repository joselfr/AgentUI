// OpenClaw skills exposed to AgentUI ("Skills" page): those the agent can use (eligible, not disabled).
import { readFile } from 'node:fs/promises';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { listSkillCommandsForAgents } from 'openclaw/plugin-sdk/skill-commands-runtime';

const commandsOf = (cfg: OpenClawConfig, subAgentId?: string) => listSkillCommandsForAgents({ cfg, ...(subAgentId ? { agentIds: [subAgentId] } : {}) });

export function listSkills(cfg: OpenClawConfig, subAgentId?: string) {
  return commandsOf(cfg, subAgentId).map((s) => ({
    id: s.skillName,
    name: s.displayName ?? s.skillName,
    description: s.description || undefined,
    category: s.skillSource === 'bundled' ? 'Bundled' : s.skillSource === 'workspace' ? 'Workspace' : undefined,
    enabled: true,
  }));
}

/** Content of SKILL.md: only skills from the list are readable (the path comes from OpenClaw, never from the client). */
export async function readSkill(cfg: OpenClawConfig, skillId: string, subAgentId?: string): Promise<{ content: string }> {
  const file = commandsOf(cfg, subAgentId).find((s) => s.skillName === skillId)?.skillFile;
  if (!file) throw new Error(`skill not found: ${skillId}`);
  return { content: await readFile(file, 'utf8') };
}
