import { describe, expect, it } from 'vitest';
import { parseImage } from './ImageCard';

describe('parseImage', () => {
  it('accepts an http(s) URL or an absolute path, with optional caption and alt', () => {
    const g = parseImage({ title: 'T', images: [{ src: 'https://x.org/a.jpg', caption: 'c', alt: 'a' }, { src: '/opt/data/b.png' }] });
    expect(g?.title).toBe('T');
    expect(g?.images).toEqual([{ src: 'https://x.org/a.jpg', caption: 'c', alt: 'a' }, { src: '/opt/data/b.png' }]);
  });
  it('rejects missing, empty or too many images', () => {
    expect(parseImage({})).toBeUndefined();
    expect(parseImage({ images: [] })).toBeUndefined();
    expect(parseImage({ images: Array.from({ length: 13 }, () => ({ src: 'https://x.org/a.jpg' })) })).toBeUndefined();
  });
  it('rejects dangerous or relative sources', () => {
    for (const src of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'relatif/a.png', '', 42]) {
      expect(parseImage({ images: [{ src }] })).toBeUndefined();
    }
  });
});
