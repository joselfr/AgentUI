import { describe, expect, it } from 'vitest';
import { parseTable } from './TableCard';
import { widgetOfTool } from './widget';

const ok = { columns: [{ label: 'A' }, { label: 'B', kind: 'number', unit: 'k' }], rows: [['x', 1], ['y', null], [true, 2.5]] };

describe('parseTable', () => {
  it('accepte colonnes et lignes valides, kind par défaut text', () => {
    const t = parseTable(ok);
    expect(t?.columns).toEqual([{ label: 'A', kind: 'text' }, { label: 'B', kind: 'number', unit: 'k' }]);
    expect(t?.rows).toHaveLength(3);
  });
  it('rejette colonnes absentes, vides ou trop nombreuses', () => {
    expect(parseTable({ rows: [] })).toBeUndefined();
    expect(parseTable({ columns: [], rows: [] })).toBeUndefined();
    expect(parseTable({ columns: Array.from({ length: 13 }, () => ({ label: 'c' })), rows: [] })).toBeUndefined();
  });
  it('rejette une ligne de mauvaise longueur, une cellule objet ou un kind inconnu', () => {
    expect(parseTable({ ...ok, rows: [['x']] })).toBeUndefined();
    expect(parseTable({ ...ok, rows: [['x', { a: 1 }]] })).toBeUndefined();
    expect(parseTable({ ...ok, columns: [{ label: 'A', kind: 'date' }, { label: 'B' }] })).toBeUndefined();
  });
  it('rejette plus de 200 lignes', () => {
    expect(parseTable({ columns: [{ label: 'A' }], rows: Array.from({ length: 201 }, () => ['x']) })).toBeUndefined();
  });
  it("l'outil agentui_table est un widget d'affichage", () => {
    expect(widgetOfTool({ name: 'agentui_table', args: ok })?.type).toBe('table');
  });
});
