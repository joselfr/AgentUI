import { useEffect, useState } from 'react';
import { Box, Chip, CircularProgress, ListItemText, ListSubheader, Menu, MenuItem, Typography } from '@mui/material';
import ArrowDropDown from '@mui/icons-material/ArrowDropDown';
import Check from '@mui/icons-material/Check';
import Memory from '@mui/icons-material/Memory';
import type { ModelOption, Usage } from '@agentui/shared';
import { useBackClose } from '../useBackClose';
import { t } from '../i18n';

/**
   * Model of the chat, in the input area. Clickable when the agent can switch models: the menu lists the
   * models by provider. The change only applies between two replies (`disabled` during a run).
 */
export default function ModelChip({ usage, canPick, disabled, load, onPick }: {
  usage?: Usage; canPick: boolean; disabled: boolean; load: () => Promise<ModelOption[]>; onPick: (o: ModelOption) => Promise<void>;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [options, setOptions] = useState<ModelOption[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (anchor && !options) load().then(setOptions).catch((e) => setError((e as Error).message));
  }, [anchor, options, load]);
  useBackClose(!!anchor, () => { if (!busy) setAnchor(null); });
  if (!usage?.model && !canPick) return null;

  const clickable = canPick && !disabled;
  const groups = (options ?? []).reduce<Map<string, ModelOption[]>>((m, o) => m.set(o.providerName, [...(m.get(o.providerName) ?? []), o]), new Map());
  const pick = async (o: ModelOption) => {
    setBusy(true); setError('');
    try { await onPick(o); setAnchor(null); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      <Chip size="small" variant="outlined" icon={<Memory />} clickable={clickable} onClick={clickable ? (e) => setAnchor(e.currentTarget) : undefined}
        title={!canPick ? t('model.current') : disabled ? t('model.afterRun') : t('model.change')}
        label={<Box component="span" sx={{ display: 'flex', alignItems: 'center' }}>
          <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{usage?.model ?? t('model.default')}</Box>
          {clickable && <ArrowDropDown fontSize="small" sx={{ ml: 0.25, mr: -0.5, flexShrink: 0 }} />}
        </Box>}
        sx={{ height: 28, fontWeight: 500, maxWidth: 'min(280px, 100%)', '& .MuiChip-label': { px: 0.75 } }} />
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => !busy && setAnchor(null)} slotProps={{ paper: { sx: { maxHeight: 360, minWidth: 240 } } }}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }} transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}>
        {!options && !error && <Box sx={{ display: 'grid', placeItems: 'center', p: 2 }}><CircularProgress size={20} /></Box>}
        {error && <Typography variant="body2" color="error" sx={{ px: 2, py: 1, maxWidth: 320 }}>{error}</Typography>}
        {[...groups].flatMap(([provider, list]) => [
          <ListSubheader key={`h-${provider}`} sx={{ lineHeight: '32px', bgcolor: 'background.paper' }}>{provider}</ListSubheader>,
          ...list.map((o) => (
            <MenuItem key={`${o.provider}/${o.id}`} selected={o.id === usage?.model} disabled={busy} onClick={() => void pick(o)}>
              <ListItemText primary={o.id} primaryTypographyProps={{ noWrap: true, fontSize: 14 }} />
              {o.id === usage?.model && <Check fontSize="small" sx={{ ml: 1.5 }} />}
            </MenuItem>)),
        ])}
      </Menu>
    </>
  );
}
