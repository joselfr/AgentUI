import { Avatar, Box, Button, CircularProgress, IconButton, List, ListItemButton, ListItemText, Tooltip, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import Add from '@mui/icons-material/Add';
import Settings from '@mui/icons-material/Settings';
import Delete from '@mui/icons-material/Delete';
import ChevronLeft from '@mui/icons-material/ChevronLeft';
import ChevronRight from '@mui/icons-material/ChevronRight';
import ChatBubbleOutline from '@mui/icons-material/ChatBubbleOutline';
import type { AgentInfo, ConnStatus } from '@agentui/shared';
import type { Conversation } from '../api';

export const DRAWER = 280;
export const RAIL = 68;

const dot: Record<ConnStatus, string> = { connected: 'success.main', connecting: 'warning.main', error: 'error.main', disconnected: 'text.disabled' };

export function StatusDot({ status, size = 8 }: { status: ConnStatus; size?: number }) {
  return (
    <Box component="span" aria-hidden sx={{
      width: size, height: size, borderRadius: '50%', bgcolor: dot[status], flexShrink: 0, display: 'inline-block',
      boxShadow: status === 'connected' ? (t) => `0 0 0 3px ${alpha(t.palette.success.main, 0.18)}` : 'none',
    }} />
  );
}

const Label = ({ children }: { children: string }) => (
  <Typography variant="overline" color="text.secondary" sx={{ display: 'block', px: 1.5, pt: 2, pb: 0.5 }}>{children}</Typography>
);

export default function Sidebar(props: {
  agents: AgentInfo[]; convs: Conversation[]; agentId?: string; currentId?: string; collapsed: boolean; canCollapse: boolean;
  onToggle: () => void; onSelectAgent: (id: string) => void; onSelectConv: (id: string) => void; onNew: () => void;
  onDelete: (c: Conversation) => void; onSettings: () => void;
}) {
  const { collapsed: rail, agents, convs } = props;
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  return (
    <Box sx={{ width: rail ? RAIL : DRAWER, display: 'flex', flexDirection: 'column', height: '100%', transition: 'width .2s', overflow: 'hidden' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 2, height: 64, flexShrink: 0 }}>
        <Box component="img" src="/icon.svg" alt="" sx={{ width: 32, height: 32, borderRadius: '9px', flexShrink: 0 }} />
        {!rail && (
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ lineHeight: 1.1 }}>AgentUI</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: '0.08em', textTransform: 'uppercase', fontSize: 10 }}>Control</Typography>
          </Box>)}
        {!rail && props.canCollapse && <IconButton size="small" onClick={props.onToggle} aria-label="Réduire le menu"><ChevronLeft /></IconButton>}
      </Box>

      <Box sx={{ px: rail ? 1.25 : 1.5, pb: 0.5 }}>
        {rail
          ? <Tooltip title="Nouvelle conversation" placement="right"><IconButton onClick={props.onNew} aria-label="Nouvelle conversation" sx={{ width: 44, height: 44, bgcolor: 'primary.main', color: 'primary.contrastText', '&:hover': { bgcolor: 'primary.dark' } }}><Add /></IconButton></Tooltip>
          : <Button fullWidth variant="contained" startIcon={<Add />} onClick={props.onNew}>Nouvelle conversation</Button>}
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', px: rail ? 1.25 : 1, pb: 1 }}>
        {!rail && <Label>Agents</Label>}
        <List dense disablePadding sx={{ mt: rail ? 1.5 : 0 }}>
          {agents.map((a) => (
            <Tooltip key={a.id} title={rail ? `${a.name} — ${a.status}` : ''} placement="right">
              <ListItemButton selected={a.id === props.agentId} onClick={() => props.onSelectAgent(a.id)} sx={{ gap: 1.25, px: rail ? 0 : 1.5, justifyContent: rail ? 'center' : 'flex-start', minHeight: 44 }}>
                {rail
                  ? <Avatar sx={{ width: 32, height: 32, fontSize: 14, bgcolor: 'action.selected', color: 'text.primary', position: 'relative' }}>{a.name[0]}</Avatar>
                  : <StatusDot status={a.status} />}
                {!rail && <ListItemText primary={a.name} secondary={a.status === 'connected' ? a.type : a.statusDetail ?? a.status}
                  primaryTypographyProps={{ fontWeight: 600, noWrap: true }} secondaryTypographyProps={{ noWrap: true, fontSize: 12 }} />}
              </ListItemButton>
            </Tooltip>))}
        </List>

        {!rail && <Label>Conversations</Label>}
        <List dense disablePadding sx={{ mt: rail ? 1.5 : 0 }}>
          {convs.map((c) => (
            <Tooltip key={c.id} title={rail ? c.title : ''} placement="right">
              <ListItemButton selected={c.id === props.currentId} onClick={() => props.onSelectConv(c.id)}
                sx={{ gap: 1, px: rail ? 0 : 1.5, justifyContent: rail ? 'center' : 'flex-start', '& .del': { opacity: 0, transition: 'opacity .15s' }, '&:hover .del, &:focus-within .del, &.Mui-selected .del': { opacity: 1 }, '@media (hover: none)': { '& .del': { opacity: 1 } } }}>
                {rail ? <ChatBubbleOutline fontSize="small" color={c.running ? 'primary' : 'action'} /> : (
                  <>
                    <ListItemText primary={c.title} secondary={`${agentName(c.agentId)} · ${new Date(c.updatedAt).toLocaleDateString()}`}
                      primaryTypographyProps={{ noWrap: true, fontWeight: 500 }} secondaryTypographyProps={{ noWrap: true, fontSize: 12 }} />
                    {c.running && <CircularProgress size={14} />}
                    <IconButton className="del" size="small" edge="end" aria-label="Supprimer" onClick={(e) => { e.stopPropagation(); props.onDelete(c); }}>
                      <Delete fontSize="small" /></IconButton>
                  </>)}
              </ListItemButton>
            </Tooltip>))}
        </List>
      </Box>

      <Box sx={{ p: rail ? 1.25 : 1.5, borderTop: 1, borderColor: 'divider', display: 'flex', flexDirection: rail ? 'column' : 'row', alignItems: 'center', gap: 0.5 }}>
        <Button color="inherit" startIcon={rail ? undefined : <Settings />} onClick={props.onSettings} aria-label="Réglages"
          sx={{ flex: rail ? undefined : 1, justifyContent: rail ? 'center' : 'flex-start', minWidth: 0, color: 'text.secondary' }}>
          {rail ? <Settings /> : 'Réglages'}</Button>
        {props.canCollapse && rail && <IconButton size="small" onClick={props.onToggle} aria-label="Développer le menu"><ChevronRight /></IconButton>}
      </Box>
    </Box>
  );
}
