import { beforeEach, describe, expect, it } from 'vitest';
import { cachedBase, codeKey, markWarm, rememberBase, WIDGET_TTL_MS } from './widgetCache';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
});

describe('widgetCache', () => {
  it('has a different key per code', () => {
    expect(codeKey('a')).not.toBe(codeKey('b'));
    expect(codeKey('a')).toBe(codeKey('a'));
  });

  it('gives back the last base for a week', () => {
    rememberBase('code', '/w/h/t1/', 1000);
    rememberBase('code', '/w/h/t2/', 2000);
    expect(cachedBase('code', 3000)).toBe('/w/h/t2/');
    expect(cachedBase('code', 2000 + WIDGET_TTL_MS - 1)).toBe('/w/h/t2/');
    expect(cachedBase('code', 2000 + WIDGET_TTL_MS)).toBeUndefined();
    expect(cachedBase('other', 3000)).toBeUndefined();
  });

  it('asks to fetch the files again at most once a day', () => {
    const day = 24 * 3600 * 1000;
    expect(rememberBase('code', '/w/h/t1/', 0)).toBe(true);
    markWarm('code', 0);
    expect(rememberBase('code', '/w/h/t2/', day - 1)).toBe(false);
    expect(rememberBase('code', '/w/h/t3/', day)).toBe(true);
  });

  it('forgets the entries past their TTL', () => {
    rememberBase('old', '/w/o/t/', 0);
    rememberBase('new', '/w/n/t/', WIDGET_TTL_MS + 1);
    expect([...store.keys()]).toEqual([codeKey('new')]);
  });
});
