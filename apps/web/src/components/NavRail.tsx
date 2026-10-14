import { Box, IconButton, Tooltip } from '@mui/material';
import { alpha } from '@mui/material/styles';
import ChatBubbleOutline from '@mui/icons-material/ChatBubbleOutline';
import EventRepeat from '@mui/icons-material/EventRepeat';
import SmartToyOutlined from '@mui/icons-material/SmartToyOutlined';
import AutoAwesomeOutlined from '@mui/icons-material/AutoAwesomeOutlined';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import type { ReactNode } from 'react';

export type View = 'chats' | 'jobs' | 'agents' | 'skills';
export const NAV = 64;

const items: Array<{ id: View; label: string; icon: ReactNode }> = [
  { id: 'chats', label: 'Discussions', icon: <ChatBubbleOutline /> },
  { id: 'jobs', label: 'Tâches', icon: <EventRepeat /> },
  { id: 'agents', label: 'Agents', icon: <SmartToyOutlined /> },
  { id: 'skills', label: 'Skills', icon: <AutoAwesomeOutlined /> },
];

export default function NavRail({ view, onView, onSettings, settingsOpen }: { view: View; onView: (v: View) => void; onSettings: () => void; settingsOpen: boolean }) {
  const btn = (key: string, label: string, icon: ReactNode, active: boolean, onClick: () => void) => (
    <Tooltip key={key} title={label} placement="right">
      <IconButton aria-label={label} aria-current={active ? 'page' : undefined} onClick={onClick}
        sx={{ width: 44, height: 44, borderRadius: '12px', color: active ? 'primary.main' : 'text.secondary', bgcolor: active ? (t) => alpha(t.palette.primary.main, 0.14) : 'transparent', '&:hover': { bgcolor: active ? (t) => alpha(t.palette.primary.main, 0.2) : 'action.hover' } }}>
        {icon}
      </IconButton>
    </Tooltip>
  );
  return (
    <Box component="nav" aria-label="Navigation" sx={{ width: NAV, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.75, py: 1.5, borderRight: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
      <Box component="img" src="/icon.svg" alt="AgentUI" sx={{ width: 32, height: 32, borderRadius: '9px', mb: 1.5 }} />
      {items.map((i) => btn(i.id, i.label, i.icon, view === i.id, () => onView(i.id)))}
      <Box sx={{ flex: 1 }} />
      {btn('settings', 'Paramètres', <SettingsOutlined />, settingsOpen, onSettings)}
    </Box>
  );
}
