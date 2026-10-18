/**
   * Forces the PWA update: asks the browser to re-read the service worker, waits for the new
   * version to be active (it precaches its files), then reloads the page. Without touching push notifications:
   * the service worker is never unregistered.
 */
export async function forceUpdate(): Promise<'updated' | 'current'> {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
  if (!reg) { location.reload(); return 'current'; }
  await reg.update();
  const next = reg.installing ?? reg.waiting;
  if (!next) { location.reload(); return 'current'; } // already up to date: reload anyway to start from a clean state
  await new Promise<void>((done) => {
    const finish = () => next.state === 'activated' && done();
    next.addEventListener('statechange', finish);
    setTimeout(done, 15000); // garde-fou
    finish();
  });
  location.reload();
  return 'updated';
}
