/** Link with the AgentUI host (parent window): theme, language and authenticated requests to the app backend. */
import { useEffect, useState } from 'react';

export type Mode = 'light' | 'dark';
export interface HostTheme { mode: Mode; lang: string; vars: Record<string, string> }

let theme: HostTheme = { mode: 'dark', lang: (typeof navigator !== 'undefined' && navigator.language?.slice(0, 2)) || 'en', vars: {} };
const subs = new Set<() => void>();

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
    else if (m?.type === 'agentui:fetch.result') {
      const done = pending.get(m.id);
      pending.delete(m.id);
      done?.({ status: m.status, body: m.body });
    }
  });
}

export const toHost = (msg: Record<string, unknown>) => window.parent.postMessage({ ...msg }, '*');

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
  useEffect(() => {
    if (path === null) return;
    let alive = true;
    setLoading(true);
    api.get<T>(path).then((d) => alive && (setData(d), setError(undefined))).catch((e) => alive && setError(e)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, n, ...deps]);
  return { data, error, loading, reload: () => setN((x) => x + 1), setData };
}
