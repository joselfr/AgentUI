import { deflateSync } from 'node:zlib';
import { expect, test } from 'vitest';
import type { Capabilities } from '@agentui/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentError, AttachmentStore, effectiveMime, parseRange, prepareAttachments, sanitizeName, sniffImage, sniffMedia } from './attachments.js';
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

test('safeJoin stays inside its base', async () => {
  const { safeJoin } = await import('./safe-path.js');
  expect(safeJoin('/data', 'uploads', 'abc')).toBe('/data/uploads/abc');
  expect(safeJoin('/data', '.')).toBe('/data');
  for (const bad of [['..'], ['a', '..', '..', 'etc'], ['/etc/passwd'], ['../data2']]) expect(() => safeJoin('/data', ...bad)).toThrow(/leaves its folder/);
  expect(() => safeJoin('/data', '../data-other')).toThrow(); // a sibling sharing the prefix is outside too
});

const box = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftyp' + brand), Buffer.alloc(16)]);

test('sniffMedia: recognizes video, audio and PDF by content', () => {
  expect(sniffMedia(box('isom'))).toBe('video/mp4');
  expect(sniffMedia(box('qt  '))).toBe('video/quicktime');
  expect(sniffMedia(box('M4A '))).toBe('audio/mp4');
  expect(sniffMedia(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0]))).toBe('video/webm');
  expect(sniffMedia(Buffer.from('OggS\0\0\0\0'))).toBe('audio/ogg');
  expect(sniffMedia(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBe('audio/wav');
  expect(sniffMedia(Buffer.from('ID3\x04\0\0\0\0\0\0'))).toBe('audio/mpeg');
  expect(sniffMedia(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe('audio/mpeg');
  expect(sniffMedia(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
  expect(sniffMedia(Buffer.from('hello world, not a media'))).toBeNull();
});

test('effectiveMime: verified type wins, an unverified media type is never kept, Markdown by extension', () => {
  expect(effectiveMime('clip.bin', 'application/octet-stream', box('isom'))).toBe('video/mp4');
  expect(effectiveMime('evil.mp4', 'video/mp4', Buffer.from('<script>alert(1)</script>'))).toBe('application/octet-stream');
  expect(effectiveMime('evil.pdf', 'application/pdf', Buffer.from('<html>'))).toBe('application/octet-stream');
  expect(effectiveMime('notes.md', 'application/octet-stream', Buffer.from('# Title'))).toBe('text/markdown');
  expect(effectiveMime('notes.md', 'application/octet-stream', Buffer.from([0, 1, 2]))).toBe('application/octet-stream');
  expect(effectiveMime('a.txt', 'text/plain', Buffer.from('hi'))).toBe('text/plain');
});

test('parseRange: byte ranges', () => {
  expect(parseRange(undefined, 1000)).toBeNull();
  expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
  expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
  expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  expect(parseRange('bytes=500-5000', 1000)).toEqual({ start: 500, end: 999 });
  expect(parseRange('bytes=1000-', 1000)).toBe('invalid');
  expect(parseRange('bytes=50-10', 1000)).toBe('invalid');
  expect(parseRange('bytes=abc', 1000)).toBe('invalid');
  expect(parseRange('bytes=0-1,5-9', 1000)).toBeNull();
});
