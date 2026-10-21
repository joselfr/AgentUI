import { closeSync, createReadStream, openSync, readSync, statSync } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { INLINE_MEDIA, parseRange, sniffMedia } from './attachments.js';

/**
 * Sends a stored file. Only verified images, videos and audio are displayed inline; everything else is downloaded, never interpreted by the
 * browser. Byte ranges are answered: iOS Safari only plays a video / audio file if the server does, and they make seeking instant.
 * `inlineOnly`: refuse (404) what would not be displayed inline instead of offering a download (iframes of widgets and miniapps).
 */
export function serveStoredFile(req: FastifyRequest, reply: FastifyReply, f: { name: string; mimeType: string; path: string }, inlineOnly = false) {
  let type = f.mimeType;
  if (!/^image\//.test(type) && !INLINE_MEDIA.test(type)) { // stored before the content check existed: look at the file itself
    const fd = openSync(f.path, 'r');
    try { const head = Buffer.alloc(16); type = sniffMedia(head.subarray(0, readSync(fd, head, 0, 16, 0))) ?? type; } finally { closeSync(fd); }
  }
  const inline = /^image\/(png|jpeg|gif|webp)$/.test(type) || INLINE_MEDIA.test(type);
  if (inlineOnly && !inline) return reply.code(404).send({ error: 'not found' });
  const size = statSync(f.path).size;
  reply
    .header('Content-Type', inline ? type : 'application/octet-stream')
    .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', 'private, max-age=86400');
  if (inlineOnly) reply.header('Access-Control-Allow-Origin', '*'); // the iframe has an opaque origin: with crossOrigin="anonymous" a canvas can read the pixels
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') return reply.code(416).header('Content-Range', `bytes */${size}`).send();
  if (range) {
    return reply
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      .header('Content-Length', range.end - range.start + 1)
      .send(createReadStream(f.path, { start: range.start, end: range.end }));
  }
  return reply.header('Content-Length', size).send(createReadStream(f.path));
}
