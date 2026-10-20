import { useCallback, useRef, useState, type TouchEvent } from 'react';

export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;
const DOUBLE_TAP_SCALE = 2.5;
const SWIPE_PX = 50;

export interface View { scale: number; x: number; y: number }
export const IDENTITY: View = { scale: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keeps the zoomed content covering the frame: the pan cannot go further than the edge of the content. */
export function clampView(v: View, w: number, h: number): View {
  const scale = clamp(v.scale, MIN_SCALE, MAX_SCALE);
  if (scale <= MIN_SCALE) return IDENTITY;
  const mx = ((scale - 1) * w) / 2;
  const my = ((scale - 1) * h) / 2;
  return { scale, x: clamp(v.x, -mx, mx), y: clamp(v.y, -my, my) };
}

/** New view after zooming to `scale` while keeping the point `(fx, fy)` (relative to the frame center) under the fingers. */
export function zoomAround(v: View, scale: number, fx: number, fy: number): View {
  const k = scale / v.scale;
  return { scale, x: fx - (fx - v.x) * k, y: fy - (fy - v.y) * k };
}

const dist = (a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

/**
 * Pinch to zoom, drag to pan when zoomed, double tap to zoom in / out. At scale 1 a horizontal swipe calls `onSwipe(±1)`.
 * Attach `handlers` to the frame (with `touch-action: none`) and apply `transform` to the content.
 */
export function usePinchZoom(onSwipe?: (dir: 1 | -1) => void) {
  const [view, setView] = useState<View>(IDENTITY);
  const viewRef = useRef(view);
  const frame = useRef({ w: 1, h: 1, cx: 0, cy: 0 });
  const g = useRef<{ mode: 'none' | 'pan' | 'pinch'; sx: number; sy: number; start: View; d0: number; lastTap: number; tapX: number; tapY: number; moved: boolean }>(
    { mode: 'none', sx: 0, sy: 0, start: IDENTITY, d0: 1, lastTap: 0, tapX: 0, tapY: 0, moved: false });
  const apply = useCallback((v: View) => { const c = clampView(v, frame.current.w, frame.current.h); viewRef.current = c; setView(c); }, []);
  const reset = useCallback(() => { viewRef.current = IDENTITY; setView(IDENTITY); g.current.mode = 'none'; }, []);

  const handlers = {
    onTouchStart: (e: TouchEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      frame.current = { w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      const s = g.current;
      s.start = viewRef.current;
      if (e.touches.length >= 2) {
        s.mode = 'pinch';
        s.d0 = dist(e.touches[0]!, e.touches[1]!) || 1;
      } else {
        const t = e.touches[0]!;
        s.mode = 'pan'; s.sx = t.clientX; s.sy = t.clientY; s.moved = false;
      }
    },
    onTouchMove: (e: TouchEvent<HTMLElement>) => {
      const s = g.current;
      const f = frame.current;
      if (s.mode === 'pinch' && e.touches.length >= 2) {
        const a = e.touches[0]!, b = e.touches[1]!;
        const fx = (a.clientX + b.clientX) / 2 - f.cx, fy = (a.clientY + b.clientY) / 2 - f.cy;
        apply(zoomAround(s.start, clamp(s.start.scale * (dist(a, b) / s.d0), MIN_SCALE, MAX_SCALE), fx, fy));
        s.moved = true;
      } else if (s.mode === 'pan' && e.touches.length === 1) {
        const t = e.touches[0]!;
        const dx = t.clientX - s.sx, dy = t.clientY - s.sy;
        if (Math.abs(dx) + Math.abs(dy) > 8) s.moved = true;
        if (s.start.scale > 1) apply({ scale: s.start.scale, x: s.start.x + dx, y: s.start.y + dy });
      }
    },
    onTouchEnd: (e: TouchEvent<HTMLElement>) => {
      const s = g.current;
      if (e.touches.length >= 1) { // a finger lifted during a pinch: the remaining one continues as a pan from here
        const t = e.touches[0]!;
        s.mode = 'pan'; s.sx = t.clientX; s.sy = t.clientY; s.start = viewRef.current; s.moved = true;
        return;
      }
      const t = e.changedTouches[0]!;
      if (s.mode === 'pan' && !s.moved) { // tap: a second one close by zooms in / back out
        const now = Date.now();
        if (now - s.lastTap < DOUBLE_TAP_MS && Math.hypot(t.clientX - s.tapX, t.clientY - s.tapY) < DOUBLE_TAP_PX) {
          s.lastTap = 0;
          if (viewRef.current.scale > 1) apply(IDENTITY);
          else apply(zoomAround(IDENTITY, DOUBLE_TAP_SCALE, t.clientX - frame.current.cx, t.clientY - frame.current.cy));
        } else { s.lastTap = now; s.tapX = t.clientX; s.tapY = t.clientY; }
      } else if (s.mode === 'pan' && viewRef.current.scale === 1 && s.start.scale === 1) {
        const dx = t.clientX - s.sx;
        if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(t.clientY - s.sy)) onSwipe?.(dx < 0 ? 1 : -1);
      }
      s.mode = 'none';
      if (viewRef.current.scale < 1.02) apply(IDENTITY);
    },
  };
  const transform = view.scale === 1 ? undefined : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  return { handlers, transform, zoomed: view.scale > 1, reset };
}
