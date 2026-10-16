import { useEffect, useRef } from 'react';

/**
 * Bouton retour (mobile) : ferme la modale ouverte au lieu de quitter la page.
 * Chaque modale ouverte empile une entrée d'historique ; un retour ferme la plus récente.
 */
interface Entry { close: () => void }
const stack: Entry[] = [];
let ignore = 0; // popstate provoqués par nos propres history.back()
let listening = false;

function onPop() {
  if (ignore > 0) { ignore--; return; }
  stack.pop()?.close();
}

export function useBackClose(open: boolean, onClose: () => void) {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!open) return;
    if (!listening) { window.addEventListener('popstate', onPop); listening = true; }
    const entry: Entry = { close: () => cb.current() };
    stack.push(entry);
    history.pushState({ modal: true }, '');
    return () => {
      const i = stack.indexOf(entry);
      if (i < 0) return; // déjà dépilée par le bouton retour
      stack.splice(i, 1);
      ignore++;
      history.back();
    };
  }, [open]);
}
