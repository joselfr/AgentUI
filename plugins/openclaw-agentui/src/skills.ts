// Skills OpenClaw exposées à AgentUI (page « Skills ») : celles que l'agent peut utiliser (éligibles, non désactivées).
import { readFile } from 'node:fs/promises';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { listSkillCommandsForAgents } from 'openclaw/plugin-sdk/skill-commands-runtime';

const commandsOf = (cfg: OpenClawConfig, subAgentId?: string) => listSkillCommandsForAgents({ cfg, ...(subAgentId ? { agentIds: [subAgentId] } : {}) });

export function listSkills(cfg: OpenClawConfig, subAgentId?: string) {
  return commandsOf(cfg, subAgentId).map((s) => ({
    id: s.skillName,
    name: s.displayName ?? s.skillName,
    description: s.description || undefined,
    category: s.skillSource === 'bundled' ? 'Fournies' : s.skillSource === 'workspace' ? 'Espace de travail' : undefined,
    enabled: true,
  }));
}

/** Contenu de SKILL.md : seules les skills de la liste sont lisibles (le chemin vient d'OpenClaw, jamais du client). */
export async function readSkill(cfg: OpenClawConfig, skillId: string, subAgentId?: string): Promise<{ content: string }> {
  const file = commandsOf(cfg, subAgentId).find((s) => s.skillName === skillId)?.skillFile;
  if (!file) throw new Error(`skill introuvable : ${skillId}`);
  return { content: await readFile(file, 'utf8') };
}
