import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

/** pdf.js is heavy (~400 kB + a worker): loaded the first time a PDF is shown, not with the app. */
let lib: Promise<typeof import('pdfjs-dist')> | undefined;
function pdfjs() {
  lib ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([m, w]) => {
    m.GlobalWorkerOptions.workerSrc = w.default;
    return m;
  });
  return lib;
}

/** Downloads then opens a PDF (same-origin attachment, or a remote file if its server allows CORS). Rejects if unreachable or not a PDF. */
export async function openPdf(url: string, signal?: AbortSignal): Promise<{ doc: PDFDocumentProxy; destroy: () => void }> {
  const [m, res] = await Promise.all([pdfjs(), fetch(url, { signal, referrerPolicy: 'no-referrer' })]);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const task = m.getDocument({ data: new Uint8Array(await res.arrayBuffer()) });
  return { doc: await task.promise, destroy: () => void task.destroy() };
}

/** Draws page `n` of `doc` in `canvas` at `cssWidth` CSS pixels wide (sharp on high-DPI screens). Returns the render task to cancel. */
export async function paintPage(doc: PDFDocumentProxy, n: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<RenderTask | undefined> {
  const page = await doc.getPage(n);
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const viewport = page.getViewport({ scale: (cssWidth / page.getViewport({ scale: 1 }).width) * dpr });
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${viewport.height / dpr}px`;
  return page.render({ canvas, canvasContext: ctx, viewport });
}

/** Height / width ratio of page `n`. */
export async function pageRatio(doc: PDFDocumentProxy, n: number): Promise<number> {
  const v = (await doc.getPage(n)).getViewport({ scale: 1 });
  return v.height / v.width;
}
