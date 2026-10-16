import { describe, expect, it } from 'vitest';
import { expandWidgetTokens, outOfTextWidgets } from './widget';

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

describe('widget progress (hors du texte)', () => {
  const steps = (...st: string[]) => ({ steps: st.map((status, i) => ({ label: `E${i + 1}`, status })) });
  const prog = (id: string, args: unknown, token = 'c0ffee') => ({ id, name: 'agentui_progress', args, resultPreview: `{"widget": "[[agentui:${token}]]"}` });
  const states = (w: { arguments: Record<string, unknown> }) => (w.arguments.steps as Array<{ status: string }>).map((s) => s.status);

  it("s'affiche dès l'appel d'outil, sans jeton dans le texte, avec l'état du dernier appel", () => {
    const calls = [prog('t1', steps('running', 'pending')), prog('t2', { update: '[[agentui:c0ffee]]', ...steps('done', 'running') })];
    const w = outOfTextWidgets(calls);
    expect(w).toHaveLength(1);
    expect(states(w[0]!)).toEqual(['done', 'running']);
    expect(expandWidgetTokens('', calls, undefined, false)).toBe('');
  });
  it("ignore le jeton écrit par l'agent et n'ajoute rien au texte", () => {
    const calls = [prog('t1', steps('running'))];
    expect(expandWidgetTokens('Voilà [[agentui:c0ffee]]', calls)).toBe('Voilà ');
    expect(expandWidgetTokens('Texte', calls)).toBe('Texte');
  });
  it('un message suivant ne le réaffiche pas, mais une mise à jour y change son état', () => {
    const first = prog('t1', steps('running'));
    const update = prog('t2', { update: '[[agentui:c0ffee]]', ...steps('done') });
    expect(outOfTextWidgets([update], [first, update])).toEqual([]);
    expect(states(outOfTextWidgets([first], [first, update])[0]!)).toEqual(['done']);
  });
  it('deux widgets distincts, dans l\'ordre de création', () => {
    const calls = [prog('t1', steps('done'), 'aaaaaa'), prog('t2', steps('running'), 'bbbbbb')];
    expect(outOfTextWidgets(calls).map((w) => w.token)).toEqual(['aaaaaa', 'bbbbbb']);
  });
});
