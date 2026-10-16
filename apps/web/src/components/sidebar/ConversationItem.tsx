import type { ComponentProps } from 'react';
import { Box, Checkbox, CircularProgress, ListItemButton, ListItemText } from '@mui/material';
import Star from '@mui/icons-material/Star';
import type { Conversation } from '../../api';

/** Une ligne de la liste. En mode sélection, une case à cocher précède le titre. */
export default function ConversationItem({ conv: c, current, agentName, selecting, checked, onClick, menuHandlers }: {
  conv: Conversation; current: boolean; agentName: string; selecting: boolean; checked: boolean;
  onClick: () => void; menuHandlers: Pick<ComponentProps<typeof ListItemButton>, 'onContextMenu' | 'onTouchStart' | 'onTouchMove' | 'onTouchEnd' | 'onTouchCancel'>;
}) {
  return (
    <ListItemButton selected={current} onClick={onClick} {...menuHandlers} sx={{ gap: 1, px: 1.5, WebkitTouchCallout: 'none', userSelect: 'none' }}>
      {selecting && <Checkbox size="small" edge="start" checked={checked} tabIndex={-1} disableRipple sx={{ p: 0.5 }} inputProps={{ 'aria-label': `Sélectionner ${c.title}` }} />}
      {c.favorite && <Star aria-label="Favori" sx={{ fontSize: 16, color: 'warning.main', flexShrink: 0 }} />}
      <ListItemText sx={{ minWidth: 0 }} primary={c.title} secondary={`${agentName} · ${new Date(c.updatedAt).toLocaleDateString()}`}
        primaryTypographyProps={{ noWrap: true, fontWeight: c.unread ? 700 : 500 }}
        secondaryTypographyProps={{ noWrap: true, fontSize: 12, color: c.unread ? 'text.primary' : 'text.secondary' }} />
      {c.running && <CircularProgress size={14} />}
      {c.unread && !c.running && <Box component="span" role="img" aria-label="Messages non lus" title="Messages non lus" sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: 'primary.main', flexShrink: 0 }} />}
    </ListItemButton>
  );
}
