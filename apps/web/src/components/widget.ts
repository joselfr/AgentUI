/** Bloc ```widget : JSON `{ "type": "ask" | "confirm" | "chart", "arguments": { … } }`. `undefined` si invalide. */
export function parseWidget(raw: string): { type: string; arguments: Record<string, unknown> } | undefined {
  try {
    const j = JSON.parse(raw) as { type?: unknown; arguments?: unknown };
    if (typeof j?.type !== 'string' || !j.arguments || typeof j.arguments !== 'object' || Array.isArray(j.arguments)) return undefined;
    return { type: j.type, arguments: j.arguments as Record<string, unknown> };
  } catch { return undefined; }
}
