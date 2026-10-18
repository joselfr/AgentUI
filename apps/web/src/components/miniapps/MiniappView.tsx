import { useEffect } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import ArrowBack from '@mui/icons-material/ArrowBack';
import Refresh from '@mui/icons-material/Refresh';
import { api } from '../../api';
import { t } from '../../i18n';
import { useLoad } from '../pages/shared';
import { MiniappIcon } from './miniappIcons';
import MiniappFrame from './MiniappFrame';

/** One miniapp, full area: a thin native header, then the sandboxed iframe. */
export default function MiniappView({ id, refreshKey, dataKey, onBack }: { id: string; refreshKey: number; dataKey: number; onBack: () => void }) {
  const app = useLoad(() => api.miniapp(id), [id]);
  useEffect(() => { if (refreshKey) app.refresh().catch(() => onBack()); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const a = app.data;
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.75, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper', flexShrink: 0 }}>
        <Tooltip title={t('miniapps.back')}><IconButton aria-label={t('miniapps.back')} onClick={onBack}><ArrowBack /></IconButton></Tooltip>
        {a && <Box sx={{ color: 'primary.main', display: 'grid' }}><MiniappIcon name={a.icon} fontSize="small" /></Box>}
        <Typography variant="subtitle1" sx={{ flex: 1, minWidth: 0 }} noWrap>{a?.name ?? ''}</Typography>
        <Tooltip title={t('miniapps.reload')}><IconButton aria-label={t('miniapps.reload')} onClick={() => app.refresh().catch(() => {})}><Refresh /></IconButton></Tooltip>
      </Box>
      {app.err ? <Typography sx={{ p: 3 }} color="text.secondary">{t('miniapps.notFound')}</Typography> : a && <MiniappFrame app={a} dataKey={dataKey} />}
    </Box>
  );
}
