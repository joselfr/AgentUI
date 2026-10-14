// Test réel : coupe le WebSocket pendant un run et vérifie la reprise. Usage : npx tsx scripts/test-openclaw-drop.ts
import { loadConfig, env } from '../apps/server/src/config.js';
import { OpenClawAdapter } from '../apps/server/src/agents/openclaw.js';

const cfg = loadConfig(new URL('../agents.config.yaml', import.meta.url).pathname).agents.find((a) => a.type === 'openclaw')!;
const ad = new OpenClawAdapter(cfg as never, env.dataDir);
await ad.connect();
const t0 = Date.now();
const run = await ad.send(undefined, { text: 'Écris un texte de 250 mots sur la mer, puis termine par le mot FIN seul sur la dernière ligne.' });
console.log('run', run.runId);
let dropped = false, deltas = 0, last = '';
for await (const ev of run.events) {
  if (ev.type === 'message.delta') deltas++;
  if (!dropped && deltas >= 3) { dropped = true; console.log(`+${Date.now() - t0}ms COUPURE du WebSocket`); (ad as any).ws.close(); }
  if (ev.type === 'message.final') last = ev.text;
  if (ev.type !== 'message.delta') console.log(`+${Date.now() - t0}ms`, ev.type, ev.type === 'message.final' ? `(${ev.text.length} car., fin: ${JSON.stringify(ev.text.slice(-12))})` : '');
}
console.log('deltas avant coupure:', deltas, '| coupure faite:', dropped);
await ad.close();
process.exit(dropped && last.trim().endsWith('FIN') ? 0 : 1);
