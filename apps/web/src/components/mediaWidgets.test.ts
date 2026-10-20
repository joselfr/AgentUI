import { describe, expect, it } from 'vitest';
import { parseVideo } from './VideoCard';
import { parseAudio, waveform } from './AudioCard';
import { parsePdf } from './PdfCard';
import { parseMarkdown } from './MarkdownCard';
import { expandWidgetTokens } from './widget';

describe('media widgets: arguments', () => {
  it('video / audio: an https URL or an absolute path, nothing else', () => {
    expect(parseVideo({ src: '/data/a.mp4', title: ' Demo ', caption: 'c' })).toEqual({ src: '/data/a.mp4', title: 'Demo', caption: 'c' });
    expect(parseVideo({ src: 'https://x.io/a.mp4' })).toMatchObject({ src: 'https://x.io/a.mp4' });
    for (const src of ['a.mp4', 'file:///a.mp4', 'data:video/mp4;base64,AAAA', 'javascript:alert(1)', 1, undefined]) {
      expect(parseVideo({ src })).toBeUndefined();
      expect(parseAudio({ src })).toBeUndefined();
    }
    expect(parseAudio({ src: '/m.mp3', title: 'Memo' })).toEqual({ src: '/m.mp3', title: 'Memo' });
  });
  it('pdf: optional page, a positive integer', () => {
    expect(parsePdf({ src: '/f.pdf' })).toEqual({ src: '/f.pdf', title: undefined, page: 1 });
    expect(parsePdf({ src: '/f.pdf', page: 3 })?.page).toBe(3);
    for (const page of [0, -1, 1.5, '2']) expect(parsePdf({ src: '/f.pdf', page })).toBeUndefined();
  });
  it('markdown: exactly one of content and src', () => {
    expect(parseMarkdown({ content: '# Hi', title: 'T' })).toEqual({ title: 'T', content: '# Hi', src: undefined });
    expect(parseMarkdown({ src: '/r.md' })).toMatchObject({ src: '/r.md' });
    expect(parseMarkdown({})).toBeUndefined();
    expect(parseMarkdown({ content: '  ' })).toBeUndefined();
    expect(parseMarkdown({ content: 'x', src: '/r.md' })).toBeUndefined();
    expect(parseMarkdown({ src: 'r.md' })).toBeUndefined();
  });
});

describe('waveform', () => {
  it('is stable for a source, differs between sources, stays in range', () => {
    const a = waveform('x.mp3');
    expect(a).toEqual(waveform('x.mp3'));
    expect(a).not.toEqual(waveform('y.mp3'));
    expect(a).toHaveLength(46);
    expect(a.every((v) => v > 0 && v <= 1)).toBe(true);
  });
});

describe('media widget tokens', () => {
  it('a video / pdf tool result carries its files and the widget replaces the token', () => {
    const call = { name: 'agentui_widget_video', args: { src: '/data/a.mp4' }, resultPreview: JSON.stringify({ widget: '[[agentui:abc123]]', files: { '/data/a.mp4': 'agentui-img-1-a.mp4' } }) };
    const out = expandWidgetTokens('Voici : [[agentui:abc123]]', [call]);
    expect(out).toContain('```widget');
    expect(out).toContain('"type":"video"');
    expect(out).toContain('"files":{"/data/a.mp4":"agentui-img-1-a.mp4"}');
  });
});
