import { useEffect, useRef } from 'react';
import type { Message } from '@agentui/shared';

/**
 * Suivi automatique du bas de la conversation. Seul un défilement vers le haut désactive le suivi : la croissance
 * du contenu ne fait jamais reculer `scrollTop`. Un changement de conversation repart du bas.
 */
export function useStickToBottom(messages: Message[]) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const toBottom = () => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; };
  const firstId = messages[0]?.id;
  useEffect(() => { stick.current = true; }, [firstId]); // autre conversation : on repart du bas
  useEffect(toBottom, [messages]);
  // Le contenu peut grandir sans que les messages changent (bloc ask rendu en carte, images chargées…)
  useEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(toBottom);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return {
    scroller, content,
    pin: () => { stick.current = true; },
    onScroll: (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (atBottom) stick.current = true;
      else if (el.scrollTop < lastTop.current - 2) stick.current = false;
      lastTop.current = el.scrollTop;
    },
  };
}
