import type { PluginRuntime } from 'openclaw/plugin-sdk/channel-core';
import type { AgentUIClient } from './client.js';

// Runtime injecté par OpenClaw au chargement (setRuntime) et client par compte démarré (gateway.startAccount).
let runtime: PluginRuntime | undefined;
const clients = new Map<string, AgentUIClient>();

export function setAgentUIRuntime(rt: PluginRuntime): void {
  runtime = rt;
}

export function getAgentUIRuntime(): PluginRuntime {
  if (!runtime) throw new Error('AgentUI : runtime OpenClaw indisponible');
  return runtime;
}

export const agentUIClients = clients;
