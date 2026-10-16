import type { ReactNode } from 'react';
import { Box, Collapse, List, ListItemButton, ListItemText } from '@mui/material';
import ChevronRight from '@mui/icons-material/ChevronRight';
import ExpandMore from '@mui/icons-material/ExpandMore';

/** Section repliable de la liste (Tâches cron, Archivées) ; `unread` signale des messages non lus quand elle est repliée. */
export default function Section({ title, count, open, onToggle, unread = false, children }: {
  title: string; count: number; open: boolean; onToggle: () => void; unread?: boolean; children: ReactNode;
}) {
  return (
    <Box sx={{ mt: 1, mb: 0.5 }}>
      <ListItemButton onClick={onToggle} aria-expanded={open} sx={{ gap: 1, px: 1.5 }}>
        {open ? <ExpandMore fontSize="small" /> : <ChevronRight fontSize="small" />}
        <ListItemText primary={`${title} (${count})`} primaryTypographyProps={{ noWrap: true, fontSize: 13, fontWeight: 600, color: 'text.secondary' }} />
        {!open && unread && <Box component="span" role="img" aria-label="Messages non lus" sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: 'primary.main', flexShrink: 0 }} />}
      </ListItemButton>
      <Collapse in={open} unmountOnExit><List dense disablePadding>{children}</List></Collapse>
    </Box>
  );
}
