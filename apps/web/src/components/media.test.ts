import { describe, expect, it } from 'vitest';
import { formatTime, mediaKind } from './media';

describe('mediaKind', () => {
  it('classifies by the verified MIME type', () => {
    expect(mediaKind({ mimeType: 'image/png', name: 'a.png' })).toBe('image');
    expect(mediaKind({ mimeType: 'video/mp4', name: 'a.mp4' })).toBe('video');
    expect(mediaKind({ mimeType: 'audio/mpeg', name: 'a.mp3' })).toBe('audio');
    expect(mediaKind({ mimeType: 'application/pdf', name: 'a.pdf' })).toBe('pdf');
  });
  it('tells Markdown from other text by type or extension', () => {
    expect(mediaKind({ mimeType: 'text/markdown', name: 'x' })).toBe('markdown');
    expect(mediaKind({ mimeType: 'application/octet-stream', name: 'notes.MD' })).toBe('markdown');
    expect(mediaKind({ mimeType: 'text/plain', name: 'notes.txt' })).toBe('file');
  });
  it('keeps unverified or unknown types as plain files', () => {
    expect(mediaKind({ mimeType: 'application/octet-stream', name: 'clip.mp4' })).toBe('file');
    expect(mediaKind({ mimeType: 'application/zip', name: 'a.zip' })).toBe('file');
    expect(mediaKind({ mimeType: 'image/svg+xml', name: 'a.svg' })).toBe('file');
  });
});

describe('formatTime', () => {
  it('formats minutes and hours', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65.9)).toBe('1:05');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(NaN)).toBe('0:00');
  });
});
