import { useState } from 'react';
import { Box, Chip, CircularProgress, Collapse, IconButton, Paper, Typography } from '@mui/material';
import { MONO } from '../theme';
import CheckCircle from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import ExpandMore from '@mui/icons-material/ExpandMore';
import BuildOutlined from '@mui/icons-material/BuildOutlined';
import AccountTreeOutlined from '@mui/icons-material/AccountTreeOutlined';
import type { SubAgentRun, ToolCall } from '@agentui/shared';

const dur = (a: number, b?: number) => (b ? `${Math.max(0, (b - a) / 1000).toFixed(1)} s` : '');
const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function StatusIcon({ s }: { s: ToolCall['status'] }) {
  if (s === 'running') return <CircularProgress size={16} />;
  return s === 'done' ? <CheckCircle color="success" fontSize="small" /> : <ErrorIcon color="error" fontSize="small" />;
}

export function ToolCard({ tool, defaultOpen }: { tool: ToolCall; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [full, setFull] = useState(false);
  const result = tool.resultPreview ?? '';
  const shown = full || result.length < 1500 ? result : result.slice(0, 1500) + '…';
  return (
    <Paper sx={{ my: 0.5, overflow: 'hidden', bgcolor: 'background.default', borderLeft: 3, borderLeftColor: tool.status === 'running' ? 'warning.main' : tool.status === 'done' ? 'success.main' : 'error.main' }}>
      <Box onClick={() => setOpen(!open)} sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.5, cursor: 'pointer' }}>
        <BuildOutlined fontSize="small" color="action" />
        <Typography variant="body2" sx={{ fontFamily: MONO, fontSize: 13, flex: 1 }} noWrap>{tool.name}</Typography>
        <Typography variant="caption" color="text.secondary">{dur(tool.startedAt, tool.endedAt)}</Typography>
        <StatusIcon s={tool.status} />
        <IconButton size="small" sx={{ transform: open ? 'rotate(180deg)' : 'none' }}><ExpandMore fontSize="small" /></IconButton>
      </Box>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ px: 1.5, pb: 1, fontSize: 12, '& pre': { fontFamily: MONO, m: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflow: 'auto' } }}>
          {tool.args !== undefined && (<><Typography variant="caption" color="text.secondary">Arguments</Typography><pre>{pretty(tool.args)}</pre></>)}
          {result && (<><Typography variant="caption" color="text.secondary">Résultat</Typography><pre>{shown}</pre>
            {(result.length >= 1500 || tool.resultTruncated) && !full && (
              <Chip size="small" label={tool.resultTruncated ? 'tronqué' : 'voir plus'} onClick={() => setFull(true)} />)}</>)}
          {tool.args === undefined && !result && <Typography variant="caption" color="text.secondary">Pas de détails exposés par l'agent.</Typography>}
        </Box>
      </Collapse>
    </Paper>
  );
}

/** Regroupe les outils : ceux d'un sous-agent sont imbriqués sous sa carte. */
export function ToolsBlock({ tools, subRuns, expandAll }: { tools: ToolCall[]; subRuns: SubAgentRun[]; expandAll: boolean }) {
  const [open, setOpen] = useState(false);
  if (!tools.length && !subRuns.length) return null;
  const running = tools.some((t) => t.status === 'running');
  const expanded = open || expandAll || running;
  const top = tools.filter((t) => !t.parentSubAgentRunId);
  return (
    <Box sx={{ mb: 1 }}>
      <Chip size="small" icon={<BuildOutlined />} label={`${tools.length} outil${tools.length > 1 ? 's' : ''} utilisé${tools.length > 1 ? 's' : ''}`}
        onClick={() => setOpen(!open)} variant="outlined" sx={{ mb: 0.5, borderRadius: 2, fontFamily: MONO, fontSize: 12 }} />
      <Collapse in={expanded}>
        {subRuns.map((s) => (
          <Paper key={s.id} sx={{ my: 0.5, p: 1, borderLeft: 3, borderLeftColor: 'secondary.main' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <AccountTreeOutlined fontSize="small" color="secondary" />
              <Typography variant="body2" sx={{ flex: 1 }}>Sous-agent : {s.name}</Typography>
              <StatusIcon s={s.status} />
            </Box>
            {tools.filter((t) => t.parentSubAgentRunId === s.id).map((t) => <ToolCard key={t.id} tool={t} />)}
          </Paper>
        ))}
        {top.map((t) => <ToolCard key={t.id} tool={t} />)}
      </Collapse>
    </Box>
  );
}
