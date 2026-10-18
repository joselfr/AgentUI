import { useEffect, useRef } from 'react';
import type { Message } from '@agentui/shared';

/**
   * Automatic following of the bottom of the conversation. Only scrolling up disables following: content growth
   * never moves `scrollTop` back. A change of conversation starts again from the bottom.
 */
export function useStickToBottom(messages: Message[]) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const toBottom = () => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; };
  const firstId = messages[0]?.id;
  useEffect(() => { stick.current = true; }, [firstId]); // other conversation: start again from the bottom
  useEffect(toBottom, [messages]);
  // The content may grow without the messages changing (ask block rendered as a card, loaded images…)
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
