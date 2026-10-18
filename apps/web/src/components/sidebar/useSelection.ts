import { useState } from 'react';
import type { Conversation } from '../../api';

/** Multi-selection of chats ("Select" mode). `selectable` = what is currently displayed. */
export function useSelection(all: Conversation[], selectable: Conversation[]) {
  const [selected, setSelected] = useState<Set<string>>();
  const chosen = all.filter((c) => selected?.has(c.id));
  const allChosen = selectable.length > 0 && selectable.every((c) => selected?.has(c.id));
  return {
    selecting: !!selected,
    has: (id: string) => !!selected?.has(id),
    start: (id: string) => setSelected(new Set([id])),
    toggle: (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }),
    toggleAll: () => setSelected(allChosen ? new Set() : new Set(selectable.map((c) => c.id))),
    clear: () => setSelected(undefined),
    chosen,
    allChosen,
    allArchived: chosen.length > 0 && chosen.every((c) => c.archived),
  };
}
