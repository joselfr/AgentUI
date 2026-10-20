import { describe, expect, it, vi } from 'vitest';
import { tracesMessage } from './UiCard';

describe('tracesMessage', () => {
  vi.stubGlobal('navigator', { userAgent: 'TestBrowser/1.0' });
  const base = { token: '[[agentui:a3f9c1]]', build: [], runtime: [], mode: 'dark', lang: 'en', width: 280 };

  it('gives the agent the widget, the errors and the context', () => {
    const m = tracesMessage({ ...base, build: ['3:5 Unexpected token'], runtime: ['TypeError: x is undefined\n  at W'] });
    expect(m).toContain('[[agentui:a3f9c1]]');
    expect(m).toContain('3:5 Unexpected token');
    expect(m).toContain('TypeError: x is undefined');
    expect(m).toContain('theme=dark, lang=en, width=280px, TestBrowser/1.0');
  });

  it('stays bounded', () => {
    expect(tracesMessage({ ...base, runtime: ['x'.repeat(20000)] }).length).toBeLessThanOrEqual(4000);
  });
});
