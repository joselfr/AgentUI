import { describe, expect, it } from 'vitest';
import { parseProgress } from './ProgressCard';
import { widgetOfTool } from './widget';

const ok = { title: 'T', steps: [{ label: 'A', status: 'done' }, { label: 'B', status: 'running', detail: '2/3' }], update: '[[agentui:ab12cd]]' };

describe('parseProgress', () => {
  it('accepte des étapes valides et ignore `update`', () => {
    const p = parseProgress(ok);
    expect(p?.title).toBe('T');
    expect(p?.steps).toEqual([{ label: 'A', status: 'done' }, { label: 'B', status: 'running', detail: '2/3' }]);
  });
  it('rejette étapes absentes, vides, trop nombreuses ou de statut inconnu', () => {
    expect(parseProgress({})).toBeUndefined();
    expect(parseProgress({ steps: [] })).toBeUndefined();
    expect(parseProgress({ steps: Array.from({ length: 21 }, () => ({ label: 'x', status: 'done' })) })).toBeUndefined();
    expect(parseProgress({ steps: [{ label: 'A', status: 'fini' }] })).toBeUndefined();
    expect(parseProgress({ steps: [{ status: 'done' }] })).toBeUndefined();
  });
  it("l'outil agentui_progress est un widget d'affichage", () => {
    expect(widgetOfTool({ name: 'agentui_progress', args: ok })?.type).toBe('progress');
  });
});
