import type { Resolved } from './ImageCard';

/**
 * Tells a sandboxed iframe (custom widget or miniapp) where to load a media file from. The iframe has no session cookie and its CSP forbids
 * remote loads, so the file is served under the iframe's own token-protected base (`media-src 'self'`, with byte ranges: streaming, seeking,
 * and what iOS Safari requires). A HEAD request gives the type and tells whether the file is there. Images, videos and audio only.
 */
export async function sendMedia(target: Window, id: string, url: string | undefined): Promise<void> {
  const fail = () => target.postMessage({ type: 'agentui:media.result', id, ok: false }, '*');
  if (!url || !url.startsWith('/')) return fail(); // our own endpoints only
  try {
    const res = await fetch(url, { method: 'HEAD' });
    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!res.ok || !/^(image|video|audio)\//.test(mimeType)) return fail();
    target.postMessage({ type: 'agentui:media.result', id, ok: true, mimeType, url }, '*');
  } catch { fail(); }
}

/** A request that came before its file (the attachment of a local file arrives while the agent is still working) waits here. */
export interface MediaRequest { id: string; name: string }

/** Answers the requests whose source is known; returns those still waiting for their file. */
export function answerMedia(target: Window, waiting: MediaRequest[], resolve: (name: string) => Resolved, frameUrl: (url: string) => string | undefined): MediaRequest[] {
  const still: MediaRequest[] = [];
  for (const r of waiting) {
    const res = resolve(r.name);
    if (res.state === 'loading') still.push(r);
    else void sendMedia(target, r.id, res.state === 'ok' ? frameUrl(res.url) : undefined);
  }
  return still;
}
