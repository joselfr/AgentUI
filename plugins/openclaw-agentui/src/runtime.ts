import type { PluginRuntime } from 'openclaw/plugin-sdk/channel-core';
import type { AgentUIClient } from './client.js';

// Runtime injected by OpenClaw at load (setRuntime) and client per started account (gateway.startAccount).
let runtime: PluginRuntime | undefined;
const clients = new Map<string, AgentUIClient>();

export function setAgentUIRuntime(rt: PluginRuntime): void {
  runtime = rt;
}

export function getAgentUIRuntime(): PluginRuntime {
  if (!runtime) throw new Error('AgentUI: OpenClaw runtime unavailable');
  return runtime;
}

export const agentUIClients = clients;
