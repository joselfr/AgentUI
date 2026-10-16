import { Box, Chip } from '@mui/material';
import type { AgentInfo } from '@agentui/shared';

/** Puces « Tous / <agent> » pour filtrer la liste. */
export default function AgentFilter({ agents, value, onChange }: { agents: AgentInfo[]; value: string; onChange: (id: string) => void }) {
  return (
    <Box role="group" aria-label="Filtrer par agent" sx={{ display: 'flex', justifyContent: 'center', gap: 0.75, px: 1.5, pt: 1, pb: 0.5, flexWrap: 'wrap' }}>
      {[{ id: 'all', name: 'Tous' }, ...agents].map((a) => (
        <Chip key={a.id} size="small" label={a.name} clickable color={value === a.id ? 'primary' : 'default'} variant={value === a.id ? 'filled' : 'outlined'}
          aria-pressed={value === a.id} onClick={() => onChange(a.id)} />))}
    </Box>
  );
}
