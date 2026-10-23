import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { Avatar, Box, Chip, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Paper, Typography } from '@mui/material';
import { alpha, keyframes } from '@mui/material/styles';
import InsertDriveFileOutlined from '@mui/icons-material/InsertDriveFileOutlined';
import FormatQuote from '@mui/icons-material/FormatQuote';
import ContentCopy from '@mui/icons-material/ContentCopy';
import MoreHoriz from '@mui/icons-material/MoreHoriz';
import TextFields from '@mui/icons-material/TextFields';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks'; // a line break = a line (cron outputs, short messages)
import type { Message, WidgetEvent } from '@agentui/shared';
import { rehypeTableLabels } from './markdownTables';
import { formatSize, type AttachmentView } from '../../attachments';
import ActivityBlock from './ActivityBlock';
import AskCard, { parseAsk, parseLegacyAsk } from '../AskCard';
import { dropStrayFence, expandWidgetTokens, interactiveBlocks, FILE_WIDGETS, outOfTextWidgets, parseWidget, WIDGET_ATTACHMENT_PREFIX, type ToolCallLike } from '../widget';
import { isAwaiting } from '../../reducer';
import ConfirmCard, { parseConfirm } from '../ConfirmCard';
import ChartCard, { parseChart } from '../ChartCard';
import MapCard, { parseMap } from '../MapCard';
import TableCard, { parseTable } from '../TableCard';
import ProgressCard, { parseProgress } from '../ProgressCard';
import ImageCard, { isRemote, parseImage, type Resolved } from '../ImageCard';
import VideoCard, { parseVideo } from '../VideoCard';
import AudioCard, { parseAudio } from '../AudioCard';
import PdfCard, { parsePdf } from '../PdfCard';
import MarkdownCard, { parseMarkdown } from '../MarkdownCard';
import { mediaKind } from '../media';
import CodeCard, { parseCode } from '../CodeCard';
import UiCard, { parseUi } from '../UiCard';
import FormCard, { parseForm } from '../FormCard';
import { splitQuote, plainText } from './quote';
import { copyText } from './copy';
import { isTouch, useLongPress } from './touch';
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

/**
 * Files attached to a message (what the agent sends with `MEDIA:/path`, or the user uploads), shown like the matching widget:
 * images grouped in one gallery, video / audio / PDF / Markdown in their player, the rest as download chips.
 */
function Attachments({ m }: { m: Message }) {
  const shown = ((m.attachments ?? []) as AttachmentView[]).filter((a) => !a.name.startsWith(WIDGET_ATTACHMENT_PREFIX)); // copies made for a widget: already in the widget
  if (!shown.length) return null;
  const urlOf = (a: AttachmentView) => a.url ?? `/api/attachments/${a.id}`;
  const ok = (src: string): Resolved => ({ state: 'ok', url: src });
  const images = shown.filter((a) => mediaKind(a) === 'image');
  const chips = shown.filter((a) => mediaKind(a) === 'file');
  return (
    <Box sx={{ mb: m.text ? 1 : 0 }}>
      {images.length > 0 && <ImageCard gallery={{ images: images.map((a) => ({ src: urlOf(a), alt: a.name })) }} resolve={ok} />}
      {shown.map((a) => {
        const src = urlOf(a), kind = mediaKind(a);
        if (kind === 'video') return <VideoCard key={a.id} video={{ src, title: a.name }} resolve={ok} />;
        if (kind === 'audio') return <AudioCard key={a.id} audio={{ src, title: a.name }} resolve={ok} />;
        if (kind === 'pdf') return <PdfCard key={a.id} pdf={{ src, title: a.name, page: 1 }} resolve={ok} />;
        if (kind === 'markdown') return <MarkdownCard key={a.id} doc={{ src, title: a.name }} resolve={ok} />;
        return null;
      })}
      {chips.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {chips.map((a) => (
            <Chip key={a.id} component="a" href={urlOf(a)} download={a.name} clickable icon={<InsertDriveFileOutlined />} label={`${a.name} · ${formatSize(a.size)}`}
              sx={{ bgcolor: 'action.selected', color: 'inherit', '& .MuiChip-icon': { color: 'inherit' } }} />
          ))}
        </Box>)}
    </Box>
  );
}

/** What a dynamic widget may do for the chat: `undefined` while it must stay inactive. `widget` is the widget's own token, to tell the live one apart. */
export type ReplyFor = (widget?: string) => ((text: string, event?: WidgetEvent) => Promise<boolean>) | undefined;

/**
 * Where the file of a media widget comes from: an external URL is loaded directly by the browser; a local file was copied by the plugin as
 * an attachment of the message (the tool result says which one: `files` = { path → attachment name }).
 */
const resolverOf = (args: Record<string, unknown>, m: Message) => (src: string): Resolved => {
  if (isRemote(src)) return { state: 'ok', url: src };
  const files = (args.files ?? {}) as Record<string, string>;
  const a = m.attachments?.find((x) => x.name === files[src]);
  return a ? { state: 'ok', url: `/api/attachments/${a.id}` } : m.status === 'streaming' && files[src] ? { state: 'loading' } : { state: 'error' };
};

/**
 * Media of a custom widget: the widget may be shown while the agent is still copying the files, so until the end of the message a file
 * the tool result has not mapped yet is awaited (then, if it never came, it is an error).
 */
const widgetMediaResolver = (args: Record<string, unknown>, m: Message) => (src: string): Resolved => {
  const files = (args.files ?? {}) as Record<string, string>;
  return m.status === 'streaming' && !(src in files) ? { state: 'loading' } : resolverOf(args, m)(src);
};

/** Display widgets (no answer): ```widget block or `agentui_widget_<type>` tool. `undefined` if the type or arguments are invalid. */
function displayWidget(w: { type: string; arguments: Record<string, unknown> } | undefined, m: Message, onReply?: ReplyFor): ReactElement | undefined {
  if (w?.type === 'chart') { const chart = parseChart(w.arguments); if (chart) return <ChartCard chart={chart} />; }
  if (w?.type === 'map') { const map = parseMap(w.arguments); if (map) return <MapCard map={map} />; }
  if (w?.type === 'table') { const table = parseTable(w.arguments); if (table) return <TableCard table={table} />; }
  const resolve = w && FILE_WIDGETS.has(w.type) ? resolverOf(w.arguments, m) : undefined;
  if (w?.type === 'image') { const gallery = parseImage(w.arguments); if (gallery && resolve) return <ImageCard gallery={gallery} resolve={resolve} />; }
  if (w?.type === 'video') { const video = parseVideo(w.arguments); if (video && resolve) return <VideoCard video={video} resolve={resolve} />; }
  if (w?.type === 'audio') { const audio = parseAudio(w.arguments); if (audio && resolve) return <AudioCard audio={audio} resolve={resolve} />; }
  if (w?.type === 'pdf') { const pdf = parsePdf(w.arguments); if (pdf && resolve) return <PdfCard pdf={pdf} resolve={resolve} />; }
  if (w?.type === 'markdown') { const doc = parseMarkdown(w.arguments); if (doc && resolve) return <MarkdownCard doc={doc} resolve={resolve} />; }
  if (w?.type === 'custom') { const ui = parseUi(w.arguments); if (ui) return <UiCard ui={ui} onReply={onReply?.(ui.token)} resolve={ui.media?.length ? widgetMediaResolver(w.arguments, m) : undefined} />; }
  if (w?.type === 'code') { const code = parseCode(w.arguments); if (code) return <CodeCard code={code} />; }
  return undefined;
}

/** Text of a user message: the leading quote (reply to a message or to a selection) is shown as a quote, then the message. */
function UserText({ text }: { text: string }) {
  const { quote, body } = splitQuote(text);
  return (
    <>
      {quote && (
        <Box data-testid="bubble-quote" sx={{ mb: body ? 0.75 : 0, pl: 1, py: 0.25, borderLeft: 3, borderColor: 'primary.main', color: 'text.secondary', fontSize: 13,
          display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-wrap' }}>{quote}</Box>)}
      {body ? <Typography sx={{ whiteSpace: 'pre-wrap' }}>{body}</Typography> : null}
    </>
  );
}

/**
 * Menu of a bubble: right click or the discreet ⋯ with a mouse (reply to / copy the message); long press on a touch screen, where the
 * system selection menu cannot be turned off (reply to / copy the paragraph or the message, or switch the message to native selection).
 */
function BubbleMenu({ at, text, block, onQuote, onSelect, onClose }: {
  at: { x: number; y: number } | null; text: string; block?: string; onQuote?: (t: string) => void; onSelect?: () => void; onClose: () => void;
}) {
  const item = (icon: ReactElement, label: string, run: () => void) => <MenuItem onClick={() => { run(); onClose(); }}><ListItemIcon>{icon}</ListItemIcon><ListItemText>{label}</ListItemText></MenuItem>;
  const quote = <FormatQuote fontSize="small" />, copy = <ContentCopy fontSize="small" />;
  return (
    <Menu open={!!at} onClose={onClose} anchorReference="anchorPosition" anchorPosition={at ? { top: at.y, left: at.x } : undefined} slotProps={{ paper: { sx: { minWidth: 200 } } }}>
      {onQuote && block && item(quote, t('chat.replyBlock'), () => onQuote(block))}
      {onQuote && item(quote, block ? t('chat.replyMessage') : t('chat.reply'), () => onQuote(text))}
      {block && item(copy, t('chat.copyBlock'), () => void copyText(block))}
      {item(copy, block ? t('chat.copyMessage') : t('chat.copy'), () => void copyText(text))}
      {onSelect && item(<TextFields fontSize="small" />, t('chat.selectText'), onSelect)}
    </Menu>
  );
}

/** A message bubble: Markdown text (or "ask" question card), reasoning, tools, attachments. */
export default function MessageBubble({ m, expandTools, agentName, answers = [], onAnswer, onReply, onQuote, working, allTools }: {
  /** Quotes a text (a whole message or a selection) in the next reply; absent while the agent waits for an answer. */
  onQuote?: (t: string) => void;
  m: Message; expandTools: boolean; agentName: string; answers?: string[]; onAnswer?: (t: string) => void; working?: boolean;
  /** Sends a new user message from a dynamic widget (`reply`); absent while the agent is working. */
  onReply?: ReplyFor;
  /** Tool calls of the whole chat: the agent may reuse the token of a widget from an earlier message. */
  allTools?: ToolCallLike[];
}) {
  const mine = m.role === 'user';
  const [menu, setMenu] = useState<{ x: number; y: number; block?: HTMLElement } | null>(null);
  const touch = isTouch();
  // Touch screens: the text is not selectable until "Select text" is chosen from the long-press menu (the system menu would get in the way).
  const [selectable, setSelectable] = useState(false);
  const blockText = (el?: HTMLElement) => (el?.innerText ?? '').trim() || undefined;
  const quotable = m.status !== 'streaming' && !!plainText(m.text);
  // Right click opens the bubble menu, except on a selection, a link, an image or a control: the browser's own menu stays there for those.
  const onContextMenu = (e: MouseEvent<HTMLElement>) => {
    if (!quotable || (e.target as Element).closest('a, button, input, textarea, img, [role="button"]')) return;
    if (touch) { e.preventDefault(); return; } // the long press (below) opens the menu; never the system one
    if (!window.getSelection()?.isCollapsed) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };
  const press = useLongPress((p) => setMenu({ x: p.x, y: p.y, block: p.block }), touch && quotable && !selectable);
  // "Select text": native selection for this message, started on the pressed paragraph; back to the default once the selection is gone.
  const picked = useRef<HTMLElement>();
  useEffect(() => {
    if (!selectable) return;
    if (picked.current?.isConnected) window.getSelection()?.selectAllChildren(picked.current);
    let timer: ReturnType<typeof setTimeout>;
    const check = () => { clearTimeout(timer); timer = setTimeout(() => { if (window.getSelection()?.isCollapsed) setSelectable(false); }, 400); };
    document.addEventListener('selectionchange', check);
    return () => { clearTimeout(timer); document.removeEventListener('selectionchange', check); };
  }, [selectable]);
  // The widget of an `agentui_widget_<type>` tool takes the place of the token the agent wrote in its text; the call is also still listed with the other tools.
  // Widgets that evolve during the run (progress): shown as soon as their tool call, without waiting for the agent's text.
  const live = useMemo(() => (m.role === 'user' ? [] : outOfTextWidgets(m.toolCalls ?? [], allTools)), [m.role, m.toolCalls, allTools]);
  const text = useMemo(() => (m.role === 'user' ? m.text : dropStrayFence(expandWidgetTokens(m.text, m.toolCalls ?? [], allTools, m.status !== 'streaming'))), [m.role, m.text, m.toolCalls, m.status, allTools]);
  // `pre` must keep the same identity from one render to the next: otherwise React unmounts and remounts it, and the widgets
  // (form input, map, checked boxes) lose their state and focus on every chat render.
  const latest = useRef({ m, answers, onAnswer, onReply });
  latest.current = { m, answers, onAnswer, onReply };
  const components = useMemo<Components>(() => ({
    pre: ({ children }) => {
      const { m, answers, onAnswer: canAnswer, onReply } = latest.current;
      const el = children as ReactElement<{ className?: string; children?: ReactNode }> | undefined;
      const lang = /language-(\w+)/.exec(el?.props?.className ?? '')?.[1];
      const raw = String(el?.props?.children ?? '').replace(/\n$/, '');
      // While streaming, only the image gallery and the dynamic widgets are already shown (the block comes from an expanded token, hence complete): the
      // gallery's local files arrive one by one, and a live widget (agentui_widget_custom_wait) must stay mounted while the agent thinks, or it would lose its state.
      const early = lang === 'widget' && m.status === 'streaming' && ['image', 'custom'].includes(parseWidget(raw)?.type ?? '');
      // An interactive block is added whole to the text by the plugin: once its fence is closed it stays a widget (frozen, with its answer)
      // while the run goes on after the user's reply, instead of falling back to raw JSON until the end of the run.
      const answered = (lang === 'widget' || lang === 'ask') && interactiveBlocks(m.text).includes(raw);
      if ((m.status !== 'streaming' || isAwaiting(m) || early || answered) && (lang === 'widget' || lang === 'ask')) {
        // A message can ask several questions in a row (question.requested then answer): the k-th gets the k-th answer, only the first unanswered one is active.
        const k = interactiveBlocks(m.text).indexOf(raw);
        const answer = k >= 0 ? answers[k] : undefined;
        const onAnswer = k >= 0 && k !== answers.length ? undefined : canAnswer;
        if (lang === 'ask') return <AskCard ask={parseLegacyAsk(raw)} answer={answer} onAnswer={onAnswer} />;
        const w = parseWidget(raw);
        if (w?.type === 'ask') { const ask = parseAsk(w.arguments); if (ask) return <AskCard ask={ask} answer={answer} onAnswer={onAnswer} />; }
        if (w?.type === 'confirm') { const confirm = parseConfirm(w.arguments); if (confirm) return <ConfirmCard confirm={confirm} answer={answer} onAnswer={onAnswer} />; }
        const display = displayWidget(w, m, onReply);
        if (display) return display;
        if (w?.type === 'form') { const form = parseForm(w.arguments); if (form) return <FormCard form={form} answer={answer} onAnswer={onAnswer} />; }
      }
      return <pre>{children}</pre>;
    },
  }), []);
  return (
    <Box sx={{ display: mine ? 'flex' : 'block', justifyContent: 'flex-end', mb: 2 }}>
      {/* The agent has no bubble (full width, mostly on a phone): its avatar and name head the message */}
      {!mine && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          <Avatar sx={{ width: 22, height: 22, fontSize: 11, fontWeight: 700, bgcolor: (t) => alpha(t.palette.primary.main, 0.16), color: 'primary.main',
            '--halo': (t) => alpha(t.palette.primary.main, 0.5), animation: working ? `${halo} 1.6s infinite` : 'none' }}>{agentName[0]}</Avatar>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>{agentName}</Typography>
        </Box>)}
      <Paper data-role={m.role} data-bubble="" data-mid={m.id} onContextMenu={onContextMenu} {...press} sx={{
        ...(touch && !selectable ? { userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' } : {}),
        position: 'relative', '&:hover .bubble-more, &:focus-within .bubble-more': { opacity: 1 },
        ...(mine
          ? { maxWidth: 'min(640px, 88%)', px: 2, py: 1.25, borderRadius: '16px 16px 4px 16px', bgcolor: (t) => alpha(t.palette.primary.main, 0.14), borderColor: (t) => alpha(t.palette.primary.main, 0.4) }
          : { maxWidth: '100%', p: 0, borderRadius: 0, bgcolor: 'transparent', border: 0 }),
        color: 'text.primary',
        '& pre': { overflow: 'auto', p: 1.5, borderRadius: 2, bgcolor: 'background.default', border: 1, borderColor: 'divider', fontSize: 13 },
        '& code': { fontSize: '0.88em' }, '& :not(pre) > code': { px: 0.6, py: 0.15, borderRadius: 1, bgcolor: 'action.selected' },
        '& p': { my: 0.5 }, '& a': { color: 'primary.main' }, '& table': { borderCollapse: 'collapse', display: 'block', maxWidth: '100%', overflowX: 'auto' }, '& th, & td': { border: 1, borderColor: 'divider', px: 1, py: 0.5, verticalAlign: 'top' },
        // Browsers center <th> by default while <td> is left-aligned: align both the same unless the Markdown (:---:) says otherwise
        '& th:not([align]):not([style*="text-align"])': { textAlign: 'start' },
        // Small screen: a table with 3 or more columns becomes a series of cards, one line per attribute
        '@media (max-width: 599.95px)': {
          '& table.stackable, & table.stackable tbody, & table.stackable tr, & table.stackable td': { display: 'block', overflowX: 'visible' },
          '& table.stackable thead': { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)' },
          '& table.stackable tr': { border: 1, borderColor: 'divider', borderRadius: 1.5, mb: 1, p: 0.5 },
          // The column alignment of the Markdown (:--:, --:) lives in an inline style: in cards every label and value starts on the left
          // Block flow (not flex): inline content (text + `code`) must stay one paragraph; the label sits in the left padding
          '& table.stackable td': { border: 0, position: 'relative', pl: '38%', pr: 1, py: 0.25, textAlign: 'left !important' },
          '& table.stackable td::before': { content: 'attr(data-label)', position: 'absolute', left: 8, top: 2, width: 'calc(38% - 16px)', color: 'text.secondary', fontWeight: 600, textAlign: 'left' },
          '& table.stackable td:not([data-label])': { pl: 1 },
          '& table.stackable td:not([data-label])::before': { content: 'none' },
          '& table.stackable td:first-of-type': { fontWeight: 600 },
        },
        overflowWrap: 'anywhere', minWidth: 0,
      }}>
        {!mine && <ActivityBlock reasoning={m.reasoning} tools={m.toolCalls ?? []} subRuns={m.subAgentRuns ?? []} expandAll={expandTools} />}
        {live.map((w) => { const progress = parseProgress(w.arguments); return progress ? <ProgressCard key={w.token} progress={progress} ended={m.status !== 'streaming'} times={w.times} /> : null; })}
        {mine && <Attachments m={m} />}
        {mine ? (m.text ? <UserText text={m.text} /> : null)
          : <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeTableLabels]} components={components}>{text}</ReactMarkdown>}
        {!mine && <Attachments m={m} />}
        {quotable && (
          <>
            <IconButton className="bubble-more" size="small" aria-label={t('chat.more')} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right, y: r.bottom }); }}
              sx={{ display: 'none', '@media (hover: hover)': { display: 'inline-flex' }, position: 'absolute', top: 2, right: 2, opacity: 0, transition: 'opacity .12s', color: 'text.secondary' }}><MoreHoriz fontSize="small" /></IconButton>
            <BubbleMenu at={menu} text={plainText(m.text)} block={blockText(menu?.block)} onQuote={onQuote} onClose={() => setMenu(null)}
              onSelect={touch ? () => { picked.current = menu?.block; setSelectable(true); } : undefined} />
          </>)}
        {working && <Working m={m} />}
        {m.status === 'aborted' && <Typography variant="caption" color="text.secondary">{t('chat.aborted')}</Typography>}
      </Paper>
    </Box>
  );
}
