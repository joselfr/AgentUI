/**
 * Widgets offline. A widget runs in a sandboxed iframe (opaque origin): neither the service worker nor the HTTP cache serve its requests.
 * So the page itself (which the service worker does control) fetches the widget's files while online, which stores them in the `widgets`
 * cache (see sw.ts), and offline it hands them to the iframe as one self-contained `srcdoc`: modules as `data:` URLs through the import map,
 * the same restrictive CSP as the server's, set by a `<meta>`.
 */
interface Files { html: string; text: Map<string, string>; fonts: Map<string, string> }

const get = async (url: string): Promise<Response> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r;
};

const dataUrl = (bytes: ArrayBuffer, type: string): Promise<string> =>
  new Promise((ok, ko) => { const f = new FileReader(); f.onload = () => ok(f.result as string); f.onerror = () => ko(f.error); f.readAsDataURL(new Blob([bytes], { type })); });
const jsUrl = (code: string) => `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;

/** Fetches everything a widget needs, from the server when it answers, else from the service worker's cache. */
async function widgetFiles(base: string): Promise<Files> {
  const html = await (await get(base)).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const imports = (JSON.parse(doc.querySelector('script[type=importmap]')?.textContent ?? '{}') as { imports?: Record<string, string> }).imports ?? {};
  const entry = (JSON.parse(/window\.__AGENTUI=(\{.*?\});/.exec(html)?.[1] ?? '{}') as { entry?: string }).entry;
  const boot = doc.querySelector('script[type=module]')?.getAttribute('src');
  const css = [...doc.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href')!);
  const urls = [...new Set([...Object.values(imports), ...(entry ? [entry] : []), ...(boot ? [boot] : []), ...css])];
  const text = new Map<string, string>();
  await Promise.all(urls.map(async (u) => { text.set(u, await (await get(u)).text()); }));
  const fonts = new Map<string, string>();
  await Promise.all(css.flatMap((c) => [...text.get(c)!.matchAll(/url\((?!["']?data:)["']?([^)"']+\.woff2)["']?\)/g)].map((m) => new URL(m[1]!, new URL(c, location.origin)).pathname)).map(async (f) => {
    fonts.set(f, await dataUrl(await (await get(f)).arrayBuffer(), 'font/woff2'));
  }));
  return { html, text, fonts };
}

/** While online: stores the widget's files in the service worker's cache, for a later offline opening. */
export const warmWidget = (base: string): Promise<void> => widgetFiles(base).then(() => undefined);

/** The widget's document, built only from its cached files (the base may carry an expired token: the cache ignores it). */
export async function offlineDocument(base: string): Promise<string> {
  const { html, text, fonts } = await widgetFiles(base);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const imports = (JSON.parse(doc.querySelector('script[type=importmap]')!.textContent!) as { imports: Record<string, string> }).imports;
  const entry = (JSON.parse(/window\.__AGENTUI=(\{.*?\});/.exec(html)![1]!) as { appId: string; entry: string });
  const cssOf = (c: string) => text.get(c)!.replace(/url\((["']?)([^)"']+\.woff2)\1\)/g, (m, _q: string, f: string) => { const d = fonts.get(new URL(f, new URL(c, location.origin)).pathname); return d ? `url(${d})` : m; });
  const styles = [...doc.querySelectorAll('link[rel=stylesheet]')].map((l) => `<style>${cssOf(l.getAttribute('href')!).replace(/<\/style/gi, '<\\/style')}</style>`).join('\n');
  const map = Object.fromEntries(Object.entries(imports).map(([k, u]) => [k, jsUrl(text.get(u)!)]));
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const boot = text.get(doc.querySelector('script[type=module]')!.getAttribute('src')!)!;
  const csp = `default-src 'none'; script-src 'nonce-${nonce}' data:; style-src 'unsafe-inline'; img-src data: blob:; media-src 'none'; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${styles}
<script type="importmap" nonce="${nonce}">${json({ imports: map })}</script>
<script nonce="${nonce}">window.__AGENTUI=${json({ appId: entry.appId, entry: jsUrl(text.get(entry.entry)!) })};</script>
</head><body><div id="root"></div><script type="module" nonce="${nonce}">${boot.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
