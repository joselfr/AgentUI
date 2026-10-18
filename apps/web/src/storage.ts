import { useState } from 'react';

/** UI preferences kept in the browser (never blocking: localStorage may be unavailable). */
export const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v === null ? d : (JSON.parse(v) as T); } catch { return d; } };
export const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignored */ } };

/** State remembered in the browser: read on mount, written on every change. */
export function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => load(key, initial));
  return [value, (v: T) => { setValue(v); save(key, v); }];
}
