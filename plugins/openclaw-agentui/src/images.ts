// `agentui_image` widget: a source is an https URL or an absolute path of a file on the agent's machine, which the
// plugin copies into the chat (message.media) so that the user can see it.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { MAX_MEDIA } from './bridge.js';
import type { Media } from './protocol.js';

export const MAX_IMAGES = 12;
/** Prefix of attachments copied for a widget: the front does not display them on top of the widget. */
export const IMAGE_PREFIX = 'agentui-img-';
const HTTP = /^https?:\/\//i;

/** Real type of an image from its first bytes (not the extension). What the attachments endpoint displays inline. */
export function sniffImage(b: Buffer): string | undefined {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

/** Shape check of the sources (before any file read). */
export function imagesError(args: { images?: Array<{ src?: unknown }> }): string | undefined {
  const images = args.images ?? [];
  if (!images.length || images.length > MAX_IMAGES) return `Between 1 and ${MAX_IMAGES} images are required.`;
  for (const [i, im] of images.entries()) {
    const src = String(im.src ?? '');
    if (!(HTTP.test(src) || src.startsWith('/'))) return `Image ${i + 1}: src must be an https://… URL or an absolute path (no data:, file: or relative path).`;
  }
  return undefined;
}

/** Reads a local image: throws an agent-readable error if the file is missing, too big or not an image. */
export async function readLocalImage(path: string, read: (p: string) => Promise<Buffer> = readFile): Promise<Media> {
  let data: Buffer;
  try {
    data = await read(path);
  } catch {
    throw new Error(`File not found or unreadable: ${path}`);
  }
  if (data.length > MAX_MEDIA) throw new Error(`${path} exceeds ${MAX_MEDIA / 1024 / 1024} MB.`);
  const mimeType = sniffImage(data);
  if (!mimeType) throw new Error(`${path} is not a png, jpeg, gif or webp image.`);
  const name = `${IMAGE_PREFIX}${createHash('sha1').update(data).digest('hex').slice(0, 8)}-${basename(path).replace(/[^\w.-]+/g, '_')}`;
  return { name, mimeType, data: data.toString('base64') };
}
