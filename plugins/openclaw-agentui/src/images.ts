// Widget `agentui_image` : une source est une URL https ou un chemin absolu d'un fichier de la machine de l'agent, que le
// plugin copie dans la discussion (message.media) pour que l'utilisateur puisse le voir.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { MAX_MEDIA } from './bridge.js';
import type { Media } from './protocol.js';

export const MAX_IMAGES = 12;
/** Préfixe des pièces jointes copiées pour un widget : le front ne les affiche pas en plus du widget. */
export const IMAGE_PREFIX = 'agentui-img-';
const HTTP = /^https?:\/\//i;

/** Type réel d'une image d'après ses premiers octets (pas l'extension). Ce que l'endpoint des pièces jointes affiche en ligne. */
export function sniffImage(b: Buffer): string | undefined {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

/** Contrôle de forme des sources (avant toute lecture de fichier). */
export function imagesError(args: { images?: Array<{ src?: unknown }> }): string | undefined {
  const images = args.images ?? [];
  if (!images.length || images.length > MAX_IMAGES) return `Il faut entre 1 et ${MAX_IMAGES} images.`;
  for (const [i, im] of images.entries()) {
    const src = String(im.src ?? '');
    if (!(HTTP.test(src) || src.startsWith('/'))) return `Image ${i + 1} : src doit être une URL https://… ou un chemin absolu (pas de data:, file: ni chemin relatif).`;
  }
  return undefined;
}

/** Lit une image locale : lève une erreur lisible par l'agent si le fichier est introuvable, trop gros ou n'est pas une image. */
export async function readLocalImage(path: string, read: (p: string) => Promise<Buffer> = readFile): Promise<Media> {
  let data: Buffer;
  try {
    data = await read(path);
  } catch {
    throw new Error(`Fichier introuvable ou illisible : ${path}`);
  }
  if (data.length > MAX_MEDIA) throw new Error(`${path} dépasse ${MAX_MEDIA / 1024 / 1024} Mo.`);
  const mimeType = sniffImage(data);
  if (!mimeType) throw new Error(`${path} n'est pas une image png, jpeg, gif ou webp.`);
  const name = `${IMAGE_PREFIX}${createHash('sha1').update(data).digest('hex').slice(0, 8)}-${basename(path).replace(/[^\w.-]+/g, '_')}`;
  return { name, mimeType, data: data.toString('base64') };
}
