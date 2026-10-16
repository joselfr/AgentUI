// Un outil par widget (`agentui_chart`, `agentui_map`, `agentui_code`) : le modèle valide ses arguments par le schéma de
// l'outil au lieu d'écrire un bloc ```widget. L'outil renvoie un jeton `[[agentui:<id>]]` que l'agent place dans son texte ;
// AgentUI le remplace par le widget (arguments de `tool.started`, jeton dans le résultat de `tool.completed`).
import { randomBytes } from 'node:crypto';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import spec from './widget-tools.json' with { type: 'json' };
import { askUser } from './asks.js';

export const WIDGET_TOOL_NAMES = [...Object.keys(spec.tools), ...Object.keys(spec.blockingTools)].map((k) => spec.prefix + k);

type Args = Record<string, any>;

/** Contrôles que le schéma JSON ne sait pas exprimer : le modèle corrige et réessaie d'après ce message. */
export function widgetError(key: string, args: Args): string | undefined {
  if (key === 'chart') {
    const x: unknown[] = args.x ?? [];
    const series: Array<{ name?: string; y?: unknown[] }> = args.series ?? [];
    for (const s of series) if ((s.y ?? []).length !== x.length) return `La série « ${s.name} » doit avoir ${x.length} valeurs (autant que x), elle en a ${(s.y ?? []).length}.`;
    if (args.kind === 'pie' && series.length !== 1) return "Un camembert (pie) n'a qu'une seule série.";
  } else if (key === 'table') {
    const n = (args.columns ?? []).length;
    for (const [i, row] of ((args.rows ?? []) as unknown[][]).entries()) {
      if (row.length !== n) return `La ligne ${i + 1} a ${row.length} valeurs, il en faut ${n} (une par colonne).`;
      if (row.some((v) => v !== null && typeof v === 'object')) return `La ligne ${i + 1} contient une valeur qui n'est ni texte, ni nombre, ni booléen, ni null.`;
    }
  } else if (key === 'progress') {
    if (args.update !== undefined && !/^\[\[agentui:[0-9a-f]+\]\]$/.test(String(args.update))) return '`update` doit être le jeton [[agentui:…]] renvoyé par le premier appel.';
  } else if (key === 'map' && !args.points?.length) return 'Il faut au moins un point.';
  else if (key === 'code' && !String(args.code ?? '').trim()) return 'Le code est vide.';
  return undefined;
}

/** Contrôles des outils interactifs (ask / confirm / form), comme `widgetError` pour les widgets d'affichage. */
export function askError(key: string, args: Args): string | undefined {
  if (key === 'ask' && !String(args.question ?? '').trim()) return 'La question est vide.';
  if (key === 'confirm' && !String(args.title ?? '').trim()) return 'Le titre est vide.';
  if (key === 'form') {
    const names = new Set<string>();
    for (const f of (args.fields ?? []) as Array<{ name?: string; kind?: string; options?: unknown[] }>) {
      if (names.has(String(f.name))) return `Le champ « ${f.name} » apparaît deux fois : les noms doivent être uniques.`;
      names.add(String(f.name));
      if (f.kind === 'select' && !f.options?.length) return `Le champ « ${f.name} » est de type select : il lui faut des options.`;
    }
  }
  return undefined;
}

/** Discussion AgentUI d'un appel d'outil : la clé de session d'un pair direct se termine par `agentui:direct:<conversationId>`. */
export function conversationOf(ctx: { sessionKey?: string; nativeChannelId?: string }): string | undefined {
  return /:agentui:direct:(.+)$/.exec(ctx.sessionKey ?? '')?.[1] ?? ctx.nativeChannelId;
}

export function registerWidgetTools(api: OpenClawPluginApi): void {
  api.registerTool((ctx) => {
    // Les outils n'existent que dans les runs lancés depuis AgentUI (ailleurs, ils encombreraient le prompt).
    if (ctx.messageChannel !== 'agentui') return null;
    const conversationId = conversationOf(ctx);
    const blocking = Object.entries(spec.blockingTools).map(([key, tool]) => ({
      name: spec.prefix + key,
      label: spec.prefix + key,
      description: tool.description,
      parameters: tool.parameters as any,
      // Bloque jusqu'à la réponse de l'utilisateur (trame `reply`), qui devient le résultat de l'outil.
      async execute(_id: string, args: Args, signal?: AbortSignal) {
        const problem = askError(key, args);
        if (problem) throw new Error(problem);
        if (!conversationId) throw new Error("Discussion AgentUI introuvable pour cet appel d'outil.");
        const res = await askUser(conversationId, key, args, signal);
        if ('error' in res) throw new Error(res.error);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ answer: res.answer }) }], details: { answer: res.answer } };
      },
    }));
    const display = Object.entries(spec.tools).map(([key, tool]) => ({
      name: spec.prefix + key,
      label: spec.prefix + key,
      description: tool.description,
      parameters: tool.parameters as any, // schéma JSON brut (pas de dépendance à typebox, absente de l'installation d'un plugin)
      async execute(_id: string, args: Args) {
        const problem = widgetError(key, args);
        if (problem) throw new Error(problem);
        if (key === 'progress' && args.update) {
          // Mise à jour : même jeton, le front affiche l'état du dernier appel.
          return { content: [{ type: 'text' as const, text: JSON.stringify({ widget: args.update, updated: true, instruction: spec.updateInstruction }) }], details: { token: args.update } };
        }
        const token = `[[agentui:${randomBytes(3).toString('hex')}]]`;
        return { content: [{ type: 'text' as const, text: JSON.stringify({ widget: token, instruction: spec.tokenInstruction }) }], details: { token } };
      },
    }));
    return [...display, ...blocking];
  }, { names: WIDGET_TOOL_NAMES });
}
