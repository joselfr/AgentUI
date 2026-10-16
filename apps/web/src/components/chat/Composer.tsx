import { useRef, useState, type ReactNode } from 'react';
import { Avatar, Box, Chip, Fab, IconButton, Paper, TextField, Tooltip } from '@mui/material';
import AttachFile from '@mui/icons-material/AttachFile';
import Close from '@mui/icons-material/Close';
import InsertDriveFileOutlined from '@mui/icons-material/InsertDriveFileOutlined';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import { formatSize } from '../../attachments';
import type { useAttachments } from './useAttachments';

/** Zone de saisie : texte (Entrée envoie, Maj+Entrée saute une ligne), fichiers joints (bouton, collage), envoi / arrêt. */
export default function Composer({ agentName, running, canAbort, attachments, onSubmit, onAbort, modelPicker }: {
  modelPicker?: ReactNode; agentName: string; running: boolean; canAbort: boolean; attachments: ReturnType<typeof useAttachments>;
  onSubmit: (text: string, files: File[]) => Promise<boolean>; onAbort: () => void;
}) {
  const [text, setText] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const { files, previews } = attachments;
  const canSend = (text.trim() || files.length) && !running;
  const send = async () => {
    if (!canSend) return;
    const t = text, f = files;
    setText(''); attachments.clear();
    if (!(await onSubmit(t.trim(), f))) { setText(t); attachments.restore(f); } // échec : on garde le brouillon
  };
  return (
    <Box sx={{ px: { xs: 1.5, sm: 3 }, pb: 'max(12px, env(safe-area-inset-bottom))', pt: 0.5 }}>
      <Paper sx={{ maxWidth: 860, mx: 'auto', borderRadius: 1.5, bgcolor: 'background.paper', '&:focus-within': { borderColor: 'primary.main' }, transition: 'border-color .15s' }}>
        {files.length > 0 && (
          <Box sx={{ px: 1.5, pt: 1.25, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {files.map((f, i) => (
              <Chip key={`${f.name}-${i}`} label={`${f.name} · ${formatSize(f.size)}`} onDelete={() => attachments.remove(i)}
                avatar={previews[i] ? <Avatar src={previews[i]} variant="rounded" alt="" /> : undefined} icon={previews[i] ? undefined : <InsertDriveFileOutlined />} deleteIcon={<Close />} />
            ))}
          </Box>)}
        <Box sx={{ p: 1, display: 'flex', gap: 0.5, alignItems: 'flex-end' }}>
          <input ref={picker} type="file" multiple hidden data-testid="file-input" onChange={(e) => { if (e.target.files) attachments.add(e.target.files); e.target.value = ''; }} />
          <Tooltip title="Joindre des fichiers"><span><IconButton onClick={() => picker.current?.click()} aria-label="Joindre un fichier" disabled={running} sx={{ borderRadius: '50%' }}><AttachFile /></IconButton></span></Tooltip>
          <TextField fullWidth multiline size="small" maxRows={8} placeholder={`Message à ${agentName}`} value={text}
            sx={{ '& .MuiOutlinedInput-root': { bgcolor: 'transparent' }, '& .MuiOutlinedInput-notchedOutline, & .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline, & .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline': { border: 0 } }}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); attachments.add(e.clipboardData.files); } }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
          {running && canAbort
            ? <Fab color="error" size="small" onClick={onAbort} aria-label="Arrêter" sx={{ flexShrink: 0, boxShadow: 'none' }}><StopIcon /></Fab>
            : <IconButton onClick={() => void send()} disabled={!canSend} aria-label="Envoyer"
                sx={{ flexShrink: 0, borderRadius: '50%', bgcolor: 'primary.main', color: 'primary.contrastText', '&:hover': { bgcolor: 'primary.dark' }, '&.Mui-disabled': { bgcolor: 'action.disabledBackground' } }}><SendIcon /></IconButton>}
        </Box>
        {modelPicker && <Box sx={{ px: 1.25, pb: 1, display: 'flex' }}>{modelPicker}</Box>}
      </Paper>
    </Box>
  );
}
