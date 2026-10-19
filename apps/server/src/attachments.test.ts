import { deflateSync } from 'node:zlib';
import { expect, test } from 'vitest';
import type { Capabilities } from '@agentui/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentError, AttachmentStore, prepareAttachments, sanitizeName, sniffImage } from './attachments.js';
import { openDb } from './db.js';

const caps = (images: boolean, files: boolean, maxBytes = 20 * 1048576): Capabilities =>
  ({ attachments: { images, files, maxBytes } }) as unknown as Capabilities;
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), deflateSync(Buffer.from('x'))]);
const PDF = Buffer.from('%PDF-1.4\n\u0000\u0001binary');

test('image: type checked from the bytes, not from the announced type', () => {
  expect(sniffImage(PNG)).toBe('image/png');
  const r = prepareAttachments('regarde', [{ name: 'a.png', mimeType: 'application/octet-stream', data: b64(PNG) }], caps(true, false));
  expect(r.native).toMatchObject([{ kind: 'image', mimeType: 'image/png', name: 'a.png' }]);
  expect(() => prepareAttachments('', [{ name: 'a.png', mimeType: 'image/png', data: b64(PNG) }], caps(false, false))).toThrow(/does not accept images/);
});

test('text file: inserted in the message for any agent, whatever the "files" capability', () => {
  const r = prepareAttachments('read this', [{ name: 'notes.md', mimeType: '', data: b64('# Title\n~~~ trap ~~~') }], caps(false, false));
  expect(r.native).toEqual([]);
  expect(r.agentText).toContain('"notes.md"');
  expect(r.agentText).toContain('# Title');
  expect(r.agentText.startsWith('read this')).toBe(true);
  expect(r.agentText).toMatch(/\n~{4,}\n# Title/); // the fence is longer than the one in the content
});

test('binary: accepted only if the agent handles files, otherwise a clear message', () => {
  const a = { name: 'doc.pdf', mimeType: 'application/pdf', data: b64(PDF) };
  expect(prepareAttachments('', [a], caps(true, true)).native).toMatchObject([{ kind: 'file', name: 'doc.pdf' }]);
  expect(() => prepareAttachments('', [a], caps(true, false))).toThrow(AttachmentError);
  expect(() => prepareAttachments('', [a], caps(true, false))).toThrow(/doc\.pdf.*images and text files/);
});

test('limits: size, count, invalid base64, text too long, SVG treated as text', () => {
  expect(() => prepareAttachments('', [{ name: 'x.bin', mimeType: '', data: b64(Buffer.alloc(2000, 1)) }], caps(true, true, 1000))).toThrow(/exceeds the maximum size/);
  expect(() => prepareAttachments('', Array.from({ length: 9 }, () => ({ name: 'a.txt', mimeType: '', data: b64('a') })), caps(true, true))).toThrow(/Too many files/);
  expect(() => prepareAttachments('', [{ name: 'a.txt', mimeType: '', data: '!!not base64!!' }], caps(true, true))).toThrow(/invalid/);
  expect(() => prepareAttachments('', [{ name: 'big.txt', mimeType: 'text/plain', data: b64('a'.repeat(250_000)) }], caps(true, true))).toThrow(/too long/);
  const svg = prepareAttachments('', [{ name: 'i.svg', mimeType: 'image/svg+xml', data: b64('<svg onload="x()"/>') }], caps(true, false));
  expect(svg.native).toEqual([]); // never sent as an image
});

test('sanitized file names', () => {
  expect(sanitizeName('../../etc/passwd')).toBe('passwd');
  expect(sanitizeName('C:\\x\\rapport "final".pdf')).toBe('rapport _final_.pdf');
  expect(sanitizeName('')).toBe('file');
});

test('the files folder of a conversation only comes from a UUID, never from another string', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentui-att-'));
  try {
    const store = new AttachmentStore(openDb(dir), dir);
    for (const bad of ['../../etc', 'home', '', 'a/b', '..', '00000000-0000-0000-0000-00000000000/../x']) {
      expect(() => store.save('m1', bad, [])).toThrow(/Invalid conversation id/);
      expect(() => store.removeConversation(bad)).toThrow(/Invalid conversation id/);
    }
    const id = '123e4567-e89b-42d3-a456-426614174000';
    expect(() => store.save('m1', id, [])).not.toThrow();
    expect(() => store.removeConversation(id)).not.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
