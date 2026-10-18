import { afterEach, describe, expect, it } from 'vitest';
import { fr } from './fr';
import { en } from './en';
import { setLangPref, t } from './index';

afterEach(() => setLangPref('fr'));

describe('i18n', () => {
  it('les deux langues définissent les mêmes clés', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
  });
  it('interpole les variables', () => {
    setLangPref('en');
    expect(t('composer.placeholder', { agent: 'Bob' })).toBe('Message Bob');
    setLangPref('fr');
    expect(t('composer.placeholder', { agent: 'Bob' })).toBe('Message à Bob');
  });
  it('choisit la forme plurielle', () => {
    setLangPref('en');
    expect(t('table.rows', { count: 1 })).toBe('1 row');
    expect(t('table.rows', { count: 3 })).toBe('3 rows');
    setLangPref('fr');
    expect(t('table.rows', { count: 1 })).toBe('1 ligne');
    expect(t('table.rows', { count: 0 })).toBe('0 ligne'); // le français traite 0 comme un singulier
  });
  it('les formes plurielles existent par paires', () => {
    for (const k of Object.keys(fr)) if (k.endsWith('_one')) expect(fr).toHaveProperty(k.replace(/_one$/, '_other'));
  });
});
