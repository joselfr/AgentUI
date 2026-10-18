import { Box, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { t } from '../../i18n';

/** "Unread" marker: separates what was read from what arrived since the last visit. */
export default function UnreadDivider({ count }: { count: number }) {
  return (
    <Box role="separator" aria-label={t('chat.unreadCount', { count })}
      sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2, color: 'primary.main' }}>
      <Box sx={{ flex: 1, height: '1px', bgcolor: (t) => alpha(t.palette.primary.main, 0.4) }} />
      <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: 0.3 }}>{t('chat.newMessage', { count })}</Typography>
      <Box sx={{ flex: 1, height: '1px', bgcolor: (t) => alpha(t.palette.primary.main, 0.4) }} />
    </Box>
  );
}
