import { useEffect, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, ListItemIcon, Menu, MenuItem, TextField } from '@mui/material';
import Archive from '@mui/icons-material/Archive';
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutline';
import Delete from '@mui/icons-material/Delete';
import Edit from '@mui/icons-material/Edit';
import Star from '@mui/icons-material/Star';
import StarBorder from '@mui/icons-material/StarBorder';
import Unarchive from '@mui/icons-material/Unarchive';
import type { Conversation } from '../../api';
import { useBackClose } from '../../useBackClose';
import type { ItemMenu } from './useItemMenu';

/** Menu clic droit / appui long d'une discussion. Chaque action ferme le menu avant de s'exécuter. */
export default function ConversationMenu({ menu, onRequestClose, onClose, onToggleFavorite, onRename, onArchive, onSelect, onDelete }: {
  menu?: ItemMenu<Conversation>; onRequestClose: () => void; onClose: () => void;
  onToggleFavorite: (c: Conversation) => void; onRename: (c: Conversation) => void; onArchive: (c: Conversation, archived: boolean) => void;
  onSelect: (c: Conversation) => void; onDelete: (c: Conversation) => void;
}) {
  const c = menu?.item;
  useBackClose(!!menu, onRequestClose);
  const run = (fn: (c: Conversation) => void) => () => { if (c) fn(c); onClose(); };
  return (
    <Menu open={!!menu} onClose={onRequestClose} anchorReference="anchorPosition" anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}
      onContextMenu={(e) => e.preventDefault()}>
      <MenuItem onClick={run(onToggleFavorite)}>
        <ListItemIcon>{c?.favorite ? <StarBorder fontSize="small" /> : <Star fontSize="small" />}</ListItemIcon>
        {c?.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
      </MenuItem>
      <MenuItem onClick={run(onRename)}>
        <ListItemIcon><Edit fontSize="small" /></ListItemIcon>Renommer
      </MenuItem>
      <MenuItem onClick={run((x) => onArchive(x, !x.archived))}>
        <ListItemIcon>{c?.archived ? <Unarchive fontSize="small" /> : <Archive fontSize="small" />}</ListItemIcon>
        {c?.archived ? 'Désarchiver' : 'Archiver'}
      </MenuItem>
      <MenuItem onClick={run(onSelect)}>
        <ListItemIcon><CheckCircleOutline fontSize="small" /></ListItemIcon>Sélectionner
      </MenuItem>
      <MenuItem onClick={run(onDelete)} sx={{ color: 'error.main' }}>
        <ListItemIcon sx={{ color: 'inherit' }}><Delete fontSize="small" /></ListItemIcon>Supprimer
      </MenuItem>
    </Menu>
  );
}

/** Modale de renommage ; `conv` non défini = fermée. */
export function RenameDialog({ conv, onSubmit, onClose }: { conv?: Conversation; onSubmit: (c: Conversation, title: string) => void; onClose: () => void }) {
  const [title, setTitle] = useState('');
  useBackClose(!!conv, onClose);
  useEffect(() => { if (conv) setTitle(conv.title); }, [conv]);
  const submit = () => {
    const t = title.trim();
    if (conv && t && t !== conv.title) onSubmit(conv, t);
    onClose();
  };
  return (
    <Dialog open={!!conv} onClose={onClose} fullWidth maxWidth="xs">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <DialogTitle sx={{ fontWeight: 650 }}>Renommer la discussion</DialogTitle>
        <DialogContent sx={{ pt: 1 }}>
          <TextField autoFocus fullWidth size="small" label="Nom" value={title} inputProps={{ maxLength: 200 }}
            onFocus={(e) => e.target.select()} onChange={(e) => setTitle(e.target.value)} />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Annuler</Button>
          <Button type="submit" variant="contained" disabled={!title.trim()}>Renommer</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
