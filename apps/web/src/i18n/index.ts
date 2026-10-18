import { useSyncExternalStore } from 'react';
import { load, save } from '../storage';
import { fr, type FullKey } from './fr';
import { en } from './en';

export type Lang = 'fr' | 'en';
export type LangPref = 'auto' | Lang;
/** Clés de traduction ; les formes plurielles (`_one` / `_other`) sont désignées par leur base. */
export type Key = FullKey extends infer K ? (K extends `${infer B}_${'one' | 'other'}` ? B : K) : never;

const dicts: Record<Lang, Record<FullKey, string>> = { fr, en };
export const LANGS: Lang[] = ['fr', 'en'];
const LOCALES: Record<Lang, string> = { fr: 'fr-FR', en: 'en-US' };

/** Langue du navigateur parmi celles gérées (français par défaut). */
const detect = (): Lang => {
  const prefs = typeof navigator === 'undefined' ? [] : (navigator.languages?.length ? navigator.languages : [navigator.language]);
  for (const p of prefs) { const l = p?.slice(0, 2).toLowerCase(); if (l === 'fr' || l === 'en') return l; }
  return 'fr';
};

let pref: LangPref = load<LangPref>('lang', 'auto');
if (pref !== 'auto' && !LANGS.includes(pref)) pref = 'auto';
let lang: Lang = pref === 'auto' ? detect() : pref;
const listeners = new Set<() => void>();
const apply = () => {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  // Le manifeste PWA est un fichier statique : une variante par langue, le <link> pointe sur celle qui convient
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (link) link.href = lang === 'en' ? '/manifest.en.webmanifest' : '/manifest.webmanifest';
};
apply();

export const setLangPref = (p: LangPref) => {
  pref = p; lang = p === 'auto' ? detect() : p;
  save('lang', p); apply();
  listeners.forEach((l) => l());
};

/** Réabonne le composant aux changements de langue (le composant racine l'appelle : tout l'arbre se redessine). */
export const useLang = () => {
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => lang);
  return { lang, pref };
};

export const getLang = () => lang;
export const locale = () => LOCALES[lang];

/** Traduit une clé ; `{nom}` est remplacé par `vars.nom`. Avec `count`, choisit la forme plurielle (`clé_one` / `clé_other`). */
export function t(key: Key, vars: Record<string, string | number> = {}): string {
  const d = dicts[lang];
  let k: string = key;
  if (typeof vars.count === 'number') {
    const form = `${key}_${new Intl.PluralRules(locale()).select(vars.count)}`;
    k = form in d ? form : `${key}_other`;
  }
  const s = (d as Record<string, string>)[k] ?? (fr as Record<string, string>)[k] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, n: string) => String(vars[n] ?? `{${n}}`));
}

export const fmtNumber = (v: number, maximumFractionDigits: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits }).format(v);
export const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(locale());
export const fmtDateTime = (ms: number, opts?: Intl.DateTimeFormatOptions) => new Date(ms).toLocaleString(locale(), opts);
/** Décimale à la française ou à l'anglaise : 3.2 → « 3,2 » / « 3.2 ». */
export const fmtDecimal = (v: number) => v.toFixed(1).replace('.', lang === 'fr' ? ',' : '.');
