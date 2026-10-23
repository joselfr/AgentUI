import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Avatar, Box, Chip, Fab, IconButton, Paper, TextField, Tooltip, Typography } from '@mui/material';
import AttachFile from '@mui/icons-material/AttachFile';
import Close from '@mui/icons-material/Close';
import FormatQuote from '@mui/icons-material/FormatQuote';
import InsertDriveFileOutlined from '@mui/icons-material/InsertDriveFileOutlined';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import { formatSize } from '../../attachments';
import type { useAttachments } from './useAttachments';
import { t } from '../../i18n';

/** Input area: text (Enter sends, Shift+Enter adds a line), attached files (button, paste), send / stop. */
export default function Composer({ agentName, running, awaiting, canAbort, attachments, onSubmit, onAbort, modelPicker, quote, onClearQuote }: {
  /** Text being replied to (shown above the input, sent as a leading blockquote by `onSubmit`'s caller). */
  quote?: string | null; onClearQuote?: () => void;
  modelPicker?: ReactNode; agentName: string; running: boolean; awaiting: boolean; canAbort: boolean; attachments: ReturnType<typeof useAttachments>;
  onSubmit: (text: string, files: File[]) => Promise<boolean>; onAbort: () => void;
}) {
  const [text, setText] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (quote) input.current?.focus(); }, [quote]);
  const { files, previews } = attachments;
  // During an agent question, the text is the answer (without attachment); without text, the button stays "Stop".
  const canSend = awaiting ? !!text.trim() && !files.length : (text.trim() || files.length) && !running;
  const send = async () => {
    if (!canSend) return;
    const t = text, f = files;
    setText(''); attachments.clear();
    if (!(await onSubmit(t.trim(), f))) { setText(t); attachments.restore(f); } // failure: keep the draft
  };
  return (
    <Box sx={{ px: { xs: 1.75, sm: 3 }, pb: 'max(12px, env(safe-area-inset-bottom))', pt: 0.5 }}>
      <Paper sx={{ maxWidth: 860, mx: 'auto', borderRadius: 1.5, bgcolor: 'background.paper', '&:focus-within': { borderColor: 'primary.main' }, transition: 'border-color .15s' }}>
        {quote && (
          <Box data-testid="composer-quote" sx={{ mx: 1, mt: 1, pl: 1, pr: 0.5, py: 0.5, display: 'flex', alignItems: 'center', gap: 1, borderLeft: 3, borderColor: 'primary.main', borderRadius: 0.5, bgcolor: 'action.hover' }}>
            <FormatQuote fontSize="small" color="primary" />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="caption" color="primary" sx={{ fontWeight: 600 }}>{t('chat.quoting')}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{quote}</Typography>
            </Box>
            <IconButton size="small" onClick={onClearQuote} aria-label={t('chat.quoteRemove')}><Close fontSize="small" /></IconButton>
          </Box>)}
        {files.length > 0 && (
          <Box sx={{ px: 1.5, pt: 1.25, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {files.map((f, i) => (
              <Chip key={`${f.name}-${i}`} label={`${f.name} · ${formatSize(f.size)}`} onDelete={() => attachments.remove(i)}
                avatar={previews[i] ? <Avatar src={previews[i]} variant="rounded" alt="" /> : undefined} icon={previews[i] ? undefined : <InsertDriveFileOutlined />} deleteIcon={<Close />} />
            ))}
          </Box>)}
        <Box sx={{ p: 1, display: 'flex', gap: 0.5, alignItems: 'flex-end' }}>
          <input ref={picker} type="file" multiple hidden data-testid="file-input" onChange={(e) => { if (e.target.files) attachments.add(e.target.files); e.target.value = ''; }} />
          <Tooltip title={t('composer.attach')}><span><IconButton onClick={() => picker.current?.click()} aria-label={t('composer.attachLabel')} disabled={running} sx={{ borderRadius: '50%' }}><AttachFile /></IconButton></span></Tooltip>
          <TextField fullWidth multiline size="small" maxRows={8} inputRef={input} placeholder={t('composer.placeholder', { agent: agentName })} value={text}
            sx={{ '& .MuiOutlinedInput-root': { bgcolor: 'transparent' }, '& .MuiOutlinedInput-notchedOutline, & .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline, & .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline': { border: 0 } }}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); attachments.add(e.clipboardData.files); } }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
          {running && canAbort && !canSend
            ? <Fab color="error" size="small" onClick={onAbort} aria-label={t('composer.stop')} sx={{ flexShrink: 0, boxShadow: 'none' }}><StopIcon /></Fab>
            : <IconButton onClick={() => void send()} disabled={!canSend} aria-label={t('composer.send')}
                sx={{ flexShrink: 0, borderRadius: '50%', bgcolor: 'primary.main', color: 'primary.contrastText', '&:hover': { bgcolor: 'primary.dark' }, '&.Mui-disabled': { bgcolor: 'action.disabledBackground' } }}><SendIcon /></IconButton>}
        </Box>
        {modelPicker && <Box sx={{ px: 1.25, pb: 1, display: 'flex' }}>{modelPicker}</Box>}
      </Paper>
    </Box>
  );
}
