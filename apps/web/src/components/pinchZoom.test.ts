import { describe, expect, it } from 'vitest';
import { IDENTITY, MAX_SCALE, clampView, zoomAround } from './pinchZoom';

describe('pinch zoom geometry', () => {
  it('zooming around the center does not move the content', () => {
    expect(zoomAround(IDENTITY, 2, 0, 0)).toEqual({ scale: 2, x: 0, y: 0 });
  });
  it('keeps the point under the fingers fixed', () => {
    const v = zoomAround(IDENTITY, 2, 100, 50); // content point (100, 50), at scale 1 under the fingers
    expect(v.x + 100 * v.scale).toBeCloseTo(100); // after zooming it is still on the fingers
    expect(v.y + 50 * v.scale).toBeCloseTo(50);
    const w = zoomAround(v, 4, 20, -10); // new focal point: same invariant from an already zoomed view
    expect(w.x + ((20 - v.x) / v.scale) * w.scale).toBeCloseTo(20);
  });
  it('cannot pan beyond the edge of the content, nor zoom beyond the limits', () => {
    expect(clampView({ scale: 2, x: 999, y: -999 }, 400, 300)).toEqual({ scale: 2, x: 200, y: -150 });
    expect(clampView({ scale: 99, x: 0, y: 0 }, 400, 300).scale).toBe(MAX_SCALE);
    expect(clampView({ scale: 0.5, x: 30, y: 30 }, 400, 300)).toEqual(IDENTITY);
  });
});
