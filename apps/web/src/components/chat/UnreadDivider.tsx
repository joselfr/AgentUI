import { Box, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';

/** Repère « non lus » : sépare ce qui a été lu de ce qui est arrivé depuis la dernière visite. */
export default function UnreadDivider({ count }: { count: number }) {
  return (
    <Box role="separator" aria-label={`${count} message${count > 1 ? 's' : ''} non lu${count > 1 ? 's' : ''}`}
      sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2, color: 'primary.main' }}>
      <Box sx={{ flex: 1, height: '1px', bgcolor: (t) => alpha(t.palette.primary.main, 0.4) }} />
      <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: 0.3 }}>{count > 1 ? `${count} nouveaux messages` : 'Nouveau message'}</Typography>
      <Box sx={{ flex: 1, height: '1px', bgcolor: (t) => alpha(t.palette.primary.main, 0.4) }} />
    </Box>
  );
}
