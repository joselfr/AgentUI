import { useEffect, useState } from 'react';
import { Box, Button, Paper } from '@mui/material';
import FormatQuote from '@mui/icons-material/FormatQuote';
import ContentCopy from '@mui/icons-material/ContentCopy';
import ChatBubbleOutline from '@mui/icons-material/ChatBubbleOutline';
import { t } from '../../i18n';
import { copyText } from './copy';

const BUBBLE = '[data-bubble]';
/** Touch screens: the system shows its own menu above the selection, so the bar is docked at the bottom, out of its way. */
const touch = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;
const bubbleOf = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest(BUBBLE) ?? null;

/**
 * Small toolbar above the text selected inside the messages: quote it in the reply, or copy it. It only reads the selection
 * (never clears or blocks it), so the browser's own copy, context menu and drag keep working.
 */
export default function SelectionQuote({ onQuote, onQuoteMessage }: { onQuote?: (text: string) => void; onQuoteMessage?: (messageId: string) => void }) {
  const [sel, setSel] = useState<{ text: string; top: number; left: number; id?: string; docked: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const read = () => {
      const s = window.getSelection();
      const text = s?.toString().trim() ?? '';
      if (!s || s.isCollapsed || !text || !bubbleOf(s.anchorNode) || !bubbleOf(s.focusNode)) return setSel(null);
      const r = s.getRangeAt(0).getBoundingClientRect();
      const top = r.top > 52 ? r.top - 44 : r.bottom + 8;
      setSel({ text, top, left: Math.min(Math.max(8, r.left + r.width / 2 - 90), window.innerWidth - 188), id: bubbleOf(s.anchorNode)?.getAttribute('data-mid') ?? undefined, docked: touch() });
    };
    // Debounced: the bar appears once the selection settles, not while the pointer is still dragging.
    const onChange = () => { clearTimeout(timer); timer = setTimeout(read, 250); };
    const hide = () => setSel(null);
    document.addEventListener('selectionchange', onChange);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => { clearTimeout(timer); document.removeEventListener('selectionchange', onChange); window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); };
  }, []);
  if (!sel) return null;
  return (
    <Paper elevation={6} role="toolbar" aria-label={t('chat.selection')} data-testid="selection-quote"
      onMouseDown={(e) => e.preventDefault() /* keeps the selection while clicking the buttons */}
      sx={{ position: 'fixed', zIndex: 1300, display: 'flex', p: 0.25, borderRadius: 2,
        ...(sel.docked ? { left: '50%', transform: 'translateX(-50%)', bottom: 'calc(env(safe-area-inset-bottom) + 92px)' } : { top: sel.top, left: sel.left }) }}>
      {onQuote && <Button size="small" color="inherit" startIcon={<FormatQuote />} onClick={() => { onQuote(sel.text); window.getSelection()?.removeAllRanges(); setSel(null); }}>{t('chat.reply')}</Button>}
      {sel.docked && onQuoteMessage && sel.id && (
        <Button size="small" color="inherit" sx={{ whiteSpace: 'nowrap' }} startIcon={<ChatBubbleOutline fontSize="small" />} onClick={() => { onQuoteMessage(sel.id!); window.getSelection()?.removeAllRanges(); setSel(null); }}>{t('chat.wholeMessage')}</Button>)}
      <Button size="small" color="inherit" startIcon={<ContentCopy fontSize="small" />}
        onClick={() => void copyText(sel.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
        <Box component="span">{copied ? t('chat.copied') : t('chat.copy')}</Box>
      </Button>
    </Paper>
  );
}
