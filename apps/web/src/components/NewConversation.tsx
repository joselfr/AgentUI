import { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, ListItemButton, ListItemText, Typography } from '@mui/material';
import type { AgentInfo, SubAgent } from '@agentui/shared';
import { api } from '../api';
import { useBackClose } from '../useBackClose';
import StatusDot from './StatusDot';
import { t } from '../i18n';

export default function NewConversation(props: {
  open: boolean; agents: AgentInfo[]; agentId?: string; sub?: string;
  onClose: () => void; onStart: (agentId: string, sub?: string) => void;
}) {
  const { open, agents } = props;
  useBackClose(open, props.onClose);
  const [agentId, setAgentId] = useState<string>();
  const [sub, setSub] = useState<string>();
  const [subs, setSubs] = useState<SubAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (open) { setAgentId(props.agentId ?? agents[0]?.id); setSub(props.sub); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !agentId) return;
    let live = true;
    setLoading(true); setErr(''); setSubs([]);
    api.subAgents(agentId).then((s) => { if (live) setSubs(s); }).catch((e) => { if (live) setErr((e as Error).message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [open, agentId]);

  const pick = (id: string) => { if (id !== agentId) { setAgentId(id); setSub(undefined); } };
  const Label = ({ children }: { children: string }) => <Typography variant="overline" color="text.secondary" sx={{ display: 'block', pb: 0.5 }}>{children}</Typography>;

  return (
    <Dialog open={open} onClose={props.onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontWeight: 650 }}>{t('chat.new')}</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: 1 }}>
        <Box>
          <Label>{t('new.agent')}</Label>
          <Box sx={{ display: 'grid', gap: 0.5 }}>
            {agents.map((a) => (
              <ListItemButton key={a.id} selected={a.id === agentId} onClick={() => pick(a.id)} sx={{ gap: 1.5, border: 1, borderColor: a.id === agentId ? 'primary.main' : 'divider' }}>
                <StatusDot status={a.status} />
                <ListItemText primary={a.name} secondary={a.status === 'connected' ? a.type : a.statusDetail ?? a.status}
                  primaryTypographyProps={{ fontWeight: 600, noWrap: true }} secondaryTypographyProps={{ noWrap: true, fontSize: 12 }} />
              </ListItemButton>))}
          </Box>
        </Box>
        {(loading || err || subs.length > 0) && (
          <Box>
            <Label>{t('new.subagent')}</Label>
            {loading && <Box sx={{ p: 2, textAlign: 'center' }}><CircularProgress size={22} /></Box>}
            {err && <Alert severity="warning">{err}</Alert>}
            <Box sx={{ display: 'grid', gap: 0.5 }}>
              {!loading && subs.length > 0 && (
                <ListItemButton selected={!sub} onClick={() => setSub(undefined)} sx={{ border: 1, borderColor: !sub ? 'primary.main' : 'divider' }}>
                  <ListItemText primary={t('common.default')} primaryTypographyProps={{ fontWeight: 600 }} /></ListItemButton>)}
              {subs.map((s) => (
                <ListItemButton key={s.id} selected={s.id === sub} onClick={() => setSub(s.id)} sx={{ border: 1, borderColor: s.id === sub ? 'primary.main' : 'divider' }}>
                  <ListItemText primary={s.name} secondary={s.description} primaryTypographyProps={{ fontWeight: 600, noWrap: true }} secondaryTypographyProps={{ fontSize: 12 }} /></ListItemButton>))}
            </Box>
          </Box>)}
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onClose}>{t('common.cancel')}</Button>
        <Button variant="contained" disabled={!agentId} onClick={() => agentId && props.onStart(agentId, sub)}>{t('new.start')}</Button>
      </DialogActions>
    </Dialog>
  );
}
