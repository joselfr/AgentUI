import { useRef, useState, type MouseEvent, type TouchEvent } from 'react';

export interface ItemMenu<T> { item: T; x: number; y: number }

/**
   * Context menu of a list row: right-click, or long press (500 ms) with a finger.
 *
   * On Android tablets, a long press also fires the native `contextmenu` event and releasing the finger
   * (with its ghost click) lands on the menu backdrop: without a guard, it would close it right away. `requestClose`
   * therefore ignores any close while the finger is down and shortly after.
 */
export function useItemMenu<T>(enabled: boolean) {
  const [menu, setMenu] = useState<ItemMenu<T>>();
  const press = useRef<{ timer?: number; x: number; y: number; fired: boolean }>({ fired: false, x: 0, y: 0 });
  const touch = useRef({ down: false, lastEvent: 0 });
  const cancelPress = () => { window.clearTimeout(press.current.timer); };
  const open = (item: T, x: number, y: number) => { touch.current.lastEvent = Date.now(); setMenu({ item, x, y }); };
  const touchEnded = () => { touch.current = { down: false, lastEvent: Date.now() }; };

  /** Handlers to set on the `item` row. */
  const bind = (item: T) => ({
    onContextMenu: (e: MouseEvent) => { e.preventDefault(); if (!enabled) return; cancelPress(); open(item, e.clientX, e.clientY); },
    onTouchStart: (e: TouchEvent) => {
      if (!enabled) return;
      touch.current = { down: true, lastEvent: Date.now() };
      const t = e.touches[0]!;
      press.current = { fired: false, x: t.clientX, y: t.clientY, timer: window.setTimeout(() => { press.current.fired = true; open(item, t.clientX, t.clientY); }, 500) };
    },
    onTouchMove: (e: TouchEvent) => { const t = e.touches[0]!; if (Math.hypot(t.clientX - press.current.x, t.clientY - press.current.y) > 10) cancelPress(); },
    onTouchEnd: (e: TouchEvent) => { cancelPress(); touchEnded(); if (press.current.fired && e.cancelable) e.preventDefault(); },
    onTouchCancel: () => { cancelPress(); touchEnded(); },
  });

  return {
    menu,
    bind,
    /** To call at the start of a click: true if this click ends a long press (to ignore). */
    consumeClick: () => { if (press.current.fired) { press.current.fired = false; return true; } return false; },
    /** Close requested by the menu backdrop (guarded, see above). */
    requestClose: () => { if (!touch.current.down && Date.now() - touch.current.lastEvent > 600) setMenu(undefined); },
    /** Immediate close (after choosing an action). */
    close: () => setMenu(undefined),
  };
}
