import { Badge, Box, IconButton, Tooltip } from '@mui/material';
import { alpha } from '@mui/material/styles';
import ChatBubbleOutline from '@mui/icons-material/ChatBubbleOutline';
import EventRepeat from '@mui/icons-material/EventRepeat';
import SmartToyOutlined from '@mui/icons-material/SmartToyOutlined';
import AutoAwesomeOutlined from '@mui/icons-material/AutoAwesomeOutlined';
import AppsOutlined from '@mui/icons-material/AppsOutlined';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import type { ReactNode } from 'react';
import { t, type Key } from '../i18n';

export type View = 'chats' | 'jobs' | 'agents' | 'skills' | 'apps';
export const NAV = 64;

const items: Array<{ id: View; label: Key; icon: ReactNode }> = [
  { id: 'chats', label: 'nav.chats', icon: <ChatBubbleOutline /> },
  { id: 'apps', label: 'nav.apps', icon: <AppsOutlined /> },
  { id: 'jobs', label: 'nav.jobs', icon: <EventRepeat /> },
  { id: 'agents', label: 'nav.agents', icon: <SmartToyOutlined /> },
  { id: 'skills', label: 'nav.skills', icon: <AutoAwesomeOutlined /> },
];

export default function NavRail({ view, onView, onSettings, settingsOpen, unread = 0 }: { view: View; onView: (v: View) => void; onSettings: () => void; settingsOpen: boolean; unread?: number }) {
  const btn = (key: string, label: string, icon: ReactNode, active: boolean, onClick: () => void, badge = 0) => (
    <Tooltip key={key} title={badge ? `${label} · ${t('nav.unread', { count: badge })}` : label} placement="right">
      <IconButton aria-label={badge ? `${label}, ${t('nav.unread', { count: badge })}` : label} aria-current={active ? 'page' : undefined} onClick={onClick}
        sx={{ width: 44, height: 44, borderRadius: '12px', color: active ? 'primary.main' : 'text.secondary', bgcolor: active ? (t) => alpha(t.palette.primary.main, 0.14) : 'transparent', '&:hover': { bgcolor: active ? (t) => alpha(t.palette.primary.main, 0.2) : 'action.hover' } }}>
        <Badge color="primary" badgeContent={badge} max={99} invisible={!badge} overlap="circular">{icon}</Badge>
      </IconButton>
    </Tooltip>
  );
  return (
    <Box component="nav" aria-label={t('nav.label')} sx={{ width: NAV, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.75, py: 1.5, borderRight: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
      <Box component="img" src="/icon.svg" alt="AgentUI" sx={{ width: 32, height: 32, borderRadius: '9px', mb: 1.5 }} />
      {items.map((i) => btn(i.id, t(i.label), i.icon, view === i.id, () => onView(i.id), i.id === 'chats' ? unread : 0))}
      <Box sx={{ flex: 1 }} />
      {btn('settings', t('nav.settings'), <SettingsOutlined />, settingsOpen, onSettings)}
    </Box>
  );
}
