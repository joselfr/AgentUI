import { describe, expect, it } from 'vitest';
import { parseTable } from './TableCard';
import { widgetOfTool } from './widget';

const ok = { columns: [{ label: 'A' }, { label: 'B', kind: 'number', unit: 'k' }], rows: [['x', 1], ['y', null], [true, 2.5]] };

describe('parseTable', () => {
  it('accepts valid columns and rows, kind defaults to text', () => {
    const t = parseTable(ok);
    expect(t?.columns).toEqual([{ label: 'A', kind: 'text' }, { label: 'B', kind: 'number', unit: 'k' }]);
    expect(t?.rows).toHaveLength(3);
  });
  it('rejects missing, empty or too many columns', () => {
    expect(parseTable({ rows: [] })).toBeUndefined();
    expect(parseTable({ columns: [], rows: [] })).toBeUndefined();
    expect(parseTable({ columns: Array.from({ length: 13 }, () => ({ label: 'c' })), rows: [] })).toBeUndefined();
  });
  it('rejects a row of the wrong length, an object cell or an unknown kind', () => {
    expect(parseTable({ ...ok, rows: [['x']] })).toBeUndefined();
    expect(parseTable({ ...ok, rows: [['x', { a: 1 }]] })).toBeUndefined();
    expect(parseTable({ ...ok, columns: [{ label: 'A', kind: 'date' }, { label: 'B' }] })).toBeUndefined();
  });
  it('rejects more than 200 rows', () => {
    expect(parseTable({ columns: [{ label: 'A' }], rows: Array.from({ length: 201 }, () => ['x']) })).toBeUndefined();
  });
  it("the agentui_widget_table tool is a display widget", () => {
    expect(widgetOfTool({ name: 'agentui_widget_table', args: ok })?.type).toBe('table');
  });
});
