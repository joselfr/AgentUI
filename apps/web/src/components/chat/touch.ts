import { useEffect, useRef } from 'react';

/** Touch-first device (no hover, coarse pointer): the system selection menu cannot be turned off, so messages offer their own menu there. */
export const isTouch = () => typeof window !== 'undefined' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;

const BLOCK = 'p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, td, th';
const LONG_PRESS_MS = 450;
const MOVE_PX = 10;

/**
 * Long press (without moving) on an element: calls `onPress` with the position and the text block under the finger (paragraph, list item,
 * code block…). The click that follows the press is swallowed, so a link under the finger is not opened.
 */
export function useLongPress(onPress: (p: { x: number; y: number; block?: HTMLElement }) => void, enabled: boolean) {
  const st = useRef<{ x: number; y: number; target: EventTarget | null; timer?: ReturnType<typeof setTimeout>; fired?: boolean }>({ x: 0, y: 0, target: null });
  useEffect(() => () => clearTimeout(st.current.timer), []);
  if (!enabled) return {};
  const cancel = () => clearTimeout(st.current.timer);
  return {
    onTouchStart: (e: React.TouchEvent<HTMLElement>) => {
      const touch = e.touches[0]!;
      const s = st.current;
      s.x = touch.clientX; s.y = touch.clientY; s.target = e.target; s.fired = false;
      clearTimeout(s.timer);
      if ((e.target as Element).closest('button, input, textarea, a, [role="button"]')) return; // controls keep their own gestures
      s.timer = setTimeout(() => {
        s.fired = true;
        navigator.vibrate?.(8);
        onPress({ x: s.x, y: s.y, block: (s.target as Element | null)?.closest?.(BLOCK) as HTMLElement | undefined });
      }, LONG_PRESS_MS);
    },
    onTouchMove: (e: React.TouchEvent<HTMLElement>) => {
      const t = e.touches[0]!;
      if (Math.hypot(t.clientX - st.current.x, t.clientY - st.current.y) > MOVE_PX) cancel();
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    onClickCapture: (e: React.MouseEvent<HTMLElement>) => { if (st.current.fired) { st.current.fired = false; e.preventDefault(); e.stopPropagation(); } },
  };
}
