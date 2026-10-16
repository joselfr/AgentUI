import { useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

interface Series { name: string; y: number[] }
interface Chart { type: 'line' | 'bar' | 'pie'; title?: string; unit?: string; x: string[]; series: Series[] }

/** Bloc ```chart : JSON `{ type: line|bar|pie, title?, unit?, x: [...], series: [{ name, y: [...] }] }`. `undefined` si invalide. */
export function parseChart(raw: string): Chart | undefined {
  try {
    const c = JSON.parse(raw) as Chart;
    if (!['line', 'bar', 'pie'].includes(c.type) || !Array.isArray(c.x) || !Array.isArray(c.series) || !c.series.length) return undefined;
    if (!c.series.every((s) => Array.isArray(s.y) && s.y.length === c.x.length && s.y.every((v) => typeof v === 'number' && isFinite(v)))) return undefined;
    return { ...c, x: c.x.map(String), series: c.series.slice(0, 6) };
  } catch { return undefined; }
}

/** Plus petit « beau » nombre ≥ v (1, 2, 2.5, 5 × 10ⁿ). */
function niceCeil(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}
const fmt = (v: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(v);

const W = 520, H = 220, M = { l: 40, r: 10, t: 14, b: 28 };

function Axes({ c, lo, hi, color }: { c: Chart; lo: number; hi: number; color: { line: string; text: string } }) {
  const step = Math.ceil(c.x.length / 8);
  const cw = (W - M.l - M.r) / c.x.length;
  return (<>
    {[0, 1, 2, 3, 4].map((i) => {
      const y = M.t + ((H - M.t - M.b) * i) / 4;
      return <g key={i}><line x1={M.l} x2={W - M.r} y1={y} y2={y} stroke={color.line} />
        <text x={M.l - 8} y={y + 4} textAnchor="end" fontSize="11" fill={color.text}>{fmt(hi - ((hi - lo) * i) / 4)}</text></g>;
    })}
    {c.x.map((l, i) => i % step === 0 && <text key={i} x={M.l + cw * (i + 0.5)} y={H - 8} textAnchor="middle" fontSize="11" fill={color.text}>{l}</text>)}
  </>);
}

function Plot({ c, colors, color }: { c: Chart; colors: string[]; color: { line: string; text: string; bg: string; fg: string } }) {
  if (c.type === 'pie') {
    const ys = c.series[0]!.y.map((v) => Math.max(0, v));
    const total = ys.reduce((a, b) => a + b, 0) || 1;
    let a0 = -Math.PI / 2;
    const P = (r: number, a: number) => `${100 + r * Math.cos(a)} ${100 + r * Math.sin(a)}`;
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2.5, flexWrap: 'wrap' }}>
        <svg viewBox="0 0 200 200" style={{ width: 180, flex: 'none' }} role="img" aria-label={c.title}>
          {ys.map((v, i) => {
            const a1 = a0 + (2 * Math.PI * v) / total;
            const full = v >= total; // une seule part : un arc de 360° se dessine en deux moitiés
            const d = full
              ? `M${P(90, 0)}A90 90 0 1 1 ${P(90, Math.PI)}A90 90 0 1 1 ${P(90, 0)}Z M${P(54, 0)}A54 54 0 1 0 ${P(54, Math.PI)}A54 54 0 1 0 ${P(54, 0)}Z`
              : `M${P(90, a0)}A90 90 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${P(90, a1)}L${P(54, a1)}A54 54 0 ${a1 - a0 > Math.PI ? 1 : 0} 0 ${P(54, a0)}Z`;
            a0 = a1;
            return <path key={i} d={d} fill={colors[i % colors.length]} fillRule="evenodd" stroke={color.bg} strokeWidth="2" />;
          })}
          <text x="100" y="99" textAnchor="middle" fontSize="20" fontWeight="600" fill={color.fg}>{fmt(total)}{c.unit ?? ''}</text>
          <text x="100" y="116" textAnchor="middle" fontSize="11" fill={color.text}>total</text>
        </svg>
        <Box sx={{ display: 'grid', gap: 0.75, fontSize: 13 }}>
          {ys.map((v, i) => (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box sx={{ width: 10, height: 10, borderRadius: '3px', bgcolor: colors[i % colors.length] }} />
              <span>{c.x[i]} <b>{fmt(v)}{c.unit ?? ''}</b> <Box component="span" sx={{ color: 'text.secondary' }}>({Math.round((100 * v) / total)} %)</Box></span>
            </Box>))}
        </Box>
      </Box>);
  }
  const all = c.series.flatMap((s) => s.y);
  const lo = Math.min(0, ...all);
  const hi = Math.max(lo + 1, niceCeil(Math.max(...all)));
  const Y = (v: number) => M.t + (H - M.t - M.b) * (1 - (v - lo) / (hi - lo));
  const cw = (W - M.l - M.r) / c.x.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={c.title}>
      <Axes c={c} lo={lo} hi={hi} color={color} />
      {c.type === 'line' ? c.series.map((s, k) => {
        const pts = s.y.map((v, i) => [M.l + cw * (i + 0.5), Y(v)] as const);
        return <g key={k}><polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={colors[k]} strokeWidth="2.5" strokeLinejoin="round" />
          {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r="3.5" fill={colors[k]}><title>{`${s.name} · ${c.x[i]} : ${fmt(s.y[i]!)}${c.unit ?? ''}`}</title></circle>)}</g>;
      }) : c.series.map((s, k) => {
        const bw = (cw * 0.7) / c.series.length;
        return <g key={k}>{s.y.map((v, i) => {
          const x = M.l + cw * i + cw * 0.15 + bw * k;
          return <g key={i}><rect x={x} y={Math.min(Y(v), Y(0))} width={bw - 2} height={Math.abs(Y(v) - Y(0))} rx="4" fill={colors[k]}><title>{`${s.name} · ${c.x[i]} : ${fmt(v)}${c.unit ?? ''}`}</title></rect>
            {c.series.length === 1 && <text x={x + (bw - 2) / 2} y={Y(v) - 5} textAnchor="middle" fontSize="11" fill={color.text}>{fmt(v)}</text>}</g>;
        })}</g>;
      })}
    </svg>);
}

export default function ChartCard({ chart: c }: { chart: Chart }) {
  const t = useTheme();
  const colors = [t.palette.primary.main, t.palette.secondary.main, t.palette.warning.main, t.palette.success.main, '#38bdf8', '#ec4899'];
  const color = { line: t.palette.divider, text: t.palette.text.secondary, bg: t.palette.background.default, fg: t.palette.text.primary };
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const rows = [['', ...c.series.map((s) => s.name)], ...c.x.map((x, i) => [x, ...c.series.map((s) => String(s.y[i]))])];
    void navigator.clipboard?.writeText(rows.map((r) => r.join('\t')).join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  return (
    <Box sx={{ my: 1, p: 1.5, border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.default' }}>
      {c.title && <Typography sx={{ fontWeight: 600 }}>{c.title}</Typography>}
      {c.unit && c.type !== 'pie' && <Typography variant="caption" color="text.secondary">en {c.unit}</Typography>}
      <Box sx={{ mt: 1 }}><Plot c={c} colors={colors} color={color} /></Box>
      {c.type !== 'pie' && c.series.length > 1 && (
        <Box sx={{ display: 'flex', gap: 2, mt: 0.5, flexWrap: 'wrap', fontSize: 12, color: 'text.secondary' }}>
          {c.series.map((s, k) => <Box key={k} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}><Box sx={{ width: 10, height: 10, borderRadius: '3px', bgcolor: colors[k] }} />{s.name}</Box>)}
        </Box>)}
      <Button size="small" variant="outlined" onClick={copy} sx={{ mt: 1, py: 0, fontSize: 12 }}>{copied ? 'Copié ✓' : 'Copier les données'}</Button>
    </Box>
  );
}
