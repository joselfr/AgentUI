import { Box, Button, CircularProgress, IconButton, List, ListItemButton, ListItemText, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import Add from '@mui/icons-material/Add';
import Delete from '@mui/icons-material/Delete';
import type { AgentInfo, ConnStatus } from '@agentui/shared';
import type { Conversation } from '../api';

export const DRAWER = 280;

const dot: Record<ConnStatus, string> = { connected: 'success.main', connecting: 'warning.main', error: 'error.main', disconnected: 'text.disabled' };

export function StatusDot({ status, size = 8 }: { status: ConnStatus; size?: number }) {
  return (
    <Box component="span" aria-hidden sx={{
      width: size, height: size, borderRadius: '50%', bgcolor: dot[status], flexShrink: 0, display: 'inline-block',
      boxShadow: status === 'connected' ? (t) => `0 0 0 3px ${alpha(t.palette.success.main, 0.18)}` : 'none',
    }} />
  );
}

export default function Sidebar(props: {
  agents: AgentInfo[]; convs: Conversation[]; currentId?: string;
  onSelectConv: (id: string) => void; onNew: () => void; onDelete: (c: Conversation) => void;
}) {
  const { agents, convs } = props;
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  return (
    <Box sx={{ width: DRAWER, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', px: 2, height: 64, flexShrink: 0 }}>
        <Typography variant="subtitle1">Discussions</Typography>
      </Box>
      <Box sx={{ px: 1.5, pb: 0.5 }}>
        <Button fullWidth variant="contained" startIcon={<Add />} onClick={props.onNew}>Nouvelle conversation</Button>
      </Box>
      <Box sx={{ flex: 1, overflow: 'auto', px: 1, pb: 1 }}>
        <List dense disablePadding sx={{ mt: 1 }}>
          {convs.map((c) => (
            <ListItemButton key={c.id} selected={c.id === props.currentId} onClick={() => props.onSelectConv(c.id)}
              sx={{ gap: 1, px: 1.5, '& .del': { opacity: 0, transition: 'opacity .15s' }, '&:hover .del, &:focus-within .del, &.Mui-selected .del': { opacity: 1 }, '@media (hover: none)': { '& .del': { opacity: 1 } } }}>
              <ListItemText primary={c.title} secondary={`${agentName(c.agentId)} · ${new Date(c.updatedAt).toLocaleDateString()}`}
                primaryTypographyProps={{ noWrap: true, fontWeight: 500 }} secondaryTypographyProps={{ noWrap: true, fontSize: 12 }} />
              {c.running && <CircularProgress size={14} />}
              <IconButton className="del" size="small" edge="end" aria-label="Supprimer" onClick={(e) => { e.stopPropagation(); props.onDelete(c); }}>
                <Delete fontSize="small" /></IconButton>
            </ListItemButton>))}
        </List>
      </Box>
    </Box>
  );
}
