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
  // Reading position, kept so a reflow (device rotation, window resize) can restore it: the first visible child and its offset.
  const anchor = useRef<{ el: Element; offset: number } | null>(null);
  const lastWidth = useRef(0);
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
    // Width change (rotation): the text reflows and the browser clamps scrollTop, so put the anchor back where it was.
    const sc = scroller.current;
    const rw = sc ? new ResizeObserver(() => {
      const w = sc.clientWidth;
      if (w === lastWidth.current) return;
      lastWidth.current = w;
      const a = anchor.current;
      if (stick.current) sc.scrollTop = sc.scrollHeight;
      else if (a?.el.isConnected) sc.scrollTop += a.el.getBoundingClientRect().top - sc.getBoundingClientRect().top - a.offset;
      lastTop.current = sc.scrollTop;
    }) : null;
    if (sc && rw) { lastWidth.current = sc.clientWidth; rw.observe(sc); }
    return () => { ro.disconnect(); rw?.disconnect(); };
  }, []);
  return {
    scroller, content,
    pin: () => { stick.current = true; },
    onScroll: (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (el.clientWidth !== lastWidth.current) return; // scroll caused by a reflow: the resize observer handles it
      const top = el.getBoundingClientRect().top;
      for (const c of Array.from(content.current?.children ?? [])) {
        const r = c.getBoundingClientRect();
        if (r.bottom > top + 1) { anchor.current = { el: c, offset: r.top - top }; break; }
      }
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (atBottom) stick.current = true;
      else if (el.scrollTop < lastTop.current - 2) stick.current = false;
      lastTop.current = el.scrollTop;
    },
  };
}
