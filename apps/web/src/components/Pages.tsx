import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, IconButton, MenuItem, Select, Tooltip, Typography } from '@mui/material';
import Pause from '@mui/icons-material/Pause';
import PlayArrow from '@mui/icons-material/PlayArrow';
import Bolt from '@mui/icons-material/Bolt';
import Delete from '@mui/icons-material/Delete';
import type { AgentInfo, Job, Skill, SubAgent } from '@agentui/shared';
import { api } from '../api';
import { MONO } from '../theme';
import { StatusDot } from './Sidebar';

const card = { display: 'flex', alignItems: 'center', gap: 1.5, p: 1.5, border: 1, borderColor: 'divider', borderRadius: '12px', bgcolor: 'background.paper' } as const;

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

function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Box sx={{ height: '100%', overflow: 'auto' }}>
      <Box sx={{ maxWidth: 860, mx: 'auto', p: { xs: 1.5, sm: 3 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
          <Typography variant="h6" sx={{ flex: 1, minWidth: 120 }}>{title}</Typography>
          {actions}
        </Box>
        {children}
      </Box>
    </Box>
  );
}

function Status({ loading, err, empty }: { loading: boolean; err: string; empty: boolean }) {
  return (
    <>
      {loading && <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>}
      {err && <Alert severity="warning" sx={{ mb: 1 }}>{err}</Alert>}
      {!loading && !err && empty && <Typography sx={{ p: 3 }} color="text.secondary" align="center">Aucun élément</Typography>}
    </>
  );
}

/** Sélecteurs d'agent (et de sous-agent pour les pages qui en dépendent). */
function Pickers({ agents, agentId, sub, onAgent, onSub, subs }: {
  agents: AgentInfo[]; agentId?: string; sub?: string; onAgent: (id: string) => void; onSub?: (s?: string) => void; subs?: SubAgent[];
}) {
  return (
    <>
      <Select size="small" value={agentId ?? ''} onChange={(e) => onAgent(e.target.value)} sx={{ minWidth: 140 }}>
        {agents.map((a) => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
      </Select>
      {onSub && !!subs?.length && (
        <Select size="small" displayEmpty value={sub ?? ''} onChange={(e) => onSub(e.target.value || undefined)} sx={{ minWidth: 140 }}>
          <MenuItem value="">Par défaut</MenuItem>
          {subs.map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
        </Select>)}
    </>
  );
}

/** Agent + sous-agent choisis dans une page, parmi les agents compatibles. */
function useScope(agents: AgentInfo[], supports: (a: AgentInfo) => boolean) {
  const ok = agents.filter(supports);
  const [agentId, setAgentId] = useState<string>();
  const [sub, setSub] = useState<string>();
  const agent = ok.find((a) => a.id === agentId) ?? ok[0];
  const subs = useLoad<SubAgent[]>(() => (agent ? api.subAgents(agent.id).catch(() => []) : Promise.resolve([])), [agent?.id]);
  return { ok, agent, sub, subs: subs.data, setAgent: (id: string) => { setAgentId(id); setSub(undefined); }, setSub };
}

export function AgentsPage({ agents, onStart }: { agents: AgentInfo[]; onStart: (agentId: string, sub?: string) => void }) {
  return (
    <Page title="Agents">
      <Box sx={{ display: 'grid', gap: 1.5 }}>
        {agents.map((a) => <AgentCard key={a.id} agent={a} onStart={onStart} />)}
        {!agents.length && <Typography color="text.secondary">Aucun agent configuré.</Typography>}
      </Box>
    </Page>
  );
}

function AgentCard({ agent, onStart }: { agent: AgentInfo; onStart: (agentId: string, sub?: string) => void }) {
  const subs = useLoad<SubAgent[]>(() => api.subAgents(agent.id).catch(() => []), [agent.id]);
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: '14px', bgcolor: 'background.paper', overflow: 'hidden' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 2 }}>
        <StatusDot status={agent.status} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" noWrap>{agent.name}</Typography>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{agent.status === 'connected' ? agent.type : agent.statusDetail ?? agent.status}</Typography>
        </Box>
        <Button size="small" variant="outlined" onClick={() => onStart(agent.id)}>Discuter</Button>
      </Box>
      {subs.loading && <Box sx={{ p: 1.5, textAlign: 'center' }}><CircularProgress size={18} /></Box>}
      {!!subs.data?.length && (
        <Box sx={{ borderTop: 1, borderColor: 'divider', p: 1.5, display: 'grid', gap: 1 }}>
          <Typography variant="overline" color="text.secondary">Sous-agents</Typography>
          {subs.data.map((s) => (
            <Box key={s.id} sx={{ ...card, bgcolor: 'background.default' }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>{s.name}{s.isDefault && <Chip size="small" label="défaut" sx={{ ml: 1 }} />}</Typography>
                {s.description && <Typography variant="caption" color="text.secondary">{s.description}</Typography>}
              </Box>
              <Button size="small" onClick={() => onStart(agent.id, s.id)}>Discuter</Button>
            </Box>))}
        </Box>)}
    </Box>
  );
}

export function SkillsPage({ agents }: { agents: AgentInfo[] }) {
  const sc = useScope(agents, (a) => a.capabilities.skills);
  const skills = useLoad<Skill[]>(() => (sc.agent ? api.skills(sc.agent.id, sc.sub) : Promise.resolve([])), [sc.agent?.id, sc.sub]);
  return (
    <Page title="Skills" actions={<Pickers agents={sc.ok} agentId={sc.agent?.id} sub={sc.sub} onAgent={sc.setAgent} onSub={sc.setSub} subs={sc.subs} />}>
      <Status loading={skills.loading} err={skills.err} empty={!sc.agent || !skills.data?.length} />
      <Box sx={{ display: 'grid', gap: 1 }}>
        {skills.data?.map((s) => (
          <Box key={s.id} sx={card}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{s.name}</Typography>
              {s.description && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{s.description}</Typography>}
              {s.category && <Chip size="small" label={s.category} sx={{ mt: 0.75 }} />}
            </Box>
          </Box>))}
      </Box>
    </Page>
  );
}

export function JobsPage({ agents }: { agents: AgentInfo[] }) {
  const sc = useScope(agents, (a) => a.capabilities.jobs);
  const jobs = useLoad<Job[]>(() => (sc.agent ? api.jobs(sc.agent.id, sc.sub) : Promise.resolve([])), [sc.agent?.id, sc.sub]);
  const act = async (j: Job, a: string) => { if (sc.agent) await api.jobAction(sc.agent.id, j.id, a, sc.sub).catch((e) => alert((e as Error).message)); jobs.reload(); };
  return (
    <Page title="Tâches" actions={<Pickers agents={sc.ok} agentId={sc.agent?.id} sub={sc.sub} onAgent={sc.setAgent} onSub={sc.setSub} subs={sc.subs} />}>
      <Status loading={jobs.loading} err={jobs.err} empty={!sc.agent || !jobs.data?.length} />
      <Box sx={{ display: 'grid', gap: 1 }}>
        {jobs.data?.map((j) => (
          <Box key={j.id} sx={card}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{j.name}{!j.enabled && <Chip size="small" label="en pause" sx={{ ml: 1 }} />}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                <code style={{ fontFamily: MONO }}>{j.schedule}</code>{j.nextRunAt ? ` · prochaine : ${new Date(j.nextRunAt).toLocaleString()}` : ''}{j.lastStatus ? ` · dernier : ${j.lastStatus}` : ''}
              </Typography>
            </Box>
            {sc.agent?.capabilities.jobControl && (
              <Box sx={{ display: 'flex', flexShrink: 0 }}>
                <Tooltip title={j.enabled ? 'Mettre en pause' : 'Reprendre'}><IconButton size="small" onClick={() => act(j, j.enabled ? 'pause' : 'resume')}>{j.enabled ? <Pause /> : <PlayArrow />}</IconButton></Tooltip>
                <Tooltip title="Exécuter maintenant"><IconButton size="small" onClick={() => act(j, 'run')}><Bolt /></IconButton></Tooltip>
                <Tooltip title="Supprimer"><IconButton size="small" onClick={() => confirm(`Supprimer « ${j.name} » ?`) && act(j, 'delete')}><Delete /></IconButton></Tooltip>
              </Box>)}
          </Box>))}
      </Box>
    </Page>
  );
}
