export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'file';

/**
 * How an attachment is shown. The server stores the verified type (content sniffing), so the MIME type is enough; the extension only
 * tells Markdown from other text files. `file`: anything else, kept as a download chip.
 */
export function mediaKind(a: { mimeType: string; name: string }): MediaKind {
  const m = a.mimeType.toLowerCase();
  if (/^image\/(png|jpeg|gif|webp)$/.test(m)) return 'image';
  if (/^video\/(mp4|webm|quicktime)$/.test(m)) return 'video';
  if (/^audio\/(mpeg|mp4|ogg|wav|flac|aac|webm)$/.test(m)) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'text/markdown' || (/^text\//.test(m) || m === 'application/octet-stream') && /\.(md|markdown)$/i.test(a.name)) return 'markdown';
  return 'file';
}

/** Common shape of the media widgets' arguments: `src` is an https URL or an absolute path (copied into the chat by the plugin). */
export const isHttp = (s: string) => /^https?:\/\//i.test(s);
export const validSrc = (s: unknown): s is string => typeof s === 'string' && (isHttp(s) || s.startsWith('/'));
export const optText = (v: unknown, max = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** "m:ss" / "h:mm:ss" */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
