import { useEffect, useRef } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import OpenInNew from '@mui/icons-material/OpenInNew';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { t as tr } from '../i18n';

interface Point { lat: number; lon: number; title: string; text?: string; maps: boolean }
interface MapData { title?: string; maps: boolean; points: Point[] }

const MAX_POINTS = 10; // Google Maps route limit (origin, destination, 8 waypoints)

/** Arguments of the `map` widget: `{ title?, maps?, points: [{ lat, lon, title, text?, maps? }] }`. `undefined` if invalid. */
export function parseMap(a: Record<string, unknown>): MapData | undefined {
  if (!Array.isArray(a.points) || !a.points.length) return undefined;
  const points: Point[] = [];
  for (const p of a.points.slice(0, MAX_POINTS)) {
    if (!p || typeof p !== 'object') return undefined;
    const { lat, lon, title, text, maps } = p as Record<string, unknown>;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return undefined;
    points.push({ lat, lon, title: typeof title === 'string' ? title : '', text: typeof text === 'string' && text.trim() ? text : undefined, maps: maps === true });
  }
  return { title: typeof a.title === 'string' ? a.title : undefined, maps: a.maps === true, points };
}

const ll = (p: Point) => `${p.lat},${p.lon}`;
/** One point: its card; several: the route in point order. */
export function mapsUrl(ps: Point[]) {
  if (ps.length === 1) return `https://www.google.com/maps/search/?api=1&query=${ll(ps[0]!)}`;
  const mid = ps.slice(1, -1).map(ll).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${ll(ps[0]!)}&destination=${ll(ps[ps.length - 1]!)}${mid ? `&waypoints=${encodeURIComponent(mid)}` : ''}`;
}

const pin = (color: string) => L.divIcon({
  className: '',
  iconSize: [28, 28], iconAnchor: [14, 27], popupAnchor: [0, -26],
  html: `<svg viewBox="0 0 24 24" width="28" height="28" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))"><path d="M12 22s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z" fill="${color}" stroke="#fff" stroke-width="1.6"/><circle cx="12" cy="10" r="2.6" fill="#fff"/></svg>`,
});

/** Popup content: title, Markdown text, optional Maps button. Rendered in a DOM node for Leaflet. */
function PopupBody({ p }: { p: Point }) {
  return (
    <Box sx={{ fontSize: 13, lineHeight: 1.45, '& p': { m: '0 0 4px' }, '& ul, & ol': { m: '0 0 4px', pl: 2.25 }, '& a': { color: 'primary.main' } }}>
      {p.title && <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{p.title}</Typography>}
      {p.text && <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _n, ...a }) => <a {...a} target="_blank" rel="noreferrer" /> }}>{p.text}</ReactMarkdown>}
      {p.maps && <Button size="small" variant="outlined" component="a" href={mapsUrl([p])} target="_blank" rel="noreferrer" startIcon={<OpenInNew sx={{ fontSize: 14 }} />} sx={{ mt: 0.5, py: 0, fontSize: 12 }}>{tr('map.openMaps')}</Button>}
    </Box>);
}

export default function MapCard({ map: m }: { map: MapData }) {
  const t = useTheme();
  const el = useRef<HTMLDivElement>(null);
  const dark = t.palette.mode === 'dark';

  useEffect(() => {
    if (!el.current) return;
    const map = L.map(el.current, { scrollWheelZoom: false, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>' }).addTo(map);
    const roots: ReturnType<typeof createRoot>[] = [];
    m.points.forEach((p) => {
      const marker = L.marker([p.lat, p.lon], { icon: pin(t.palette.primary.main), title: p.title, alt: p.title || tr('map.point') }).addTo(map);
      if (!p.title && !p.text && !p.maps) return;
      const node = document.createElement('div');
      const root = createRoot(node);
      root.render(<PopupBody p={p} />);
      roots.push(root);
      marker.bindPopup(node, { minWidth: 160, maxWidth: 260, autoPanPadding: [16, 16] });
    });
    if (m.points.length === 1) map.setView([m.points[0]!.lat, m.points[0]!.lon], 15);
    else map.fitBounds(L.latLngBounds(m.points.map((p) => [p.lat, p.lon] as [number, number])), { padding: [40, 40], maxZoom: 16 });
    return () => { map.remove(); setTimeout(() => roots.forEach((r) => r.unmount())); };
  }, [m, t.palette.primary.main]);

  return (
    <Box sx={{ my: 1, p: 1.5, minWidth: 'min(480px, 72vw)', border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.default' }}>
      {m.title && <Typography sx={{ fontWeight: 600 }}>{m.title}</Typography>}
      {m.points.length > 1 && <Typography variant="caption" color="text.secondary">{tr('map.points', { count: m.points.length })}</Typography>}
      <Box ref={el} sx={{
        mt: 1, height: { xs: 240, sm: 300 }, borderRadius: '10px', overflow: 'hidden', border: 1, borderColor: 'divider', isolation: 'isolate',
        // OSM tiles darkened in dark theme
        ...(dark && { '& .leaflet-tile-pane': { filter: 'invert(1) hue-rotate(180deg) brightness(.9) contrast(.9)' } }),
        '& .leaflet-popup-content-wrapper, & .leaflet-popup-tip': { bgcolor: 'background.paper', color: 'text.primary', border: 1, borderColor: 'divider', boxShadow: `0 6px 20px ${alpha('#000', 0.25)}` },
        '& .leaflet-popup-content-wrapper': { borderRadius: '12px' },
        '& .leaflet-popup-content': { m: '10px 12px' },
        '& .leaflet-container a.leaflet-popup-close-button': { color: 'text.secondary' },
        '& .leaflet-control-attribution': { bgcolor: alpha(t.palette.background.paper, 0.8), color: 'text.secondary', fontSize: 10 },
        '& .leaflet-control-attribution a': { color: 'text.secondary' },
        '& .leaflet-bar a': { bgcolor: 'background.paper', color: 'text.primary', borderColor: 'divider' },
      }} />
      {m.maps && (
        <Button size="small" variant="contained" component="a" href={mapsUrl(m.points)} target="_blank" rel="noreferrer" startIcon={<OpenInNew />} sx={{ mt: 1, '&&': { color: 'primary.contrastText' } }}>{tr('map.openMaps')}</Button>)}
    </Box>
  );
}
