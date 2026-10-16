import { useState, type ReactNode } from 'react';
import { Box, ButtonBase, Collapse, Typography } from '@mui/material';
import { alpha, keyframes } from '@mui/material/styles';
import BuildOutlined from '@mui/icons-material/BuildOutlined';
import ExpandMore from '@mui/icons-material/ExpandMore';
import PsychologyOutlined from '@mui/icons-material/PsychologyOutlined';
import type { SubAgentRun, ToolCall } from '@agentui/shared';
import { MONO } from '../../theme';

const rotate = keyframes`to { transform: rotate(360deg) }`;
const pulse = keyframes`0%, 100% { opacity: 1; box-shadow: 0 0 0 0 var(--pulse) } 50% { opacity: .6; box-shadow: 0 0 0 4px transparent }`;

/** Anneau de chargement discret (activité en cours). */
const Spin = () => (
  <Box component="span" role="progressbar" aria-label="En cours"
    sx={{ width: 12, height: 12, border: 2, borderColor: 'text.disabled', borderTopColor: 'primary.main', borderRadius: '50%', animation: `${rotate} .8s linear infinite`, flexShrink: 0 }} />
);

/** Durée en français : « 0,1 s ». */
const dur = (a: number, b?: number) => (b ? `${(Math.max(0, b - a) / 1000).toFixed(1).replace('.', ',')} s` : '');
const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const STATUS_LABEL = { running: 'En cours', done: 'Terminé', failed: 'Échec' } as const;

/** Pastille d'état : vert = réussi, orange animé = en cours, rouge = échec, violet = sous-agent terminé. */
function Dot({ status, sub = false }: { status: ToolCall['status']; sub?: boolean }) {
  const color = status === 'running' ? 'warning.main' : status === 'failed' ? 'error.main' : sub ? 'secondary.main' : 'success.main';
  return (
    <Box component="span" role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]}
      sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, flexShrink: 0, ...(status === 'running' && { '--pulse': (t: any) => alpha(t.palette.warning.main, 0.5), animation: `${pulse} 1.3s infinite` }) }} />
  );
}

const rowSx = {
  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 1, py: 0.375, px: 0.75, ml: -0.75, borderRadius: '6px', textAlign: 'left',
  '&:hover': { bgcolor: 'action.hover' },
} as const;

const Chevron = ({ open }: { open: boolean }) => (
  <ExpandMore sx={{ fontSize: 16, color: 'text.disabled', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
);

/** Un outil : une ligne (état, nom, durée) qui se déplie pour montrer ses arguments et son résultat. */
function ToolRow({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const result = tool.resultPreview ?? '';
  const shown = full || result.length < 1500 ? result : result.slice(0, 1500) + '…';
  return (
    <Box>
      <ButtonBase onClick={() => setOpen(!open)} aria-expanded={open} sx={rowSx}>
        <Dot status={tool.status} />
        <Typography component="span" noWrap sx={{ fontFamily: MONO, fontSize: 12, flex: 1, minWidth: 0 }}>{tool.name}</Typography>
        <Typography component="span" variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{dur(tool.startedAt, tool.endedAt)}</Typography>
        <Chevron open={open} />
      </ButtonBase>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ pl: 2.25, pb: 0.75, fontSize: 12, '&& pre': { fontFamily: MONO, fontSize: 12, m: 0, mb: 0.5, p: 0.75, px: 1, border: 0, borderRadius: '6px', bgcolor: 'action.hover', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflow: 'auto' } }}>
          {tool.args !== undefined && (<><Typography variant="caption" color="text.secondary">Arguments</Typography><pre>{pretty(tool.args)}</pre></>)}
          {result && (<><Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: tool.args !== undefined ? 0.5 : 0 }}>Résultat</Typography><pre>{shown}</pre>
            {(result.length >= 1500 || tool.resultTruncated) && !full && (
              <ButtonBase onClick={() => setFull(true)} sx={{ fontSize: 12, color: 'primary.main', py: 0.25 }}>{tool.resultTruncated ? 'Résultat tronqué' : 'Voir plus'}</ButtonBase>)}</>)}
          {tool.args === undefined && !result && <Typography variant="caption" color="text.secondary">Pas de détails exposés par l'agent.</Typography>}
        </Box>
      </Collapse>
    </Box>
  );
}

/** Un sous-agent : sa ligne se déplie pour montrer son raisonnement, son résumé et ses outils. */
function SubRunRow({ run, tools, expandAll }: { run: SubAgentRun; tools: ToolCall[]; expandAll: boolean }) {
  const [manual, setManual] = useState<boolean>();
  const open = manual ?? (expandAll || run.status === 'running');
  return (
    <Box>
      <ButtonBase onClick={() => setManual(!open)} aria-expanded={open} sx={rowSx}>
        <Dot status={run.status} sub />
        <Typography component="span" noWrap sx={{ fontSize: 12.5, flex: 1, minWidth: 0 }}>Sous-agent : {run.name}</Typography>
        <Chevron open={open} />
      </ButtonBase>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ ml: 0.5, pl: 1.5, mb: 0.5, borderLeft: 2, borderColor: (t) => alpha(t.palette.secondary.main, 0.5) }}>
          {run.reasoning && <Typography variant="body2" color="text.secondary" sx={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflow: 'auto', py: 0.5 }}>{run.reasoning}</Typography>}
          {run.summary && run.status !== 'running' && <Typography variant="body2" sx={{ fontSize: 12.5, whiteSpace: 'pre-wrap', py: 0.5 }}>{run.summary}</Typography>}
          {tools.map((t) => <ToolRow key={t.id} tool={t} />)}
        </Box>
      </Collapse>
    </Box>
  );
}

const sep: ReactNode = <Box component="span" aria-hidden sx={{ opacity: 0.5 }}>·</Box>;

/**
 * Activité de l'agent sur un message : une ligne discrète « ✦ Raisonnement · 🔧 2 outils 0,1 s ⌄ » qui se déplie en
 * une liste sobre (raisonnement, sous-agents, outils avec leurs arguments et résultats). Un outil en cours reste
 * visible même ligne repliée ; « Déplier les outils par défaut » (Réglages) ouvre tout.
 */
export default function ActivityBlock({ reasoning, tools, subRuns, expandAll }: { reasoning?: string; tools: ToolCall[]; subRuns: SubAgentRun[]; expandAll: boolean }) {
  const [open, setOpen] = useState(false);
  if (!reasoning && !tools.length && !subRuns.length) return null;
  const runningTool = tools.find((t) => t.status === 'running');
  const running = !!runningTool || subRuns.some((s) => s.status === 'running');
  const showAll = open || expandAll;
  // Hors dépliage, seul ce qui est en cours d'exécution est affiché
  const visible = showAll ? tools : tools.filter((t) => t.status === 'running');
  const runs = showAll ? subRuns : subRuns.filter((s) => s.status === 'running' || visible.some((t) => t.parentSubAgentRunId === s.id));
  const top = visible.filter((t) => !t.parentSubAgentRunId);

  const hasWork = tools.length > 0 || subRuns.length > 0;
  const count = tools.length ? `${tools.length} outil${tools.length > 1 ? 's' : ''}` : `${subRuns.length} sous-agent${subRuns.length > 1 ? 's' : ''}`;
  const label = running ? `${runningTool?.name ?? 'sous-agent'}…` : count;
  const ended = tools.length > 0 && tools.every((t) => t.endedAt);
  const total = ended ? dur(Math.min(...tools.map((t) => t.startedAt)), Math.max(...tools.map((t) => t.endedAt!))) : '';

  return (
    <Box sx={{ mb: 0.5, minWidth: 240, maxWidth: '100%' }}>
      <ButtonBase onClick={() => setOpen(!open)} aria-expanded={showAll}
        sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-start', gap: 0.75, py: 0.25, ml: -0.25, px: 0.25, borderRadius: '6px', color: 'text.secondary', fontSize: 12.5, textAlign: 'left',
          '&:hover': { color: 'text.primary' }, '&.Mui-focusVisible': { outline: 2, outlineColor: 'primary.main' } }}>
        {reasoning && (<><PsychologyOutlined sx={{ fontSize: 15 }} /><span>Raisonnement</span></>)}
        {reasoning && hasWork && sep}
        {hasWork && (<>
          {running ? <Spin /> : <BuildOutlined sx={{ fontSize: 15 }} />}
          <span>{label}</span>
          {total && <Typography component="span" variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>{total}</Typography>}
        </>)}
        <Chevron open={showAll} />
      </ButtonBase>
      <Collapse in={showAll || running} unmountOnExit>
        <Box sx={{ mt: 0.5, mb: 1, pl: 1.5, borderLeft: 2, borderColor: 'divider' }}>
          {showAll && reasoning && <Typography variant="body2" color="text.secondary" sx={{ fontSize: 12.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', mb: hasWork ? 1 : 0 }}>{reasoning}</Typography>}
          {runs.map((s) => <SubRunRow key={s.id} run={s} expandAll={expandAll} tools={visible.filter((t) => t.parentSubAgentRunId === s.id)} />)}
          {top.map((t) => <ToolRow key={t.id} tool={t} />)}
        </Box>
      </Collapse>
    </Box>
  );
}
