import { describe, expect, it } from 'vitest';
import { fmtDuration, parseProgress } from './ProgressCard';
import { widgetOfTool } from './widget';
import { setLangPref } from '../i18n';

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

describe('fmtDuration', () => {
  it('formate en français selon l\'ordre de grandeur', () => {
    setLangPref('fr');
    expect(fmtDuration(3200)).toBe('3,2 s');
    expect(fmtDuration(42_400)).toBe('42 s');
    expect(fmtDuration(125_000)).toBe('2 min 05 s');
    expect(fmtDuration(3_900_000)).toBe('1 h 05 min');
    expect(fmtDuration(-5)).toBe('0,0 s');
  });
  it('utilise le point décimal en anglais', () => {
    setLangPref('en');
    expect(fmtDuration(3200)).toBe('3.2 s');
    setLangPref('fr');
  });
});
