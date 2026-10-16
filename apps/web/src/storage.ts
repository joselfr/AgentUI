/** Préférences d'interface conservées dans le navigateur (jamais bloquant : localStorage peut être indisponible). */
export const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v === null ? d : (JSON.parse(v) as T); } catch { return d; } };
export const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignoré */ } };
