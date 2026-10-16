// Un outil par widget (`agentui_chart`, `agentui_map`, `agentui_code`) : le modèle valide ses arguments par le schéma de
// l'outil au lieu d'écrire un bloc ```widget. L'outil renvoie un jeton `[[agentui:<id>]]` que l'agent place dans son texte ;
// AgentUI le remplace par le widget (arguments de `tool.started`, jeton dans le résultat de `tool.completed`).
import { randomBytes } from 'node:crypto';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import spec from './widget-tools.json' with { type: 'json' };

export const WIDGET_TOOL_NAMES = Object.keys(spec.tools).map((k) => spec.prefix + k);

type Args = Record<string, any>;

/** Contrôles que le schéma JSON ne sait pas exprimer : le modèle corrige et réessaie d'après ce message. */
export function widgetError(key: string, args: Args): string | undefined {
  if (key === 'chart') {
    const x: unknown[] = args.x ?? [];
    const series: Array<{ name?: string; y?: unknown[] }> = args.series ?? [];
    for (const s of series) if ((s.y ?? []).length !== x.length) return `La série « ${s.name} » doit avoir ${x.length} valeurs (autant que x), elle en a ${(s.y ?? []).length}.`;
    if (args.kind === 'pie' && series.length !== 1) return "Un camembert (pie) n'a qu'une seule série.";
  } else if (key === 'map' && !args.points?.length) return 'Il faut au moins un point.';
  else if (key === 'code' && !String(args.code ?? '').trim()) return 'Le code est vide.';
  return undefined;
}

export function registerWidgetTools(api: OpenClawPluginApi): void {
  api.registerTool((ctx) => {
    // Les outils n'existent que dans les runs lancés depuis AgentUI (ailleurs, ils encombreraient le prompt).
    if (ctx.messageChannel !== 'agentui') return null;
    return Object.entries(spec.tools).map(([key, tool]) => ({
      name: spec.prefix + key,
      label: spec.prefix + key,
      description: tool.description,
      parameters: tool.parameters as any, // schéma JSON brut (pas de dépendance à typebox, absente de l'installation d'un plugin)
      async execute(_id: string, args: Args) {
        const problem = widgetError(key, args);
        if (problem) throw new Error(problem);
        const token = `[[agentui:${randomBytes(3).toString('hex')}]]`;
        return { content: [{ type: 'text' as const, text: JSON.stringify({ widget: token, instruction: spec.tokenInstruction }) }], details: { token } };
      },
    }));
  }, { names: WIDGET_TOOL_NAMES });
}
