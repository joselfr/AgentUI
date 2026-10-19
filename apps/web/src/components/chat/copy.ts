/** Copies text to the clipboard (Clipboard API, or a hidden textarea where it is unavailable: insecure context, old browser). */
export async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return; } catch { /* fall back */ }
  const el = document.createElement('textarea');
  el.value = text; el.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(el);
  el.select(); document.execCommand('copy'); el.remove();
}
