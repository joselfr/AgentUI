import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { agentUIPlugin } from './src/channel.js';

export default defineSetupPluginEntry(agentUIPlugin);
