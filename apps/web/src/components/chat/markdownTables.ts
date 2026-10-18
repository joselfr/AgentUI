/** Responsive Markdown tables: column label on each cell, and marker for "wide" tables. */

/** From this number of columns, a table turns into cards (one line per attribute) on small screens. */
export const STACK_FROM_COLUMNS = 3;

interface HastNode { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }

const textOf = (n: HastNode): string => (n.type === 'text' ? n.value ?? '' : (n.children ?? []).map(textOf).join(''));
const cells = (tr: HastNode, tag: string) => (tr.children ?? []).filter((c) => c.type === 'element' && c.tagName === tag);
const rowsOf = (table: HastNode): HastNode[] =>
  (table.children ?? []).flatMap((s) => (s.type === 'element' && s.tagName === 'tr' ? [s] : s.type === 'element' ? (s.children ?? []).filter((r) => r.type === 'element' && r.tagName === 'tr') : []));

function annotate(table: HastNode) {
  const rows = rowsOf(table);
  const headRow = rows.find((r) => cells(r, 'th').length);
  const headers = headRow ? cells(headRow, 'th').map((th) => textOf(th).trim()) : [];
  for (const tr of rows) {
    cells(tr, 'td').forEach((td, i) => { if (headers[i]) td.properties = { ...td.properties, dataLabel: headers[i] }; });
  }
  if (headers.length >= STACK_FROM_COLUMNS) table.properties = { ...table.properties, className: [...((table.properties?.className as string[]) ?? []), 'stackable'] };
}

/** Rehype plugin: `<td data-label="Price">` and `<table class="stackable">` for wide tables. */
export function rehypeTableLabels() {
  return (tree: HastNode) => {
    const walk = (n: HastNode) => { if (n.type === 'element' && n.tagName === 'table') annotate(n); n.children?.forEach(walk); };
    walk(tree);
  };
}
