import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { agentUIPlugin } from './src/channel.js';
import { setAgentUIRuntime } from './src/runtime.js';
import { setCronAccess } from './src/cron.js';

export default defineChannelPluginEntry({
  id: 'agentui',
  name: 'AgentUI',
  description: "Canal AgentUI : OpenClaw se connecte à AgentUI selon l'AgentUI Channel Protocol v1.",
  plugin: agentUIPlugin,
  setRuntime: setAgentUIRuntime,
  registerFull(api) {
    // Accès au planificateur pour la page « Tâches » d'AgentUI (réservé aux services hébergés par la gateway).
    api.registerService({
      id: 'agentui-cron',
      start: (ctx) => setCronAccess(ctx.getCron),
      stop: () => setCronAccess(undefined),
    });
  },
});
