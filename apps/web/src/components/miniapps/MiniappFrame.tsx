import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, CircularProgress } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { themeCssVars, type MiniApp } from '@agentui/shared';
import { api } from '../../api';
import { getLang, t, useLang } from '../../i18n';
import { sendMedia } from '../widgetMedia';

/** Rejects paths that could escape the app's own backend namespace. */
const safePath = (p: unknown): string | undefined =>
  typeof p === 'string' && !p.split('?')[0]!.split('/').some((s) => s === '..' || s === '.') && !/^[a-z]+:/i.test(p) && !p.startsWith('//') ? p.replace(/^\/+/, '') : undefined;

/** Only web links, mail and phone links may be opened on behalf of a miniapp (no `javascript:`, `data:`, `file:`…). */
const safeUrl = (u: unknown): string | undefined => {
  if (typeof u !== 'string' || u.length > 4096) return undefined;
  try { const p = new URL(u); return ['http:', 'https:', 'mailto:', 'tel:'].includes(p.protocol) ? p.href : undefined; } catch { return undefined; }
};

/**
 * Runs a miniapp in a sandboxed iframe (`allow-scripts` only: opaque origin, no access to the session cookie nor to /api).
 * The only way out is this postMessage bridge: the host replays the app's requests on its own backend namespace
 * (`/api/miniapps/<id>/x/…`) with the user's session, and pushes the theme and language.
 */
export default function MiniappFrame({ app, dataKey = 0 }: { app: MiniApp; dataKey?: number }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const muiTheme = useTheme();
  const lang = useLang() && getLang();
  const mode = muiTheme.palette.mode;
  const [base, setBase] = useState<string>();
  const baseRef = useRef<string>();
  baseRef.current = base;
  const [err, setErr] = useState('');
  const [appError, setAppError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    setBase(undefined); setReady(false); setAppError(''); setErr('');
    api.miniappSession(app.id).then((s) => live && setBase(s.base)).catch((e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [app.id, app.version]);

  const postTheme = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ type: 'agentui:theme', mode, lang, vars: themeCssVars(mode) }, '*');
  }, [mode, lang]);
  useEffect(postTheme, [postTheme]);
  // The app's data changed (agent or another tab): the app refetches what it displays.
  useEffect(() => { if (dataKey) frame.current?.contentWindow?.postMessage({ type: 'agentui:data' }, '*'); }, [dataKey]);

  useEffect(() => {
    const onMsg = async (e: MessageEvent) => {
      const w = frame.current?.contentWindow;
      if (!w || e.source !== w) return;
      const m = e.data as { type?: string; id?: string; method?: string; path?: unknown; body?: unknown } | null;
      if (m?.type === 'agentui:ready') { setReady(true); postTheme(); }
      else if (m?.type === 'agentui:error') setAppError(String((m as { message?: string }).message ?? ''));
      else if (m?.type === 'agentui:media' && typeof m.id === 'string') {
        const name = (m as { name?: unknown }).name;
        // Under the iframe's own token-protected base; `v` makes sure a replaced asset is fetched again.
        void sendMedia(w, m.id, typeof name === 'string' && baseRef.current ? `${baseRef.current}assets/${encodeURIComponent(name)}?v=${Date.now()}` : undefined);
      }
      else if (m?.type === 'agentui:open') {
        const url = safeUrl((m as { url?: unknown }).url);
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
      }
      else if (m?.type === 'agentui:fetch' && typeof m.id === 'string') {
        const path = safePath(m.path);
        const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m.method ?? '') ? m.method! : 'GET';
        const reply = (status: number, body: unknown) => w.postMessage({ type: 'agentui:fetch.result', id: m.id, status, body }, '*');
        if (path === undefined) return reply(400, { error: 'Invalid path' });
        try {
          const res = await fetch(`/api/miniapps/${encodeURIComponent(app.id)}/x/${path}`, {
            method, credentials: 'same-origin',
            headers: { 'X-Requested-With': 'agentui', ...(method === 'GET' || m.body == null ? {} : { 'Content-Type': 'application/json' }) },
            body: method === 'GET' || m.body == null ? undefined : JSON.stringify(m.body),
          });
          const text = await res.text();
          let body: unknown = text;
          try { body = text ? JSON.parse(text) : null; } catch { /* plain text */ }
          reply(res.status, body);
        } catch { reply(0, { error: 'Network error' }); }
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [app.id, postTheme]);

  return (
    <Box sx={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {err && <Alert severity="warning" sx={{ m: 2 }}>{err}</Alert>}
      {!ready && !err && <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}><CircularProgress size={24} /></Box>}
      {base && (
        <iframe ref={frame} key={`${app.id}-${app.version}`} title={app.name} src={base} sandbox="allow-scripts" onLoad={postTheme}
          style={{ flex: 1, width: '100%', border: 0, background: 'transparent', colorScheme: mode }} />)}
      {appError && <Alert severity="error" onClose={() => setAppError('')} sx={{ position: 'absolute', left: 8, right: 8, bottom: 8, whiteSpace: 'pre-wrap', maxHeight: '40%', overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>{t('miniapps.error')}: {appError}</Alert>}
    </Box>
  );
}
