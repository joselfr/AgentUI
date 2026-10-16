import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Box, CircularProgress, IconButton, InputAdornment, List, ListItemButton, ListItemText, TextField, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import Close from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import Star from '@mui/icons-material/Star';
import type { SearchHit } from '@agentui/shared';
import { api } from '../../api';

/** Recherche plein texte (titres et messages) : active dès 2 caractères, requêtes espacées de 250 ms. */
export function useSearch() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>();
  const [searching, setSearching] = useState(false);
  const q = query.trim();
  const active = q.length >= 2;
  useEffect(() => {
    if (!active) { setHits(undefined); setSearching(false); return; }
    let stale = false;
    setSearching(true);
    const t = setTimeout(() => {
      api.search(q).then((r) => { if (!stale) setHits(r); }).catch(() => { if (!stale) setHits([]); }).finally(() => { if (!stale) setSearching(false); });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [q, active]);
  return { query, setQuery, q, active, hits, searching };
}

/** Champ de recherche : Échap l'efface, Ctrl/Cmd + K y amène le curseur. */
export function SearchField({ query, onChange, searching }: { query: string; onChange: (v: string) => void; searching: boolean }) {
  const input: RefObject<HTMLInputElement> = useRef(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <Box sx={{ px: 1.5, pt: 1, pb: 0.5 }}>
      <TextField fullWidth size="small" placeholder="Rechercher…" value={query} inputRef={input}
        onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onChange(''); }}
        inputProps={{ 'aria-label': 'Rechercher dans les discussions', enterKeyHint: 'search' }}
        InputProps={{
          startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>,
          endAdornment: query ? (
            <InputAdornment position="end">
              {searching ? <CircularProgress size={14} sx={{ mr: 0.5 }} /> : null}
              <IconButton size="small" edge="end" aria-label="Effacer la recherche" onClick={() => { onChange(''); input.current?.focus(); }}><Close fontSize="small" /></IconButton>
            </InputAdornment>) : undefined,
        }} />
    </Box>
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

export function SearchResults({ hits, searching, q, currentId, agentName, onPick }: {
  hits?: SearchHit[]; searching: boolean; q: string; currentId?: string; agentName: (id: string) => string; onPick: (id: string) => void;
}) {
  return (
    <>
      <List dense disablePadding sx={{ mt: 1 }} aria-label="Résultats de la recherche">
        {hits?.map((h) => (
          <ListItemButton key={h.id} selected={h.id === currentId} onClick={() => onPick(h.id)} sx={{ gap: 1, px: 1.5, alignItems: 'flex-start' }}>
            {h.favorite && <Star aria-label="Favori" sx={{ fontSize: 16, color: 'warning.main', flexShrink: 0, mt: 0.5 }} />}
            <ListItemText sx={{ minWidth: 0 }} primary={h.title} primaryTypographyProps={{ noWrap: true, fontWeight: 600 }}
              secondaryTypographyProps={{ component: 'div', fontSize: 12 }}
              secondary={<>
                {h.snippet && <Box sx={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere', color: 'text.primary', opacity: 0.85 }}>
                  <Snippet text={h.snippet} marks={h.marks ?? []} /></Box>}
                <Box sx={{ color: 'text.secondary', mt: 0.25 }}>{agentName(h.agentId)} · {new Date(h.updatedAt).toLocaleDateString()}{h.archived ? ' · archivée' : ''}</Box>
              </>} />
          </ListItemButton>))}
      </List>
      {hits?.length === 0 && !searching && (
        <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 2, textAlign: 'center' }}>Aucun résultat pour « {q} »</Typography>)}
    </>
  );
}
