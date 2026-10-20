import type { ComponentProps } from 'react';
import { Avatar, Box, Checkbox, CircularProgress, ListItemButton, ListItemText } from '@mui/material';
import { alpha } from '@mui/material/styles';
import Star from '@mui/icons-material/Star';
import type { Conversation } from '../../api';
import { fmtDate, t } from '../../i18n';

/** One row of the list. In selection mode, a checkbox precedes the title. */
export default function ConversationItem({ conv: c, current, agentName, sub, selecting, checked, onClick, menuHandlers }: {
  conv: Conversation; current: boolean; agentName: string; sub?: string; selecting: boolean; checked: boolean;
  onClick: () => void; menuHandlers: Pick<ComponentProps<typeof ListItemButton>, 'onContextMenu' | 'onTouchStart' | 'onTouchMove' | 'onTouchEnd' | 'onTouchCancel'>;
}) {
  return (
    <ListItemButton selected={current} data-current={current || undefined} onClick={onClick} {...menuHandlers} sx={{ gap: 1, px: 1.5, WebkitTouchCallout: 'none', userSelect: 'none' }}>
      {selecting && <Checkbox size="small" edge="start" checked={checked} tabIndex={-1} disableRipple sx={{ p: 0.5 }} inputProps={{ 'aria-label': t('chat.select', { title: c.title }) }} />}
      {c.favorite && <Star aria-label={t('chat.favorite')} sx={{ fontSize: 16, color: 'warning.main', flexShrink: 0 }} />}
      <Box sx={{ position: 'relative', flexShrink: 0 }}>
        <Avatar sx={{ width: 32, height: 32, fontSize: 14, fontWeight: 700, bgcolor: (t) => alpha(t.palette.primary.main, 0.16), color: 'primary.main' }}>{agentName[0]}</Avatar>
        {sub && (
          <Box component="span" title={sub} aria-label={sub}
            sx={{ position: 'absolute', right: -5, bottom: -5, width: 17, height: 17, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 9, fontWeight: 700, lineHeight: 1, bgcolor: 'background.paper', color: 'text.primary', border: 1, borderColor: 'divider', boxShadow: (t) => `0 0 0 1.5px ${t.palette.background.default}` }}>
            {sub[0]!.toUpperCase()}
          </Box>)}
      </Box>
      <ListItemText sx={{ minWidth: 0 }} primary={c.title} secondary={<>
          {agentName}
          {sub && <Box component="span" sx={{ display: 'inline-block', ml: 0.75, mr: 0.5, px: 0.9, lineHeight: '16px', fontSize: 10.5, fontWeight: 600, borderRadius: 999, border: 1, borderColor: 'divider', bgcolor: (t) => alpha(t.palette.text.primary, 0.07), color: 'text.primary', verticalAlign: 'baseline' }}>{sub}</Box>}
          {sub ? '' : ' '}· {fmtDate(c.updatedAt)}
        </>}
        primaryTypographyProps={{ noWrap: true, fontWeight: c.unread ? 700 : 500 }}
        secondaryTypographyProps={{ noWrap: true, fontSize: 12, color: c.unread ? 'text.primary' : 'text.secondary' }} />
      {c.running && <CircularProgress size={14} />}
      {c.unread && !c.running && <Box component="span" role="img" aria-label={t('chat.unreadMessages')} title={t('chat.unreadMessages')} sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: 'primary.main', flexShrink: 0 }} />}
    </ListItemButton>
  );
}
