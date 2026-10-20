import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AdapterAttachment, AttachmentMeta, Capabilities, OutgoingAttachment } from '@agentui/shared';
import type { DB } from './db.js';
import { safeJoin } from './safe-path.js';

export const LIMITS = {
  maxFiles: 8,
  maxTotalBytes: 25 * 1024 * 1024,
  maxImageBytes: 6 * 1024 * 1024, // OpenClaw limit for an inline image
  maxInlineTextBytes: 200_000, // per text file inserted in the message
  maxInlineTextTotal: 400_000,
};

/** Validation error meant for the user (HTTP 400). */
export class AttachmentError extends Error {}

const TEXT_EXT = new Set(
  'txt md markdown csv tsv json jsonl yaml yml toml ini cfg conf env log xml html htm css scss js mjs cjs ts tsx jsx py rb go rs java kt c h cpp hpp cs php sh bash zsh fish sql graphql svg tex rst diff patch dockerfile makefile'.split(' '),
);
const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|toml|javascript|x-sh|sql|x-ndjson)|image\/svg\+xml)/;

export const sanitizeName = (n: string): string =>
  (n.split(/[\\/]/).pop() ?? 'file').replace(/[\u0000-\u001f"<>|:*?]/g, '_').trim().slice(0, 120) || 'file';

/** Detects the real type of an image from its first bytes (the type announced by the client is not reliable). */
export function sniffImage(b: Buffer): string | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const MARKDOWN_EXT = /\.(md|markdown)$/i;

/**
 * Real type of a video, audio or PDF file from its first bytes (the type announced by the sender is not reliable).
 * `null` if it is none of those. MP4 family: the `ftyp` brand tells audio (M4A…) from video.
 */
export function sniffMedia(b: Buffer): string | null {
  const s = (from: number, to: number) => b.subarray(from, to).toString('latin1');
  if (b.length > 5 && s(0, 5) === '%PDF-') return 'application/pdf';
  if (b.length > 12 && s(4, 8) === 'ftyp') {
    const brand = s(8, 12);
    if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') return 'audio/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  if (b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm'; // Matroska/WebM (EBML)
  if (b.length > 4 && s(0, 4) === 'OggS') return 'audio/ogg';
  if (b.length > 12 && s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'audio/wav';
  if (b.length > 4 && s(0, 4) === 'fLaC') return 'audio/flac';
  if (b.length > 3 && s(0, 3) === 'ID3') return 'audio/mpeg';
  if (b.length > 2 && b[0] === 0xff && (b[1]! & 0xe6) === 0xe2) return 'audio/mpeg'; // MPEG audio frame sync
  if (b.length > 2 && b[0] === 0xff && (b[1]! & 0xf6) === 0xf0) return 'audio/aac'; // ADTS
  return null;
}

/** Types the browser may play inline from /api/attachments (verified by `sniffMedia`); everything else is served as a download. */
export const INLINE_MEDIA = /^(video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|wav|flac|aac|webm))$/;

/** Type to store for a file: the verified one (image, video, audio, PDF), `text/markdown` for a .md file, else what the sender said. */
export function effectiveMime(name: string, announced: string, data: Buffer): string {
  const sniffed = sniffImage(data) ?? sniffMedia(data);
  if (sniffed) return sniffed;
  if (MARKDOWN_EXT.test(name) && !data.subarray(0, 8000).includes(0)) return 'text/markdown';
  return /^(video|audio)\/|^application\/pdf$/.test(announced) ? 'application/octet-stream' : announced; // announced but not verified: kept only as a download
}

/** `Range: bytes=a-b` header → bounds (inclusive) within a file of `size` bytes; `null` if absent, `'invalid'` if unsatisfiable. Single range only. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return header.startsWith('bytes=') && /,/.test(header) ? null : 'invalid'; // several ranges: the whole file is sent
  let start: number, end: number;
  if (m[1] === '') { // suffix: the last N bytes
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start >= size || start > end ? 'invalid' : { start, end };
}

function looksLikeText(name: string, mime: string, b: Buffer): boolean {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : name.toLowerCase();
  if (!(TEXT_MIME.test(mime) || TEXT_EXT.has(ext))) return false;
  return !b.subarray(0, 8000).includes(0); // a null byte = binary
}

export interface Prepared {
  /** Text actually sent to the agent (text files inserted). */
  agentText: string;
  /** Native attachments (images, and binary files if the agent accepts them). */
  native: AdapterAttachment[];
  /** Everything to keep for the history (content + verified type). */
  stored: { name: string; mimeType: string; data: Buffer }[];
}

/** Validates the attachments according to the agent's capabilities and prepares what will be sent. */
export function prepareAttachments(text: string, incoming: OutgoingAttachment[], caps: Capabilities): Prepared {
  if (incoming.length > LIMITS.maxFiles) throw new AttachmentError(`Too many files (maximum ${LIMITS.maxFiles}).`);
  const out: Prepared = { agentText: text, native: [], stored: [] };
  let total = 0;
  let inlined = 0;
  const blocks: string[] = [];
  for (const a of incoming) {
    const name = sanitizeName(a.name);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(a.data)) throw new AttachmentError(`"${name}": invalid content.`);
    const data = Buffer.from(a.data, 'base64');
    if (data.length === 0) throw new AttachmentError(`"${name}" is empty.`);
    total += data.length;
    if (total > LIMITS.maxTotalBytes) throw new AttachmentError('Attachments too large (25 MB in total).');
    if (data.length > caps.attachments.maxBytes) throw new AttachmentError(`"${name}" exceeds the maximum size of this agent (${Math.round(caps.attachments.maxBytes / 1048576)} MB).`);

    const img = sniffImage(data);
    if (img) {
      if (!caps.attachments.images) throw new AttachmentError(`This agent does not accept images ("${name}").`);
      if (data.length > LIMITS.maxImageBytes) throw new AttachmentError(`Image "${name}" too large (maximum ${LIMITS.maxImageBytes / 1048576} MB).`);
      out.native.push({ kind: 'image', name, mimeType: img, data });
      out.stored.push({ name, mimeType: img, data });
    } else if (looksLikeText(name, a.mimeType, data)) {
      inlined += data.length;
      if (data.length > LIMITS.maxInlineTextBytes || inlined > LIMITS.maxInlineTextTotal) {
        throw new AttachmentError(`Text file "${name}" is too long to be inserted in the message (maximum ${LIMITS.maxInlineTextBytes / 1000} KB).`);
      }
      const body = data.toString('utf8');
      const fence = '~'.repeat(Math.max(3, ...(body.match(/~+/g) ?? []).map((m) => m.length + 1)));
      blocks.push(`Attached file "${name}":\n${fence}\n${body}\n${fence}`);
      out.stored.push({ name, mimeType: a.mimeType || 'text/plain', data });
    } else if (caps.attachments.files) {
      out.native.push({ kind: 'file', name, mimeType: a.mimeType || 'application/octet-stream', data });
      out.stored.push({ name, mimeType: a.mimeType || 'application/octet-stream', data });
    } else {
      throw new AttachmentError(`"${name}": this agent only accepts images and text files (not this file type).`);
    }
  }
  if (blocks.length) out.agentText = [text, ...blocks].filter(Boolean).join('\n\n');
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AttachmentStore {
  constructor(private db: DB, private dir: string) {}

  /** Folder of a conversation's files. The id is always a UUID made by the server; anything else never becomes a path. */
  private folder(convId: string): string {
    if (!UUID_RE.test(convId)) throw new Error('Invalid conversation id');
    return safeJoin(this.dir, 'uploads', convId);
  }

  save(messageId: string, convId: string, files: Prepared['stored']): AttachmentMeta[] {
    const metas: AttachmentMeta[] = [];
    const folder = this.folder(convId);
    mkdirSync(folder, { recursive: true });
    for (const f of files) {
      const id = randomUUID();
      const path = safeJoin(folder, id);
      writeFileSync(path, f.data, { mode: 0o600 });
      const mimeType = effectiveMime(f.name, f.mimeType, f.data);
      this.db
        .prepare('INSERT INTO attachments (id, message_id, name, mime_type, size, path) VALUES (?,?,?,?,?,?)')
        .run(id, messageId, f.name, mimeType, f.data.length, path);
      metas.push({ id, name: f.name, mimeType, size: f.data.length });
    }
    return metas;
  }

  get(id: string): { name: string; mimeType: string; path: string } | undefined {
    const r = this.db.prepare('SELECT name, mime_type, path FROM attachments WHERE id = ?').get(id) as
      | { name: string; mime_type: string; path: string }
      | undefined;
    return r && { name: r.name, mimeType: r.mime_type, path: r.path };
  }

  removeConversation(convId: string): void {
    rmSync(this.folder(convId), { recursive: true, force: true });
  }
}
