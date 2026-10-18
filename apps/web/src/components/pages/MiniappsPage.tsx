import { useEffect } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import type { AgentInfo, MiniApp } from '@agentui/shared';
import { api } from '../../api';
import { t } from '../../i18n';
import { useConfirm } from '../Confirm';
import { MiniappIcon } from '../miniapps/miniappIcons';
import { card, Page, Status, useLoad } from './shared';

export function MiniappsPage({ agents, refreshKey, onOpen }: { agents: AgentInfo[]; refreshKey: number; onOpen: (id: string) => void }) {
  const apps = useLoad<MiniApp[]>(() => api.miniapps(), []);
  const { ask, dialog } = useConfirm();
  useEffect(() => { if (refreshKey) apps.refresh().catch(() => {}); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = async (a: MiniApp) => {
    if (!(await ask({ title: t('miniapps.deleteTitle', { name: a.name }), text: t('miniapps.deleteText'), confirmLabel: t('common.delete'), danger: true }))) return;
    await api.removeMiniapp(a.id).catch(() => {});
    apps.reload();
  };
  return (
    <Page title={t('miniapps.title')}>
      <Status loading={apps.loading} err={apps.err} empty={!apps.data?.length} />
      {!apps.loading && !apps.err && !apps.data?.length && <Typography color="text.secondary" align="center" variant="body2">{t('miniapps.empty')}</Typography>}
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
        {apps.data?.map((a) => (
          <Box key={a.id} role="button" tabIndex={0} onClick={() => onOpen(a.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(a.id)}
            sx={{ ...card, cursor: 'pointer', alignItems: 'flex-start', '&:hover': { borderColor: 'text.secondary' } }}>
            <Box sx={{ width: 40, height: 40, borderRadius: '10px', display: 'grid', placeItems: 'center', flexShrink: 0, color: 'primary.main', bgcolor: (th) => `${th.palette.primary.main}22` }}><MiniappIcon name={a.icon} /></Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>{a.name}</Typography>
              {a.description && <Typography variant="caption" color="text.secondary" sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.description}</Typography>}
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, opacity: 0.8 }}>{t('miniapps.by', { agent: agents.find((g) => g.id === a.agentId)?.name ?? a.agentId })}</Typography>
            </Box>
            <Tooltip title={t('miniapps.delete')}><IconButton size="small" aria-label={t('miniapps.delete')} onClick={(e) => { e.stopPropagation(); void remove(a); }}><DeleteOutline fontSize="small" /></IconButton></Tooltip>
          </Box>))}
      </Box>
      {dialog}
    </Page>
  );
}
