// Copies plugins/protocol/widget-tools.json (single source of the widget-tool schemas) into each plugin:
// installing a plugin only carries its own folder.
import { copyFileSync } from 'node:fs';
const here = new URL('.', import.meta.url);
for (const dest of ['hermes-agentui/widget_tools.json', 'openclaw-agentui/src/widget-tools.json'])
  copyFileSync(new URL('protocol/widget-tools.json', here), new URL(dest, here));
