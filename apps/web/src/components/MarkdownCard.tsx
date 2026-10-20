import { useEffect, useRef, useState } from 'react';
import { Box, Button, Dialog, IconButton, Link, Typography } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { t } from '../i18n';
import { useBackClose } from '../useBackClose';
import { copyText } from './chat/copy';
import { isHttp, optText, validSrc } from './media';
import type { Resolved } from './ImageCard';

export interface MarkdownDoc { title?: string; content?: string; src?: string }

const MAX_CHARS = 400_000;
const FOLD_PX = 220;

/** Arguments of the `markdown` widget: `{ title?, content? | src? }` (exactly one of the two). `undefined` if invalid. */
export function parseMarkdown(a: Record<string, unknown>): MarkdownDoc | undefined {
  const content = typeof a.content === 'string' && a.content.trim() ? a.content : undefined;
  if ((content !== undefined) === (a.src !== undefined)) return undefined; // neither, or both
  if (content && content.length > MAX_CHARS) return undefined;
  if (a.src !== undefined && !validSrc(a.src)) return undefined;
  return { title: optText(a.title, 120), content, src: a.src as string | undefined };
}

type Source = { state: 'loading' } | { state: 'error' } | { state: 'ok'; text: string };

/** Text of the document: inline, or fetched from the attachment (same origin) / the URL (if its server allows CORS). */
function useSource(doc: MarkdownDoc, resolve: (src: string) => Resolved): Source {
  const r = doc.src ? resolve(doc.src) : undefined;
  const url = r?.state === 'ok' ? r.url : undefined;
  const [s, setS] = useState<Source>(doc.content !== undefined ? { state: 'ok', text: doc.content } : { state: 'loading' });
  useEffect(() => {
    if (doc.content !== undefined) { setS({ state: 'ok', text: doc.content }); return; }
    if (r?.state === 'error') { setS({ state: 'error' }); return; }
    if (!url) { setS({ state: 'loading' }); return; }
    const ctl = new AbortController();
    setS({ state: 'loading' });
    fetch(url, { signal: ctl.signal, referrerPolicy: 'no-referrer' })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((text) => setS({ state: 'ok', text: text.slice(0, MAX_CHARS) }), () => { if (!ctl.signal.aborted) setS({ state: 'error' }); });
    return () => ctl.abort();
  }, [doc.content, url, r?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  return s;
}

function Rendered({ text }: { text: string }) {
  return (
    <Box sx={{
      overflowWrap: 'anywhere', '& > :first-of-type': { mt: 0 }, '& > :last-child': { mb: 0 }, '& p': { my: 0.75 }, '& a': { color: 'primary.main' },
      '& pre': { overflow: 'auto', p: 1.5, borderRadius: 2, bgcolor: 'action.hover', border: 1, borderColor: 'divider', fontSize: 13 },
      '& :not(pre) > code': { px: 0.6, py: 0.15, borderRadius: 1, bgcolor: 'action.selected', fontSize: '0.88em' },
      '& table': { borderCollapse: 'collapse', display: 'block', maxWidth: '100%', overflowX: 'auto' }, '& th, & td': { border: 1, borderColor: 'divider', px: 1, py: 0.5 },
      '& img': { maxWidth: '100%' }, '& blockquote': { m: 0, pl: 1.5, borderLeft: 3, borderColor: 'divider', color: 'text.secondary' },
    }}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ a: ({ node: _n, ...a }) => <a {...a} target="_blank" rel="noreferrer noopener" /> }}>{text}</ReactMarkdown>
    </Box>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Full({ doc, text, onClose }: { doc: MarkdownDoc; text: string; onClose: () => void }) {
  useBackClose(true, onClose);
  return (
    <Dialog open onClose={onClose} fullScreen PaperProps={{ sx: { display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', height: 'var(--app-height, 100dvh)', maxHeight: 'var(--app-height, 100dvh)', overflow: 'hidden', pt: 'env(safe-area-inset-top)', pb: 'env(safe-area-inset-bottom)' } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1.5, borderBottom: 1, borderColor: 'divider' }}>
        <Typography sx={{ flex: 1, fontWeight: 600, minWidth: 0 }} noWrap>{doc.title ?? ''}</Typography>
        <IconButton onClick={onClose} aria-label={t('common.close')}>✕</IconButton>
      </Box>
      <Box sx={{ overflow: 'auto', p: 2, minHeight: 0 }}><Box sx={{ maxWidth: 820, mx: 'auto' }}><Rendered text={text} /></Box></Box>
    </Dialog>
  );
}

export default function MarkdownCard({ doc, resolve }: { doc: MarkdownDoc; resolve: (src: string) => Resolved }) {
  const s = useSource(doc, resolve);
  const body = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (s.state === 'ok' && body.current) setTall(body.current.scrollHeight > FOLD_PX + 24); }, [s]);
  const r = doc.src ? resolve(doc.src) : undefined;
  const name = doc.title ?? decodeURIComponent((doc.src ?? 'document').split('/').pop() ?? 'document');
  return (
    <Box sx={{ my: 1, p: 1.25, border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.default', minWidth: 0 }}>
      {s.state === 'error' ? (
        <Box sx={{ display: 'grid', placeItems: 'center', gap: 0.5, py: 2, color: 'text.secondary', fontSize: 12, textAlign: 'center' }}>
          <span>{t('markdown.unavailable')}</span>
          {r?.state === 'ok' && <Link href={r.url} {...(doc.src && isHttp(doc.src) ? { target: '_blank', rel: 'noreferrer noopener' } : { download: true })} underline="always" sx={{ color: 'primary.main' }}>{doc.src && isHttp(doc.src) ? t('media.open') : t('media.download')}</Link>}
        </Box>
      ) : (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mx: 0.25, mb: 0.75 }}>
            <Typography sx={{ flex: 1, fontWeight: 600, minWidth: 0 }} noWrap>{doc.title ?? ''}</Typography>
            {s.state === 'ok' && <>
              <Button size="small" variant="outlined" color="inherit" onClick={() => void copyText(s.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })} sx={{ borderColor: 'divider', minWidth: 0, px: 1 }}>{copied ? t('markdown.copied') : t('markdown.copy')}</Button>
              <Button size="small" variant="outlined" color="inherit" onClick={() => download(/\.(md|markdown)$/i.test(name) ? name : `${name}.md`, s.text)} sx={{ borderColor: 'divider', minWidth: 0, px: 1 }}>.md</Button>
            </>}
          </Box>
          {s.state === 'loading' ? <Box sx={{ height: 90, borderRadius: '8px', bgcolor: 'action.hover' }} /> : (
            <Box sx={{ position: 'relative' }}>
              <Box ref={body} sx={{ px: 0.5, maxHeight: tall ? FOLD_PX : undefined, overflow: 'hidden' }}><Rendered text={s.text} /></Box>
              {tall && <Box sx={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 56, pointerEvents: 'none', background: (th) => `linear-gradient(transparent, ${th.palette.background.default})` }} />}
            </Box>)}
          {tall && s.state === 'ok' && <Button size="small" variant="outlined" color="inherit" onClick={() => setOpen(true)} sx={{ mt: 1, borderColor: 'divider' }}>{t('markdown.showAll')}</Button>}
          {open && s.state === 'ok' && <Full doc={{ ...doc, title: doc.title ?? name }} text={s.text} onClose={() => setOpen(false)} />}
        </>
      )}
    </Box>
  );
}
