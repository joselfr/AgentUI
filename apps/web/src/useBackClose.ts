import { useEffect, useRef } from 'react';

/**
   * Back button (mobile): closes the open dialog instead of leaving the page.
   * Each open dialog pushes a history entry; going back closes the most recent one.
 */
interface Entry { close: () => void }
const stack: Entry[] = [];
let ignore = 0; // popstate events caused by our own history.back()
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
    const token = Math.random().toString(36).slice(2);
    stack.push(entry);
    history.pushState({ ...history.state, modal: token }, ''); // keeps the router state (idx)
    return () => {
      const i = stack.indexOf(entry);
      if (i < 0) return; // already popped by the back button
      stack.splice(i, 1);
      // Only go back if the current entry is still ours: after a navigation (choosing a
      // chat in the drawer), going back would return to the old URL.
      if (history.state?.modal !== token) return;
      ignore++;
      history.back();
    };
  }, [open]);
}
