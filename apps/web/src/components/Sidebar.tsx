import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Button, Checkbox, Chip, CircularProgress, Collapse, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputAdornment, List, ListItemButton, ListItemIcon, ListItemText, Menu, MenuItem, TextField, Tooltip, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import Add from '@mui/icons-material/Add';
import Archive from '@mui/icons-material/Archive';
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutline';
import Unarchive from '@mui/icons-material/Unarchive';
import Close from '@mui/icons-material/Close';
import Search from '@mui/icons-material/Search';
import Delete from '@mui/icons-material/Delete';
import ChevronRight from '@mui/icons-material/ChevronRight';
import ExpandMore from '@mui/icons-material/ExpandMore';
import Edit from '@mui/icons-material/Edit';
import Star from '@mui/icons-material/Star';
import StarBorder from '@mui/icons-material/StarBorder';
import MenuOpen from '@mui/icons-material/MenuOpen';
import type { AgentInfo, ConnStatus, SearchHit } from '@agentui/shared';
import { api, type Conversation } from '../api';
import { load, save } from '../storage';

export const DRAWER = 280;

const dot: Record<ConnStatus, string> = { connected: 'success.main', connecting: 'warning.main', error: 'error.main', disconnected: 'text.disabled' };

export function StatusDot({ status, size = 8 }: { status: ConnStatus; size?: number }) {
  return (
    <Box component="span" aria-hidden sx={{
      width: size, height: size, borderRadius: '50%', bgcolor: dot[status], flexShrink: 0, display: 'inline-block',
      boxShadow: status === 'connected' ? (t) => `0 0 0 3px ${alpha(t.palette.success.main, 0.18)}` : 'none',
    }} />
  );
}

/** Extrait de message avec les mots recherchés surlignés. */
function Snippet({ text, marks }: { text: string; marks: [number, number][] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  marks.forEach(([start, len], i) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<Box key={i} component="mark" sx={{ bgcolor: (t) => alpha(t.palette.primary.main, 0.3), color: 'inherit', borderRadius: '3px', px: '1px' }}>{text.slice(start, start + len)}</Box>);
    at = start + len;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

export default function Sidebar(props: {
  agents: AgentInfo[]; convs: Conversation[]; currentId?: string;
  onSelectConv: (id: string) => void; onNew: () => void; onDelete: (c: Conversation) => void; onArchive: (c: Conversation, archived: boolean) => void;
  onArchiveMany: (cs: Conversation[], archived: boolean) => void; onDeleteMany: (cs: Conversation[]) => Promise<boolean>; onToggleFavorite: (c: Conversation) => void; onRename: (c: Conversation, title: string) => void; onClose: () => void;
}) {
  const { agents } = props;
  // Favoris en tête (tri stable : l'ordre par date de mise à jour est conservé dans chaque groupe)
  const convs = [...props.convs].sort((a, b) => Number(b.favorite) - Number(a.favorite));
  // Filtre par agent (mémorisé) : n'a de sens qu'avec plusieurs agents
  const [agentFilter, setAgentFilter] = useState<string>(() => load('agentFilter', 'all'));
  const filter = agents.some((a) => a.id === agentFilter) ? agentFilter : 'all';
  const shown = convs.filter((c) => filter === 'all' || c.agentId === filter);
  const active = shown.filter((c) => !c.archived);
  const crons = active.filter((c) => c.cron);
  const mains = active.filter((c) => !c.cron);
  const archivedList = shown.filter((c) => c.archived);
  // Recherche plein texte (titres et messages) : remplace la liste tant que la requête fait au moins 2 caractères
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>();
  const [searching, setSearching] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const q = query.trim();
  const searchActive = q.length >= 2;
  useEffect(() => {
    if (!searchActive) { setHits(undefined); setSearching(false); return; }
    let stale = false;
    setSearching(true);
    const t = setTimeout(() => {
      api.search(q).then((r) => { if (!stale) setHits(r); }).catch(() => { if (!stale) setHits([]); }).finally(() => { if (!stale) setSearching(false); });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [q, searchActive]);
  useEffect(() => { // Ctrl/Cmd + K : aller au champ de recherche
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchInput.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Sections repliables : repliées par défaut, état mémorisé
  const [cronOpen, setCronOpen] = useState(() => load('cronOpen', false));
  const [archOpen, setArchOpen] = useState(() => load('archOpen', false));
  const toggleCron = () => setCronOpen((o) => { save('cronOpen', !o); return !o; });
  const toggleArch = () => setArchOpen((o) => { save('archOpen', !o); return !o; });
  // Sélection multiple (archiver / supprimer plusieurs discussions)
  const [selected, setSelected] = useState<Set<string>>();
  const selecting = !!selected;
  const toggleSel = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectable = [...mains, ...(cronOpen ? crons : []), ...(archOpen ? archivedList : [])];
  const chosen = convs.filter((c) => selected?.has(c.id));
  const allChosen = selectable.length > 0 && selectable.every((c) => selected?.has(c.id));
  const allArchived = chosen.length > 0 && chosen.every((c) => c.archived);
  useEffect(() => { if (selecting && searchActive) setSelected(undefined); }, [selecting, searchActive]);
  const [menu, setMenu] = useState<{ conv: Conversation; x: number; y: number }>();
  const [renaming, setRenaming] = useState<{ conv: Conversation; title: string }>();
  const submitRename = () => {
    const title = renaming?.title.trim();
    if (renaming && title && title !== renaming.conv.title) props.onRename(renaming.conv, title);
    setRenaming(undefined);
  };
  const press = useRef<{ timer?: number; x: number; y: number; fired: boolean }>({ fired: false, x: 0, y: 0 });
  const cancelPress = () => { window.clearTimeout(press.current.timer); };
  // Le relâchement du doigt qui suit un long appui (et le clic fantôme qui l'accompagne) tombe sur le fond du menu :
  // sans garde, il le refermerait aussitôt. On ignore donc toute fermeture tant que le doigt est posé et peu après.
  const touch = useRef({ down: false, lastEvent: 0 });
  const openMenu = (conv: Conversation, x: number, y: number) => { touch.current.lastEvent = Date.now(); setMenu({ conv, x, y }); };
  const touchEnded = () => { touch.current = { down: false, lastEvent: Date.now() }; };
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const item = (c: Conversation) => (
    <ListItemButton key={c.id} selected={c.id === props.currentId}
      onClick={() => { if (press.current.fired) { press.current.fired = false; return; } if (selecting) toggleSel(c.id); else props.onSelectConv(c.id); }}
      onContextMenu={(e) => { e.preventDefault(); if (selecting) return; cancelPress(); openMenu(c, e.clientX, e.clientY); }}
      onTouchStart={(e) => {
        if (selecting) return;
        touch.current = { down: true, lastEvent: Date.now() };
        const t = e.touches[0]!;
        press.current = { fired: false, x: t.clientX, y: t.clientY, timer: window.setTimeout(() => { press.current.fired = true; openMenu(c, t.clientX, t.clientY); }, 500) };
      }}
      onTouchMove={(e) => { const t = e.touches[0]!; if (Math.hypot(t.clientX - press.current.x, t.clientY - press.current.y) > 10) cancelPress(); }}
      onTouchEnd={(e) => { cancelPress(); touchEnded(); if (press.current.fired && e.cancelable) e.preventDefault(); }} onTouchCancel={() => { cancelPress(); touchEnded(); }}
      sx={{ gap: 1, px: 1.5, WebkitTouchCallout: 'none', userSelect: 'none' }}>
      {selecting && <Checkbox size="small" edge="start" checked={!!selected?.has(c.id)} tabIndex={-1} disableRipple sx={{ p: 0.5 }} inputProps={{ 'aria-label': `Sélectionner ${c.title}` }} />}
      {c.favorite && <Star aria-label="Favori" sx={{ fontSize: 16, color: 'warning.main', flexShrink: 0 }} />}
      <ListItemText sx={{ minWidth: 0 }} primary={c.title} secondary={`${agentName(c.agentId)} · ${new Date(c.updatedAt).toLocaleDateString()}`}
        primaryTypographyProps={{ noWrap: true, fontWeight: c.unread ? 700 : 500 }}
        secondaryTypographyProps={{ noWrap: true, fontSize: 12, color: c.unread ? 'text.primary' : 'text.secondary' }} />
      {c.running && <CircularProgress size={14} />}
      {c.unread && !c.running && <Box component="span" role="img" aria-label="Messages non lus" title="Messages non lus" sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: 'primary.main', flexShrink: 0 }} />}
    </ListItemButton>
  );

  return (
    <Box sx={{ width: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {selecting ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1.5, pr: 1, height: 64, flexShrink: 0 }}>
          <Checkbox size="small" checked={allChosen} indeterminate={!allChosen && chosen.length > 0} sx={{ p: 0.5 }} inputProps={{ 'aria-label': 'Tout sélectionner' }}
            onChange={() => setSelected(allChosen ? new Set() : new Set(selectable.map((c) => c.id)))} />
          <Typography variant="subtitle2" sx={{ flex: 1 }} noWrap>{chosen.length ? `${chosen.length} sélectionnée${chosen.length > 1 ? 's' : ''}` : 'Sélectionner'}</Typography>
          <Tooltip title={allArchived ? 'Désarchiver' : 'Archiver'}><span><IconButton size="small" disabled={!chosen.length} aria-label={allArchived ? 'Désarchiver' : 'Archiver'}
            onClick={() => { props.onArchiveMany(chosen, !allArchived); setSelected(undefined); }}>{allArchived ? <Unarchive fontSize="small" /> : <Archive fontSize="small" />}</IconButton></span></Tooltip>
          <Tooltip title="Supprimer"><span><IconButton size="small" color="error" disabled={!chosen.length} aria-label="Supprimer la sélection"
            onClick={() => { void props.onDeleteMany(chosen).then((done) => { if (done) setSelected(undefined); }); }}><Delete fontSize="small" /></IconButton></span></Tooltip>
          <Tooltip title="Annuler"><IconButton size="small" aria-label="Quitter la sélection" onClick={() => setSelected(undefined)}><Close fontSize="small" /></IconButton></Tooltip>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', alignItems: 'center', px: 2, pr: 1, height: 64, flexShrink: 0 }}>
          <Typography variant="subtitle1" sx={{ flex: 1 }}>Discussions</Typography>
          <IconButton size="small" onClick={props.onClose} aria-label="Masquer les discussions" title="Masquer les discussions"><MenuOpen fontSize="small" /></IconButton>
        </Box>)}
      <Box sx={{ px: 1.5, pb: 0.5 }}>
        <Button fullWidth variant="contained" startIcon={<Add />} onClick={props.onNew}>Nouvelle conversation</Button>
      </Box>
      <Box sx={{ px: 1.5, pt: 1, pb: 0.5 }}>
        <TextField fullWidth size="small" placeholder="Rechercher…" value={query} inputRef={searchInput}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
          inputProps={{ 'aria-label': 'Rechercher dans les discussions', enterKeyHint: 'search' }}
          InputProps={{
            startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment>,
            endAdornment: query ? (
              <InputAdornment position="end">
                {searching ? <CircularProgress size={14} sx={{ mr: 0.5 }} /> : null}
                <IconButton size="small" edge="end" aria-label="Effacer la recherche" onClick={() => { setQuery(''); searchInput.current?.focus(); }}><Close fontSize="small" /></IconButton>
              </InputAdornment>) : undefined,
          }} />
      </Box>
      {agents.length > 1 && !searchActive && (
        <Box role="group" aria-label="Filtrer par agent" sx={{ display: 'flex', justifyContent: 'center', gap: 0.75, px: 1.5, pt: 1, pb: 0.5, flexWrap: 'wrap' }}>
          {[{ id: 'all', name: 'Tous' }, ...agents].map((a) => (
            <Chip key={a.id} size="small" label={a.name} clickable color={filter === a.id ? 'primary' : 'default'} variant={filter === a.id ? 'filled' : 'outlined'}
              aria-pressed={filter === a.id} onClick={() => { setAgentFilter(a.id); save('agentFilter', a.id); }} />))}
        </Box>)}
      <Box sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', px: 1, pb: 1 }}>
        {searchActive && (
          <List dense disablePadding sx={{ mt: 1 }} aria-label="Résultats de la recherche">
            {hits?.map((h) => (
              <ListItemButton key={h.id} selected={h.id === props.currentId} onClick={() => { setQuery(''); props.onSelectConv(h.id); }} sx={{ gap: 1, px: 1.5, alignItems: 'flex-start' }}>
                {h.favorite && <Star aria-label="Favori" sx={{ fontSize: 16, color: 'warning.main', flexShrink: 0, mt: 0.5 }} />}
                <ListItemText sx={{ minWidth: 0 }} primary={h.title} primaryTypographyProps={{ noWrap: true, fontWeight: 600 }}
                  secondaryTypographyProps={{ component: 'div', fontSize: 12 }}
                  secondary={<>
                    {h.snippet && <Box sx={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere', color: 'text.primary', opacity: 0.85 }}>
                      <Snippet text={h.snippet} marks={h.marks ?? []} /></Box>}
                    <Box sx={{ color: 'text.secondary', mt: 0.25 }}>{agentName(h.agentId)} · {new Date(h.updatedAt).toLocaleDateString()}{h.archived ? ' · archivée' : ''}</Box>
                  </>} />
              </ListItemButton>))}
          </List>)}
        {searchActive && hits?.length === 0 && !searching && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 2, textAlign: 'center' }}>Aucun résultat pour « {q} »</Typography>)}
        {!searchActive && crons.length > 0 && (
          <Box sx={{ mt: 1, mb: 0.5 }}>
            <ListItemButton onClick={toggleCron} aria-expanded={cronOpen} sx={{ gap: 1, px: 1.5 }}>
              {cronOpen ? <ExpandMore fontSize="small" /> : <ChevronRight fontSize="small" />}
              <ListItemText primary={`Tâches cron (${crons.length})`} primaryTypographyProps={{ noWrap: true, fontSize: 13, fontWeight: 600, color: 'text.secondary' }} />
              {!cronOpen && crons.some((c) => c.unread) && <Box component="span" role="img" aria-label="Messages non lus" sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: 'primary.main', flexShrink: 0 }} />}
            </ListItemButton>
            <Collapse in={cronOpen} unmountOnExit><List dense disablePadding>{crons.map(item)}</List></Collapse>
          </Box>)}
        {!searchActive && (
          <List dense disablePadding sx={{ mt: 1 }}>
            {mains.map(item)}
          </List>)}
        {!searchActive && archivedList.length > 0 && (
          <Box sx={{ mt: 1, mb: 0.5 }}>
            <ListItemButton onClick={toggleArch} aria-expanded={archOpen} sx={{ gap: 1, px: 1.5 }}>
              {archOpen ? <ExpandMore fontSize="small" /> : <ChevronRight fontSize="small" />}
              <ListItemText primary={`Archivées (${archivedList.length})`} primaryTypographyProps={{ noWrap: true, fontSize: 13, fontWeight: 600, color: 'text.secondary' }} />
            </ListItemButton>
            <Collapse in={archOpen} unmountOnExit><List dense disablePadding>{archivedList.map(item)}</List></Collapse>
          </Box>)}
        {!searchActive && active.length === 0 && archivedList.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 2, textAlign: 'center' }}>Aucune discussion</Typography>)}
        <Menu open={!!menu} onClose={() => { if (!touch.current.down && Date.now() - touch.current.lastEvent > 600) setMenu(undefined); }} anchorReference="anchorPosition" anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}
          onContextMenu={(e) => e.preventDefault()}>
          <MenuItem onClick={() => { if (menu) props.onToggleFavorite(menu.conv); setMenu(undefined); }}>
            <ListItemIcon>{menu?.conv.favorite ? <StarBorder fontSize="small" /> : <Star fontSize="small" />}</ListItemIcon>
            {menu?.conv.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
          </MenuItem>
          <MenuItem onClick={() => { if (menu) setRenaming({ conv: menu.conv, title: menu.conv.title }); setMenu(undefined); }}>
            <ListItemIcon><Edit fontSize="small" /></ListItemIcon>Renommer
          </MenuItem>
          <MenuItem onClick={() => { if (menu) props.onArchive(menu.conv, !menu.conv.archived); setMenu(undefined); }}>
            <ListItemIcon>{menu?.conv.archived ? <Unarchive fontSize="small" /> : <Archive fontSize="small" />}</ListItemIcon>
            {menu?.conv.archived ? 'Désarchiver' : 'Archiver'}
          </MenuItem>
          <MenuItem onClick={() => { if (menu) setSelected(new Set([menu.conv.id])); setMenu(undefined); }}>
            <ListItemIcon><CheckCircleOutline fontSize="small" /></ListItemIcon>Sélectionner
          </MenuItem>
          <MenuItem onClick={() => { if (menu) props.onDelete(menu.conv); setMenu(undefined); }} sx={{ color: 'error.main' }}>
            <ListItemIcon sx={{ color: 'inherit' }}><Delete fontSize="small" /></ListItemIcon>Supprimer
          </MenuItem>
        </Menu>
        <Dialog open={!!renaming} onClose={() => setRenaming(undefined)} fullWidth maxWidth="xs">
          <form onSubmit={(e) => { e.preventDefault(); submitRename(); }}>
            <DialogTitle sx={{ fontWeight: 650 }}>Renommer la discussion</DialogTitle>
            <DialogContent sx={{ pt: 1 }}>
              <TextField autoFocus fullWidth size="small" label="Nom" value={renaming?.title ?? ''} inputProps={{ maxLength: 200 }}
                onFocus={(e) => e.target.select()} onChange={(e) => setRenaming((r) => r && { ...r, title: e.target.value })} />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setRenaming(undefined)}>Annuler</Button>
              <Button type="submit" variant="contained" disabled={!renaming?.title.trim()}>Renommer</Button>
            </DialogActions>
          </form>
        </Dialog>
      </Box>
    </Box>
  );
}
