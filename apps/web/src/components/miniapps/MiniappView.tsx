import { useEffect, useState } from 'react';
import { Badge, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Tooltip, Typography } from '@mui/material';
import ArrowBack from '@mui/icons-material/ArrowBack';
import FolderOpen from '@mui/icons-material/FolderOpen';
import EventRepeat from '@mui/icons-material/EventRepeat';
import Refresh from '@mui/icons-material/Refresh';
import { api } from '../../api';
import { t } from '../../i18n';
import { useLoad } from '../pages/shared';
import { MiniappIcon } from './miniappIcons';
import MiniappFrame from './MiniappFrame';

/** One miniapp, full area: a thin native header, then the sandboxed iframe. */
export default function MiniappView({ id, refreshKey, dataKey, onBack, onName, onOpenJobs }: { id: string; refreshKey: number; dataKey: number; onBack: () => void; onName?: (name?: string) => void; onOpenJobs: () => void }) {
  const app = useLoad(() => api.miniapp(id), [id]);
  useEffect(() => { onName?.(app.data?.name); return () => onName?.(undefined); }, [app.data?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (refreshKey) app.refresh().catch(() => onBack()); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const fs = useLoad(() => api.miniappFs(id), [id]);
  useEffect(() => { if (refreshKey) fs.refresh().catch(() => {}); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [fsOpen, setFsOpen] = useState(false);
  const jobs = useLoad(() => api.miniappJobs(id), [id]);
  useEffect(() => { if (refreshKey) jobs.refresh().catch(() => {}); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [jobsOpen, setJobsOpen] = useState(false);
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
        {!!jobs.data?.length && (
          <Tooltip title={t('miniapps.jobs.button')}>
            <IconButton aria-label={t('miniapps.jobs.button')} onClick={() => { jobs.refresh().catch(() => {}); setJobsOpen(true); }}><EventRepeat /></IconButton>
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
      <Dialog open={jobsOpen} onClose={() => setJobsOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t('miniapps.jobs.title')}</DialogTitle>
        <DialogContent>
          {jobs.data?.map((j) => (
            <Box key={j.id} sx={{ py: 0.75 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{j.name}{!j.enabled && <Typography component="span" variant="caption" color="text.secondary"> · {t('jobs.paused')}</Typography>}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: 'monospace' }}>{j.schedule}{j.lastStatus ? ` · ${j.lastStatus}` : ''}</Typography>
            </Box>
          ))}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setJobsOpen(false); onOpenJobs(); }}>{t('miniapps.jobs.open')}</Button>
          <Button onClick={() => setJobsOpen(false)}>{t('common.close')}</Button>
        </DialogActions>
      </Dialog>
      {app.err ? <Typography sx={{ p: 3 }} color="text.secondary">{t('miniapps.notFound')}</Typography> : a && <MiniappFrame app={a} dataKey={dataKey} />}
    </Box>
  );
}
