/**
 * Force la mise à jour de la PWA : demande au navigateur de relire le service worker, attend que la nouvelle
 * version soit active (elle précharge ses fichiers), puis recharge la page. Sans toucher aux notifications push :
 * le service worker n'est jamais désinscrit.
 */
export async function forceUpdate(): Promise<'updated' | 'current'> {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
  if (!reg) { location.reload(); return 'current'; }
  await reg.update();
  const next = reg.installing ?? reg.waiting;
  if (!next) { location.reload(); return 'current'; } // déjà à jour : on recharge quand même pour repartir d'un état propre
  await new Promise<void>((done) => {
    const finish = () => next.state === 'activated' && done();
    next.addEventListener('statechange', finish);
    setTimeout(done, 15000); // garde-fou
    finish();
  });
  location.reload();
  return 'updated';
}
