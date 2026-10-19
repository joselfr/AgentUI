import { useEffect, useState } from 'react';
import { Badge, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Tooltip, Typography } from '@mui/material';
import ArrowBack from '@mui/icons-material/ArrowBack';
import FolderOpen from '@mui/icons-material/FolderOpen';
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
  const fs = useLoad(() => api.miniappFs(id), [id]);
  useEffect(() => { if (refreshKey) fs.refresh().catch(() => {}); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [fsOpen, setFsOpen] = useState(false);
  const pending = fs.data?.filter((g) => !g.approved).length ?? 0;
  const a = app.data;
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.75, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper', flexShrink: 0 }}>
        <Tooltip title={t('miniapps.back')}><IconButton aria-label={t('miniapps.back')} onClick={onBack}><ArrowBack /></IconButton></Tooltip>
        {a && <Box sx={{ color: 'primary.main', display: 'grid' }}><MiniappIcon name={a.icon} fontSize="small" /></Box>}
        <Typography variant="subtitle1" sx={{ flex: 1, minWidth: 0 }} noWrap>{a?.name ?? ''}</Typography>
        {!!fs.data?.length && (
          <Tooltip title={t('miniapps.fs.button')}>
            <IconButton aria-label={t('miniapps.fs.button')} onClick={() => setFsOpen(true)}>
              <Badge color="warning" variant="dot" invisible={!pending}><FolderOpen /></Badge>
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title={t('miniapps.reload')}><IconButton aria-label={t('miniapps.reload')} onClick={() => app.refresh().catch(() => {})}><Refresh /></IconButton></Tooltip>
      </Box>
      <Dialog open={fsOpen} onClose={() => setFsOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t('miniapps.fs.title')}</DialogTitle>
        <DialogContent>
          {fs.data?.map((g) => (
            <Box key={g.path} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.75 }}>
              <Typography variant="body2" sx={{ flex: 1, minWidth: 0, fontFamily: 'monospace', wordBreak: 'break-all' }}>{g.path} <Typography component="span" variant="caption" color="text.secondary">({t(g.mode === 'rw' ? 'miniapps.fs.rw' : 'miniapps.fs.ro')})</Typography></Typography>
              <Button size="small" variant={g.approved ? 'outlined' : 'contained'} color={g.approved ? 'inherit' : 'primary'}
                onClick={() => api.setMiniappFs(id, g.path, !g.approved).then(() => fs.refresh()).catch(() => {})}>
                {t(g.approved ? 'miniapps.fs.revoke' : 'miniapps.fs.allow')}
              </Button>
            </Box>
          ))}
        </DialogContent>
        <DialogActions><Button onClick={() => setFsOpen(false)}>{t('common.close')}</Button></DialogActions>
      </Dialog>
      {app.err ? <Typography sx={{ p: 3 }} color="text.secondary">{t('miniapps.notFound')}</Typography> : a && <MiniappFrame app={a} dataKey={dataKey} />}
    </Box>
  );
}
