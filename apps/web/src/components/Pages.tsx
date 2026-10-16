import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, MenuItem, Select, Snackbar, Tooltip, Typography } from '@mui/material';
import Pause from '@mui/icons-material/Pause';
import PlayArrow from '@mui/icons-material/PlayArrow';
import Bolt from '@mui/icons-material/Bolt';
import Delete from '@mui/icons-material/Delete';
import Forum from '@mui/icons-material/Forum';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import type { AgentInfo, Job, Skill, SubAgent } from '@agentui/shared';
import { api } from '../api';
import { MONO } from '../theme';
import { useConfirm } from './Confirm';
import { StatusDot } from './Sidebar';

const card = { display: 'flex', alignItems: 'center', gap: 1.5, p: 1.5, border: 1, borderColor: 'divider', borderRadius: '12px', bgcolor: 'background.paper' } as const;

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  /** Rechargement silencieux (sans indicateur de chargement), pour le suivi en direct. */
  const refresh = useCallback(() => fn().then((d) => { setData(d); setErr(''); return d; }), deps); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = useCallback(() => {
    setLoading(true);
    fn().then((d) => { setData(d); setErr(''); }).catch((e) => setErr((e as Error).message)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, err, loading, reload, refresh };
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

const RUN_TIMEOUT_MS = 15 * 60_000;
const timeOf = (ms: number) => new Date(ms).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Pastille d'état d'une tâche : en attente / en cours / résultat de la dernière exécution. */
function RunState({ j, launched }: { j: Job; launched: boolean }) {
  if (j.running) return <Chip size="small" color="info" icon={<CircularProgress size={12} color="inherit" sx={{ ml: '6px !important' }} />} label="en cours" />;
  if (j.queued || launched) return <Chip size="small" variant="outlined" color="warning" icon={<CircularProgress size={12} color="inherit" sx={{ ml: '6px !important' }} />} label="en attente du planificateur" />;
  if (!j.lastStatus) return null;
  const ok = /^(ok|success|completed)$/i.test(j.lastStatus);
  const chip = <Chip size="small" variant="outlined" color={ok ? 'success' : 'error'} label={`${ok ? 'ok' : j.lastStatus}${j.lastRunAt ? ` · ${timeOf(j.lastRunAt)}` : ''}`} />;
  return j.lastError && !ok ? <Tooltip title={j.lastError}>{chip}</Tooltip> : chip;
}

/** Popup de détail d'une tâche : planification, dernière exécution, script exécuté et prompt confié à l'agent. */
function JobDialog({ j, onClose }: { j?: Job; onClose: () => void }) {
  const field = (label: string, value: ReactNode) => (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>{label}</Typography>
      <Box sx={{ mt: 0.25 }}>{value}</Box>
    </Box>);
  const block = (text: string, mono: boolean) => (
    <Box sx={{ p: 1.25, borderRadius: '8px', bgcolor: 'action.hover', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, maxHeight: 360, overflow: 'auto', ...(mono ? { fontFamily: MONO } : {}) }}>{text}</Box>);
  return (
    <Dialog open={!!j} onClose={onClose} fullWidth maxWidth="sm">
      {j && (<>
        <DialogTitle sx={{ fontWeight: 650, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          {j.name}
          {j.mode && <Chip size="small" variant="outlined" label={j.mode} />}
          {!j.enabled && <Chip size="small" label="en pause" />}
        </DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 2 }}>
          {field('Planification', <Typography variant="body2"><code style={{ fontFamily: MONO }}>{j.schedule}</code>{j.nextRunAt && j.enabled ? ` · prochaine : ${new Date(j.nextRunAt).toLocaleString()}` : ''}</Typography>)}
          {(j.lastStatus || j.running || j.queued) && field('Dernière exécution', <Box sx={{ display: 'grid', gap: 1, justifyItems: 'start' }}>
            <RunState j={j} launched={false} />
            {j.lastError && block(j.lastError, true)}
          </Box>)}
          {j.script && field(j.mode === 'script' ? 'Script' : 'Script préalable (sa sortie alimente le prompt)', block(j.script, true))}
          {j.prompt && field('Prompt', block(j.prompt, false))}
        </DialogContent>
        <DialogActions><Button onClick={onClose}>Fermer</Button></DialogActions>
      </>)}
    </Dialog>);
}

export function JobsPage({ agents, onOpenConversation }: { agents: AgentInfo[]; onOpenConversation: (id: string) => void }) {
  const { ask, dialog: confirmDialog } = useConfirm();
  const sc = useScope(agents, (a) => a.capabilities.jobs);
  const jobs = useLoad<Job[]>(() => (sc.agent ? api.jobs(sc.agent.id, sc.sub) : Promise.resolve([])), [sc.agent?.id, sc.sub]);
  // Exécutions lancées depuis cette page, suivies jusqu'à leur fin (lastRunAt postérieur au lancement).
  const [launched, setLaunched] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<{ text: string; ok: boolean; conversationId?: string }>();
  const [detail, setDetail] = useState<string>();
  const launchedRef = useRef(launched);
  launchedRef.current = launched;

  const act = async (j: Job, a: string) => {
    if (!sc.agent) return;
    try {
      await api.jobAction(sc.agent.id, j.id, a, sc.sub);
      if (a === 'run') setLaunched((l) => ({ ...l, [j.id]: Date.now() }));
    } catch (e) {
      setNotice({ text: (e as Error).message, ok: false });
    }
    jobs.reload();
  };

  const active = !!jobs.data?.some((j) => j.running || j.queued) || Object.keys(launched).length > 0;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      jobs.refresh().then((list) => {
        const now = Date.now();
        const done: Record<string, true> = {};
        for (const [id, at] of Object.entries(launchedRef.current)) {
          const j = list.find((x) => x.id === id);
          if (!j) { done[id] = true; continue; }
          if (!j.running && !j.queued && (j.lastRunAt ?? 0) >= at - 1000) {
            done[id] = true;
            const ok = !j.lastStatus || /^(ok|success|completed)$/i.test(j.lastStatus);
            setNotice({ text: `« ${j.name} » ${ok ? 'terminée' : `en échec${j.lastError ? ` : ${j.lastError}` : ''}`}`, ok, conversationId: j.conversationId });
          } else if (now - at > RUN_TIMEOUT_MS) {
            done[id] = true;
            setNotice({ text: `« ${j.name} » : pas de fin d'exécution observée après 15 min`, ok: false, conversationId: j.conversationId });
          }
        }
        if (Object.keys(done).length) setLaunched((l) => Object.fromEntries(Object.entries(l).filter(([id]) => !done[id])));
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [active, jobs.refresh]);

  return (
    <Page title="Tâches" actions={<Pickers agents={sc.ok} agentId={sc.agent?.id} sub={sc.sub} onAgent={sc.setAgent} onSub={sc.setSub} subs={sc.subs} />}>
      <Status loading={jobs.loading} err={jobs.err} empty={!sc.agent || !jobs.data?.length} />
      <Box sx={{ display: 'grid', gap: 1 }}>
        {jobs.data?.map((j) => {
          const busy = !!(j.running || j.queued || launched[j.id]);
          return (
            <Box key={j.id} sx={card}>
              <Box onClick={() => setDetail(j.id)} sx={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>{j.name}</Typography>
                  {j.mode && <Chip size="small" variant="outlined" label={j.mode === 'script' ? 'script' : 'agent'} />}
                  {!j.enabled && <Chip size="small" label="en pause" />}
                  <RunState j={j} launched={!!launched[j.id]} />
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  <code style={{ fontFamily: MONO }}>{j.schedule}</code>{j.nextRunAt && j.enabled ? ` · prochaine : ${new Date(j.nextRunAt).toLocaleString()}` : ''}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', flexShrink: 0 }}>
                <Tooltip title="Détails"><IconButton size="small" onClick={() => setDetail(j.id)}><InfoOutlined /></IconButton></Tooltip>
                {j.conversationId && (
                  <Tooltip title="Voir les résultats"><IconButton size="small" onClick={() => onOpenConversation(j.conversationId!)}><Forum /></IconButton></Tooltip>)}
                {sc.agent?.capabilities.jobControl && (<>
                  <Tooltip title={j.enabled ? 'Mettre en pause' : 'Reprendre'}><IconButton size="small" onClick={() => act(j, j.enabled ? 'pause' : 'resume')}>{j.enabled ? <Pause /> : <PlayArrow />}</IconButton></Tooltip>
                  <Tooltip title={busy ? 'Exécution en cours' : 'Exécuter maintenant'}><span><IconButton size="small" disabled={busy} onClick={() => act(j, 'run')}><Bolt /></IconButton></span></Tooltip>
                  <Tooltip title="Supprimer"><IconButton size="small" onClick={async () => { if (await ask({ title: 'Supprimer cette tâche ?', text: <>« {j.name} » sera supprimée définitivement.</>, confirmLabel: 'Supprimer', danger: true })) act(j, 'delete'); }}><Delete /></IconButton></Tooltip>
                </>)}
              </Box>
            </Box>);
        })}
      </Box>
      {confirmDialog}
      <JobDialog j={jobs.data?.find((x) => x.id === detail)} onClose={() => setDetail(undefined)} />
      <Snackbar open={!!notice} autoHideDuration={notice?.conversationId ? 15000 : 6000} onClose={() => setNotice(undefined)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={notice?.ok ? 'success' : 'error'} variant="filled" onClose={() => setNotice(undefined)}
          action={notice?.conversationId ? <Button color="inherit" size="small" onClick={() => { onOpenConversation(notice.conversationId!); setNotice(undefined); }}>Voir le résultat</Button> : undefined}>
          {notice?.text}
        </Alert>
      </Snackbar>
    </Page>
  );
}
