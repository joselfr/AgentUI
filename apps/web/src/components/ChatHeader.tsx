import { AppBar, Box, Chip, IconButton, Toolbar, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import MenuIcon from '@mui/icons-material/Menu';
import type { AgentInfo } from '@agentui/shared';
import StatusDot from './StatusDot';

/** Barre du haut du chat : bouton d'affichage de la liste, titre de la discussion, agent et son état de connexion. */
export default function ChatHeader({ title, agent, showListButton, onShowList }: { title: string; agent?: AgentInfo; showListButton: boolean; onShowList: () => void }) {
  return (
    <AppBar position="static" color="transparent" elevation={0}
      sx={{ border: 0, borderBottom: 1, borderColor: 'divider', backdropFilter: 'blur(12px)', bgcolor: (t) => alpha(t.palette.background.default, 0.8) }}>
      <Toolbar sx={{ gap: 1.5, minHeight: { xs: 56, md: 64 } }}>
        {showListButton && <IconButton edge="start" onClick={onShowList} aria-label="Afficher les discussions" title="Afficher les discussions"><MenuIcon /></IconButton>}
        <Typography variant="subtitle1" noWrap sx={{ flex: 1 }}>{title}</Typography>
        {agent && (
          <Chip size="small" variant="outlined"
            label={<Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><StatusDot status={agent.status} /><Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.name}</Box></Box>}
            title={agent.status === 'connected' ? agent.type : agent.statusDetail ?? agent.status}
            sx={{ height: 32, fontWeight: 600, maxWidth: { xs: 140, sm: 260 }, '& .MuiChip-label': { px: 1.5 } }} />)}
      </Toolbar>
    </AppBar>
  );
}
