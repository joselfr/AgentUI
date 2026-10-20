import { useCallback, useEffect, useState } from 'react';
import type { AgentInfo, SubAgent } from '@agentui/shared';
import { api } from './api';

/**
 * Sub-agents (profiles) of each agent, loaded once. `subLabel(agentId, subAgentId)` is the name of the sub-agent a chat talks to
 * (a Hermes gateway serves a single profile, which is worth showing too). A chat created without a sub-agent uses the default one.
 */
export function useSubAgents(agents: AgentInfo[]) {
  const [subs, setSubs] = useState<Record<string, SubAgent[]>>({});
  const key = agents.map((a) => a.id).join(','); // not gated on `capabilities.subagents` (that one is about tracked runs): the list is asked of every agent
  useEffect(() => {
    let live = true;
    for (const id of key ? key.split(',') : []) {
      api.subAgents(id).then((s) => { if (live) setSubs((p) => ({ ...p, [id]: s })); }).catch(() => {});
    }
    return () => { live = false; };
  }, [key]);
  return useCallback((agentId: string, subAgentId?: string): string | undefined => {
    const list = subs[agentId];
    const sub = list && (list.find((s) => s.id === subAgentId) ?? (subAgentId ? undefined : list.find((s) => s.isDefault)));
    const agent = agents.find((a) => a.id === agentId);
    return sub && sub.name.trim().toLowerCase() !== agent?.name.trim().toLowerCase() ? sub.name : undefined; // same name as the agent: nothing to add
  }, [subs, agents]);
}
