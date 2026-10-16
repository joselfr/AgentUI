import { useState } from 'react';

/** Préférences d'interface conservées dans le navigateur (jamais bloquant : localStorage peut être indisponible). */
export const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v === null ? d : (JSON.parse(v) as T); } catch { return d; } };
export const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignoré */ } };

/** État mémorisé dans le navigateur : se lit au montage, s'écrit à chaque changement. */
export function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => load(key, initial));
  return [value, (v: T) => { setValue(v); save(key, v); }];
}
