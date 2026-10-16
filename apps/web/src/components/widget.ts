/** Bloc ```widget : JSON `{ "type": "ask" | "confirm" | "chart", "arguments": { … } }`. `undefined` si invalide. */
export function parseWidget(raw: string): { type: string; arguments: Record<string, unknown> } | undefined {
  try {
    const j = JSON.parse(raw) as { type?: unknown; arguments?: unknown };
    if (typeof j?.type !== 'string' || !j.arguments || typeof j.arguments !== 'object' || Array.isArray(j.arguments)) return undefined;
    return { type: j.type, arguments: j.arguments as Record<string, unknown> };
  } catch { return undefined; }
}

const INTERACTIVE = new Set(['ask', 'confirm', 'form']);

/** Blocs interactifs d'un texte (widgets `ask`/`confirm`/`form` et ancien bloc ```ask), dans l'ordre : chacun attend une réponse. */
export function interactiveBlocks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/```(widget|ask)[^\S\n]*\n([\s\S]*?)\n?```/g)) {
    const raw = m[2]!;
    if (m[1] === 'ask' || INTERACTIVE.has(parseWidget(raw)?.type ?? '')) out.push(raw);
  }
  return out;
}
