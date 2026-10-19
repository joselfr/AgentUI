import { useEffect, useState } from 'react';
import { Box, Button, Paper } from '@mui/material';
import FormatQuote from '@mui/icons-material/FormatQuote';
import ContentCopy from '@mui/icons-material/ContentCopy';
import { t } from '../../i18n';
import { copyText } from './copy';

const BUBBLE = '[data-bubble]';
const bubbleOf = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest(BUBBLE) ?? null;

/**
 * Small toolbar above the text selected inside the messages: quote it in the reply, or copy it. It only reads the selection
 * (never clears or blocks it), so the browser's own copy, context menu and drag keep working.
 */
export default function SelectionQuote({ onQuote }: { onQuote?: (text: string) => void }) {
  const [sel, setSel] = useState<{ text: string; top: number; left: number } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const read = () => {
      const s = window.getSelection();
      const text = s?.toString().trim() ?? '';
      if (!s || s.isCollapsed || !text || !bubbleOf(s.anchorNode) || !bubbleOf(s.focusNode)) return setSel(null);
      const r = s.getRangeAt(0).getBoundingClientRect();
      const top = r.top > 52 ? r.top - 44 : r.bottom + 8;
      setSel({ text, top, left: Math.min(Math.max(8, r.left + r.width / 2 - 90), window.innerWidth - 188) });
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
      sx={{ position: 'fixed', top: sel.top, left: sel.left, zIndex: 1300, display: 'flex', p: 0.25, borderRadius: 2 }}>
      {onQuote && <Button size="small" color="inherit" startIcon={<FormatQuote />} onClick={() => { onQuote(sel.text); window.getSelection()?.removeAllRanges(); setSel(null); }}>{t('chat.reply')}</Button>}
      <Button size="small" color="inherit" startIcon={<ContentCopy fontSize="small" />}
        onClick={() => void copyText(sel.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
        <Box component="span">{copied ? t('chat.copied') : t('chat.copy')}</Box>
      </Button>
    </Paper>
  );
}
