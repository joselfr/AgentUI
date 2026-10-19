import { useMemo, useState } from 'react';
import { fmtNumber, getLang, t as tr } from '../i18n';
import { Box, Button, Typography } from '@mui/material';
import Markdown from './Markdown';

type Cell = string | number | boolean | null;
interface Column { label: string; kind: 'text' | 'number'; unit?: string }
interface Table { title?: string; caption?: string; columns: Column[]; rows: Cell[][] }

const MAX_COLUMNS = 12;
const MAX_ROWS = 200;
const FOLD_ROWS = 10; // beyond that, only the first PEEK_ROWS rows
const PEEK_ROWS = 8;

/** Arguments of the `table` widget: `{ title?, caption?, columns: [{ label, kind?: text|number, unit? }], rows: [[cell, …], …] }`. `undefined` if invalid. */
export function parseTable(a: Record<string, unknown>): Table | undefined {
  const { columns, rows } = a as { columns?: unknown; rows?: unknown };
  if (!Array.isArray(columns) || !columns.length || columns.length > MAX_COLUMNS || !Array.isArray(rows) || rows.length > MAX_ROWS) return undefined;
  const cols: Column[] = [];
  for (const c of columns as Array<Record<string, unknown>>) {
    if (!c || typeof c.label !== 'string' || (c.kind !== undefined && c.kind !== 'text' && c.kind !== 'number')) return undefined;
    cols.push({ label: c.label, kind: c.kind === 'number' ? 'number' : 'text', ...(typeof c.unit === 'string' && c.unit ? { unit: c.unit } : {}) });
  }
  const isCell = (v: unknown): v is Cell => v === null || ['string', 'number', 'boolean'].includes(typeof v);
  if (!rows.every((r) => Array.isArray(r) && r.length === cols.length && r.every(isCell))) return undefined;
  return {
    ...(typeof a.title === 'string' && a.title ? { title: a.title } : {}),
    ...(typeof a.caption === 'string' && a.caption ? { caption: a.caption } : {}),
    columns: cols,
    rows: rows as Cell[][],
  };
}

function show(v: Cell, col: Column): string {
  if (v === null) return '—';
  if (typeof v === 'boolean') return v ? tr('common.yes') : tr('common.no');
  return typeof v === 'number' && col.kind === 'number' ? fmtNumber(v, 3) : String(v);
}

const csvField = (s: string) => (/[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csv = (t: Table) =>
  [t.columns.map((c) => c.label), ...t.rows.map((r) => r.map((v) => (v === null ? '' : typeof v === 'boolean' ? (v ? tr('common.yes') : tr('common.no')) : String(v))))]
    .map((r) => r.map(csvField).join(','))
    .join('\n');

export default function TableCard({ table: t }: { table: Table }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const sorted = useMemo(() => {
    if (!sort) return t.rows;
    const { col, dir } = sort;
    const num = t.columns[col]!.kind === 'number';
    // Empty cells stay at the end of the table, whichever the direction.
    return [...t.rows].sort((x, y) => {
      const u = x[col], v = y[col];
      if (u === null) return v === null ? 0 : 1;
      if (v === null) return -1;
      return (num && typeof u === 'number' && typeof v === 'number' ? u - v : String(u).localeCompare(String(v), getLang())) * dir;
    });
  }, [t, sort]);

  const folded = !open && sorted.length > FOLD_ROWS;
  const visible = folded ? sorted.slice(0, PEEK_ROWS) : sorted;

  const clickHeader = (col: number) => {
    const first = t.columns[col]!.kind === 'number' ? -1 : 1; // numbers: largest to smallest first
    setSort((s) => (!s || s.col !== col ? { col, dir: first } : s.dir === first ? { col, dir: (-first) as 1 | -1 } : null));
  };
  const copy = () => void navigator.clipboard?.writeText(csv(t)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });

  const cellSx = { px: 1.5, py: 0.9, borderBottom: 1, borderColor: 'divider', whiteSpace: 'nowrap', textAlign: 'left', fontSize: 13 } as const;
  return (
    <Box sx={{ my: 1, p: 1.5, border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.default', minWidth: 0 }}>
      {t.title && <Typography sx={{ fontWeight: 600 }}>{t.title}</Typography>}
      {t.caption && <Typography variant="caption" color="text.secondary">{t.caption}</Typography>}
      <Box sx={{ mt: 1, overflow: 'auto', maxWidth: '100%', maxHeight: open ? 320 : undefined, border: 1, borderColor: 'divider', borderRadius: '8px', bgcolor: 'background.paper' }}>
        <Box component="table" sx={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%' }}>
          <thead>
            <tr>
              {t.columns.map((c, i) => {
                const s = sort?.col === i ? sort.dir : 0;
                return (
                  <Box component="th" key={i} onClick={() => clickHeader(i)} aria-sort={s === 0 ? 'none' : s > 0 ? 'ascending' : 'descending'}
                    sx={{ ...cellSx, position: 'sticky', top: 0, left: i === 0 ? 0 : undefined, zIndex: i === 0 ? 2 : 1, bgcolor: 'background.paper', backgroundImage: (th) => `linear-gradient(${th.palette.action.hover}, ${th.palette.action.hover})`, fontWeight: 600, fontSize: 12, color: s ? 'text.primary' : 'text.secondary', cursor: 'pointer', userSelect: 'none', textAlign: c.kind === 'number' ? 'right' : 'left', '&:hover': { color: 'text.primary' } }}>
                    {c.label}
                    <Box component="span" sx={{ display: 'inline-block', width: 12, ml: 0.5, color: 'primary.main' }}>{s > 0 ? '▲' : s < 0 ? '▼' : ''}</Box>
                  </Box>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r, ri) => (
              <tr key={ri}>
                {r.map((v, ci) => {
                  const col = t.columns[ci]!;
                  const long = typeof v === 'string' && v.length > 40;
                  return (
                    <Box component="td" key={ci}
                      sx={{ ...cellSx, ...(ri === visible.length - 1 && { borderBottom: 0 }), ...(ci === 0 && { position: 'sticky', left: 0, zIndex: 1, bgcolor: 'background.paper' }), textAlign: col.kind === 'number' ? 'right' : 'left', ...(col.kind === 'number' && { fontVariantNumeric: 'tabular-nums' }), color: v === null ? 'text.secondary' : 'text.primary', ...(long && { whiteSpace: 'normal', minWidth: 180, maxWidth: 300 }) }}>
                      {typeof v === 'string' && col.kind === 'text' ? <Markdown>{v}</Markdown> : show(v, col)}
                      {col.unit && typeof v === 'number' && <Box component="span" sx={{ ml: 0.25, fontSize: 12, color: 'text.secondary' }}>{col.unit}</Box>}
                    </Box>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </Box>
      </Box>
      <Box sx={{ display: 'flex', gap: 1, mt: 1, alignItems: 'center' }}>
        {folded && <Button size="small" variant="outlined" onClick={() => setOpen(true)} sx={{ py: 0, fontSize: 12 }}>{tr('table.showMore', { count: sorted.length - PEEK_ROWS })}</Button>}
        {open && sorted.length > FOLD_ROWS && <Button size="small" variant="outlined" onClick={() => setOpen(false)} sx={{ py: 0, fontSize: 12 }}>{tr('table.fold')}</Button>}
        <Button size="small" variant="outlined" onClick={copy} sx={{ py: 0, fontSize: 12 }}>{copied ? tr('table.copied') : tr('table.copy')}</Button>
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>{tr('table.rows', { count: t.rows.length })}</Typography>
      </Box>
    </Box>
  );
}
