import { useMemo, useRef, type ReactElement, type ReactNode } from 'react';
import { Avatar, Box, Chip, Paper, Typography } from '@mui/material';
import { alpha, keyframes } from '@mui/material/styles';
import InsertDriveFileOutlined from '@mui/icons-material/InsertDriveFileOutlined';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks'; // a line break = a line (cron outputs, short messages)
import type { Message } from '@agentui/shared';
import { rehypeTableLabels } from './markdownTables';
import { formatSize, isImage, type AttachmentView } from '../../attachments';
import ActivityBlock from './ActivityBlock';
import AskCard, { parseAsk, parseLegacyAsk } from '../AskCard';
import { expandWidgetTokens, interactiveBlocks, outOfTextWidgets, parseWidget, WIDGET_ATTACHMENT_PREFIX, type ToolCallLike } from '../widget';
import { isAwaiting } from '../../reducer';
import ConfirmCard, { parseConfirm } from '../ConfirmCard';
import ChartCard, { parseChart } from '../ChartCard';
import MapCard, { parseMap } from '../MapCard';
import TableCard, { parseTable } from '../TableCard';
import ProgressCard, { parseProgress } from '../ProgressCard';
import ImageCard, { isRemote, parseImage, type Resolved } from '../ImageCard';
import CodeCard, { parseCode } from '../CodeCard';
import FormCard, { parseForm } from '../FormCard';
import { t } from '../../i18n';

const bounce = keyframes`0%, 60%, 100% { transform: translateY(0); opacity: .35 } 30% { transform: translateY(-4px); opacity: 1 }`;
const halo = keyframes`0% { box-shadow: 0 0 0 0 var(--halo) } 70%, 100% { box-shadow: 0 0 0 7px transparent }`;

/** "The agent is working" indicator: animated dots + current activity. */
function Working({ m }: { m: Message }) {
  const tool = [...(m.toolCalls ?? [])].reverse().find((t) => t.status === 'running');
  const label = tool ? t('chat.working.tool', { tool: tool.name }) : m.text ? t('chat.working.writing') : t('chat.working.thinking');
  return (
    <Box role="status" aria-label={`${label}…`} sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: m.text || m.toolCalls?.length ? 1 : 0, color: 'text.secondary' }}>
      <Box sx={{ display: 'flex', gap: '4px' }}>
        {[0, 1, 2].map((i) => <Box key={i} sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'primary.main', animation: `${bounce} 1.2s ${i * 0.15}s infinite ease-in-out` }} />)}
      </Box>
      <Typography variant="caption" noWrap sx={{ minWidth: 0 }}>{label}…</Typography>
    </Box>
  );
}

/** Images (clickable preview) and files (download chips) attached to a message. */
function Attachments({ m }: { m: Message }) {
  const shown = (m.attachments ?? []).filter((a) => !a.name.startsWith(WIDGET_ATTACHMENT_PREFIX)); // copies of an image widget: already in the widget
  if (!shown.length) return null;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: m.text ? 1 : 0 }}>
      {(shown as AttachmentView[]).map((a) => {
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

/** Display widgets (no answer): ```widget block or `agentui_<type>` tool. `undefined` if the type or arguments are invalid. */
function displayWidget(w: { type: string; arguments: Record<string, unknown> } | undefined, m: Message): ReactElement | undefined {
  if (w?.type === 'chart') { const chart = parseChart(w.arguments); if (chart) return <ChartCard chart={chart} />; }
  if (w?.type === 'map') { const map = parseMap(w.arguments); if (map) return <MapCard map={map} />; }
  if (w?.type === 'table') { const table = parseTable(w.arguments); if (table) return <TableCard table={table} />; }
  if (w?.type === 'image') {
    const gallery = parseImage(w.arguments);
    if (gallery) {
      const files = (w.arguments.files ?? {}) as Record<string, string>;
      // Local file: copied by the plugin as a message attachment; external URL: loaded directly by the browser.
      const resolve = (src: string): Resolved => {
        if (isRemote(src)) return { state: 'ok', url: src };
        const a = m.attachments?.find((x) => x.name === files[src]);
        return a ? { state: 'ok', url: `/api/attachments/${a.id}` } : m.status === 'streaming' && files[src] ? { state: 'loading' } : { state: 'error' };
      };
      return <ImageCard gallery={gallery} resolve={resolve} />;
    }
  }
  if (w?.type === 'code') { const code = parseCode(w.arguments); if (code) return <CodeCard code={code} />; }
  return undefined;
}

/** A message bubble: Markdown text (or "ask" question card), reasoning, tools, attachments. */
export default function MessageBubble({ m, expandTools, agentName, answers = [], onAnswer, working, allTools }: {
  m: Message; expandTools: boolean; agentName: string; answers?: string[]; onAnswer?: (t: string) => void; working?: boolean;
  /** Tool calls of the whole chat: the agent may reuse the token of a widget from an earlier message. */
  allTools?: ToolCallLike[];
}) {
  const mine = m.role === 'user';
  // The widget of an `agentui_<type>` tool takes the place of the token the agent wrote in its text; the call is also still listed with the other tools.
  // Widgets that evolve during the run (progress): shown as soon as their tool call, without waiting for the agent's text.
  const live = useMemo(() => (m.role === 'user' ? [] : outOfTextWidgets(m.toolCalls ?? [], allTools)), [m.role, m.toolCalls, allTools]);
  const text = useMemo(() => (m.role === 'user' ? m.text : expandWidgetTokens(m.text, m.toolCalls ?? [], allTools, m.status !== 'streaming')), [m.role, m.text, m.toolCalls, m.status, allTools]);
  // `pre` must keep the same identity from one render to the next: otherwise React unmounts and remounts it, and the widgets
  // (form input, map, checked boxes) lose their state and focus on every chat render.
  const latest = useRef({ m, answers, onAnswer });
  latest.current = { m, answers, onAnswer };
  const components = useMemo<Components>(() => ({
    pre: ({ children }) => {
      const { m, answers, onAnswer: canAnswer } = latest.current;
      const el = children as ReactElement<{ className?: string; children?: ReactNode }> | undefined;
      const lang = /language-(\w+)/.exec(el?.props?.className ?? '')?.[1];
      const raw = String(el?.props?.children ?? '').replace(/\n$/, '');
      // While streaming, only the image gallery is already shown (the block comes from an expanded token, hence complete): its local files arrive one by one.
      const early = lang === 'widget' && m.status === 'streaming' && parseWidget(raw)?.type === 'image';
      if ((m.status !== 'streaming' || isAwaiting(m) || early) && (lang === 'widget' || lang === 'ask')) {
        // A message can ask several questions in a row (question.requested then answer): the k-th gets the k-th answer, only the first unanswered one is active.
        const k = interactiveBlocks(m.text).indexOf(raw);
        const answer = k >= 0 ? answers[k] : undefined;
        const onAnswer = k >= 0 && k !== answers.length ? undefined : canAnswer;
        if (lang === 'ask') return <AskCard ask={parseLegacyAsk(raw)} answer={answer} onAnswer={onAnswer} />;
        const w = parseWidget(raw);
        if (w?.type === 'ask') { const ask = parseAsk(w.arguments); if (ask) return <AskCard ask={ask} answer={answer} onAnswer={onAnswer} />; }
        if (w?.type === 'confirm') { const confirm = parseConfirm(w.arguments); if (confirm) return <ConfirmCard confirm={confirm} answer={answer} onAnswer={onAnswer} />; }
        const display = displayWidget(w, m);
        if (display) return display;
        if (w?.type === 'form') { const form = parseForm(w.arguments); if (form) return <FormCard form={form} answer={answer} onAnswer={onAnswer} />; }
      }
      return <pre>{children}</pre>;
    },
  }), []);
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
        // Small screen: a table with 3 or more columns becomes a series of cards, one line per attribute
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
        {!mine && <ActivityBlock reasoning={m.reasoning} tools={m.toolCalls ?? []} subRuns={m.subAgentRuns ?? []} expandAll={expandTools} />}
        {live.map((w) => { const progress = parseProgress(w.arguments); return progress ? <ProgressCard key={w.token} progress={progress} ended={m.status !== 'streaming'} times={w.times} /> : null; })}
        {mine && <Attachments m={m} />}
        {mine ? (m.text ? <Typography sx={{ whiteSpace: 'pre-wrap' }}>{m.text}</Typography> : null)
          : <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeTableLabels]} components={components}>{text}</ReactMarkdown>}
        {!mine && <Attachments m={m} />}
        {working && <Working m={m} />}
        {m.status === 'aborted' && <Typography variant="caption" color="text.secondary">{t('chat.aborted')}</Typography>}
      </Paper>
    </Box>
  );
}
