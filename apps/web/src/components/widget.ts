/** Bloc ```widget : JSON `{ "type": "ask" | "confirm" | "chart" | …, "arguments": { … } }`. `undefined` si invalide. */
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

/** Les plugins exposent chaque widget d'affichage comme un outil `agentui_<type>` (ex. `agentui_chart`) : ses arguments sont ceux du widget. */
const WIDGET_TOOL_PREFIX = 'agentui_';
export type ToolCallLike = { id?: string; name: string; args?: unknown; resultPreview?: string };
const DISPLAY_WIDGETS = new Set(['chart', 'map', 'code', 'table', 'progress']);

export function widgetOfTool(t: { name: string; args?: unknown }): { type: string; arguments: Record<string, unknown> } | undefined {
  if (!t.name.startsWith(WIDGET_TOOL_PREFIX)) return undefined;
  const type = t.name.slice(WIDGET_TOOL_PREFIX.length);
  const args = t.args;
  if (!DISPLAY_WIDGETS.has(type) || !args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  return { type, arguments: args as Record<string, unknown> };
}

const TOKEN = /\[\[agentui:([0-9a-f]+)\]\]/g;
const HEAD = '[[agentui:';
/** Retire un jeton en cours de frappe en fin de texte (« [[agent », « [[agentui:a3f », « [[agentui:a3f9c1] »). */
function stripPartialToken(text: string): string {
  for (let i = Math.min(text.length, HEAD.length + 7); i > 0; i--) {
    const tail = text.slice(-i);
    if (HEAD.startsWith(tail) || (tail.startsWith(HEAD) && /^\[\[agentui:[0-9a-f]*\]?$/.test(tail))) return text.slice(0, -i);
  }
  return text;
}
const fence = (w: { type: string; arguments: Record<string, unknown> }) => '\n\n```widget\n' + JSON.stringify(w) + '\n```\n\n';

/** Widget mis à jour par des appels ultérieurs (`update` = jeton du widget) : l'état d'un jeton est celui du dernier appel. */
const isUpdate = (t: { args?: unknown }) => typeof (t.args as { update?: unknown } | undefined)?.update === 'string';
const sameCall = (a: ToolCallLike, b: ToolCallLike) => (a.id !== undefined && b.id !== undefined ? a.id === b.id : a === b);

/** Jeton (`[[agentui:<id>]]`) renvoyé par l'outil, lu dans son résultat. */
const tokenOf = (t: { resultPreview?: string }) => t.resultPreview?.match(/\[\[agentui:([0-9a-f]+)\]\]/)?.[1];

/**
 * Remplace par leur widget les jetons que l'agent a placés dans son texte après un appel d'outil `agentui_<type>`.
 * Les arguments du widget sont ceux de l'appel (`own` : outils du message ; `all` : toute la discussion, car l'agent peut
 * réutiliser un jeton d'un message précédent). Un jeton inconnu ou en cours de frappe disparaît ; un widget dont le jeton
 * n'a jamais été écrit est ajouté en fin de message une fois celui-ci terminé, pour qu'il ne soit pas perdu.
 */
export function expandWidgetTokens(text: string, own: ToolCallLike[], all: ToolCallLike[] = own, done = true): string {
  const widgets = new Map<string, { type: string; arguments: Record<string, unknown> }>();
  const firstCall = new Map<string, ToolCallLike>();
  for (const t of all) {
    const id = tokenOf(t);
    const w = id ? widgetOfTool(t) : undefined;
    if (id && w) {
      widgets.set(id, w); // le dernier appel fait foi : une mise à jour remplace l'état affiché
      if (!firstCall.has(id)) firstCall.set(id, t);
    }
  }
  const used = new Set<string>();
  let out = text.replace(TOKEN, (_m, id: string) => {
    const w = widgets.get(id);
    if (!w) return '';
    // Un widget mis à jour vit dans le message qui l'a créé : le jeton réécrit ailleurs ne le duplique pas.
    if (w.type === 'progress' && !own.some((t) => sameCall(t, firstCall.get(id)!))) return '';
    used.add(id);
    return fence(w);
  });
  out = stripPartialToken(out);
  if (done) for (const t of own) {
    const id = tokenOf(t);
    const w = id ? widgets.get(id) : undefined;
    if (id && w && !used.has(id) && !isUpdate(t)) out += fence(w);
  }
  return out;
}
