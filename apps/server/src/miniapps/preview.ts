import { createHmac, timingSafeEqual } from 'node:crypto';
import { themeCssVars } from '@agentui/shared';

/**
 * Preview of a miniapp for the agent's own browser (`agentui_miniapp_open`): a link that needs no session cookie, scoped to ONE miniapp and
 * short-lived. It is not the iframe token (`/m/…`, which only serves static files): it also lets the page replay the app's handler calls.
 */
export const PREVIEW_DEFAULT_TTL_S = 15 * 60;
export const PREVIEW_MAX_TTL_S = 60 * 60;

const mac = (secret: string, userId: string | number, appId: string, exp: string | number) =>
  createHmac('sha256', secret).update(`preview.${userId}.${appId}.${exp}`).digest('base64url'); // prefixed: never valid as an iframe token

export function signPreviewToken(secret: string, userId: number, appId: string, ttlMs: number, now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + ttlMs;
  return { token: `${userId}.${expiresAt}.${mac(secret, userId, appId, expiresAt)}`, expiresAt };
}

/** User the preview acts as, or `undefined` if the token is not valid for this miniapp (forged, expired). */
export function verifyPreviewToken(secret: string, appId: string, token: string, now = Date.now()): number | undefined {
  const [uid, exp, sig] = token.split('.');
  if (!uid || !exp || !sig || !/^\d+$/.test(uid) || Number(exp) < now) return undefined;
  const a = Buffer.from(sig), b = Buffer.from(mac(secret, uid, appId, exp));
  return a.length === b.length && timingSafeEqual(a, b) ? Number(uid) : undefined;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/**
 * Host page of a preview: the same sandboxed iframe as the Miniapps tab and the same postMessage bridge (theme, handler calls, media,
 * data refresh), without the AgentUI web app. Everything the agent needs to debug is written in the page text: `#agentui-errors` lists the
 * errors of the front and the failed handler calls, and `body[data-state]` is `loading`, `ready` or `error`.
 */
export function previewHtml(o: { appId: string; name: string; frameSrc: string; nonce: string; version: number; seq: number }): string {
  const cfg = { frameSrc: o.frameSrc, version: o.version, seq: o.seq, themes: { light: themeCssVars('light'), dark: themeCssVars('dark') } };
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>${esc(o.name)} (preview)</title>
<style>
html,body{margin:0;height:100%;background:transparent}
iframe{position:fixed;inset:0;width:100%;height:100%;border:0;background:transparent}
#agentui-errors{position:fixed;left:8px;right:8px;bottom:8px;max-height:40%;overflow:auto;margin:0;padding:8px 12px;border-radius:8px;background:#7f1d1d;color:#fff;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap;z-index:2}
#agentui-errors:empty{display:none}
</style></head>
<body data-state="loading" data-app="${esc(o.appId)}">
<iframe id="app" title="${esc(o.name)}" sandbox="allow-scripts"></iframe>
<pre id="agentui-errors" role="alert"></pre>
<script nonce="${o.nonce}">
(function () {
  var cfg = ${json(cfg)};
  var base = location.pathname.replace(/\\/+$/, '');
  var frame = document.getElementById('app');
  var box = document.getElementById('agentui-errors');
  var dark = matchMedia('(prefers-color-scheme: dark)');
  var lines = [];
  function note(line) { if (lines.length < 30) lines.push(line); box.textContent = lines.join('\\n---\\n'); }
  function theme() {
    var mode = dark.matches ? 'dark' : 'light';
    if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'agentui:theme', mode: mode, lang: (navigator.language || 'en').slice(0, 2), vars: cfg.themes[mode] }, '*');
  }
  dark.addEventListener('change', theme);
  frame.addEventListener('load', theme);
  frame.src = cfg.frameSrc + location.search; // ?a=b on the preview link reaches the app (its location.search)

  function safePath(p) {
    return typeof p === 'string' && !p.split('?')[0].split('/').some(function (s) { return s === '..' || s === '.'; }) && !/^[a-z]+:/i.test(p) && p.indexOf('//') !== 0 ? p.replace(/^\\/+/, '') : undefined;
  }
  function reply(w, id, status, body) { w.postMessage({ type: 'agentui:fetch.result', id: id, status: status, body: body }, '*'); }

  window.addEventListener('message', function (e) {
    var w = frame.contentWindow;
    if (!w || e.source !== w) return;
    var m = e.data || {};
    if (m.type === 'agentui:ready') { if (document.body.dataset.state === 'loading') document.body.dataset.state = 'ready'; theme(); }
    else if (m.type === 'agentui:error') { document.body.dataset.state = 'error'; note('app error: ' + String(m.message || '')); }
    else if (m.type === 'agentui:media' && typeof m.id === 'string') {
      var url = cfg.frameSrc + 'assets/' + encodeURIComponent(String(m.name || '')) + '?v=' + Date.now();
      fetch(url, { method: 'HEAD' }).then(function (r) {
        var type = (r.headers.get('content-type') || '').split(';')[0].trim();
        if (!r.ok || !/^(image|video|audio)\\//.test(type)) throw 0;
        w.postMessage({ type: 'agentui:media.result', id: m.id, ok: true, mimeType: type, url: url }, '*');
      }).catch(function () { w.postMessage({ type: 'agentui:media.result', id: m.id, ok: false }, '*'); });
    }
    else if (m.type === 'agentui:fetch' && typeof m.id === 'string') {
      var path = safePath(m.path);
      var method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].indexOf(m.method) >= 0 ? m.method : 'GET';
      if (path === undefined) return reply(w, m.id, 400, { error: 'Invalid path' });
      var withBody = method !== 'GET' && m.body != null;
      fetch(base + '/x/' + path, { method: method, headers: withBody ? { 'Content-Type': 'application/json' } : {}, body: withBody ? JSON.stringify(m.body) : undefined })
        .then(function (r) {
          return r.text().then(function (text) {
            var body = text;
            try { body = text ? JSON.parse(text) : null; } catch (_) {}
            if (r.status >= 400) note('handler ' + method + ' /' + path + ' -> ' + r.status + ' ' + (typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 500));
            reply(w, m.id, r.status, body);
          });
        })
        .catch(function () { note('handler ' + method + ' /' + path + ' -> network error'); reply(w, m.id, 0, { error: 'Network error' }); });
    }
  });

  // The agent rewrites the app or its data while the page is open: reload on a new version, refresh on new data.
  var version = cfg.version, seq = cfg.seq; // those of the rendered page: a write right after the opening is not missed
  var timer = setInterval(function () {
    fetch(base + '/state').then(function (r) {
      if (!r.ok) throw 0;
      return r.json();
    }).then(function (s) {
      if (s.version !== version) return location.reload();
      if (s.seq !== seq && frame.contentWindow) frame.contentWindow.postMessage({ type: 'agentui:data' }, '*');
      version = s.version; seq = s.seq;
    }).catch(function () { clearInterval(timer); note('preview link expired or miniapp removed'); document.body.dataset.state = 'error'; });
  }, 2000);
})();
</script></body></html>`;
}
