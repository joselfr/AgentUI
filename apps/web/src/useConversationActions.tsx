import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { api, type Conversation } from './api';
import { t } from './i18n';

/**
   * List management actions (favorite, rename, archive, delete). Changes are applied to the local list
   * immediately, then rolled back if the server refuses; deletions ask for confirmation.
 */
export function useConversationActions({ setConvs, setCurrentId, currentRef, guard, ask }: {
  setConvs: Dispatch<SetStateAction<Conversation[]>>;
  setCurrentId: (id: string | undefined) => void;
  currentRef: MutableRefObject<string | undefined>;
  guard: (e: unknown) => void;
  ask: (o: { title: string; text?: React.ReactNode; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
}) {
  const patch = useCallback((ids: Set<string>, change: Partial<Conversation> | ((c: Conversation) => Partial<Conversation>)) =>
    setConvs((all) => all.map((x) => (ids.has(x.id) ? { ...x, ...(typeof change === 'function' ? change(x) : change) } : x))), [setConvs]);

  const toggleFavorite = (c: Conversation) => {
    const favorite = !c.favorite;
    patch(new Set([c.id]), { favorite });
    api.setFavorite(c.id, favorite).catch((e) => { patch(new Set([c.id]), { favorite: !favorite }); guard(e); });
  };
  const renameConv = (c: Conversation, title: string) => {
    patch(new Set([c.id]), { title });
    api.rename(c.id, title).catch((e) => { patch(new Set([c.id]), { title: c.title }); guard(e); });
  };
  const archiveMany = async (cs: Conversation[], archived: boolean) => {
    const ids = new Set(cs.map((c) => c.id));
    patch(ids, { archived });
    try { await Promise.all(cs.map((c) => api.setArchived(c.id, archived))); } catch (e) { patch(ids, { archived: !archived }); guard(e); }
  };
  const archiveConv = (c: Conversation, archived: boolean) => archiveMany([c], archived);

  const removeLocal = (id: string) => { setConvs((all) => all.filter((x) => x.id !== id)); if (id === currentRef.current) setCurrentId(undefined); };
  const deleteConv = async (c: Conversation) => {
    if (await ask({ title: t('confirm.deleteConv.title'), text: t('confirm.deleteConv.text', { title: c.title.length > 60 ? `${c.title.slice(0, 60)}…` : c.title }), confirmLabel: t('common.delete'), danger: true })) {
      api.remove(c.id).then(() => removeLocal(c.id)).catch(guard);
    }
  };
  /** Bulk delete: one confirmation, then one deletion per chat (the agent's session is deleted too). */
  const deleteMany = async (cs: Conversation[]): Promise<boolean> => {
    if (!(await ask({ title: t('confirm.deleteMany.title', { count: cs.length }), text: t('confirm.deleteMany.text', { count: cs.length }), confirmLabel: t('common.delete'), danger: true }))) return false;
    for (const c of cs) {
      try { await api.remove(c.id); removeLocal(c.id); } catch (e) { guard(e); break; } // stop at the first error: the rest is kept
    }
    return true;
  };

  return { toggleFavorite, renameConv, archiveConv, archiveMany, deleteConv, deleteMany };
}
