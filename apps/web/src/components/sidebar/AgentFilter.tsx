import { Box, Chip } from '@mui/material';
import type { AgentInfo } from '@agentui/shared';
import { t } from '../../i18n';

/** Puces « Tous / <agent> » pour filtrer la liste. */
export default function AgentFilter({ agents, value, onChange }: { agents: AgentInfo[]; value: string; onChange: (id: string) => void }) {
  return (
    <Box role="group" aria-label={t('agentFilter.label')} sx={{ display: 'flex', justifyContent: 'center', gap: 0.75, px: 1.5, pt: 1, pb: 0.5, flexWrap: 'wrap' }}>
      {[{ id: 'all', name: t('agentFilter.all') }, ...agents].map((a) => (
        <Chip key={a.id} size="small" label={a.name} clickable color={value === a.id ? 'primary' : 'default'} variant={value === a.id ? 'filled' : 'outlined'}
          aria-pressed={value === a.id} onClick={() => onChange(a.id)} />))}
    </Box>
  );
}
