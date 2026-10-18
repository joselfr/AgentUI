import { afterEach, describe, expect, it } from 'vitest';
import { fr } from './fr';
import { en } from './en';
import { setLangPref, t } from './index';

afterEach(() => setLangPref('fr'));

describe('i18n', () => {
  it('both languages define the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
  });
  it('interpolates variables', () => {
    setLangPref('en');
    expect(t('composer.placeholder', { agent: 'Bob' })).toBe('Message Bob');
    setLangPref('fr');
    expect(t('composer.placeholder', { agent: 'Bob' })).toBe('Message à Bob');
  });
  it('picks the plural form', () => {
    setLangPref('en');
    expect(t('table.rows', { count: 1 })).toBe('1 row');
    expect(t('table.rows', { count: 3 })).toBe('3 rows');
    setLangPref('fr');
    expect(t('table.rows', { count: 1 })).toBe('1 ligne');
    expect(t('table.rows', { count: 0 })).toBe('0 ligne'); // French treats 0 as singular
  });
  it('plural forms come in pairs', () => {
    for (const k of Object.keys(fr)) if (k.endsWith('_one')) expect(fr).toHaveProperty(k.replace(/_one$/, '_other'));
  });
});
