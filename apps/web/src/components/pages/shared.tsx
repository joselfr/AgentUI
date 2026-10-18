import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Box, CircularProgress, MenuItem, Select, Typography } from '@mui/material';
import type { AgentInfo, SubAgent } from '@agentui/shared';
import { api } from '../../api';
import { t } from '../../i18n';

export const card = { display: 'flex', alignItems: 'center', gap: 1.5, p: 1.5, border: 1, borderColor: 'divider', borderRadius: '12px', bgcolor: 'background.paper' } as const;

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  /** Silent reload (no loading indicator), for live tracking. */
  const refresh = useCallback(() => fn().then((d) => { setData(d); setErr(''); return d; }), deps); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = useCallback(() => {
    setLoading(true);
    fn().then((d) => { setData(d); setErr(''); }).catch((e) => setErr((e as Error).message)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, err, loading, reload, refresh };
}

export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
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

export function Status({ loading, err, empty }: { loading: boolean; err: string; empty: boolean }) {
  return (
    <>
      {loading && <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>}
      {err && <Alert severity="warning" sx={{ mb: 1 }}>{err}</Alert>}
      {!loading && !err && empty && <Typography sx={{ p: 3 }} color="text.secondary" align="center">{t('common.noItems')}</Typography>}
    </>
  );
}

/** Agent pickers (and sub-agent pickers for the pages that depend on them). */
export function Pickers({ agents, agentId, sub, onAgent, onSub, subs }: {
  agents: AgentInfo[]; agentId?: string; sub?: string; onAgent: (id: string) => void; onSub?: (s?: string) => void; subs?: SubAgent[];
}) {
  return (
    <>
      <Select size="small" value={agentId ?? ''} onChange={(e) => onAgent(e.target.value)} sx={{ minWidth: 140 }}>
        {agents.map((a) => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
      </Select>
      {onSub && !!subs?.length && (
        <Select size="small" displayEmpty value={sub ?? ''} onChange={(e) => onSub(e.target.value || undefined)} sx={{ minWidth: 140 }}>
          <MenuItem value="">{t('common.default')}</MenuItem>
          {subs.map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
        </Select>)}
    </>
  );
}

/** Agent + sub-agent chosen in a page, among the compatible agents. */
export function useScope(agents: AgentInfo[], supports: (a: AgentInfo) => boolean) {
  const ok = agents.filter(supports);
  const [agentId, setAgentId] = useState<string>();
  const [sub, setSub] = useState<string>();
  const agent = ok.find((a) => a.id === agentId) ?? ok[0];
  const subs = useLoad<SubAgent[]>(() => (agent ? api.subAgents(agent.id).catch(() => []) : Promise.resolve([])), [agent?.id]);
  return { ok, agent, sub, subs: subs.data, setAgent: (id: string) => { setAgentId(id); setSub(undefined); }, setSub };
}
