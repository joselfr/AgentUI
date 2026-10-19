import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, CircularProgress, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { themeCssVars } from '@agentui/shared';
import { api } from '../api';
import { getLang, t, useLang } from '../i18n';

interface Ui { code: string; title?: string; maxHeight: number }

const MIN_HEIGHT = 40;
const MAX_HEIGHT = 1200;

/** Arguments of the `ui` widget: `{ code, title?, height? }`. `code` is a TSX module that default-exports a React component. `undefined` if invalid. */
export function parseUi(a: Record<string, unknown>): Ui | undefined {
  if (typeof a.code !== 'string' || !a.code.trim()) return undefined;
  const h = a.height;
  return {
    code: a.code,
    title: typeof a.title === 'string' && a.title.trim() ? a.title.trim() : undefined,
    maxHeight: typeof h === 'number' && isFinite(h) ? Math.min(Math.max(h, 120), MAX_HEIGHT) : 640,
  };
}

/** Only web links, mail and phone links may be opened on behalf of a widget (no `javascript:`, `data:`, `file:`…). */
const safeUrl = (u: unknown): string | undefined => {
  if (typeof u !== 'string' || u.length > 4096) return undefined;
  try { const p = new URL(u); return ['http:', 'https:', 'mailto:', 'tel:'].includes(p.protocol) ? p.href : undefined; } catch { return undefined; }
};

/**
 * Dynamic widget written by the agent: its code is compiled by the server and runs in a sandboxed iframe (`allow-scripts` only,
 * opaque origin) with the miniapps runtime (`@agentui/ui`, themed by the host). It has no backend: the only messages it can
 * send are its size, errors and links to open.
 */
export default function UiCard({ ui }: { ui: Ui }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const muiTheme = useTheme();
  const lang = useLang() && getLang();
  const mode = muiTheme.palette.mode;
  const [base, setBase] = useState<string>();
  const [errors, setErrors] = useState<string[]>([]);
  const [runtimeError, setRuntimeError] = useState('');
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(MIN_HEIGHT * 3);

  useEffect(() => {
    let live = true;
    setBase(undefined); setReady(false); setErrors([]); setRuntimeError('');
    api.buildWidget(ui.code).then((r) => {
      if (!live) return;
      if (r.ok) setBase(r.base);
      else setErrors(r.errors.map((e) => (e.line ? `${e.line}:${e.column ?? 0} ` : '') + e.message));
    }).catch((e) => live && setErrors([(e as Error).message]));
    return () => { live = false; };
  }, [ui.code]);

  const postTheme = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ type: 'agentui:theme', mode, lang, vars: themeCssVars(mode) }, '*');
  }, [mode, lang]);
  useEffect(postTheme, [postTheme]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const w = frame.current?.contentWindow;
      if (!w || e.source !== w) return;
      const m = e.data as { type?: string; id?: string; height?: unknown; message?: unknown; url?: unknown } | null;
      if (m?.type === 'agentui:ready') { setReady(true); postTheme(); }
      else if (m?.type === 'agentui:resize' && typeof m.height === 'number') setHeight(Math.max(MIN_HEIGHT, Math.min(m.height, ui.maxHeight)));
      else if (m?.type === 'agentui:error') setRuntimeError(String(m.message ?? ''));
      else if (m?.type === 'agentui:open') { const url = safeUrl(m.url); if (url) window.open(url, '_blank', 'noopener,noreferrer'); }
      else if (m?.type === 'agentui:fetch' && typeof m.id === 'string') w.postMessage({ type: 'agentui:fetch.result', id: m.id, status: 404, body: { error: 'This widget has no backend.' } }, '*');
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [postTheme, ui.maxHeight]);

  if (errors.length) {
    return (
      <Alert severity="warning" sx={{ my: 1, '& .MuiAlert-message': { minWidth: 0 } }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{t('ui.error')}</Typography>
        <Box component="pre" sx={{ m: 0, mt: 0.5, fontSize: 12, whiteSpace: 'pre-wrap', border: 0, p: 0, bgcolor: 'transparent' }}>{errors.join('\n')}</Box>
      </Alert>
    );
  }
  return (
    <Box sx={{ my: 1 }}>
      {ui.title && <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{ui.title}</Typography>}
      <Box sx={{ position: 'relative', minHeight: ready ? 0 : 96 }}>
        {!ready && <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}><CircularProgress size={20} /></Box>}
        {base && <iframe ref={frame} title={ui.title ?? t('ui.title')} src={base} sandbox="allow-scripts" onLoad={postTheme}
          style={{ display: 'block', width: '100%', height, border: 0, background: 'transparent', colorScheme: mode, visibility: ready ? 'visible' : 'hidden' }} />}
      </Box>
      {runtimeError && <Alert severity="error" onClose={() => setRuntimeError('')} sx={{ mt: 0.5, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>{runtimeError}</Alert>}
    </Box>
  );
}
