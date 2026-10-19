import { describe, expect, it } from 'vitest';
import { plainText, splitQuote, withQuote } from './quote';

describe('quote', () => {
  it('round-trips a multi-line quote', () => {
    const sent = withQuote('first line\n\nsecond', 'My question');
    expect(sent).toBe('> first line\n>\n> second\n\nMy question');
    expect(splitQuote(sent)).toEqual({ quote: 'first line\n\nsecond', body: 'My question' });
  });
  it('leaves a message without quote alone', () => {
    expect(withQuote(null, 'hi')).toBe('hi');
    expect(withQuote('  ', 'hi')).toBe('hi');
    expect(splitQuote('hello\n> not leading')).toEqual({ body: 'hello\n> not leading' });
  });
  it('cuts a long quote', () => {
    const sent = withQuote('x'.repeat(1000), 'a');
    expect(splitQuote(sent).quote!.length).toBe(401);
    expect(splitQuote(sent).quote!.endsWith('…')).toBe(true);
  });
  it('cleans widgets and tokens out of a message', () => {
    expect(plainText('Intro\n\n```widget\n{"type":"chart"}\n```\n\n[[agentui:a1b2c3]] done')).toBe('Intro\n\n done');
  });
});
