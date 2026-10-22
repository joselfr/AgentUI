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

/** Preview id of a custom widget: `widget-<hash>` (the hash of its code, see `WidgetStore`). Never the id of a miniapp preview. */
export const widgetPreviewId = (hash: string) => `widget-${hash}`;
export const widgetHashOfPreview = (id: string): string | undefined => /^widget-([0-9a-f]{24})$/.exec(id)?.[1];
export const WIDGET_WIDTH = { min: 200, max: 1200, default: 360 };

/**
 * Host page of a `agentui_widget_custom` preview: a stand-in for the chat bubble. The widget runs in the same sandboxed iframe, at the width
 * the agent asked for (a phone by default), sized to its content like in the chat, with the theme, `useWidth()`, full screen and `reply()`.
 * It has no backend, so what the agent needs to debug is written in the page text: `#agentui-errors` lists the errors of the widget, and
 * `#agentui-replies` what it tried to send with `reply()` (nothing goes to a conversation). `body[data-state]` is `loading`, `ready` or `error`.
 */
export function widgetPreviewHtml(o: { hash: string; frameSrc: string; nonce: string; width: number }): string {
  const width = Math.min(Math.max(Math.round(o.width) || WIDGET_WIDTH.default, WIDGET_WIDTH.min), WIDGET_WIDTH.max);
  const cfg = { frameSrc: o.frameSrc, width, themes: { light: themeCssVars('light'), dark: themeCssVars('dark') } };
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>Widget (preview)</title>
<style>
html,body{margin:0;min-height:100%}
body{padding:12px;box-sizing:border-box;font:14px system-ui,sans-serif}
#stage{width:${width}px;max-width:100%;margin:0 auto}
iframe{display:block;width:100%;height:96px;border:0;background:transparent}
#stage.fs{position:fixed;inset:0;width:auto;max-width:none;margin:0;z-index:1}
#stage.fs iframe{height:100%}
.log{margin:12px auto 0;max-width:${Math.max(width, 360)}px;padding:8px 12px;border-radius:8px;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap;overflow:auto;max-height:30vh}
.log:empty{display:none}
#agentui-errors{background:#7f1d1d;color:#fff}
#agentui-replies{background:#1e3a5f;color:#fff}
</style></head>
<body data-state="loading" data-widget="${esc(o.hash)}">
<div id="stage"><iframe id="app" title="Widget" sandbox="allow-scripts"></iframe></div>
<pre id="agentui-errors" class="log" role="alert"></pre>
<pre id="agentui-replies" class="log"></pre>
<script nonce="${o.nonce}">
(function () {
  var cfg = ${json(cfg)};
  var frame = document.getElementById('app');
  var stage = document.getElementById('stage');
  var errBox = document.getElementById('agentui-errors');
  var replyBox = document.getElementById('agentui-replies');
  var dark = matchMedia('(prefers-color-scheme: dark)');
  var errors = [], replies = [], fs = false;
  function show(box, list, label) { box.textContent = list.map(function (l) { return label + l; }).join('\\n---\\n'); }
  function theme() {
    var mode = dark.matches ? 'dark' : 'light';
    document.body.style.background = cfg.themes[mode]['--au-bg'] || '';
    if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'agentui:theme', mode: mode, lang: (navigator.language || 'en').slice(0, 2), vars: cfg.themes[mode] }, '*');
  }
  function post(m) { if (frame.contentWindow) frame.contentWindow.postMessage(m, '*'); }
  dark.addEventListener('change', theme);
  frame.addEventListener('load', function () { theme(); post({ type: 'agentui:chat', canReply: true }); });
  frame.src = cfg.frameSrc;
  theme();

  window.addEventListener('message', function (e) {
    var w = frame.contentWindow;
    if (!w || e.source !== w) return;
    var m = e.data || {};
    if (m.type === 'agentui:ready') { if (document.body.dataset.state === 'loading') document.body.dataset.state = 'ready'; theme(); post({ type: 'agentui:chat', canReply: true }); }
    else if (m.type === 'agentui:error') { document.body.dataset.state = 'error'; if (errors.length < 10) errors.push(String(m.message || '')); show(errBox, errors, 'widget error: '); }
    else if (m.type === 'agentui:resize' && typeof m.height === 'number' && !fs) frame.style.height = Math.max(40, Math.min(m.height, 4000)) + 'px';
    else if (m.type === 'agentui:fullscreen') {
      var on = m.on === true;
      fs = on; stage.className = on ? 'fs' : '';
      if (typeof m.id === 'string') w.postMessage({ type: 'agentui:fullscreen.result', id: m.id, ok: true }, '*');
      post({ type: 'agentui:fullscreen.state', on: on });
    }
    else if (m.type === 'agentui:reply' && typeof m.id === 'string') {
      if (replies.length < 20) replies.push(String(m.text || '').slice(0, 500));
      show(replyBox, replies, 'reply(): ');
      w.postMessage({ type: 'agentui:reply.result', id: m.id, ok: true }, '*');
    }
    else if (m.type === 'agentui:open') { replies.push('openUrl(): ' + String(m.url || '').slice(0, 500)); show(replyBox, replies, ''); }
    else if (m.type === 'agentui:fetch' && typeof m.id === 'string') w.postMessage({ type: 'agentui:fetch.result', id: m.id, status: 404, body: { error: 'This widget has no backend.' } }, '*');
    else if (m.type === 'agentui:media' && typeof m.id === 'string') w.postMessage({ type: 'agentui:media.result', id: m.id, ok: false }, '*'); // media of a widget are the chat's attachments: none here
  });
})();
</script></body></html>`;
}
