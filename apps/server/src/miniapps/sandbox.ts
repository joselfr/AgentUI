import { constants, createHash, createHmac, randomBytes, sign as cryptoSign, verify as cryptoVerify, randomUUID, timingSafeEqual } from 'node:crypto';
import { MessageChannel, Worker } from 'node:worker_threads';
import type { AppData } from './data.js';
import { appFetch, FETCH_LIMITS } from './net.js';
import type { AppFs } from './fs.js';
import { AppError } from './store.js';

export interface SandboxRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  /** Public (unauthenticated) calls only: request headers (without cookies) and the body as received, for signature checks. */
  headers?: Record<string, string>;
  rawBody?: string;
}
export interface SandboxResult {
  status: number;
  body: unknown;
  /** Response headers requested by the handler via `ctx.status(code, body, headers)`, already validated (see `sanitizeHeaders`). */
  headers?: Record<string, string>;
}

/** Response headers a handler may set. Everything else is ignored (never `set-cookie`, `content-length`, `transfer-encoding`…). */
export const ALLOWED_RESPONSE_HEADERS = ['location', 'content-type', 'cache-control', 'retry-after'] as const;
const HEADER_LIMITS = { maxHeaders: 10, maxValueBytes: 1024 };

/** Validates, on the HOST side, the headers a handler asked for. Rejected headers are dropped and logged: the request never fails because of them. */
export function sanitizeHeaders(raw: unknown, log: (line: string) => void = () => {}): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) { log('headers ignored: must be a plain object'); return undefined; }
  const out: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > HEADER_LIMITS.maxHeaders) log(`headers: only the first ${HEADER_LIMITS.maxHeaders} are considered`);
  for (const [k, v] of entries.slice(0, HEADER_LIMITS.maxHeaders)) {
    const name = k.toLowerCase();
    if (name === 'set-cookie' || name === 'content-length' || name === 'transfer-encoding') { log(`header "${name}" refused`); continue; }
    if (!(ALLOWED_RESPONSE_HEADERS as readonly string[]).includes(name)) { log(`header "${name}" ignored (not allowed)`); continue; }
    if (typeof v !== 'string' || /[\u0000-\u001f\u007f]/.test(v) || Buffer.byteLength(v) > HEADER_LIMITS.maxValueBytes) { log(`header "${name}" ignored (invalid value)`); continue; }
    out[name] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Hash / HMAC algorithms exposed to handlers (`ctx.crypto`). */
export const CRYPTO_ALGOS = ['md5', 'sha1', 'sha256', 'sha384', 'sha512'];
/** JWT-style signature algorithms for `ctx.crypto.sign` / `verify`: digest, and padding (RSA-PSS) or raw r||s encoding (ECDSA). */
const SIGN_ALGOS: Record<string, { hash: string; pss?: boolean; ec?: boolean }> = {
  RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: true }, PS384: { hash: 'sha384', pss: true }, PS512: { hash: 'sha512', pss: true },
  ES256: { hash: 'sha256', ec: true }, ES384: { hash: 'sha384', ec: true }, ES512: { hash: 'sha512', ec: true },
};
const MAX_KEY_CHARS = 16 * 1024;
export const SANDBOX_LIMITS = { timeoutMs: 3000, maxResponseBytes: 2 * 1024 * 1024, maxCalls: 2000, maxTotalMs: 30_000 };

/**
 * Worker code. One worker per request: it is killed at the timeout.
 * The handler runs in a `vm` context without Node globals, without `eval`/`new Function`; the only door to the
 * outside is a host function, captured in a closure of the bootstrap and removed from the global scope, which exchanges
 * JSON strings only (synchronously, via Atomics) with the main thread, which scopes every data access to the miniapp.
 * Best-effort isolation for code written by the user's own agent, not a barrier against a determined attacker.
 */
const WORKER_CODE = `
const { workerData, parentPort, receiveMessageOnPort } = require('node:worker_threads');
const vm = require('node:vm');
const flag = new Int32Array(workerData.sab);
let calls = 0;
function hostCall(op, argsJson) {
  const waitMs = op === 'fetch' ? workerData.fetchWaitMs : workerData.timeoutMs;
  if (++calls > workerData.maxCalls) return JSON.stringify({ ok: false, e: 'Too many data calls in one request.' });
  Atomics.store(flag, 0, 0);
  parentPort.postMessage({ t: 'call', op: String(op), args: String(argsJson) });
  if (Atomics.wait(flag, 0, 0, waitMs) === 'timed-out') return JSON.stringify({ ok: false, e: 'Data call timed out.' });
  const m = receiveMessageOnPort(workerData.port);
  return m ? m.message : JSON.stringify({ ok: false, e: 'No answer.' });
}
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
const boot = vm.runInContext(\`(function (call, inputJson) {
  'use strict';
  const input = JSON.parse(inputJson);
  const rpc = (op, args) => {
    const r = JSON.parse(call(op, JSON.stringify(args === undefined ? null : args)));
    if (!r.ok) throw new Error(r.e);
    return r.v;
  };
  const log = (...a) => { rpc('log', { m: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') }); };
  globalThis.console = { log, info: log, warn: log, error: log, debug: log };
  const ctx = {
    user: input.user,
    db: { collection: (c) => ({
      find: (filter, opts) => rpc('db.find', { c, filter, opts }),
      get: (id) => rpc('db.get', { c, id }),
      insert: (doc) => rpc('db.insert', { c, doc }),
      update: (id, patch) => rpc('db.update', { c, id, patch }),
      remove: (id) => rpc('db.remove', { c, id }),
    }) },
    kv: { get: (k) => rpc('kv.get', { k }), set: (k, v) => rpc('kv.set', { k, v }), delete: (k) => rpc('kv.delete', { k }) },
    fetch: (url, init) => {
      const r = rpc('fetch', { url: String(url), init: init === undefined ? null : init });
      return { status: r.status, ok: r.ok, url: r.url, headers: r.headers, text: r.text, json: () => JSON.parse(r.text) };
    },
    crypto: {
      hash: (algo, data, enc) => rpc('crypto.hash', { algo, data, enc }),
      hmac: (algo, key, data, enc) => rpc('crypto.hmac', { algo, key, data, enc }),
      randomBytes: (n, enc) => rpc('crypto.randomBytes', { n, enc }),
      randomUUID: () => rpc('crypto.randomUUID', {}),
      timingSafeEqual: (a, b) => rpc('crypto.timingSafeEqual', { a, b }),
      sign: (algo, privateKey, data, enc) => rpc('crypto.sign', { algo, key: privateKey, data, enc }),
      verify: (algo, publicKey, data, signature, enc) => rpc('crypto.verify', { algo, key: publicKey, data, signature, enc }),
      base64url: (data) => rpc('crypto.base64url', { data }),
      fromBase64url: (data) => rpc('crypto.fromBase64url', { data }),
    },
    fs: {
      readFile: (path, encoding) => rpc('fs.readFile', { path, encoding }),
      writeFile: (path, content, encoding) => rpc('fs.writeFile', { path, content, encoding }),
      readdir: (path) => rpc('fs.readdir', { path }),
      stat: (path) => rpc('fs.stat', { path }),
      mkdir: (path) => rpc('fs.mkdir', { path }),
      remove: (path) => rpc('fs.remove', { path }),
    },
    log,
    status: (status, body, headers) => ({ __status: status, body, __headers: headers }),
  };
  globalThis.crypto = ctx.crypto;
  const mod = { exports: {} };
  return { ctx, mod, req: input.req };
})\`, context, { filename: 'agentui-boot' });

function out(msg) { parentPort.postMessage(Object.assign({ t: 'done' }, msg)); }
(async () => {
  const { ctx, mod, req } = boot(hostCall, workerData.input);
  const fn = vm.runInContext('(function (module, exports) { "use strict";\\n' + workerData.code + '\\n})', context, { filename: 'app-handler', timeout: workerData.timeoutMs });
  fn(mod, mod.exports);
  const h = mod.exports[req.method] || mod.exports.default;
  if (typeof h !== 'function') return out({ status: 405, json: JSON.stringify({ error: 'Method ' + req.method + ' not implemented by this route.' }) });
  const r = await h(req, ctx);
  const res = r && typeof r === 'object' && '__status' in r ? { status: r.__status, body: r.body, headers: r.__headers } : { status: 200, body: r === undefined ? null : r };
  const json = JSON.stringify(res.body === undefined ? null : res.body);
  // Headers cross as JSON text only; the HOST validates them.
  let hjson; try { hjson = res.headers === undefined ? undefined : JSON.stringify(res.headers); } catch (e) { hjson = undefined; }
  out({ status: Number(res.status) || 200, json, hjson });
})().catch((e) => out({ status: 500, error: String((e && e.stack) || e).slice(0, 2000) }));
`;

/** Runs a compiled handler (`cjs`) for one request. Data calls are served by the main thread through `data`. */
export function runHandler(opts: {
  code: string;
  appId: string;
  req: SandboxRequest;
  user: { id: number; username: string } | null;
  data: AppData;
  /** Approved file grants of the miniapp (none → `ctx.fs` calls fail). */
  fs?: AppFs;
  log: (line: string) => void;
  /** Called when the handler wrote data (insert / update / remove / kv). */
  onData?: () => void;
}): Promise<SandboxResult> {
  const { appId, data } = opts;
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(WORKER_CODE, {
    eval: true,
    env: {},
    argv: [],
    execArgv: [],
    stdout: true,
    stderr: true,
    workerData: {
      sab,
      port: port2,
      code: opts.code,
      input: JSON.stringify({ req: opts.req, user: opts.user }),
      timeoutMs: SANDBOX_LIMITS.timeoutMs,
      fetchWaitMs: FETCH_LIMITS.timeoutMs * (FETCH_LIMITS.maxRedirects + 1) + 2000,
      maxCalls: SANDBOX_LIMITS.maxCalls,
    },
    transferList: [port2],
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
  });

  const fsOf = () => {
    if (!opts.fs) throw new AppError('fs: this miniapp has no approved file access.');
    return opts.fs;
  };
  const algoOf = (v: unknown) => {
    if (typeof v !== 'string' || !CRYPTO_ALGOS.includes(v.toLowerCase())) throw new AppError(`crypto: algorithm must be one of ${CRYPTO_ALGOS.join(', ')}.`);
    return v.toLowerCase();
  };
  const signOpts = (v: unknown) => {
    const g = typeof v === 'string' ? SIGN_ALGOS[v] : undefined;
    if (!g) throw new AppError(`crypto: signature algorithm must be one of ${Object.keys(SIGN_ALGOS).join(', ')}.`);
    return g;
  };
  const keyOf = (v: unknown, g: { pss?: boolean; ec?: boolean }) => {
    if (typeof v !== 'string' || v.length > MAX_KEY_CHARS || !v.includes('-----BEGIN')) throw new AppError('crypto: the key must be a PEM string.');
    return { key: v, ...(g.pss ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : {}), ...(g.ec ? { dsaEncoding: 'ieee-p1363' as const } : {}) };
  };
  const encOf = (v: unknown, dflt: 'hex' | 'base64url' = 'hex'): 'hex' | 'base64' | 'base64url' => {
    if (v === undefined || v === null) return dflt;
    if (v === 'hex' || v === 'base64' || v === 'base64url') return v;
    throw new AppError('crypto: encoding must be hex, base64 or base64url.');
  };
  const strOf = (v: unknown) => {
    if (typeof v !== 'string') throw new AppError('crypto: data and keys must be strings.');
    if (v.length > SANDBOX_LIMITS.maxResponseBytes) throw new AppError('crypto: input too large.');
    return v;
  };
  let fetches = 0;
  const dispatch = async (op: string, a: any): Promise<unknown> => {
    switch (op) {
      case 'fetch':
        if (++fetches > FETCH_LIMITS.maxCalls) throw new AppError('Too many network calls in one request.');
        return appFetch(a.url, a.init);
      case 'crypto.hash': return createHash(algoOf(a.algo)).update(strOf(a.data)).digest(encOf(a.enc));
      case 'crypto.hmac': return createHmac(algoOf(a.algo), strOf(a.key)).update(strOf(a.data)).digest(encOf(a.enc));
      case 'crypto.randomBytes': {
        const n = Number(a.n);
        if (!Number.isInteger(n) || n < 1 || n > 1024) throw new AppError('crypto.randomBytes: n must be an integer between 1 and 1024.');
        return randomBytes(n).toString(encOf(a.enc));
      }
      case 'crypto.sign': {
        const g = signOpts(a.algo);
        try { return cryptoSign(g.hash, Buffer.from(strOf(a.data)), keyOf(a.key, g)).toString(encOf(a.enc, 'base64url')); }
        catch (e) { throw new AppError(`crypto.sign: ${(e as Error).message.split('\n')[0]!.slice(0, 200)}`); }
      }
      case 'crypto.verify': {
        const g = signOpts(a.algo);
        try { return cryptoVerify(g.hash, Buffer.from(strOf(a.data)), keyOf(a.key, g), Buffer.from(strOf(a.signature), encOf(a.enc, 'base64url'))); }
        catch (e) { throw new AppError(`crypto.verify: ${(e as Error).message.split('\n')[0]!.slice(0, 200)}`); }
      }
      case 'crypto.base64url': return Buffer.from(strOf(a.data)).toString('base64url');
      case 'crypto.fromBase64url': return Buffer.from(strOf(a.data), 'base64url').toString('utf8');
      case 'crypto.randomUUID': return randomUUID();
      case 'crypto.timingSafeEqual': {
        const x = Buffer.from(strOf(a.a)), y = Buffer.from(strOf(a.b));
        return x.length === y.length && timingSafeEqual(x, y);
      }
      case 'fs.readFile': return fsOf().readFile(a.path, a.encoding);
      case 'fs.writeFile': return fsOf().writeFile(a.path, a.content, a.encoding);
      case 'fs.readdir': return fsOf().readdir(a.path);
      case 'fs.stat': return fsOf().stat(a.path);
      case 'fs.mkdir': return fsOf().mkdir(a.path);
      case 'fs.remove': return fsOf().remove(a.path);
      case 'log': opts.log(String(a.m).slice(0, 500)); return true;
      case 'db.find': return data.find(appId, a.c, a.filter ?? undefined, a.opts ?? undefined);
      case 'db.get': return data.get(appId, a.c, a.id);
      case 'db.insert': opts.onData?.(); return data.insert(appId, a.c, a.doc);
      case 'db.update': opts.onData?.(); return data.update(appId, a.c, a.id, a.patch);
      case 'db.remove': opts.onData?.(); return data.remove(appId, a.c, a.id);
      case 'kv.get': return data.kvGet(appId, a.k);
      case 'kv.set': opts.onData?.(); return data.kvSet(appId, a.k, a.v);
      case 'kv.delete': opts.onData?.(); return data.kvDelete(appId, a.k);
      default: throw new AppError(`Unknown operation ${op}`);
    }
  };

  return new Promise<SandboxResult>((resolve) => {
    let settled = false;
    let total: ReturnType<typeof setTimeout>;
    const finish = (r: SandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(total);
      void worker.terminate();
      port1.close();
      resolve(r);
    };
    // Two clocks: the handler's own computation (restarted after each host call, so a loop is killed fast) and a total cap.
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        opts.log(`timeout: ${opts.req.method} ${opts.req.path}`);
        finish({ status: 504, body: { error: 'The miniapp handler took too long.' } });
      }, SANDBOX_LIMITS.timeoutMs + 500);
    };
    total = setTimeout(() => {
      opts.log(`timeout (total): ${opts.req.method} ${opts.req.path}`);
      finish({ status: 504, body: { error: 'The miniapp handler took too long.' } });
    }, SANDBOX_LIMITS.maxTotalMs);
    arm();
    worker.on('message', (m: any) => {
      if (m.t === 'call') {
        clearTimeout(timer); // waiting on the host (data, network): not the handler's CPU time
        void (async () => {
          let res: string;
          try {
            res = JSON.stringify({ ok: true, v: (await dispatch(m.op, JSON.parse(m.args))) ?? null });
          } catch (e) {
            res = JSON.stringify({ ok: false, e: (e as Error).message });
          }
          if (settled) return;
          port1.postMessage(res);
          Atomics.store(flag, 0, 1);
          Atomics.notify(flag, 0);
          arm();
        })();
      } else if (m.t === 'done') {
        if (m.error) {
          opts.log(`error: ${m.error.split('\n')[0]}`);
          return finish({ status: 500, body: { error: 'Handler error', detail: String(m.error).split('\n')[0] } });
        }
        if (m.json.length > SANDBOX_LIMITS.maxResponseBytes) return finish({ status: 500, body: { error: 'Response too large.' } });
        let headers: Record<string, string> | undefined;
        try { headers = sanitizeHeaders(typeof m.hjson === 'string' ? JSON.parse(m.hjson) : undefined, (l) => opts.log(l)); } catch { opts.log('headers ignored: not valid JSON'); }
        finish({ status: m.status, body: JSON.parse(m.json), ...(headers ? { headers } : {}) });
      }
    });
    worker.on('error', (e) => {
      opts.log(`worker error: ${e.message}`);
      finish({ status: 500, body: { error: 'Handler crashed', detail: e.message.slice(0, 300) } });
    });
    worker.on('exit', () => finish({ status: 500, body: { error: 'Handler exited unexpectedly' } }));
  });
}
