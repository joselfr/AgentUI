import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Dialog, IconButton, Link, Typography } from '@mui/material';
import { alpha, keyframes } from '@mui/material/styles';
import { useBackClose } from '../useBackClose';
import { t } from '../i18n';

interface Img { src: string; caption?: string; alt?: string }
interface Gallery { title?: string; images: Img[] }
/** Résolution d'une source : URL à afficher, chargement en cours (fichier local pas encore copié), ou indisponible. */
export type Resolved = { state: 'ok'; url: string } | { state: 'loading' } | { state: 'error' };

const MAX_IMAGES = 12;
const MAX_TILES = 6; // au-delà, la dernière vignette porte « +N »
export const isRemote = (src: string) => /^https?:\/\//i.test(src);

/** Arguments du widget `image` : `{ title?, images: [{ src, caption?, alt? }] }` ; `src` : URL http(s) ou chemin absolu. `undefined` si invalide. */
export function parseImage(a: Record<string, unknown>): Gallery | undefined {
  const { images } = a as { images?: unknown };
  if (!Array.isArray(images) || !images.length || images.length > MAX_IMAGES) return undefined;
  const out: Img[] = [];
  for (const i of images as Array<Record<string, unknown>>) {
    if (!i || typeof i.src !== 'string' || !(isRemote(i.src) || i.src.startsWith('/'))) return undefined;
    out.push({ src: i.src, ...(typeof i.caption === 'string' && i.caption ? { caption: i.caption } : {}), ...(typeof i.alt === 'string' && i.alt ? { alt: i.alt } : {}) });
  }
  return { ...(typeof a.title === 'string' && a.title ? { title: a.title } : {}), images: out };
}

const pulse = keyframes`0% { background-position: 200% 0; } 100% { background-position: -200% 0; }`;
const host = (src: string) => { try { return new URL(src).hostname; } catch { return ''; } };

function Tile({ img, r, onOpen, last, more, single }: { img: Img; r: Resolved; onOpen: () => void; last: boolean; more: number; single: boolean }) {
  const [broken, setBroken] = useState(false);
  const failed = r.state === 'error' || broken;
  const frame = { position: 'relative', borderRadius: '8px', overflow: 'hidden', bgcolor: 'action.hover', border: 1, borderColor: 'divider', aspectRatio: single ? undefined : '4 / 3' } as const;
  if (r.state === 'loading') {
    return <Box sx={{ ...frame, aspectRatio: single ? '4 / 3' : '4 / 3', backgroundImage: (t) => `linear-gradient(90deg, transparent, ${alpha(t.palette.text.secondary, 0.18)}, transparent)`, backgroundSize: '200% 100%', animation: `${pulse} 1.4s ease-in-out infinite`, '@media (prefers-reduced-motion: reduce)': { animation: 'none' } }} />;
  }
  if (failed) {
    return (
      <Box sx={{ ...frame, aspectRatio: '4 / 3', display: 'grid', placeItems: 'center', alignContent: 'center', gap: 0.5, p: 1, textAlign: 'center', color: 'text.secondary', fontSize: 12 }}>
        <span>{t('image.unavailable')}</span>
        {isRemote(img.src) && <Link href={img.src} target="_blank" rel="noreferrer noopener" underline="always" sx={{ color: 'primary.main' }}>{t('image.open')}</Link>}
      </Box>
    );
  }
  return (
    <Box component="button" type="button" onClick={onOpen} aria-label={img.alt ?? img.caption ?? t('chat.enlarge')}
      sx={{ ...frame, p: 0, m: 0, cursor: 'zoom-in', display: 'block', width: '100%', font: 'inherit', color: 'inherit', ...(single && { maxHeight: 340 }) }}>
      <img src={r.state === 'ok' ? r.url : ''} alt={img.alt ?? img.caption ?? ''} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)}
        style={{ width: '100%', height: single ? 'auto' : '100%', maxHeight: single ? 340 : undefined, objectFit: single ? 'contain' : 'cover', display: 'block' }} />
      {isRemote(img.src) && !last && (
        <Box component="span" sx={{ position: 'absolute', left: 6, bottom: 6, bgcolor: 'rgba(0,0,0,.55)', color: '#fff', borderRadius: '6px', px: 0.75, fontSize: 11 }}>{host(img.src)}</Box>
      )}
      {last && <Box component="span" sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', bgcolor: 'rgba(0,0,0,.55)', color: '#fff', fontSize: 22, fontWeight: 600 }}>+{more}</Box>}
    </Box>
  );
}

function Lightbox({ gallery, resolve, index, onIndex, onClose }: { gallery: Gallery; resolve: (src: string) => Resolved; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  useBackClose(true, onClose);
  const n = gallery.images.length;
  const img = gallery.images[index]!;
  const r = resolve(img.src);
  const go = useCallback((d: number) => onIndex((index + d + n) % n), [index, n, onIndex]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [go]);
  const touch = useRef<number | null>(null);
  const url = r.state === 'ok' ? r.url : undefined;
  const btn = { color: '#fff', bgcolor: 'rgba(255,255,255,.12)', '&:hover': { bgcolor: 'rgba(255,255,255,.2)' }, borderRadius: '8px', fontSize: 13, px: 1.25 } as const;
  return (
    <Dialog open onClose={onClose} fullScreen PaperProps={{ sx: { bgcolor: 'rgba(0,0,0,.92)', backgroundImage: 'none', color: '#fff', display: 'grid', gridTemplateRows: 'auto 1fr auto', border: 0 } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1.5 }}>
        <Typography sx={{ flex: 1, fontSize: 13, minWidth: 0 }} noWrap>{n > 1 ? `${index + 1} / ${n}` : ''}{n > 1 && img.caption ? ' — ' : ''}{img.caption}</Typography>
        {isRemote(img.src) && <IconButton component="a" href={img.src} target="_blank" rel="noreferrer noopener" sx={btn}>{t('image.open')}</IconButton>}
        {url && <IconButton component="a" href={url} download sx={btn}>{t('image.download')}</IconButton>}
        <IconButton onClick={onClose} aria-label={t('common.close')} sx={btn}>✕</IconButton>
      </Box>
      <Box sx={{ position: 'relative', display: 'grid', placeItems: 'center', minHeight: 0, p: 1 }}
        onTouchStart={(e) => { touch.current = e.touches[0]!.clientX; }}
        onTouchEnd={(e) => { if (touch.current === null) return; const dx = e.changedTouches[0]!.clientX - touch.current; touch.current = null; if (Math.abs(dx) > 50 && n > 1) go(dx < 0 ? 1 : -1); }}>
        {url ? <img src={url} alt={img.alt ?? img.caption ?? ''} referrerPolicy="no-referrer" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <Typography color="inherit" sx={{ opacity: 0.7 }}>{t('image.unavailable')}</Typography>}
        {n > 1 && (<>
          <IconButton onClick={() => go(-1)} aria-label={t('image.previous')} sx={{ ...btn, position: 'absolute', left: 8, top: '50%', fontSize: 22 }}>‹</IconButton>
          <IconButton onClick={() => go(1)} aria-label={t('image.next')} sx={{ ...btn, position: 'absolute', right: 8, top: '50%', fontSize: 22 }}>›</IconButton>
        </>)}
      </Box>
      <Typography sx={{ textAlign: 'center', p: 1.5, fontSize: 13, minHeight: 24 }}>{img.caption}</Typography>
    </Dialog>
  );
}

export default function ImageCard({ gallery, resolve }: { gallery: Gallery; resolve: (src: string) => Resolved }) {
  const [open, setOpen] = useState<number | null>(null);
  const n = gallery.images.length;
  const cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
  const shown = Math.min(n, MAX_TILES);
  const captions = gallery.images.filter((i) => i.caption);
  const caption = cols === 1 ? captions[0]?.caption : `${captions.slice(0, 2).map((i) => i.caption).join(' · ')}${captions.length > 2 ? ' …' : ''}`;
  return (
    <Box sx={{ my: 1, p: 1.25, border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.default', minWidth: 0 }}>
      {gallery.title && <Typography sx={{ fontWeight: 600, mx: 0.25, mb: 1 }}>{gallery.title}</Typography>}
      <Box sx={{ display: 'grid', gap: 0.75, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {gallery.images.slice(0, shown).map((img, i) => (
          <Tile key={i} img={img} r={resolve(img.src)} single={cols === 1} last={n > MAX_TILES && i === shown - 1} more={n - shown + 1} onOpen={() => setOpen(i)} />
        ))}
      </Box>
      {caption && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mx: 0.25, mt: 0.5 }}>{caption}</Typography>}
      {open !== null && <Lightbox gallery={gallery} resolve={resolve} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </Box>
  );
}
