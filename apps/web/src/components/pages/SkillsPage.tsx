import { Box, Chip, Typography } from '@mui/material';
import type { AgentInfo, Skill } from '@agentui/shared';
import { api } from '../../api';
import { card, useLoad, Page, Status, Pickers, useScope } from './shared';

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
