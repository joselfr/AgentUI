import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Avatar, Button, Box, Chip, Collapse, Fab, IconButton, Paper, TextField, Tooltip, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import AttachFile from '@mui/icons-material/AttachFile';
import Close from '@mui/icons-material/Close';
import InsertDriveFileOutlined from '@mui/icons-material/InsertDriveFileOutlined';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import Psychology from '@mui/icons-material/Psychology';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Capabilities, Message } from '@agentui/shared';
import { checkFile, formatSize, isImage, type AttachmentView } from '../attachments';
import { ToolsBlock } from './ToolCard';

function Bubble({ m, expandTools, agentName }: { m: Message; expandTools: boolean; agentName: string }) {
  const mine = m.role === 'user';
  const [showReasoning, setShowReasoning] = useState(false);
  return (
    <Box sx={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', gap: 1.5, mb: 2 }}>
      {!mine && <Avatar sx={{ width: 30, height: 30, fontSize: 14, fontWeight: 700, mt: 0.25, bgcolor: (t) => alpha(t.palette.primary.main, 0.16), color: 'primary.main' }}>{agentName[0]}</Avatar>}
      <Paper data-role={m.role} sx={{
        maxWidth: mine ? 'min(640px, 88%)' : 'min(760px, calc(100% - 44px))', px: 2, py: 1.25, borderRadius: mine ? '16px 16px 4px 16px' : '4px 16px 16px 16px',
        bgcolor: mine ? (t) => alpha(t.palette.primary.main, 0.14) : 'background.paper', borderColor: mine ? (t) => alpha(t.palette.primary.main, 0.4) : 'divider', color: 'text.primary',
        '& pre': { overflow: 'auto', p: 1.5, borderRadius: 2, bgcolor: 'background.default', border: 1, borderColor: 'divider', fontSize: 13 },
        '& code': { fontSize: '0.88em' }, '& :not(pre) > code': { px: 0.6, py: 0.15, borderRadius: 1, bgcolor: 'action.selected' },
        '& p': { my: 0.5 }, '& a': { color: 'primary.main' }, '& table': { borderCollapse: 'collapse' }, '& th, & td': { border: 1, borderColor: 'divider', px: 1, py: 0.5 },
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
        {mine && !!m.attachments?.length && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: m.text ? 1 : 0 }}>
            {(m.attachments as AttachmentView[]).map((a) => {
              const href = a.url ?? `/api/attachments/${a.id}`;
              return isImage(a.mimeType) ? (
                <a key={a.id} href={href} target="_blank" rel="noreferrer"><img src={href} alt={a.name} title={a.name} style={{ maxWidth: 240, maxHeight: 200, borderRadius: 8, display: 'block' }} /></a>
              ) : (
                <Chip key={a.id} component="a" href={href} download={a.name} clickable icon={<InsertDriveFileOutlined />} label={`${a.name} · ${formatSize(a.size)}`}
                  sx={{ bgcolor: 'action.selected', color: 'inherit', '& .MuiChip-icon': { color: 'inherit' } }} />
              );
            })}
          </Box>
        )}
        {mine ? (m.text ? <Typography sx={{ whiteSpace: 'pre-wrap' }}>{m.text}</Typography> : null)
          : <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text || (m.status === 'streaming' ? '…' : '')}</ReactMarkdown>}
        {m.status === 'aborted' && <Typography variant="caption" color="text.secondary">⏹ interrompu</Typography>}
      </Paper>
    </Box>
  );
}

export default function Chat(props: {
  title: string; agentName: string; messages: Message[]; running: boolean; expandTools: boolean;
  canAbort: boolean; attach: Capabilities['attachments']; approval?: { id: string; description: string }; onApprove: (ok: boolean) => void; onSend: (t: string, files: File[]) => Promise<boolean>; onAbort: () => void; error?: string;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState('');
  const [drag, setDrag] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => files.map((f) => (isImage(f.type) ? URL.createObjectURL(f) : '')), [files]);
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews]);
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { if (stick.current) bottom.current?.scrollIntoView({ block: 'end' }); }, [props.messages]);
  const add = (list: FileList | File[]) => {
    let next = files; const errs: string[] = [];
    for (const f of Array.from(list)) { const e = checkFile(f, next, props.attach); if (e) errs.push(e); else next = [...next, f]; }
    setFiles(next); setFileError(errs.join(' '));
  };
  const canSend = (text.trim() || files.length) && !props.running;
  const send = async () => {
    if (!canSend) return;
    const t = text, f = files;
    setText(''); setFiles([]); setFileError(''); stick.current = true;
    if (!(await props.onSend(t.trim(), f))) { setText(t); setFiles(f); } // échec : on garde le brouillon
  };
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) add(e.dataTransfer.files); }}>
      {drag && (
        <Box sx={{ position: 'absolute', inset: 8, zIndex: 10, border: 2, borderStyle: 'dashed', borderColor: 'primary.main', borderRadius: 4, bgcolor: (t) => alpha(t.palette.primary.main, 0.08), display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <Typography variant="h6" color="primary">Déposez vos fichiers ici</Typography>
        </Box>)}
      <Box ref={scroller} sx={{ flex: 1, overflow: 'auto', p: { xs: 1.5, sm: 3 } }}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        <Box sx={{ maxWidth: 860, mx: 'auto' }}>
          {props.messages.length === 0 && (
            <Box sx={{ textAlign: 'center', mt: { xs: 6, md: 12 }, color: 'text.secondary' }}>
              <Avatar sx={{ mx: 'auto', mb: 2, width: 64, height: 64, fontSize: 28, fontWeight: 700, bgcolor: (t) => alpha(t.palette.primary.main, 0.16), color: 'primary.main', border: 1, borderColor: (t) => alpha(t.palette.primary.main, 0.4) }}>{props.agentName[0]}</Avatar>
              <Typography variant="h6" color="text.primary">Discutez avec {props.agentName}</Typography>
              <Typography variant="body2">Posez une question, joignez des fichiers ou lancez une tâche.</Typography>
            </Box>)}
          {props.messages.map((m) => <Bubble key={m.id} m={m} expandTools={props.expandTools} agentName={props.agentName} />)}
          <div ref={bottom} />
        </Box>
      </Box>
      {props.approval && (
        <Alert severity="warning" variant="outlined" sx={{ mx: 'auto', mb: 1, width: 'min(836px, calc(100% - 24px))' }} action={<>
          <Button color="inherit" size="small" onClick={() => props.onApprove(true)}>Autoriser</Button>
          <Button color="inherit" size="small" onClick={() => props.onApprove(false)}>Refuser</Button></>}>
          {props.approval.description}
        </Alert>)}
      {props.error && <Alert severity="error" variant="outlined" sx={{ mx: 'auto', mb: 1, width: 'min(836px, calc(100% - 24px))' }}>{props.error}</Alert>}
      {fileError && <Alert severity="warning" variant="outlined" onClose={() => setFileError('')} sx={{ mx: 'auto', mb: 1, width: 'min(836px, calc(100% - 24px))' }}>{fileError}</Alert>}
      <Box sx={{ px: { xs: 1.5, sm: 3 }, pb: 'max(12px, env(safe-area-inset-bottom))', pt: 0.5 }}>
        <Paper sx={{ maxWidth: 860, mx: 'auto', borderRadius: 4, bgcolor: 'background.paper', '&:focus-within': { borderColor: 'primary.main' }, transition: 'border-color .15s' }}>
          {files.length > 0 && (
            <Box sx={{ px: 1.5, pt: 1.25, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {files.map((f, i) => (
                <Chip key={`${f.name}-${i}`} label={`${f.name} · ${formatSize(f.size)}`} onDelete={() => setFiles(files.filter((_, j) => j !== i))}
                  avatar={previews[i] ? <Avatar src={previews[i]} variant="rounded" alt="" /> : undefined} icon={previews[i] ? undefined : <InsertDriveFileOutlined />} deleteIcon={<Close />} />
              ))}
            </Box>)}
          <Box sx={{ p: 1, display: 'flex', gap: 0.5, alignItems: 'flex-end' }}>
            <input ref={picker} type="file" multiple hidden data-testid="file-input" onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ''; }} />
            <Tooltip title="Joindre des fichiers"><span><IconButton onClick={() => picker.current?.click()} aria-label="Joindre un fichier" disabled={props.running} sx={{ borderRadius: '50%' }}><AttachFile /></IconButton></span></Tooltip>
            <TextField fullWidth multiline size="small" maxRows={8}placeholder={`Message à ${props.agentName}`} value={text}
              sx={{ '& .MuiOutlinedInput-root': { bgcolor: 'transparent' }, '& .MuiOutlinedInput-notchedOutline, & .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline, & .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline': { border: 0 } }}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); add(e.clipboardData.files); } }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
            {props.running && props.canAbort
              ? <Fab color="error" size="small" onClick={props.onAbort} aria-label="Arrêter" sx={{ flexShrink: 0, boxShadow: 'none' }}><StopIcon /></Fab>
              : <IconButton onClick={() => void send()} disabled={!canSend} aria-label="Envoyer"
                  sx={{ flexShrink: 0, borderRadius: '50%', bgcolor: 'primary.main', color: 'primary.contrastText', '&:hover': { bgcolor: 'primary.dark' }, '&.Mui-disabled': { bgcolor: 'action.disabledBackground' } }}><SendIcon /></IconButton>}
          </Box>
        </Paper>
      </Box>
    </Box>
  );
}
