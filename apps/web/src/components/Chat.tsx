import { Fragment, useState, type ReactNode } from 'react';
import { Alert, Avatar, Box, Button, CircularProgress, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { Capabilities, Message } from '@agentui/shared';
import Composer from './chat/Composer';
import MessageBubble from './chat/MessageBubble';
import UnreadDivider from './chat/UnreadDivider';
import { useAttachments } from './chat/useAttachments';
import { useStickToBottom } from './chat/useStickToBottom';

const alertSx = { mx: 'auto', mb: 1, width: 'min(836px, calc(100% - 24px))' } as const;

/** Conversation : messages, demande d'autorisation, erreurs et zone de saisie ; dépôt de fichiers par glisser-déposer. */
export default function Chat(props: {
  /** Sélecteur de modèle, affiché sous la saisie. */
  modelPicker?: ReactNode;
  unreadMark?: { id: string; count: number };
  title: string; agentName: string; messages: Message[]; loading: boolean; isNew: boolean; running: boolean; expandTools: boolean;
  canAbort: boolean; attach: Capabilities['attachments']; approval?: { id: string; description: string }; onApprove: (ok: boolean) => void; onSend: (t: string, files: File[]) => Promise<boolean>; onAbort: () => void; error?: string;
}) {
  const [drag, setDrag] = useState(false);
  const attachments = useAttachments(props.attach);
  const scroll = useStickToBottom(props.messages);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) attachments.add(e.dataTransfer.files); }}>
      {drag && (
        <Box sx={{ position: 'absolute', inset: 8, zIndex: 10, border: 2, borderStyle: 'dashed', borderColor: 'primary.main', borderRadius: 4, bgcolor: (t) => alpha(t.palette.primary.main, 0.08), display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <Typography variant="h6" color="primary">Déposez vos fichiers ici</Typography>
        </Box>)}
      <Box ref={scroll.scroller} onScroll={scroll.onScroll} sx={{ flex: 1, overflow: 'auto', p: { xs: 1.5, sm: 3 } }}>
        <Box ref={scroll.content} sx={{ maxWidth: 860, mx: 'auto' }}>
          {props.messages.length === 0 && props.loading && <Box sx={{ display: 'grid', placeItems: 'center', mt: 8 }}><CircularProgress size={28} /></Box>}
          {props.messages.length === 0 && props.isNew && (
            <Box sx={{ textAlign: 'center', mt: { xs: 6, md: 12 }, color: 'text.secondary' }}>
              <Avatar sx={{ mx: 'auto', mb: 2, width: 64, height: 64, fontSize: 28, fontWeight: 700, bgcolor: (t) => alpha(t.palette.primary.main, 0.16), color: 'primary.main', border: 1, borderColor: (t) => alpha(t.palette.primary.main, 0.4) }}>{props.agentName[0]}</Avatar>
              <Typography variant="h6" color="text.primary">Discutez avec {props.agentName}</Typography>
              <Typography variant="body2">Posez une question, joignez des fichiers ou lancez une tâche.</Typography>
            </Box>)}
          {props.messages.map((m, i) => {
            const last = i === props.messages.length - 1;
            const next = props.messages[i + 1];
            return (
              <Fragment key={m.id}>
                {props.unreadMark?.id === m.id && <UnreadDivider count={props.unreadMark.count} />}
                <MessageBubble m={m} expandTools={props.expandTools} agentName={props.agentName}
                  answer={next?.role === 'user' ? next.text : undefined}
                  onAnswer={last && !props.running && m.role === 'assistant' ? (t) => void props.onSend(t, []) : undefined}
                  working={last && props.running && m.role === 'assistant'} />
              </Fragment>);
          })}
        </Box>
      </Box>
      {props.approval && (
        <Alert severity="warning" variant="outlined" sx={alertSx} action={<>
          <Button color="inherit" size="small" onClick={() => props.onApprove(true)}>Autoriser</Button>
          <Button color="inherit" size="small" onClick={() => props.onApprove(false)}>Refuser</Button></>}>
          {props.approval.description}
        </Alert>)}
      {props.error && <Alert severity="error" variant="outlined" sx={alertSx}>{props.error}</Alert>}
      {attachments.error && <Alert severity="warning" variant="outlined" onClose={attachments.dismissError} sx={alertSx}>{attachments.error}</Alert>}
      <Composer agentName={props.agentName} running={props.running} canAbort={props.canAbort} attachments={attachments} onAbort={props.onAbort} modelPicker={props.modelPicker}
        onSubmit={(t, f) => { scroll.pin(); return props.onSend(t, f); }} />
    </Box>
  );
}
