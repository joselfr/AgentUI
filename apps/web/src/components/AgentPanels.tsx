import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Chip, CircularProgress, IconButton, List, ListItem, ListItemText, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import Pause from '@mui/icons-material/Pause';
import PlayArrow from '@mui/icons-material/PlayArrow';
import Bolt from '@mui/icons-material/Bolt';
import Delete from '@mui/icons-material/Delete';
import type { AgentInfo, Job, Skill, SubAgent } from '@agentui/shared';
import { api } from '../api';
import { MONO } from '../theme';

const card = { border: 1, borderColor: 'divider', borderRadius: 3, bgcolor: 'background.default' } as const;

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    fn().then((d) => { setData(d); setErr(''); }).catch((e) => setErr((e as Error).message)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, err, loading, reload };
}

export default function AgentPanels({ agent, sub, onSubChange }: { agent: AgentInfo; sub?: string; onSubChange: (s: string) => void }) {
  const [tab, setTab] = useState(0);
  const subs = useLoad<SubAgent[]>(() => api.subAgents(agent.id), [agent.id]);
  const skills = useLoad<Skill[]>(() => (agent.capabilities.skills ? api.skills(agent.id, sub) : Promise.resolve([])), [agent.id, sub]);
  const jobs = useLoad<Job[]>(() => (agent.capabilities.jobs ? api.jobs(agent.id, sub) : Promise.resolve([])), [agent.id, sub]);
  const act = async (j: Job, a: string) => { await api.jobAction(agent.id, j.id, a, sub).catch((e) => alert((e as Error).message)); jobs.reload(); };
  const cur = [subs, skills, jobs][tab]!;
  return (
    <Box sx={{ height: '100%', overflow: 'auto' }}>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="fullWidth" sx={{ borderBottom: 1, borderColor: 'divider', position: 'sticky', top: 0, bgcolor: 'background.paper', zIndex: 1 }}>
        <Tab label="Agents" /><Tab label="Skills" /><Tab label="Tâches" />
      </Tabs>
      {cur.loading && <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>}
      {cur.err && <Alert severity="warning" sx={{ m: 2 }}>{cur.err}</Alert>}
      <List dense sx={{ p: 1.5, display: 'grid', gap: 1 }}>
        {tab === 0 && subs.data?.map((s) => (
          <ListItem key={s.id} secondaryAction={s.id === sub ? <Chip size="small" color="primary" label="actif" /> : undefined}
            onClick={() => onSubChange(s.id)} sx={{ cursor: 'pointer', ...card, ...(s.id === sub && { borderColor: 'primary.main' }) }}>
            <ListItemText primary={s.name} secondary={s.description} /></ListItem>))}
        {tab === 1 && skills.data?.map((s) => (
          <ListItem key={s.id} sx={card}><ListItemText primary={s.name} secondary={s.description} />{s.category && <Chip size="small" label={s.category} />}</ListItem>))}
        {tab === 2 && jobs.data?.map((j) => (
          <ListItem key={j.id} sx={card} secondaryAction={agent.capabilities.jobControl && (<>
            <Tooltip title={j.enabled ? 'Mettre en pause' : 'Reprendre'}><IconButton size="small" onClick={() => act(j, j.enabled ? 'pause' : 'resume')}>{j.enabled ? <Pause /> : <PlayArrow />}</IconButton></Tooltip>
            <Tooltip title="Exécuter maintenant"><IconButton size="small" onClick={() => act(j, 'run')}><Bolt /></IconButton></Tooltip>
            <Tooltip title="Supprimer"><IconButton size="small" onClick={() => confirm(`Supprimer « ${j.name} » ?`) && act(j, 'delete')}><Delete /></IconButton></Tooltip></>)}>
            <ListItemText primary={j.name} secondary={<>
              <code style={{ fontFamily: MONO }}>{j.schedule}</code>{j.nextRunAt ? ` · prochaine : ${new Date(j.nextRunAt).toLocaleString()}` : ''}{j.lastStatus ? ` · dernier : ${j.lastStatus}` : ''}</>} />
            {!j.enabled && <Chip size="small" label="en pause" sx={{ mr: 12 }} />}</ListItem>))}
      </List>
      {!cur.loading && !cur.err && !cur.data?.length && <Typography sx={{ p: 3 }} color="text.secondary" align="center">Aucun élément</Typography>}
    </Box>
  );
}
