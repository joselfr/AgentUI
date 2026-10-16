import { useState, type ReactElement, type ReactNode } from 'react';
import { Avatar, Box, Chip, Collapse, Paper, Typography } from '@mui/material';
import { alpha, keyframes } from '@mui/material/styles';
import InsertDriveFileOutlined from '@mui/icons-material/InsertDriveFileOutlined';
import Psychology from '@mui/icons-material/Psychology';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks'; // un retour à la ligne = une ligne (sorties de cron, messages courts)
import type { Message } from '@agentui/shared';
import { rehypeTableLabels } from './markdownTables';
import { formatSize, isImage, type AttachmentView } from '../../attachments';
import { ToolsBlock } from '../ToolCard';
import AskCard from '../AskCard';

const bounce = keyframes`0%, 60%, 100% { transform: translateY(0); opacity: .35 } 30% { transform: translateY(-4px); opacity: 1 }`;
const halo = keyframes`0% { box-shadow: 0 0 0 0 var(--halo) } 70%, 100% { box-shadow: 0 0 0 7px transparent }`;

/** Indicateur « l'agent travaille » : points animés + activité en cours. */
function Working({ m }: { m: Message }) {
  const tool = [...(m.toolCalls ?? [])].reverse().find((t) => t.status === 'running');
  const label = tool ? `Utilise ${tool.name}` : m.text ? 'Rédige' : 'Réfléchit';
  return (
    <Box role="status" aria-label={`${label}…`} sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: m.text || m.toolCalls?.length ? 1 : 0, color: 'text.secondary' }}>
      <Box sx={{ display: 'flex', gap: '4px' }}>
        {[0, 1, 2].map((i) => <Box key={i} sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'primary.main', animation: `${bounce} 1.2s ${i * 0.15}s infinite ease-in-out` }} />)}
      </Box>
      <Typography variant="caption" noWrap sx={{ minWidth: 0 }}>{label}…</Typography>
    </Box>
  );
}

/** Images (aperçu cliquable) et fichiers (puces de téléchargement) joints à un message. */
function Attachments({ m }: { m: Message }) {
  if (!m.attachments?.length) return null;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: m.text ? 1 : 0 }}>
      {(m.attachments as AttachmentView[]).map((a) => {
        const href = a.url ?? `/api/attachments/${a.id}`;
        return isImage(a.mimeType) ? (
          <a key={a.id} href={href} target="_blank" rel="noreferrer"><img src={href} alt={a.name} title={a.name} style={{ maxWidth: 'min(100%, 480px)', maxHeight: 320, borderRadius: 8, display: 'block' }} /></a>
        ) : (
          <Chip key={a.id} component="a" href={href} download={a.name} clickable icon={<InsertDriveFileOutlined />} label={`${a.name} · ${formatSize(a.size)}`}
            sx={{ bgcolor: 'action.selected', color: 'inherit', '& .MuiChip-icon': { color: 'inherit' } }} />
        );
      })}
    </Box>
  );
}

/** Une bulle de message : texte Markdown (ou carte de question « ask »), raisonnement, outils, pièces jointes. */
export default function MessageBubble({ m, expandTools, agentName, answer, onAnswer, working }: {
  m: Message; expandTools: boolean; agentName: string; answer?: string; onAnswer?: (t: string) => void; working?: boolean;
}) {
  const mine = m.role === 'user';
  const [showReasoning, setShowReasoning] = useState(false);
  return (
    <Box sx={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', gap: 1.5, mb: 2 }}>
      {!mine && <Avatar sx={{ width: 30, height: 30, fontSize: 14, fontWeight: 700, mt: 0.25, bgcolor: (t) => alpha(t.palette.primary.main, 0.16), color: 'primary.main',
        '--halo': (t) => alpha(t.palette.primary.main, 0.5), animation: working ? `${halo} 1.6s infinite` : 'none' }}>{agentName[0]}</Avatar>}
      <Paper data-role={m.role} sx={{
        maxWidth: mine ? 'min(640px, 88%)' : 'min(760px, calc(100% - 44px))', px: 2, py: 1.25, borderRadius: mine ? '16px 16px 4px 16px' : '4px 16px 16px 16px',
        bgcolor: mine ? (t) => alpha(t.palette.primary.main, 0.14) : 'background.paper', borderColor: mine ? (t) => alpha(t.palette.primary.main, 0.4) : 'divider', color: 'text.primary',
        '& pre': { overflow: 'auto', p: 1.5, borderRadius: 2, bgcolor: 'background.default', border: 1, borderColor: 'divider', fontSize: 13 },
        '& code': { fontSize: '0.88em' }, '& :not(pre) > code': { px: 0.6, py: 0.15, borderRadius: 1, bgcolor: 'action.selected' },
        '& p': { my: 0.5 }, '& a': { color: 'primary.main' }, '& table': { borderCollapse: 'collapse', display: 'block', maxWidth: '100%', overflowX: 'auto' }, '& th, & td': { border: 1, borderColor: 'divider', px: 1, py: 0.5 },
        // Petit écran : un tableau de 3 colonnes ou plus devient une suite de cartes, une ligne par attribut
        '@media (max-width: 599.95px)': {
          '& table.stackable, & table.stackable tbody, & table.stackable tr, & table.stackable td': { display: 'block', overflowX: 'visible' },
          '& table.stackable thead': { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' },
          '& table.stackable tr': { border: 1, borderColor: 'divider', borderRadius: 1.5, mb: 1, p: 0.5 },
          '& table.stackable td': { border: 0, display: 'flex', gap: 1, px: 1, py: 0.25 },
          '& table.stackable td::before': { content: 'attr(data-label)', flex: '0 0 34%', color: 'text.secondary', fontWeight: 600 },
          '& table.stackable td:not([data-label])::before': { content: 'none' },
          '& table.stackable td:first-of-type': { fontWeight: 600 },
        },
        overflowWrap: 'anywhere', minWidth: 0,
      }}>
        {!mine && m.reasoning && (
          <Box sx={{ mb: 1 }}>
            <Typography variant="caption" sx={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 0.5 }} color="text.secondary"
              onClick={() => setShowReasoning(!showReasoning)}><Psychology fontSize="inherit" /> Raisonnement</Typography>
            <Collapse in={showReasoning}><Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>{m.reasoning}</Typography></Collapse>
          </Box>
        )}
        {!mine && <ToolsBlock tools={m.toolCalls ?? []} subRuns={m.subAgentRuns ?? []} expandAll={expandTools} />}
        {mine && <Attachments m={m} />}
        {mine ? (m.text ? <Typography sx={{ whiteSpace: 'pre-wrap' }}>{m.text}</Typography> : null)
          : <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeTableLabels]} components={{
            pre: ({ children }) => {
              const el = children as ReactElement<{ className?: string; children?: ReactNode }> | undefined;
              if (el?.props?.className?.includes('language-ask') && m.status !== 'streaming') return <AskCard raw={String(el.props.children ?? '').replace(/\n$/, '')} answer={answer} onAnswer={onAnswer} />;
              return <pre>{children}</pre>;
            },
          }}>{m.text}</ReactMarkdown>}
        {!mine && <Attachments m={m} />}
        {working && <Working m={m} />}
        {m.status === 'aborted' && <Typography variant="caption" color="text.secondary">⏹ interrompu</Typography>}
      </Paper>
    </Box>
  );
}
