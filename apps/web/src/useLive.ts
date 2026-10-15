import { useEffect, useRef } from 'react';
import type { ConnStatus, ServerPush } from '@agentui/shared';

export type LiveEvent = Extract<ServerPush, { type: 'event' }>;

/** WebSocket persistant avec reconnexion ; `onOpen` sert à resynchroniser l'état via REST. */
export function useLive(opts: {
  enabled: boolean;
  onEvent: (e: LiveEvent) => void;
  onStatus: (agentId: string, s: ConnStatus, detail?: string) => void;
  /** Discussion marquée lue depuis un autre appareil. */
  onRead?: (conversationId: string) => void;
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
        // Pas de rejeu : l'état est rechargé via REST (source de vérité), seuls les events live nous intéressent.
        ws!.send(JSON.stringify({ type: 'resume', since: Number.MAX_SAFE_INTEGER }));
        ref.current.onOpen();
      };
      ws.onmessage = (m) => {
        const p = JSON.parse(m.data as string) as ServerPush;
        if (p.type === 'event') ref.current.onEvent(p);
        else if (p.type === 'conversation.read') ref.current.onRead?.(p.conversationId);
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
