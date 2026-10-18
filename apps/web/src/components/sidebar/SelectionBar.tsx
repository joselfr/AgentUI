import { Box, Checkbox, IconButton, Tooltip, Typography } from '@mui/material';
import Archive from '@mui/icons-material/Archive';
import Close from '@mui/icons-material/Close';
import Delete from '@mui/icons-material/Delete';
import Unarchive from '@mui/icons-material/Unarchive';
import { t } from '../../i18n';

/** Selection mode action bar: select all, archive / unarchive, delete, exit. */
export default function SelectionBar({ count, allChosen, allArchived, onToggleAll, onArchive, onDelete, onCancel }: {
  count: number; allChosen: boolean; allArchived: boolean;
  onToggleAll: () => void; onArchive: () => void; onDelete: () => void; onCancel: () => void;
}) {
  const archiveLabel = allArchived ? t('menu.unarchive') : t('menu.archive');
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1.5, pr: 1, height: 64, flexShrink: 0 }}>
      <Checkbox size="small" checked={allChosen} indeterminate={!allChosen && count > 0} sx={{ p: 0.5 }} inputProps={{ 'aria-label': t('selection.all') }} onChange={onToggleAll} />
      <Typography variant="subtitle2" sx={{ flex: 1 }} noWrap>{count ? t('selection.count', { count }) : t('menu.select')}</Typography>
      <Tooltip title={archiveLabel}><span><IconButton size="small" disabled={!count} aria-label={archiveLabel} onClick={onArchive}>
        {allArchived ? <Unarchive fontSize="small" /> : <Archive fontSize="small" />}</IconButton></span></Tooltip>
      <Tooltip title={t('common.delete')}><span><IconButton size="small" color="error" disabled={!count} aria-label={t('selection.delete')} onClick={onDelete}><Delete fontSize="small" /></IconButton></span></Tooltip>
      <Tooltip title={t('common.cancel')}><IconButton size="small" aria-label={t('selection.quit')} onClick={onCancel}><Close fontSize="small" /></IconButton></Tooltip>
    </Box>
  );
}
