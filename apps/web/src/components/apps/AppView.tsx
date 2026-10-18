import { useEffect } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import ArrowBack from '@mui/icons-material/ArrowBack';
import Refresh from '@mui/icons-material/Refresh';
import { api } from '../../api';
import { t } from '../../i18n';
import { useLoad } from '../pages/shared';
import { AppIcon } from './appIcons';
import AppFrame from './AppFrame';

/** One app, full area: a thin native header, then the sandboxed iframe. */
export default function AppView({ id, refreshKey, onBack }: { id: string; refreshKey: number; onBack: () => void }) {
  const app = useLoad(() => api.app(id), [id]);
  useEffect(() => { if (refreshKey) app.refresh().catch(() => onBack()); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const a = app.data;
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.75, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper', flexShrink: 0 }}>
        <Tooltip title={t('apps.back')}><IconButton aria-label={t('apps.back')} onClick={onBack}><ArrowBack /></IconButton></Tooltip>
        {a && <Box sx={{ color: 'primary.main', display: 'grid' }}><AppIcon name={a.icon} fontSize="small" /></Box>}
        <Typography variant="subtitle1" sx={{ flex: 1, minWidth: 0 }} noWrap>{a?.name ?? ''}</Typography>
        <Tooltip title={t('apps.reload')}><IconButton aria-label={t('apps.reload')} onClick={() => app.refresh().catch(() => {})}><Refresh /></IconButton></Tooltip>
      </Box>
      {app.err ? <Typography sx={{ p: 3 }} color="text.secondary">{t('apps.notFound')}</Typography> : a && <AppFrame app={a} />}
    </Box>
  );
}
