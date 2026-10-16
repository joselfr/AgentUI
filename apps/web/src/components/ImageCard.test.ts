import { describe, expect, it } from 'vitest';
import { parseImage } from './ImageCard';

describe('parseImage', () => {
  it('accepte une URL http(s) ou un chemin absolu, avec légende et alt facultatifs', () => {
    const g = parseImage({ title: 'T', images: [{ src: 'https://x.org/a.jpg', caption: 'c', alt: 'a' }, { src: '/opt/data/b.png' }] });
    expect(g?.title).toBe('T');
    expect(g?.images).toEqual([{ src: 'https://x.org/a.jpg', caption: 'c', alt: 'a' }, { src: '/opt/data/b.png' }]);
  });
  it('rejette images absentes, vides ou trop nombreuses', () => {
    expect(parseImage({})).toBeUndefined();
    expect(parseImage({ images: [] })).toBeUndefined();
    expect(parseImage({ images: Array.from({ length: 13 }, () => ({ src: 'https://x.org/a.jpg' })) })).toBeUndefined();
  });
  it('rejette les sources dangereuses ou relatives', () => {
    for (const src of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'relatif/a.png', '', 42]) {
      expect(parseImage({ images: [{ src }] })).toBeUndefined();
    }
  });
});
