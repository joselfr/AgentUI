import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Button, IconButton, List, Typography } from '@mui/material';
import Add from '@mui/icons-material/Add';
import MenuOpen from '@mui/icons-material/MenuOpen';
import type { AgentInfo } from '@agentui/shared';
import type { Conversation } from '../api';
import { load, save } from '../storage';
import { t } from '../i18n';
import AgentFilter from './sidebar/AgentFilter';
import ConversationItem from './sidebar/ConversationItem';
import ConversationMenu, { RenameDialog } from './sidebar/ConversationMenu';
import { SearchField, SearchResults, useSearch } from './sidebar/Search';
import SelectionBar from './sidebar/SelectionBar';
import Section from './sidebar/Section';
import { useItemMenu } from './sidebar/useItemMenu';
import { usePersistedToggle } from './sidebar/usePersistedToggle';
import { useSelection } from './sidebar/useSelection';

export const DRAWER = 280;

/** Chat list: favorites first, Cron tasks / Archived sections, agent filter, search, multi-selection. */
export default function Sidebar(props: {
  agents: AgentInfo[]; subLabel: (agentId: string, subAgentId?: string) => string | undefined; convs: Conversation[]; currentId?: string;
  onSelectConv: (id: string) => void; onNew: () => void; onDelete: (c: Conversation) => void; onArchive: (c: Conversation, archived: boolean) => void;
  onArchiveMany: (cs: Conversation[], archived: boolean) => void; onDeleteMany: (cs: Conversation[]) => Promise<boolean>; onToggleFavorite: (c: Conversation) => void; onRename: (c: Conversation, title: string) => void; onClose: () => void;
}) {
  const { agents } = props;
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  // Favorites first (stable sort: the by-update-date order is kept within each group)
  const convs = [...props.convs].sort((a, b) => Number(b.favorite) - Number(a.favorite));
  // Agent filter (remembered): only makes sense with several agents
  const [agentFilter, setAgentFilter] = useState<string>(() => load('agentFilter', 'all'));
  const filter = agents.some((a) => a.id === agentFilter) ? agentFilter : 'all';
  const shown = convs.filter((c) => filter === 'all' || c.agentId === filter);
  const active = shown.filter((c) => !c.archived);
  const crons = active.filter((c) => c.cron);
  const mains = active.filter((c) => !c.cron);
  const archivedList = shown.filter((c) => c.archived);

  const search = useSearch();
  const [cronOpen, toggleCron] = usePersistedToggle('cronOpen');
  const [archOpen, toggleArch] = usePersistedToggle('archOpen');
  const selection = useSelection(convs, [...mains, ...(cronOpen ? crons : []), ...(archOpen ? archivedList : [])]);
  useEffect(() => { if (selection.selecting && search.active) selection.clear(); }, [selection.selecting, search.active]); // eslint-disable-line react-hooks/exhaustive-deps
  const itemMenu = useItemMenu<Conversation>(!selection.selecting);
  const [renaming, setRenaming] = useState<Conversation>();

  // When the list opens, the active chat is brought to the very top
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = listRef.current;
    const cur = box?.querySelector<HTMLElement>('[data-current]');
    if (box && cur) box.scrollTop = cur.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  }, []);

  const item = (c: Conversation) => (
    <ConversationItem key={c.id} conv={c} current={c.id === props.currentId} agentName={agentName(c.agentId)} sub={props.subLabel(c.agentId, c.subAgentId)}
      selecting={selection.selecting} checked={selection.has(c.id)} menuHandlers={itemMenu.bind(c)}
      onClick={() => { if (itemMenu.consumeClick()) return; if (selection.selecting) selection.toggle(c.id); else props.onSelectConv(c.id); }} />
  );

  return (
    <Box sx={{ width: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {selection.selecting ? (
        <SelectionBar count={selection.chosen.length} allChosen={selection.allChosen} allArchived={selection.allArchived} onToggleAll={selection.toggleAll} onCancel={selection.clear}
          onArchive={() => { props.onArchiveMany(selection.chosen, !selection.allArchived); selection.clear(); }}
          onDelete={() => { void props.onDeleteMany(selection.chosen).then((done) => { if (done) selection.clear(); }); }} />
      ) : (
        <Box sx={{ display: 'flex', alignItems: 'center', px: 2, pr: 1, height: 64, flexShrink: 0 }}>
          <Typography variant="subtitle1" sx={{ flex: 1 }}>{t('nav.chats')}</Typography>
          <IconButton size="small" onClick={props.onClose} aria-label={t('header.hideChats')} title={t('header.hideChats')}><MenuOpen fontSize="small" /></IconButton>
        </Box>)}
      <Box sx={{ px: 1.5, pb: 0.5 }}>
        <Button fullWidth variant="contained" startIcon={<Add />} onClick={props.onNew}>{t('chat.new')}</Button>
      </Box>
      <SearchField query={search.query} onChange={search.setQuery} searching={search.searching} />
      {agents.length > 1 && !search.active && (
        <AgentFilter agents={agents} value={filter} onChange={(id) => { setAgentFilter(id); save('agentFilter', id); }} />)}
      <Box ref={listRef} sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', px: 1, pb: 1 }}>
        {search.active ? (
          <SearchResults hits={search.hits} searching={search.searching} q={search.q} currentId={props.currentId} agentName={agentName}
            onPick={(id) => { search.setQuery(''); props.onSelectConv(id); }} />
        ) : (<>
          {crons.length > 0 && <Section title={t('chat.cron')} count={crons.length} open={cronOpen} onToggle={toggleCron} unread={crons.some((c) => c.unread)}>{crons.map(item)}</Section>}
          <List dense disablePadding sx={{ mt: 1 }}>{mains.map(item)}</List>
          {archivedList.length > 0 && <Section title={t('chat.archived')} count={archivedList.length} open={archOpen} onToggle={toggleArch}>{archivedList.map(item)}</Section>}
          {active.length === 0 && archivedList.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 2, textAlign: 'center' }}>{t('chat.empty')}</Typography>)}
        </>)}
        <ConversationMenu menu={itemMenu.menu} onRequestClose={itemMenu.requestClose} onClose={itemMenu.close}
          onToggleFavorite={props.onToggleFavorite} onRename={setRenaming} onArchive={props.onArchive} onSelect={(c) => selection.start(c.id)} onDelete={props.onDelete} />
        <RenameDialog conv={renaming} onSubmit={props.onRename} onClose={() => setRenaming(undefined)} />
      </Box>
    </Box>
  );
}
