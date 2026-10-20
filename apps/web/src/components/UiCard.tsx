import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, IconButton, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import Close from '@mui/icons-material/Close';
import Send from '@mui/icons-material/Send';
import { themeCssVars, type WidgetEvent } from '@agentui/shared';
import { api } from '../api';
import { getLang, t, useLang } from '../i18n';

interface Ui { code: string; title?: string; maxHeight: number; state?: unknown; token?: string }

const MIN_HEIGHT = 40;
const MAX_HEIGHT = 4000;

/** Arguments of the `ui` widget: `{ code, title?, height?, state? }` (`state`: latest value pushed by the agent). `code` is a TSX module that default-exports a React component. `undefined` if invalid. */
export function parseUi(a: Record<string, unknown>): Ui | undefined {
  if (typeof a.code !== 'string' || !a.code.trim()) return undefined;
  const h = a.height;
  return {
    code: a.code,
    title: typeof a.title === 'string' && a.title.trim() ? a.title.trim() : undefined,
    maxHeight: typeof h === 'number' && isFinite(h) ? Math.min(Math.max(h, 120), MAX_HEIGHT) : 2400,
    state: a.state,
    token: typeof a.token === 'string' ? a.token : undefined,
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
 * send are its size, errors, links to open and `reply` (a message sent in the chat as the user, see below).
 */
export const REPLY_MAX = 2000;
const REPLY_COOLDOWN_MS = 1500;
const TRACES_MAX = 4000;
const MAX_RUNTIME_ERRORS = 5;

const cut = (e: string) => (e.length > 1000 ? `${e.slice(0, 1000)}…` : e); // keeps the context and the request below within the limit

/** Message sent to the agent when its widget fails: everything it needs to debug it (it already has the code in the conversation). */
export function tracesMessage(o: { token?: string; title?: string; build: string[]; runtime: string[]; mode: string; lang: string; width: number }): string {
  const parts = [t('ui.traces.intro', { widget: o.token ?? o.title ?? t('ui.title') })];
  if (o.build.length) parts.push(`${t('ui.traces.build')}\n${o.build.map(cut).join('\n')}`);
  if (o.runtime.length) parts.push(`${t('ui.traces.runtime')}\n${o.runtime.map(cut).join('\n---\n')}`);
  parts.push(`${t('ui.traces.context')} theme=${o.mode}, lang=${o.lang}, width=${o.width}px, ${navigator.userAgent}`);
  parts.push(t('ui.traces.ask'));
  return parts.join('\n\n').slice(0, TRACES_MAX);
}

export default function UiCard({ ui, onReply }: { ui: Ui; onReply?: (text: string, widget?: WidgetEvent) => Promise<boolean> }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const muiTheme = useTheme();
  const lang = useLang() && getLang();
  const mode = muiTheme.palette.mode;
  const [base, setBase] = useState<string>();
  const [errors, setErrors] = useState<string[]>([]);
  const [runtimeErrors, setRuntimeErrors] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(MIN_HEIGHT * 3);
  // Full screen (`requestFullscreen()` in the widget): the SAME iframe is stretched over the viewport, never moved or remounted, so the widget keeps
  // running with its state. The browser's own full screen is requested on top of it when available (not on iPhone: the overlay alone is used).
  const [fs, setFs] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const enterFs = useCallback(() => {
    setFs(true);
    try { void wrap.current?.requestFullscreen?.().catch(() => {}); } catch { /* overlay only */ }
  }, []);
  const leaveFs = useCallback(() => {
    setFs(false);
    try { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); } catch { /* already out */ }
  }, []);
  useEffect(() => {
    if (!fs) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') leaveFs(); };
    const onChange = () => { if (!document.fullscreenElement) setFs(false); }; // Escape in the browser's full screen
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onChange);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('fullscreenchange', onChange); };
  }, [fs, leaveFs]);
  useEffect(() => () => { try { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); } catch { /* unmounted while open */ } }, []);

  useEffect(() => {
    let live = true;
    setBase(undefined); setReady(false); setErrors([]); setRuntimeErrors([]); setSent(false);
    api.buildWidget(ui.code).then((r) => {
      if (!live) return;
      if (r.ok) setBase(r.base);
      else setErrors(r.errors.map((e) => (e.line ? `${e.line}:${e.column ?? 0} ` : '') + e.message));
    }).catch((e) => live && setErrors([(e as Error).message]));
    return () => { live = false; };
  }, [ui.code]);

  const lastReply = useRef(0);
  const token = useRef(ui.token);
  token.current = ui.token;
  const reply = useRef(onReply);
  reply.current = onReply;
  const postChat = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ type: 'agentui:chat', canReply: !!reply.current }, '*');
  }, []);
  useEffect(postChat, [postChat, !!onReply]);

  // State pushed by the agent (`agentui_widget_custom` with `update` + `state`): sent to the running widget, which is neither reloaded nor remounted.
  const state = useRef(ui.state);
  state.current = ui.state;
  const postState = useCallback(() => {
    if (state.current !== undefined) frame.current?.contentWindow?.postMessage({ type: 'agentui:state', state: state.current }, '*');
  }, []);
  const stateJson = JSON.stringify(ui.state) ?? '';
  useEffect(postState, [postState, stateJson]);
  const postFs = useCallback(() => { frame.current?.contentWindow?.postMessage({ type: 'agentui:fullscreen.state', on: fs }, '*'); }, [fs]);
  useEffect(postFs, [postFs]);

  const postTheme = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ type: 'agentui:theme', mode, lang, vars: themeCssVars(mode) }, '*');
  }, [mode, lang]);
  useEffect(postTheme, [postTheme]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const w = frame.current?.contentWindow;
      if (!w || e.source !== w) return;
      const m = e.data as { type?: string; id?: string; height?: unknown; message?: unknown; url?: unknown; text?: unknown; silent?: unknown; on?: unknown } | null;
      if (m?.type === 'agentui:ready') { setReady(true); postTheme(); postChat(); postState(); postFs(); }
      else if (m?.type === 'agentui:fullscreen') {
        if (m.on === true) {
          // Takes over the whole screen, so like `reply` it only follows a click in the widget (the iframe has the focus).
          const allowed = document.activeElement === frame.current;
          if (typeof m.id === 'string') w.postMessage({ type: 'agentui:fullscreen.result', id: m.id, ok: allowed }, '*');
          if (allowed) enterFs();
        } else leaveFs();
      }
      else if (m?.type === 'agentui:resize' && typeof m.height === 'number') setHeight(Math.max(MIN_HEIGHT, Math.min(m.height, ui.maxHeight)));
      else if (m?.type === 'agentui:error') { const msg = String(m.message ?? ''); setSent(false); setRuntimeErrors((p) => (p.includes(msg) ? p : [...p, msg].slice(-MAX_RUNTIME_ERRORS))); }
      else if (m?.type === 'agentui:open') { const url = safeUrl(m.url); if (url) window.open(url, '_blank', 'noopener,noreferrer'); }
      else if (m?.type === 'agentui:reply' && typeof m.id === 'string') {
        // The text goes to the agent as if the user had typed it, so it is only accepted when the user is plausibly the one acting:
        // the iframe has the focus (they clicked in it), the chat is idle, and not more than once every 1.5 s.
        const text = typeof m.text === 'string' ? m.text.trim() : '';
        const now = Date.now();
        const allowed = !!reply.current && !!text && text.length <= REPLY_MAX && document.activeElement === frame.current && now - lastReply.current > REPLY_COOLDOWN_MS;
        const done = (ok: boolean) => w.postMessage({ type: 'agentui:reply.result', id: m.id, ok }, '*');
        if (!allowed) return done(false);
        lastReply.current = now;
        void reply.current!(text, m.silent === true ? { token: token.current } : undefined).then(done, () => done(false));
      }
      else if (m?.type === 'agentui:fetch' && typeof m.id === 'string') w.postMessage({ type: 'agentui:fetch.result', id: m.id, status: 404, body: { error: 'This widget has no backend.' } }, '*');
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [postTheme, postChat, postState, postFs, enterFs, leaveFs, ui.maxHeight]);

  const sendTraces = () => {
    const text = tracesMessage({ token: ui.token, title: ui.title, build: errors, runtime: runtimeErrors, mode, lang, width: Math.round(wrap.current?.clientWidth ?? 0) });
    void onReply?.(text).then((ok) => setSent(ok));
  };
  const tracesButton = onReply && (
    <Button size="small" variant="outlined" startIcon={<Send />} disabled={sent} onClick={sendTraces} sx={{ mt: 1 }}>{sent ? t('ui.traces.sent') : t('ui.traces.send')}</Button>);

  if (errors.length) {
    return (
      <Alert severity="warning" sx={{ my: 1, '& .MuiAlert-message': { minWidth: 0 } }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{t('ui.error')}</Typography>
        <Box component="pre" sx={{ m: 0, mt: 0.5, fontSize: 12, whiteSpace: 'pre-wrap', border: 0, p: 0, bgcolor: 'transparent' }}>{errors.join('\n')}</Box>
        {tracesButton}
      </Alert>
    );
  }
  return (
    <Box sx={{ my: 1 }}>
      {ui.title && <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{ui.title}</Typography>}
      <Box sx={{ height: fs ? height : undefined }}>
      <Box ref={wrap} role={fs ? 'dialog' : undefined} aria-modal={fs || undefined} aria-label={fs ? (ui.title ?? t('ui.title')) : undefined}
        sx={fs ? { position: 'fixed', inset: 0, zIndex: 1300, bgcolor: 'background.default' } : { position: 'relative', minHeight: ready ? 0 : 96 }}>
        {!ready && <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}><CircularProgress size={20} /></Box>}
        {base && <iframe ref={frame} title={ui.title ?? t('ui.title')} src={base} sandbox="allow-scripts" onLoad={() => { postTheme(); postChat(); postState(); }}
          style={{ display: 'block', width: '100%', height: fs ? '100%' : height, border: 0, background: 'transparent', colorScheme: mode, visibility: ready ? 'visible' : 'hidden' }} />}
        {fs && (
          <IconButton onClick={leaveFs} aria-label={t('ui.exitFullscreen')} title={t('ui.exitFullscreen')}
            sx={{ position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 8px)', right: 'calc(env(safe-area-inset-right, 0px) + 8px)', zIndex: 1, bgcolor: (th) => alpha(th.palette.background.paper, 0.75), '&:hover': { bgcolor: 'background.paper' } }}>
            <Close />
          </IconButton>)}
      </Box>
      </Box>
      {runtimeErrors.length > 0 && (
        <Alert severity="error" onClose={() => setRuntimeErrors([])} sx={{ mt: 0.5, '& .MuiAlert-message': { minWidth: 0 } }}>
          <Box sx={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>{runtimeErrors[runtimeErrors.length - 1]}</Box>
          {tracesButton}
        </Alert>)}
    </Box>
  );
}
