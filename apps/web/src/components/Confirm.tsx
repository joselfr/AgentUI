import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useBackClose } from '../useBackClose';
import { t } from '../i18n';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import HelpOutline from '@mui/icons-material/HelpOutline';

export interface ConfirmOptions {
  title: string;
  /** Detail of the consequence (shown under the title). */
  text?: ReactNode;
  confirmLabel?: string;
  /** Destructive action: red button and icon. */
  danger?: boolean;
}

/** Replaces `window.confirm`: `if (await ask({ … })) …` + `{dialog}` to render in the component. */
export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOptions>();
  const resolver = useRef<(ok: boolean) => void>();
  const ask = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setOpts(o);
  }), []);
  const close = (ok: boolean) => { resolver.current?.(ok); resolver.current = undefined; setOpts(undefined); };
  useBackClose(!!opts, () => close(false));
  // The content is kept during the closing animation (opts becomes undefined right away)
  const last = useRef<ConfirmOptions>();
  if (opts) last.current = opts;
  const o = opts ?? last.current;
  const color = o?.danger ? 'error' : 'primary';
  const dialog = (
    <Dialog open={!!opts} onClose={() => close(false)} fullWidth maxWidth="xs">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1.5, fontWeight: 650 }}>
        <Box aria-hidden sx={{ width: 36, height: 36, borderRadius: '50%', display: 'grid', placeItems: 'center', flexShrink: 0,
          color: `${color}.main`, bgcolor: (t) => alpha(t.palette[color].main, 0.14) }}>
          {o?.danger ? <DeleteOutline fontSize="small" /> : <HelpOutline fontSize="small" />}
        </Box>
        {o?.title}
      </DialogTitle>
      {o?.text && <DialogContent sx={{ pt: 0 }}><Typography variant="body2" color="text.secondary">{o.text}</Typography></DialogContent>}
      <DialogActions>
        <Button onClick={() => close(false)}>{t('common.cancel')}</Button>
        <Button variant="contained" color={color} autoFocus onClick={() => close(true)}>{o?.confirmLabel ?? t('common.confirm')}</Button>
      </DialogActions>
    </Dialog>
  );
  return { ask, dialog };
}
