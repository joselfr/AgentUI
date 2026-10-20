// `agentui_widget_image` widget: a source is an https URL or an absolute path of a file on the agent's machine, which the
// plugin copies into the chat (message.media) so that the user can see it.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { MAX_OUT_MEDIA } from './bridge.js';
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
  if (data.length > MAX_OUT_MEDIA) throw new Error(`${path} exceeds ${MAX_OUT_MEDIA / 1024 / 1024} MB.`);
  const mimeType = sniffImage(data);
  if (!mimeType) throw new Error(`${path} is not a png, jpeg, gif or webp image.`);
  const name = `${IMAGE_PREFIX}${createHash('sha1').update(data).digest('hex').slice(0, 8)}-${basename(path).replace(/[^\w.-]+/g, '_')}`;
  return { name, mimeType, data: data.toString('base64') };
}

export type FileKind = 'video' | 'audio' | 'pdf' | 'markdown';
/** Widgets that show a file (the `image` widget has its own list of sources): a local file is copied into the chat. */
export const FILE_KINDS: readonly string[] = ['video', 'audio', 'pdf', 'markdown'];
const MARKDOWN_EXT = /\.(md|markdown|txt)$/i;

/** Real type of a video, audio or PDF file from its first bytes (same rules as the AgentUI server, which serves it inline). */
export function sniffMedia(b: Buffer): string | undefined {
  const s = (from: number, to: number) => b.subarray(from, to).toString('latin1');
  if (b.length > 5 && s(0, 5) === '%PDF-') return 'application/pdf';
  if (b.length > 12 && s(4, 8) === 'ftyp') {
    const brand = s(8, 12);
    if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') return 'audio/mp4';
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (b.length > 4 && s(0, 4) === 'OggS') return 'audio/ogg';
  if (b.length > 12 && s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'audio/wav';
  if (b.length > 4 && s(0, 4) === 'fLaC') return 'audio/flac';
  if (b.length > 3 && (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe6) === 0xe2))) return 'audio/mpeg';
  if (b.length > 2 && b[0] === 0xff && (b[1]! & 0xf6) === 0xf0) return 'audio/aac';
  return undefined;
}

/** Shape check of the `video`, `audio`, `pdf` and `markdown` widgets (before any file read). */
export function fileWidgetError(key: string, args: { src?: unknown; content?: unknown }): string | undefined {
  const src = args.src;
  if (key === 'markdown') {
    const content = typeof args.content === 'string' ? args.content : '';
    if (!!content.trim() === (src !== undefined && src !== '')) return 'Give exactly one of `content` (the Markdown text) and `src` (absolute path of a .md file).';
    if (content.length > 400_000) return 'The content is too long (max 400,000 characters).';
    if (typeof src === 'string' && src && !src.startsWith('/')) return '`src` must be an absolute path (for text you have in memory, use `content`).';
    return undefined;
  }
  if (!(typeof src === 'string' && (HTTP.test(src) || src.startsWith('/')))) return 'src must be an https://… URL or an absolute path (no data:, file: or relative path).';
  return undefined;
}

/** Reads a local video, audio, PDF or Markdown file: throws an agent-readable error if missing, too big or of another type. */
export async function readLocalMedia(path: string, kind: FileKind, read: (p: string) => Promise<Buffer> = readFile): Promise<Media> {
  let data: Buffer;
  try {
    data = await read(path);
  } catch {
    throw new Error(`File not found or unreadable: ${path}`);
  }
  if (data.length > MAX_OUT_MEDIA) throw new Error(`${path} exceeds ${MAX_OUT_MEDIA / 1024 / 1024} MB.`);
  let mimeType: string | undefined;
  if (kind === 'markdown') {
    if (!MARKDOWN_EXT.test(path) || data.subarray(0, 8000).includes(0)) throw new Error(`${path} is not a Markdown or text file (.md, .markdown, .txt).`);
    mimeType = 'text/markdown';
  } else {
    mimeType = sniffMedia(data);
    const wanted = { video: 'video/', audio: 'audio/', pdf: 'application/pdf' }[kind];
    if (!mimeType || !mimeType.startsWith(wanted)) throw new Error(`${path} is not a ${kind} file in a supported format.`);
  }
  const name = `${IMAGE_PREFIX}${createHash('sha1').update(data).digest('hex').slice(0, 8)}-${basename(path).replace(/[^\w.-]+/g, '_')}`;
  return { name, mimeType, data: data.toString('base64') };
}
