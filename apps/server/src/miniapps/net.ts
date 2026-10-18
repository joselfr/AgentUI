import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { AppError } from './store.js';

export const FETCH_LIMITS = { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024, maxRedirects: 3, maxCalls: 10, maxRequestBytes: 512 * 1024 };

/** Loopback, private, link-local, CGNAT, multicast… : never reachable from an app (internal containers, metadata services). */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  if (isIP(a) === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('ff');
  }
  const [x = 0, y = 0] = a.split('.').map(Number);
  return x === 0 || x === 10 || x === 127 || x >= 224 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 192 && y === 0) || (x === 198 && (y === 18 || y === 19));
}

export interface AppFetchResult {
  status: number;
  ok: boolean;
  url: string;
  headers: Record<string, string>;
  text: string;
}

/** `lookup` used for the actual connection: the check applies to the address really connected to (no DNS rebinding window). */
const makeLookup = (allowPrivate: boolean): typeof dnsLookup => (((host: string, opts: unknown, cb: (...a: unknown[]) => void) => {
  const options = typeof opts === 'function' ? {} : (opts as object);
  const done = (typeof opts === 'function' ? opts : cb) as (...a: unknown[]) => void;
  dnsLookup(host, { ...options, all: true }, (err, addrs) => {
    if (err) return done(err);
    const list = addrs as unknown as { address: string; family: number }[];
    const bad = allowPrivate ? undefined : list.find((a) => isPrivateAddress(a.address));
    if (bad || !list.length) return done(new AppError(`Requests to private or internal addresses are not allowed (${host}).`));
    if ((options as { all?: boolean }).all) return done(null, list);
    done(null, list[0]!.address, list[0]!.family);
  });
}) as unknown) as typeof dnsLookup;

function once(url: URL, init: { method: string; headers: Record<string, string>; body?: string }, allowPrivate: boolean): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      { method: init.method, headers: init.headers, lookup: makeLookup(allowPrivate) as never, timeout: FETCH_LIMITS.timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > FETCH_LIMITS.maxBytes) return req.destroy(new AppError('Response too large (2 MB maximum).'));
          chunks.push(c);
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new AppError('Request timed out.')));
    req.on('error', (e) => reject(e instanceof AppError ? e : new AppError(`Network error: ${(e as Error).message}`)));
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

const STRIP_ON_REDIRECT = ['authorization', 'cookie', 'proxy-authorization'];

/** `ctx.fetch(url, { method?, headers?, body? })` of the app backends: http(s) only, public addresses only, bounded size/time. */
/** `allowPrivate` is for tests only: the sandbox never sets it. */
export async function appFetch(rawUrl: unknown, rawInit: unknown, allowPrivate = false): Promise<AppFetchResult> {
  let url: URL;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new AppError('Invalid URL.');
  }
  const init = (rawInit && typeof rawInit === 'object' ? rawInit : {}) as { method?: string; headers?: Record<string, unknown>; body?: unknown };
  let method = String(init.method ?? 'GET').toUpperCase();
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method)) throw new AppError(`Method ${method} is not allowed.`);
  const headers: Record<string, string> = { 'user-agent': 'AgentUI-App/1', accept: '*/*' };
  for (const [k, v] of Object.entries(init.headers ?? {})) if (typeof v === 'string' && /^[A-Za-z0-9-]+$/.test(k) && k.toLowerCase() !== 'host') headers[k.toLowerCase()] = v;
  let body: string | undefined;
  if (init.body !== undefined && init.body !== null && method !== 'GET' && method !== 'HEAD') {
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    if (typeof init.body !== 'string' && !headers['content-type']) headers['content-type'] = 'application/json';
    if (Buffer.byteLength(body) > FETCH_LIMITS.maxRequestBytes) throw new AppError('Request body too large.');
  }
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError('Only http(s) URLs are allowed.');
    if (!allowPrivate && isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
      throw new AppError(`Requests to private or internal addresses are not allowed (${url.hostname}).`);
    }
    const res = await once(url, { method, headers, body }, allowPrivate);
    const loc = res.headers.location;
    if (res.status >= 300 && res.status < 400 && loc) {
      if (hop >= FETCH_LIMITS.maxRedirects) throw new AppError('Too many redirects.');
      const next = new URL(loc, url);
      if (next.origin !== url.origin) for (const h of STRIP_ON_REDIRECT) delete headers[h];
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
      url = next;
      continue;
    }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, url: url.toString(), headers: res.headers, text: res.body.toString('utf8') };
  }
}
