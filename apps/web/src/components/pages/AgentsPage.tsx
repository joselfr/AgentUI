import { Box, Button, Chip, CircularProgress, Typography } from '@mui/material';
import type { AgentInfo, SubAgent } from '@agentui/shared';
import { api } from '../../api';
import StatusDot from '../StatusDot';
import { card, useLoad, Page } from './shared';

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
