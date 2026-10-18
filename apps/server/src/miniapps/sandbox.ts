import { MessageChannel, Worker } from 'node:worker_threads';
import type { AppData } from './data.js';
import { appFetch, FETCH_LIMITS } from './net.js';
import { AppError } from './store.js';

export interface SandboxRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}
export interface SandboxResult {
  status: number;
  body: unknown;
}

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
    log,
    status: (status, body) => ({ __status: status, body }),
  };
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
  const res = r && typeof r === 'object' && '__status' in r ? { status: r.__status, body: r.body } : { status: 200, body: r === undefined ? null : r };
  const json = JSON.stringify(res.body === undefined ? null : res.body);
  out({ status: Number(res.status) || 200, json });
})().catch((e) => out({ status: 500, error: String((e && e.stack) || e).slice(0, 2000) }));
`;

/** Runs a compiled handler (`cjs`) for one request. Data calls are served by the main thread through `data`. */
export function runHandler(opts: {
  code: string;
  appId: string;
  req: SandboxRequest;
  user: { id: number; username: string };
  data: AppData;
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

  let fetches = 0;
  const dispatch = async (op: string, a: any): Promise<unknown> => {
    switch (op) {
      case 'fetch':
        if (++fetches > FETCH_LIMITS.maxCalls) throw new AppError('Too many network calls in one request.');
        return appFetch(a.url, a.init);
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
        finish({ status: m.status, body: JSON.parse(m.json) });
      }
    });
    worker.on('error', (e) => {
      opts.log(`worker error: ${e.message}`);
      finish({ status: 500, body: { error: 'Handler crashed', detail: e.message.slice(0, 300) } });
    });
    worker.on('exit', () => finish({ status: 500, body: { error: 'Handler exited unexpectedly' } }));
  });
}
