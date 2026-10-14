import { deflateSync } from 'node:zlib';
import { expect, test } from 'vitest';
import type { Capabilities } from '@agentui/shared';
import { AttachmentError, prepareAttachments, sanitizeName, sniffImage } from './attachments.js';

const caps = (images: boolean, files: boolean, maxBytes = 20 * 1048576): Capabilities =>
  ({ attachments: { images, files, maxBytes } }) as unknown as Capabilities;
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), deflateSync(Buffer.from('x'))]);
const PDF = Buffer.from('%PDF-1.4\n\u0000\u0001binary');

test('image : type vérifié par les octets, pas par le type annoncé', () => {
  expect(sniffImage(PNG)).toBe('image/png');
  const r = prepareAttachments('regarde', [{ name: 'a.png', mimeType: 'application/octet-stream', data: b64(PNG) }], caps(true, false));
  expect(r.native).toMatchObject([{ kind: 'image', mimeType: 'image/png', name: 'a.png' }]);
  expect(() => prepareAttachments('', [{ name: 'a.png', mimeType: 'image/png', data: b64(PNG) }], caps(false, false))).toThrow(/n'accepte pas les images/);
});

test('fichier texte : inséré dans le message pour tout agent, quelle que soit la capacité "files"', () => {
  const r = prepareAttachments('lis ça', [{ name: 'notes.md', mimeType: '', data: b64('# Titre\n~~~ piège ~~~') }], caps(false, false));
  expect(r.native).toEqual([]);
  expect(r.agentText).toContain('« notes.md »');
  expect(r.agentText).toContain('# Titre');
  expect(r.agentText.startsWith('lis ça')).toBe(true);
  expect(r.agentText).toMatch(/\n~{4,}\n# Titre/); // la clôture est plus longue que celle du contenu
});

test('binaire : accepté seulement si l\'agent gère les fichiers, sinon message clair', () => {
  const a = { name: 'doc.pdf', mimeType: 'application/pdf', data: b64(PDF) };
  expect(prepareAttachments('', [a], caps(true, true)).native).toMatchObject([{ kind: 'file', name: 'doc.pdf' }]);
  expect(() => prepareAttachments('', [a], caps(true, false))).toThrow(AttachmentError);
  expect(() => prepareAttachments('', [a], caps(true, false))).toThrow(/doc\.pdf.*images et les fichiers texte/);
});

test('limites : taille, nombre, base64 invalide, texte trop long, SVG traité comme texte', () => {
  expect(() => prepareAttachments('', [{ name: 'x.bin', mimeType: '', data: b64(Buffer.alloc(2000, 1)) }], caps(true, true, 1000))).toThrow(/dépasse la taille/);
  expect(() => prepareAttachments('', Array.from({ length: 9 }, () => ({ name: 'a.txt', mimeType: '', data: b64('a') })), caps(true, true))).toThrow(/Trop de fichiers/);
  expect(() => prepareAttachments('', [{ name: 'a.txt', mimeType: '', data: '!!pas du base64!!' }], caps(true, true))).toThrow(/invalide/);
  expect(() => prepareAttachments('', [{ name: 'gros.txt', mimeType: 'text/plain', data: b64('a'.repeat(250_000)) }], caps(true, true))).toThrow(/trop long/);
  const svg = prepareAttachments('', [{ name: 'i.svg', mimeType: 'image/svg+xml', data: b64('<svg onload="x()"/>') }], caps(true, false));
  expect(svg.native).toEqual([]); // jamais envoyé comme image
});

test('noms de fichiers assainis', () => {
  expect(sanitizeName('../../etc/passwd')).toBe('passwd');
  expect(sanitizeName('C:\\x\\rapport "final".pdf')).toBe('rapport _final_.pdf');
  expect(sanitizeName('')).toBe('fichier');
});
