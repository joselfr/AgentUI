import { useEffect, useRef } from 'react';
import type { ConnStatus, ServerPush } from '@agentui/shared';

export type LiveEvent = Extract<ServerPush, { type: 'event' }>;

/** Persistent WebSocket with reconnection; `onOpen` is used to resync the state via REST. */
export function useLive(opts: {
  enabled: boolean;
  onEvent: (e: LiveEvent) => void;
  onStatus: (agentId: string, s: ConnStatus, detail?: string) => void;
  /** Chat marked read from another device. */
  onRead?: (conversationId: string) => void;
  /** A mini-app was created / rebuilt / removed. */
  onAppChanged?: (appId: string, removed: boolean) => void;
  onOpen: () => void;
  onUnauthorized: () => void;
}) {
  const ref = useRef(opts);
  ref.current = opts;
  useEffect(() => {
    if (!opts.enabled) return;
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let delay = 500;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        delay = 500;
        // No replay: the state is reloaded via REST (source of truth), only live events matter to us.
        ws!.send(JSON.stringify({ type: 'resume', since: Number.MAX_SAFE_INTEGER }));
        ref.current.onOpen();
      };
      ws.onmessage = (m) => {
        const p = JSON.parse(m.data as string) as ServerPush;
        if (p.type === 'event') ref.current.onEvent(p);
        else if (p.type === 'conversation.read') ref.current.onRead?.(p.conversationId);
        else if (p.type === 'app.changed') ref.current.onAppChanged?.(p.appId, !!p.removed);
        else ref.current.onStatus(p.agentId, p.status, p.detail);
      };
      ws.onclose = (e) => {
        if (stopped) return;
        if (e.code === 4401) return ref.current.onUnauthorized();
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10000);
      };
    };
    connect();
    const onVisible = () => document.visibilityState === 'visible' && ws?.readyState !== WebSocket.OPEN && (clearTimeout(timer), connect());
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      ws?.close();
    };
  }, [opts.enabled]);
}
