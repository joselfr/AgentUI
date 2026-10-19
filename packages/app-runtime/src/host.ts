/** Link with the AgentUI host (parent window): theme, language and authenticated requests to the app backend. */
import { useEffect, useRef, useState } from 'react';

export type Mode = 'light' | 'dark';
export interface HostTheme { mode: Mode; lang: string; vars: Record<string, string> }

let theme: HostTheme = { mode: 'dark', lang: (typeof navigator !== 'undefined' && navigator.language?.slice(0, 2)) || 'en', vars: {} };
const subs = new Set<() => void>();
const dataSubs = new Set<() => void>();
const chatSubs = new Set<() => void>();
const replies = new Map<string, (ok: boolean) => void>();
let canReplyNow = false;
let agentState: unknown;
let fullscreenOn = false;
const fullscreenSubs = new Set<() => void>();
const stateSubs = new Set<() => void>();

function applyTheme(t: HostTheme) {
  theme = t;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  root.style.colorScheme = t.mode;
  root.lang = t.lang;
  subs.forEach((f) => f());
}

const pending = new Map<string, (r: { status: number; body: unknown }) => void>();
let seq = 0;

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    const m = e.data as { type?: string; [k: string]: any } | null;
    if (m?.type === 'agentui:theme') applyTheme({ mode: m.mode, lang: m.lang, vars: m.vars ?? {} });
    else if (m?.type === 'agentui:data') dataSubs.forEach((f) => f());
    else if (m?.type === 'agentui:chat') { canReplyNow = !!m.canReply; chatSubs.forEach((f) => f()); }
    else if (m?.type === 'agentui:fullscreen.state') {
      fullscreenOn = !!m.on;
      document.documentElement.classList.toggle('au-fullscreen', fullscreenOn);
      fullscreenSubs.forEach((f) => f());
    }
    else if (m?.type === 'agentui:fullscreen.result') { const done = replies.get(m.id); replies.delete(m.id); done?.(!!m.ok); }
    else if (m?.type === 'agentui:state') { agentState = m.state; stateSubs.forEach((f) => f()); }
    else if (m?.type === 'agentui:reply.result') { const done = replies.get(m.id); replies.delete(m.id); done?.(!!m.ok); }
    else if (m?.type === 'agentui:fetch.result') {
      const done = pending.get(m.id);
      pending.delete(m.id);
      done?.({ status: m.status, body: m.body });
    }
  });
}

// Escape leaves the full screen even though the keyboard focus is inside the widget (the host only sees keys typed outside the iframe).
if (typeof window !== 'undefined') window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && fullscreenOn) toHost({ type: 'agentui:fullscreen', on: false }); });

export const toHost = (msg: Record<string, unknown>) => window.parent.postMessage({ ...msg }, '*');

/**
 * Opens a link in a new browser tab. The iframe is sandboxed (no `allow-popups`), so `window.open` and `target="_blank"`
 * are blocked: the host opens the URL for us. Only `http(s):`, `mailto:` and `tel:` are accepted. Call it from a click handler.
 */
export const openUrl = (url: string) => toHost({ type: 'agentui:open', url: String(url) });

if (typeof window !== 'undefined') {
  // Make `window.open(url)` and `<a target="_blank">` work transparently through the host.
  window.open = ((url?: string | URL) => { if (url) openUrl(String(new URL(String(url), document.baseURI))); return null; }) as typeof window.open;
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || e.defaultPrevented || e.button !== 0) return;
    const external = a.target === '_blank' || /^(https?:|mailto:|tel:)/i.test(a.getAttribute('href') ?? '');
    if (!external) return;
    e.preventDefault();
    openUrl(a.href);
  });
}

/**
 * Sends `text` in the chat as the user's next message (chat widgets, `agentui_widget_custom` only: miniapps have no chat). It answers `true`
 * once sent, `false` when it was refused: the agent is busy, the click did not come from the user, the text is empty or over
 * 2000 characters. Call it from a click handler, e.g. `<Button onClick={() => reply(`Tell me more about ${offer.name}`)}>Details</Button>`.
 * With `{ silent: true }` the message reaches the agent but is not shown in the chat: use it for the moves of a game or any
 * exchange that happens inside the widget; the agent answers by pushing a new state (`useAgentState`).
 */
export function reply(text: string, opts?: { silent?: boolean }): Promise<boolean> {
  const id = `p${++seq}`;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { replies.delete(id); resolve(false); }, 5000);
    replies.set(id, (ok) => { clearTimeout(timer); resolve(ok); });
    toHost({ type: 'agentui:reply', id, text: String(text), ...(opts?.silent ? { silent: true } : {}) });
  });
}

/**
 * Latest state the agent pushed to this widget (`agentui_widget_custom` called with `update` + `state`), `initial` until the first one.
 * The widget is not reloaded between two states: its own React state (selection, animation…) is kept.
 */
export function useAgentState<T = unknown>(initial?: T): T | undefined {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    stateSubs.add(f);
    return () => { stateSubs.delete(f); };
  }, []);
  return (agentState === undefined ? initial : agentState) as T | undefined;
}

/**
 * Width in px available to the widget (the width of its iframe, i.e. of the chat bubble: about 250-330 px on a phone, up to ~700 px on a desktop).
 * Updates when it changes (rotation, window resize). Size canvases and boards with it instead of a fixed width, which would be cut on a phone.
 */
export function useWidth(): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 0 : document.documentElement.clientWidth));
  useEffect(() => {
    const f = () => setW(document.documentElement.clientWidth);
    f();
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);
  return w;
}

/**
 * Opens this widget over the whole screen (chat widgets, `agentui_widget_custom` only: miniapps already have their own page). The same component
 * keeps running, nothing is reloaded: its state, timers and canvas stay as they are, only its size changes (see `useWidth` / `useHeight`).
 * It answers `true` once open, `false` when refused: the user did not just click in the widget (call it from a click handler), or the widget is
 * not displayed in a chat. The host draws a close button above the widget, and Escape closes it too.
 */
export function requestFullscreen(): Promise<boolean> {
  const id = `f${++seq}`;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { replies.delete(id); resolve(false); }, 5000);
    replies.set(id, (ok) => { clearTimeout(timer); resolve(ok); });
    toHost({ type: 'agentui:fullscreen', id, on: true });
  });
}

/** Back to the chat (no-op when the widget is not in full screen). */
export function exitFullscreen(): void { toHost({ type: 'agentui:fullscreen', on: false }); }

/** `true` while the widget is over the whole screen: switch to a layout that uses all the room (`useWidth()` and `useHeight()` give it). */
export function useFullscreen(): boolean {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    fullscreenSubs.add(f);
    return () => { fullscreenSubs.delete(f); };
  }, []);
  return fullscreenOn;
}

/** Height in px of the screen area given to the widget while it is in full screen, `undefined` otherwise (in the chat it is sized to its content). */
export function useHeight(): number | undefined {
  const full = useFullscreen();
  const [h, setH] = useState(() => (typeof window === 'undefined' ? 0 : window.innerHeight));
  useEffect(() => {
    const f = () => setH(window.innerHeight);
    f();
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);
  return full ? h : undefined;
}

/** `false` while the agent is working (a `reply` would be refused): disable the buttons that call it. */
export function useCanReply(): boolean {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    chatSubs.add(f);
    return () => { chatSubs.delete(f); };
  }, []);
  return canReplyNow;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const id = `r${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new ApiError('Request timed out', 0, null)); }, 30_000);
    pending.set(id, ({ status, body }) => {
      clearTimeout(timer);
      if (status >= 200 && status < 300) resolve(body as T);
      else reject(new ApiError(((body as { error?: string } | null)?.error) ?? `HTTP ${status}`, status, body));
    });
    toHost({ type: 'agentui:fetch', id, method, path: path.replace(/^\/+/, ''), body: body ?? null });
  });
}

/** Calls the app backend (`server/*.js`) through the host, which adds the user's session. Paths are relative to the app: `api.get('todos')`. */
export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T = any>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T = any>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T = any>(path: string) => request<T>('DELETE', path),
};

/** Current theme (`mode`, `lang`) of the host; re-renders when it changes. */
export function useTheme(): HostTheme {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    return () => { subs.delete(f); };
  }, []);
  return theme;
}

/** Calls `f` when the app's data changed outside this iframe (agent tool, cron, another device). Returns the unsubscribe. */
export const onDataChange = (f: () => void) => { dataSubs.add(f); return () => { dataSubs.delete(f); }; };

/** UI language of AgentUI (`fr`, `en`…). */
export const useLang = (): string => useTheme().lang;
export const getTheme = () => theme;
export const onTheme = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** Loads `path` from the backend; `reload()` refetches. */
export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(path !== null);
  const [n, setN] = useState(0);
  const [quiet, setQuiet] = useState(0);
  const silent = useRef(false); // refetch after an external data change: no spinner
  useEffect(() => (path === null ? undefined : onDataChange(() => { silent.current = true; setQuiet((x) => x + 1); })), [path]);
  useEffect(() => {
    if (path === null) return;
    let alive = true;
    if (!silent.current) setLoading(true);
    silent.current = false;
    api.get<T>(path).then((d) => alive && (setData(d), setError(undefined))).catch((e) => alive && setError(e)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, n, quiet, ...deps]);
  return { data, error, loading, reload: () => setN((x) => x + 1), setData };
}
