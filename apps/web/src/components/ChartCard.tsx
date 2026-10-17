import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { ArcElement, BarController, BarElement, CategoryScale, Chart as ChartJS, DoughnutController, LinearScale, LineController, LineElement, PointElement, Tooltip, type Plugin } from 'chart.js';

ChartJS.register(ArcElement, BarController, BarElement, CategoryScale, DoughnutController, LinearScale, LineController, LineElement, PointElement, Tooltip);

interface Series { name: string; y: number[] }
interface Chart { kind: 'line' | 'bar' | 'pie'; title?: string; unit?: string; x: string[]; series: Series[] }

/** Arguments du widget `chart` : `{ kind: line|bar|pie, title?, unit?, x: [...], series: [{ name, y: [...] }] }`. `undefined` si invalide. */
export function parseChart(a: Record<string, unknown>): Chart | undefined {
  const c = a as unknown as Chart;
  if (!['line', 'bar', 'pie'].includes(c.kind) || !Array.isArray(c.x) || !Array.isArray(c.series) || !c.series.length) return undefined;
  if (!c.series.every((s) => s && Array.isArray(s.y) && s.y.length === c.x.length && s.y.every((v) => typeof v === 'number' && isFinite(v)))) return undefined;
  return { ...c, x: c.x.map(String), series: c.series.slice(0, 6) };
}

/** Plus petit « beau » nombre ≥ v (1, 2, 2.5, 5 × 10ⁿ). */
function niceCeil(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}
const fmt = (v: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(v);

type Colors = { line: string; text: string; bg: string; fg: string; paper: string };

/** Repère vertical pointillé sous le point survolé (courbes). */
const crosshair: Plugin = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const a = chart.tooltip?.getActiveElements();
    if ((chart.config as { type?: string }).type !== 'line' || !a?.length) return;
    const x = a[0]!.element.x, { top, bottom } = chart.chartArea, g = chart.ctx;
    g.save(); g.strokeStyle = (chart.options.color as string) ?? '#888'; g.globalAlpha = 0.5; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke(); g.restore();
  },
};

/** Valeur au-dessus de chaque barre (graphique à une seule série). */
const barLabels: Plugin = {
  id: 'barLabels',
  afterDatasetsDraw(chart, _a, opts: { on?: boolean; color?: string }) {
    if (!opts.on) return;
    const g = chart.ctx; g.save(); g.fillStyle = opts.color ?? '#888'; g.font = '11px Inter Variable, Inter, sans-serif'; g.textAlign = 'center';
    chart.getDatasetMeta(0).data.forEach((b, i) => { const v = chart.data.datasets[0]!.data[i] as number; g.fillText(fmt(v), b.x, v < 0 ? b.y + 14 : b.y - 5); });
    g.restore();
  },
};

function Pie({ c, colors, color }: { c: Chart; colors: string[]; color: Colors }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<ChartJS<'doughnut'>>();
  const [hover, setHover] = useState<number | null>(null);
  const key = JSON.stringify(c);
  const ys = c.series[0]!.y.map((v) => Math.max(0, v));
  const total = ys.reduce((a, b) => a + b, 0) || 1;
  const unit = c.unit ?? '';
  useEffect(() => {
    const ch = new ChartJS(ref.current!, {
      type: 'doughnut',
      data: { labels: c.x, datasets: [{ data: ys, backgroundColor: colors, borderColor: color.bg, borderWidth: 2, hoverOffset: 6, hoverBorderColor: color.bg }] },
      options: {
        cutout: '60%', responsive: true, aspectRatio: 1, animation: { duration: 400 }, layout: { padding: 6 },
        plugins: { tooltip: { enabled: false } },
        onHover: (_e, a) => setHover(a.length ? a[0]!.index : null),
      },
    });
    chartRef.current = ch;
    return () => ch.destroy();
    // `c` est recréé à chaque rendu du message (parseChart) : on ne reconstruit que si son contenu change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, colors, color.bg]);
  const highlight = (i: number | null) => {
    const ch = chartRef.current; if (!ch) return;
    ch.setActiveElements(i === null ? [] : [{ datasetIndex: 0, index: i }]); ch.update(); setHover(i);
  };
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2.5, flexWrap: 'wrap' }}>
      <Box sx={{ position: 'relative', width: 180, flex: 'none' }} onMouseLeave={() => setHover(null)}>
        <canvas ref={ref} role="img" aria-label={c.title} />
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', textAlign: 'center', pointerEvents: 'none' }}>
          <Box sx={{ fontSize: 20, fontWeight: 600, lineHeight: 1.2, color: color.fg }}>{fmt(hover === null ? total : ys[hover]!)}{unit}</Box>
          <Box sx={{ fontSize: 11, color: color.text }}>{hover === null ? 'total' : `${c.x[hover]} · ${Math.round((100 * ys[hover]!) / total)} %`}</Box>
        </Box>
      </Box>
      <Box sx={{ display: 'grid', gap: 0.75, fontSize: 13 }}>
        {ys.map((v, i) => (
          <Box key={i} onMouseEnter={() => highlight(i)} onMouseLeave={() => highlight(null)}
            sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 0.5, mx: -0.5, borderRadius: '6px', bgcolor: hover === i ? 'action.hover' : 'transparent' }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '3px', bgcolor: colors[i % colors.length] }} />
            <span>{c.x[i]} <b>{fmt(v)}{unit}</b> <Box component="span" sx={{ color: 'text.secondary' }}>({Math.round((100 * v) / total)} %)</Box></span>
          </Box>))}
      </Box>
    </Box>);
}

function Plot({ c, colors, color }: { c: Chart; colors: string[]; color: Colors }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<ChartJS>();
  const [hidden, setHidden] = useState<number[]>([]);
  const key = JSON.stringify(c);
  const line = c.kind === 'line';
  const unit = c.unit ?? '';
  useEffect(() => {
    const all = c.series.flatMap((s) => s.y);
    const mn = Math.min(0, ...all), mx = Math.max(0, ...all);
    // ~4 intervalles ronds, bornes alignées sur le pas (pas de graduations du type 37,5)
    const step = niceCeil(Math.max(mx - mn, 1e-9) / 4);
    const lo = Math.floor(mn / step) * step, hi = Math.max(lo + step, Math.ceil(mx / step) * step);
    const ch = new ChartJS(ref.current!, {
      type: c.kind === 'line' ? 'line' : 'bar',
      data: {
        labels: c.x,
        datasets: c.series.map((s, k) => ({
          label: s.name, data: s.y, borderColor: colors[k], backgroundColor: colors[k],
          ...(line
            ? { borderWidth: 2.5, tension: 0, pointRadius: 3.5, pointHoverRadius: 6, pointBorderColor: color.bg, pointBorderWidth: 0, pointHoverBorderWidth: 2 }
            : { borderRadius: 4, borderSkipped: false, borderWidth: 0, categoryPercentage: 0.7, barPercentage: 1 }),
        })) as never,
      },
      options: {
        responsive: true, aspectRatio: 520 / 220, animation: { duration: 400 }, color: color.text,
        layout: { padding: { top: 8, right: 4 } },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: color.text, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 } },
          y: { min: lo, max: hi, border: { display: false }, grid: { color: color.line }, ticks: { color: color.text, font: { size: 11 }, stepSize: step, callback: (v) => fmt(Number(v)) } },
        },
        plugins: {
          tooltip: {
            backgroundColor: color.paper, borderColor: color.line, borderWidth: 1, cornerRadius: 8, padding: 10, boxPadding: 4,
            titleColor: color.text, bodyColor: color.fg, titleFont: { weight: 'normal', size: 12 }, bodyFont: { size: 12 },
            displayColors: true, boxWidth: 9, boxHeight: 9, usePointStyle: false,
            callbacks: { label: (i: { dataset: { label?: string }; parsed: { y: number | null } }) => ` ${i.dataset.label} : ${fmt(i.parsed.y ?? 0)}${unit}` },
          },
          barLabels: { on: !line && c.series.length === 1, color: color.text },
        } as never,
      },
      plugins: [crosshair, barLabels],
    });
    chartRef.current = ch;
    return () => ch.destroy();
    // idem : clé de contenu, pas l'identité de `c`
  }, [key, colors, color, line, unit]);
  const toggle = (k: number) => {
    const ch = chartRef.current; if (!ch) return;
    ch.setDatasetVisibility(k, !ch.isDatasetVisible(k)); ch.update();
    setHidden(c.series.map((_, i) => i).filter((i) => !ch.isDatasetVisible(i)));
  };
  return (<>
    <canvas ref={ref} role="img" aria-label={c.title} />
    {c.series.length > 1 && (
      <Box sx={{ display: 'flex', gap: 2, mt: 0.5, flexWrap: 'wrap', fontSize: 12, color: 'text.secondary' }}>
        {c.series.map((s, k) => (
          <Box key={k} onClick={() => toggle(k)} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, cursor: 'pointer', userSelect: 'none', opacity: hidden.includes(k) ? 0.4 : 1, textDecoration: hidden.includes(k) ? 'line-through' : 'none' }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '3px', bgcolor: colors[k] }} />{s.name}
          </Box>))}
      </Box>)}
  </>);
}

export default function ChartCard({ chart: c }: { chart: Chart }) {
  const t = useTheme();
  const colors = useMemo(() => [t.palette.primary.main, t.palette.secondary.main, t.palette.warning.main, t.palette.success.main, '#38bdf8', '#ec4899'], [t]);
  const color = useMemo<Colors>(() => ({ line: t.palette.divider, text: t.palette.text.secondary, bg: t.palette.background.default, fg: t.palette.text.primary, paper: t.palette.background.paper }), [t]);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const rows = [['', ...c.series.map((s) => s.name)], ...c.x.map((x, i) => [x, ...c.series.map((s) => String(s.y[i]))])];
    void navigator.clipboard?.writeText(rows.map((r) => r.join('\t')).join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  return (
    <Box sx={{ my: 1, p: 1.5, border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.default' }}>
      {c.title && <Typography sx={{ fontWeight: 600 }}>{c.title}</Typography>}
      {c.unit && c.kind !== 'pie' && <Typography variant="caption" color="text.secondary">en {c.unit}</Typography>}
      <Box sx={{ mt: 1 }}>{c.kind === 'pie' ? <Pie c={c} colors={colors} color={color} /> : <Plot c={c} colors={colors} color={color} />}</Box>
      <Button size="small" variant="outlined" onClick={copy} sx={{ mt: 1, py: 0, fontSize: 12 }}>{copied ? 'Copié ✓' : 'Copier les données'}</Button>
    </Box>
  );
}
