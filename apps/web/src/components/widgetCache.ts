import { load, save } from '../storage';

/** How long a widget stays available offline (also the lifetime of its files in the service worker's cache, see sw.ts). */
export const WIDGET_TTL_MS = 7 * 24 * 3600 * 1000;

const PREFIX = 'widget-base:';
interface Entry { base: string; at: number; warm?: number }

/** Short, stable key for a widget's code (FNV-1a, 32 bits + length): the code itself can be large. */
export function codeKey(code: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${PREFIX}${(h >>> 0).toString(36)}.${code.length.toString(36)}`;
}

/** A widget's files are fetched again for the offline cache at most once a day. */
const WARM_EVERY_MS = 24 * 3600 * 1000;

/**
 * Remembers where the server served this widget from, to open it again without the server.
 * Tells whether its files have to be (re)fetched into the offline cache now.
 */
export function rememberBase(code: string, base: string, now = Date.now()): boolean {
  const prev = load<Entry | null>(codeKey(code), null);
  const fresh = prev?.warm !== undefined && now - prev.warm < WARM_EVERY_MS;
  save(codeKey(code), { base, at: now, ...(fresh ? { warm: prev!.warm } : {}) } satisfies Entry);
  prune(now);
  return !fresh;
}

/** The files of this widget are in the offline cache (called once they have been fetched). */
export function markWarm(code: string, now = Date.now()): void {
  const e = load<Entry | null>(codeKey(code), null);
  if (e) save(codeKey(code), { ...e, warm: now } satisfies Entry);
}

/** Last known base of this widget, if it is less than a week old. The token inside may have expired: the service worker ignores it. */
export function cachedBase(code: string, now = Date.now()): string | undefined {
  const e = load<Entry | null>(codeKey(code), null);
  return e && typeof e.base === 'string' && now - e.at < WIDGET_TTL_MS ? e.base : undefined;
}

/** Drops the entries past their TTL so localStorage does not grow forever. */
function prune(now: number): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      const e = load<Entry | null>(k, null);
      if (!e || now - e.at >= WIDGET_TTL_MS) localStorage.removeItem(k);
    }
  } catch { /* storage unavailable */ }
}
