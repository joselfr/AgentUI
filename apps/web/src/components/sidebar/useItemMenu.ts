import { useRef, useState, type MouseEvent, type TouchEvent } from 'react';

export interface ItemMenu<T> { item: T; x: number; y: number }

/**
 * Menu contextuel d'une ligne de liste : clic droit, ou appui long (500 ms) au doigt.
 *
 * Sur tablette Android, le long appui déclenche aussi l'événement natif `contextmenu` et le relâchement du doigt
 * (avec son clic fantôme) tombe sur le fond du menu : sans garde, il le refermerait aussitôt. `requestClose`
 * ignore donc toute fermeture tant que le doigt est posé et peu après.
 */
export function useItemMenu<T>(enabled: boolean) {
  const [menu, setMenu] = useState<ItemMenu<T>>();
  const press = useRef<{ timer?: number; x: number; y: number; fired: boolean }>({ fired: false, x: 0, y: 0 });
  const touch = useRef({ down: false, lastEvent: 0 });
  const cancelPress = () => { window.clearTimeout(press.current.timer); };
  const open = (item: T, x: number, y: number) => { touch.current.lastEvent = Date.now(); setMenu({ item, x, y }); };
  const touchEnded = () => { touch.current = { down: false, lastEvent: Date.now() }; };

  /** Gestionnaires à poser sur la ligne `item`. */
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
    /** À appeler au début d'un clic : vrai si ce clic termine un long appui (à ignorer). */
    consumeClick: () => { if (press.current.fired) { press.current.fired = false; return true; } return false; },
    /** Fermeture demandée par le fond du menu (gardée, voir plus haut). */
    requestClose: () => { if (!touch.current.down && Date.now() - touch.current.lastEvent > 600) setMenu(undefined); },
    /** Fermeture immédiate (après le choix d'une action). */
    close: () => setMenu(undefined),
  };
}
