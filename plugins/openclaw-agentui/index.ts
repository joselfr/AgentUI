import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { agentUIPlugin } from './src/channel.js';
import { setAgentUIRuntime } from './src/runtime.js';
import { setCronAccess } from './src/cron.js';
import { registerUsageGuide, registerWidgetTools } from './src/widget-tools.js';

export default defineChannelPluginEntry({
  id: 'agentui',
  name: 'AgentUI',
  description: "AgentUI channel: OpenClaw connects to AgentUI using the AgentUI Channel Protocol v1.",
  plugin: agentUIPlugin,
  setRuntime: setAgentUIRuntime,
  registerFull(api) {
    registerWidgetTools(api);
    registerUsageGuide(api);
    // Access to the scheduler for AgentUI's "Tasks" page (reserved for services hosted by the gateway).
    api.registerService({
      id: 'agentui-cron',
      start: (ctx) => setCronAccess(ctx.getCron),
      stop: () => setCronAccess(undefined),
    });
  },
});
