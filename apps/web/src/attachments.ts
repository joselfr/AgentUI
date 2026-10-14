import type { AttachmentMeta, Capabilities, OutgoingAttachment } from '@agentui/shared';

/** Pièce jointe affichée : celles qui viennent d'être envoyées gardent une URL locale (blob:) en attendant le rechargement. */
export type AttachmentView = AttachmentMeta & { url?: string };

export const MAX_FILES = 8;
export const MAX_TOTAL = 25 * 1024 * 1024;
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
const TEXT_EXT = new Set(
  'txt md markdown csv tsv json jsonl yaml yml toml ini cfg conf env log xml html htm css scss js mjs cjs ts tsx jsx py rb go rs java kt c h cpp hpp cs php sh bash zsh fish sql graphql svg tex rst diff patch dockerfile makefile'.split(' '),
);

export const isImage = (mime: string) => IMAGE.test(mime);
const isTextLike = (f: File) =>
  /^(text\/|application\/(json|xml|x-yaml|yaml|toml|javascript|x-sh|sql))/.test(f.type) ||
  TEXT_EXT.has((f.name.split('.').pop() ?? f.name).toLowerCase());

export const formatSize = (n: number) => (n < 1024 ? `${n} o` : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${(n / 1048576).toFixed(1)} Mo`);

/** Contrôle côté client (confort) ; le serveur revalide tout. Retourne un message d'erreur ou null. */
export function checkFile(f: File, current: File[], caps: Capabilities['attachments']): string | null {
  if (current.length >= MAX_FILES) return `Maximum ${MAX_FILES} fichiers par message.`;
  if (f.size === 0) return `« ${f.name} » est vide.`;
  if (f.size > caps.maxBytes) return `« ${f.name} » dépasse ${formatSize(caps.maxBytes)}.`;
  if (current.reduce((n, x) => n + x.size, f.size) > MAX_TOTAL) return 'Pièces jointes trop volumineuses (25 Mo au total).';
  if (isImage(f.type)) return caps.images ? (f.size > 6 * 1048576 ? `Image « ${f.name} » trop grande (6 Mo maximum).` : null) : `Cet agent n'accepte pas les images.`;
  if (isTextLike(f)) return f.size > 200_000 ? `Fichier texte « ${f.name} » trop long (200 Ko maximum).` : null;
  return caps.files ? null : `« ${f.name} » : cet agent n'accepte que les images et les fichiers texte.`;
}

async function toBase64(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function toOutgoing(files: File[]): Promise<OutgoingAttachment[]> {
  return Promise.all(files.map(async (f) => ({ name: f.name, mimeType: f.type, data: await toBase64(f) })));
}
