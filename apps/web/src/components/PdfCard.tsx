import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Button, Dialog, IconButton, Link, Typography } from '@mui/material';
import { AddRounded, RemoveRounded } from '@mui/icons-material';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { t } from '../i18n';
import { useBackClose } from '../useBackClose';
import { isHttp, optText, validSrc } from './media';
import { openPdf, pageRatio, paintPage } from './pdfjs';
import type { Resolved } from './ImageCard';

export interface Pdf { src: string; title?: string; page: number }

/** Arguments of the `pdf` widget: `{ src, title?, page? }`; `src`: http(s) URL or absolute path. `undefined` if invalid. */
export function parsePdf(a: Record<string, unknown>): Pdf | undefined {
  if (!validSrc(a.src)) return undefined;
  const page = a.page === undefined ? 1 : a.page;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return undefined;
  return { src: a.src, title: optText(a.title, 120), page };
}

type Doc = { state: 'loading' } | { state: 'error' } | { state: 'ok'; doc: PDFDocumentProxy };

/** Loads a PDF once its URL is known (`undefined` while the file is still being copied into the chat). */
function usePdf(url: string | undefined, failed: boolean): Doc {
  const [d, setD] = useState<Doc>({ state: 'loading' });
  useEffect(() => {
    if (failed) { setD({ state: 'error' }); return; }
    if (!url) { setD({ state: 'loading' }); return; }
    const ctl = new AbortController();
    let destroy: (() => void) | undefined;
    setD({ state: 'loading' });
    openPdf(url, ctl.signal).then((x) => { destroy = x.destroy; if (ctl.signal.aborted) x.destroy(); else setD({ state: 'ok', doc: x.doc }); }, () => { if (!ctl.signal.aborted) setD({ state: 'error' }); });
    return () => { ctl.abort(); destroy?.(); };
  }, [url, failed]);
  return d;
}

/** Canvas showing page `n` at the width of its container (re-drawn when the width changes). */
function PageCanvas({ doc, n, width, onSize }: { doc: PDFDocumentProxy; n: number; width: number; onSize?: (cssHeight: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || width < 1) return;
    let task: Awaited<ReturnType<typeof paintPage>>;
    let dead = false;
    void paintPage(doc, n, c, width).then((t0) => {
      task = t0;
      if (dead) { t0?.cancel(); return; }
      onSize?.(parseFloat(c.style.height));
      t0?.promise.catch(() => {});
    }, () => {});
    return () => { dead = true; task?.cancel(); };
  }, [doc, n, width]); // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={ref} style={{ display: 'block', background: '#fff', maxWidth: 'none' }} />;
}

/** Page rendered only when it comes into view (a long PDF does not draw all its pages at once). */
function LazyPage({ doc, n, width, ratio, root }: { doc: PDFDocumentProxy; n: number; width: number; ratio: number; root: HTMLElement | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || !root) return;
    const io = new IntersectionObserver((e) => setSeen(e.some((x) => x.isIntersecting)), { root, rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);
  return (
    <Box ref={box} data-page={n} sx={{ width, height: width * ratio, bgcolor: '#fff', mb: 1, flex: 'none', boxShadow: 1 }}>
      {seen && <PageCanvas doc={doc} n={n} width={width} />}
    </Box>
  );
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

function Viewer({ doc, title, url, onClose }: { doc: PDFDocumentProxy; title?: string; url: string; onClose: () => void }) {
  useBackClose(true, onClose);
  const scroller = useRef<HTMLDivElement | null>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [base, setBase] = useState(0); // width of a page at zoom 1 (fits the screen)
  const [zoom, setZoom] = useState(1);
  const [ratio, setRatio] = useState(1.4);
  const [current, setCurrent] = useState(1);
  const pending = useRef<{ fx: number; fy: number; k: number } | null>(null);
  const setScroller = useCallback((el: HTMLDivElement | null) => { scroller.current = el; setRoot(el); if (el) setBase(el.clientWidth - 16); }, []);
  useEffect(() => { void pageRatio(doc, 1).then(setRatio, () => {}); }, [doc]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBase(el.clientWidth - 16));
    ro.observe(el);
    return () => ro.disconnect();
  }, [root]);
  const width = Math.max(1, Math.round(base * zoom));
  // After a zoom, the point under the fingers (or the center) keeps its place on screen.
  useLayoutEffect(() => {
    const p = pending.current, el = scroller.current;
    if (!p || !el) return;
    pending.current = null;
    el.scrollLeft = p.fx * p.k - (p.fx - el.scrollLeft);
    el.scrollTop = p.fy * p.k - (p.fy - el.scrollTop);
  }, [width]);
  const zoomTo = (z: number, fx?: number, fy?: number) => {
    const el = scroller.current;
    const next = clampZoom(z);
    if (!el || next === zoom) return;
    pending.current = { fx: fx ?? el.scrollLeft + el.clientWidth / 2, fy: fy ?? el.scrollTop + el.clientHeight / 2, k: next / zoom };
    setZoom(next);
  };
  // Pinch: the pages follow the fingers (CSS transform), then are re-drawn sharp at the final zoom.
  useEffect(() => {
    const el = scroller.current, wrap = inner.current;
    if (!el || !wrap) return;
    let d0 = 0, z0 = 1, fx = 0, fy = 0, f = 1;
    const dist = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const r = el.getBoundingClientRect();
      d0 = dist(e.touches); z0 = zoomRef.current; f = 1;
      fx = el.scrollLeft + (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2 - r.left;
      fy = el.scrollTop + (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2 - r.top;
      wrap.style.transformOrigin = `${fx}px ${fy}px`;
    };
    const move = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !d0) return;
      e.preventDefault();
      f = clampZoom(z0 * (dist(e.touches) / d0)) / z0;
      wrap.style.transform = `scale(${f})`;
    };
    const end = (e: TouchEvent) => {
      if (!d0 || e.touches.length >= 2) return;
      wrap.style.transform = '';
      const target = z0 * f;
      d0 = 0;
      if (Math.abs(f - 1) > 0.02) zoomToRef.current(target, fx, fy);
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => { el.removeEventListener('touchstart', start); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', end); el.removeEventListener('touchcancel', end); };
  }, [root]); // eslint-disable-line react-hooks/exhaustive-deps
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const zoomToRef = useRef(zoomTo);
  zoomToRef.current = zoomTo;
  // Current page = the one crossing the middle of the screen.
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const mid = el.getBoundingClientRect().top + el.clientHeight / 2;
    for (const p of el.querySelectorAll<HTMLElement>('[data-page]')) {
      const r = p.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) { setCurrent(Number(p.dataset.page)); break; }
    }
  };
  const btn = { color: '#fff', bgcolor: 'rgba(255,255,255,.12)', '&:hover': { bgcolor: 'rgba(255,255,255,.2)' }, borderRadius: '8px', fontSize: 13, px: 1.25 } as const;
  return (
    <Dialog open onClose={onClose} fullScreen PaperProps={{ sx: { bgcolor: '#0b0b0d', backgroundImage: 'none', color: '#fff', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: 'auto minmax(0, 1fr)', height: 'var(--app-height, 100dvh)', maxHeight: 'var(--app-height, 100dvh)', overflow: 'hidden', border: 0, pt: 'env(safe-area-inset-top)', pb: 'env(safe-area-inset-bottom)', pl: 'env(safe-area-inset-left)', pr: 'env(safe-area-inset-right)' } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1.5, flexShrink: 0 }}>
        <Typography sx={{ flex: 1, fontSize: 13, minWidth: 0 }} noWrap>{t('pdf.page', { page: current, total: doc.numPages })}</Typography>
        <IconButton onClick={() => zoomTo(zoom / 1.4)} disabled={zoom <= MIN_ZOOM} aria-label={t('pdf.zoomOut')} sx={btn}><RemoveRounded fontSize="small" /></IconButton>
        <IconButton onClick={() => zoomTo(zoom * 1.4)} disabled={zoom >= MAX_ZOOM} aria-label={t('pdf.zoomIn')} sx={btn}><AddRounded fontSize="small" /></IconButton>
        <IconButton component="a" href={url} download sx={btn}>{t('media.download')}</IconButton>
        <IconButton onClick={onClose} aria-label={t('common.close')} sx={btn}>✕</IconButton>
      </Box>
      <Box ref={setScroller} onScroll={onScroll} sx={{ overflow: 'auto', minHeight: 0, p: 1, touchAction: 'pan-x pan-y', overscrollBehavior: 'contain' }}>
        <Box ref={inner} sx={{ width: 'max-content', minWidth: '100%', display: 'flex', flexDirection: 'column', alignItems: zoom > 1 ? 'flex-start' : 'center' }}>
          {Array.from({ length: doc.numPages }, (_, i) => <LazyPage key={i} doc={doc} n={i + 1} width={width} ratio={ratio} root={root} />)}
        </Box>
      </Box>
    </Dialog>
  );
}

export default function PdfCard({ pdf, resolve }: { pdf: Pdf; resolve: (src: string) => Resolved }) {
  const r = resolve(pdf.src);
  const url = r.state === 'ok' ? r.url : undefined;
  const d = usePdf(url, r.state === 'error');
  const [page, setPage] = useState(pdf.page);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, [d.state]);
  const count = d.state === 'ok' ? d.doc.numPages : 0;
  const shown = Math.min(Math.max(1, page), count || 1);
  const remote = isHttp(pdf.src);
  return (
    <Box sx={{ my: 1, p: 1.25, border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.default', minWidth: 0 }}>
      {pdf.title && <Typography sx={{ fontWeight: 600, mx: 0.25, mb: 1 }}>{pdf.title}</Typography>}
      {d.state === 'error' ? (
        <Box sx={{ borderRadius: '8px', bgcolor: 'action.hover', border: 1, borderColor: 'divider', aspectRatio: '4 / 3', display: 'grid', placeItems: 'center', alignContent: 'center', gap: 0.5, p: 1, textAlign: 'center', color: 'text.secondary', fontSize: 12 }}>
          <span>{t('pdf.unavailable')}</span>
          {url && <Link href={url} {...(remote ? { target: '_blank', rel: 'noreferrer noopener' } : { download: true })} underline="always" sx={{ color: 'primary.main' }}>{remote ? t('media.open') : t('media.download')}</Link>}
        </Box>
      ) : d.state === 'loading' ? (
        <Box role="status" aria-label={t('pdf.loading')} sx={{ borderRadius: '8px', bgcolor: 'action.hover', border: 1, borderColor: 'divider', aspectRatio: '1 / 1.2' }} />
      ) : (
        <>
          <Box ref={wrap} component="button" type="button" onClick={() => setOpen(true)} aria-label={t('media.open')} sx={{ p: 0, m: 0, display: 'block', width: '100%', border: 1, borderColor: 'divider', borderRadius: '6px', overflow: 'hidden', cursor: 'zoom-in', bgcolor: '#fff', lineHeight: 0 }}>
            <PageCanvas doc={d.doc} n={shown} width={width} />
          </Box>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 0.75, mt: 0.75, color: 'text.secondary', fontSize: 12, '& .MuiButton-root': { whiteSpace: 'nowrap' } }}>
            <Box component="span" sx={{ whiteSpace: 'nowrap' }}>{t('pdf.page', { page: shown, total: count })}</Box>
            {count > 1 && (
              <Box sx={{ display: 'flex', gap: 0.75 }}>
                <Button size="small" variant="outlined" color="inherit" disabled={shown <= 1} aria-label={t('pdf.previous')} onClick={() => setPage(shown - 1)} sx={{ minWidth: 32, px: 0.5, borderColor: 'divider' }}>‹</Button>
                <Button size="small" variant="outlined" color="inherit" disabled={shown >= count} aria-label={t('pdf.next')} onClick={() => setPage(shown + 1)} sx={{ minWidth: 32, px: 0.5, borderColor: 'divider' }}>›</Button>
              </Box>)}
            <Box sx={{ display: 'flex', gap: 0.75 }}>
              <Button size="small" variant="outlined" color="inherit" onClick={() => setOpen(true)} sx={{ borderColor: 'divider' }}>{t('media.open')}</Button>
              {url && <Button size="small" variant="outlined" color="inherit" component="a" href={url} {...(remote ? { target: '_blank', rel: 'noreferrer noopener' } : { download: true })} sx={{ borderColor: 'divider' }}>{t('media.download')}</Button>}
            </Box>
          </Box>
          {open && url && <Viewer doc={d.doc} title={pdf.title} url={url} onClose={() => setOpen(false)} />}
        </>
      )}
    </Box>
  );
}
