// Copie plugins/protocol/widget-tools.json (source unique des schémas d'outils-widgets) dans chaque plugin :
// l'installation d'un plugin n'emporte que son propre dossier.
import { copyFileSync } from 'node:fs';
const here = new URL('.', import.meta.url);
for (const dest of ['hermes-agentui/widget_tools.json', 'openclaw-agentui/src/widget-tools.json'])
  copyFileSync(new URL('protocol/widget-tools.json', here), new URL(dest, here));
