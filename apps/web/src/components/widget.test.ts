import { describe, expect, it } from 'vitest';
import { expandWidgetTokens } from './widget';

const chart = { kind: 'bar', x: ['a'], series: [{ name: 's', y: [1] }] };
const tool = (id: string, token = 'a3f9c1', args: unknown = chart, name = 'agentui_chart') =>
  ({ id, name, args, resultPreview: `{"widget": "[[agentui:${token}]]", "instruction": "…"}` });
const widget = `\`\`\`widget\n${JSON.stringify({ type: 'chart', arguments: chart })}\n\`\`\``;

describe('expandWidgetTokens', () => {
  it('remplace le jeton à sa place dans le texte', () => {
    const out = expandWidgetTokens('Avant\n[[agentui:a3f9c1]]\nAprès', [tool('t1')]);
    expect(out).toBe(`Avant\n\n\n${widget}\n\n\nAprès`);
  });
  it('remplace plusieurs jetons', () => {
    const out = expandWidgetTokens('[[agentui:a3f9c1]] et [[agentui:b00001]]', [tool('t1'), tool('t2', 'b00001')]);
    expect(out.match(/```widget/g)).toHaveLength(2);
  });
  it('supprime un jeton inconnu', () => {
    expect(expandWidgetTokens('Texte [[agentui:ffffff]] fin', [])).toBe('Texte  fin');
  });
  it('masque un jeton en cours de frappe', () => {
    for (const tail of ['[', '[[', '[[agent', '[[agentui:', '[[agentui:a3f', '[[agentui:a3f9c1]']) {
      expect(expandWidgetTokens(`Voici ${tail}`, [tool('t1')], undefined, false)).toBe('Voici ');
    }
  });
  it('garde un crochet ordinaire en fin de texte', () => {
    expect(expandWidgetTokens('liste [1', [], undefined, false)).toBe('liste [1');
  });
  it('ajoute en fin de message le widget dont le jeton est absent, seulement une fois le message terminé', () => {
    expect(expandWidgetTokens('Texte', [tool('t1')], undefined, false)).toBe('Texte');
    expect(expandWidgetTokens('Texte', [tool('t1')])).toBe(`Texte\n\n${widget}\n\n`);
  });
  it("résout le jeton d'un message précédent", () => {
    const out = expandWidgetTokens('Encore [[agentui:a3f9c1]]', [], [tool('t1')]);
    expect(out).toContain('```widget');
  });
  it('ignore un outil aux arguments invalides ou un autre outil', () => {
    expect(expandWidgetTokens('x [[agentui:a3f9c1]]', [tool('t1', 'a3f9c1', null)])).toBe('x ');
    expect(expandWidgetTokens('x [[agentui:a3f9c1]]', [tool('t1', 'a3f9c1', chart, 'terminal')])).toBe('x ');
  });
});
