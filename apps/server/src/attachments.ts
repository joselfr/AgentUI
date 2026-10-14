import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterAttachment, Capabilities, OutgoingAttachment } from '@agentui/shared';
import type { DB } from './db.js';

export const LIMITS = {
  maxFiles: 8,
  maxTotalBytes: 25 * 1024 * 1024,
  maxImageBytes: 6 * 1024 * 1024, // limite d'OpenClaw pour une image inline
  maxInlineTextBytes: 200_000, // par fichier texte inséré dans le message
  maxInlineTextTotal: 400_000,
};

/** Erreur de validation destinée à l'utilisateur (HTTP 400). */
export class AttachmentError extends Error {}

const TEXT_EXT = new Set(
  'txt md markdown csv tsv json jsonl yaml yml toml ini cfg conf env log xml html htm css scss js mjs cjs ts tsx jsx py rb go rs java kt c h cpp hpp cs php sh bash zsh fish sql graphql svg tex rst diff patch dockerfile makefile'.split(' '),
);
const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|toml|javascript|x-sh|sql|x-ndjson)|image\/svg\+xml)/;

export const sanitizeName = (n: string): string =>
  (n.split(/[\\/]/).pop() ?? 'fichier').replace(/[\u0000-\u001f"<>|:*?]/g, '_').trim().slice(0, 120) || 'fichier';

/** Détecte le vrai type d'une image par ses premiers octets (le type annoncé par le client n'est pas fiable). */
export function sniffImage(b: Buffer): string | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function looksLikeText(name: string, mime: string, b: Buffer): boolean {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : name.toLowerCase();
  if (!(TEXT_MIME.test(mime) || TEXT_EXT.has(ext))) return false;
  return !b.subarray(0, 8000).includes(0); // un octet nul = binaire
}

export interface Prepared {
  /** Texte réellement envoyé à l'agent (fichiers texte insérés). */
  agentText: string;
  /** Pièces jointes natives (images, et fichiers binaires si l'agent les accepte). */
  native: AdapterAttachment[];
  /** Tout ce qui est à conserver pour l'historique (contenu + type vérifié). */
  stored: { name: string; mimeType: string; data: Buffer }[];
}

/** Valide les pièces jointes selon les capacités de l'agent et prépare ce qui sera envoyé. */
export function prepareAttachments(text: string, incoming: OutgoingAttachment[], caps: Capabilities): Prepared {
  if (incoming.length > LIMITS.maxFiles) throw new AttachmentError(`Trop de fichiers (maximum ${LIMITS.maxFiles}).`);
  const out: Prepared = { agentText: text, native: [], stored: [] };
  let total = 0;
  let inlined = 0;
  const blocks: string[] = [];
  for (const a of incoming) {
    const name = sanitizeName(a.name);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(a.data)) throw new AttachmentError(`« ${name} » : contenu invalide.`);
    const data = Buffer.from(a.data, 'base64');
    if (data.length === 0) throw new AttachmentError(`« ${name} » est vide.`);
    total += data.length;
    if (total > LIMITS.maxTotalBytes) throw new AttachmentError('Pièces jointes trop volumineuses (25 Mo au total).');
    if (data.length > caps.attachments.maxBytes) throw new AttachmentError(`« ${name} » dépasse la taille maximale de cet agent (${Math.round(caps.attachments.maxBytes / 1048576)} Mo).`);

    const img = sniffImage(data);
    if (img) {
      if (!caps.attachments.images) throw new AttachmentError(`Cet agent n'accepte pas les images (« ${name} »).`);
      if (data.length > LIMITS.maxImageBytes) throw new AttachmentError(`Image « ${name} » trop grande (maximum ${LIMITS.maxImageBytes / 1048576} Mo).`);
      out.native.push({ kind: 'image', name, mimeType: img, data });
      out.stored.push({ name, mimeType: img, data });
    } else if (looksLikeText(name, a.mimeType, data)) {
      inlined += data.length;
      if (data.length > LIMITS.maxInlineTextBytes || inlined > LIMITS.maxInlineTextTotal) {
        throw new AttachmentError(`Fichier texte « ${name} » trop long pour être inséré dans le message (maximum ${LIMITS.maxInlineTextBytes / 1000} Ko).`);
      }
      const body = data.toString('utf8');
      const fence = '~'.repeat(Math.max(3, ...(body.match(/~+/g) ?? []).map((m) => m.length + 1)));
      blocks.push(`Fichier joint « ${name} » :\n${fence}\n${body}\n${fence}`);
      out.stored.push({ name, mimeType: a.mimeType || 'text/plain', data });
    } else if (caps.attachments.files) {
      out.native.push({ kind: 'file', name, mimeType: a.mimeType || 'application/octet-stream', data });
      out.stored.push({ name, mimeType: a.mimeType || 'application/octet-stream', data });
    } else {
      throw new AttachmentError(`« ${name} » : cet agent n'accepte que les images et les fichiers texte (pas ce type de fichier).`);
    }
  }
  if (blocks.length) out.agentText = [text, ...blocks].filter(Boolean).join('\n\n');
  return out;
}

export class AttachmentStore {
  constructor(private db: DB, private dir: string) {}

  save(messageId: string, convId: string, files: Prepared['stored']): void {
    const folder = join(this.dir, 'uploads', convId);
    mkdirSync(folder, { recursive: true });
    for (const f of files) {
      const id = randomUUID();
      const path = join(folder, id);
      writeFileSync(path, f.data, { mode: 0o600 });
      this.db
        .prepare('INSERT INTO attachments (id, message_id, name, mime_type, size, path) VALUES (?,?,?,?,?,?)')
        .run(id, messageId, f.name, f.mimeType, f.data.length, path);
    }
  }

  get(id: string): { name: string; mimeType: string; path: string } | undefined {
    const r = this.db.prepare('SELECT name, mime_type, path FROM attachments WHERE id = ?').get(id) as
      | { name: string; mime_type: string; path: string }
      | undefined;
    return r && { name: r.name, mimeType: r.mime_type, path: r.path };
  }

  removeConversation(convId: string): void {
    rmSync(join(this.dir, 'uploads', convId), { recursive: true, force: true });
  }
}
