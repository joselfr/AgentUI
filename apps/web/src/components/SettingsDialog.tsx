import { useEffect, useState } from 'react';
import { Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Select, Switch, TextField, Typography } from '@mui/material';
import SystemUpdateAlt from '@mui/icons-material/SystemUpdateAlt';
import { api } from '../api';
import { forceUpdate } from '../pwa';
import { useBackClose } from '../useBackClose';
import { t, setLangPref, useLang, LANGS, type LangPref } from '../i18n';
import { disablePush, enablePush, pushState, type PushState } from '../push';

export type ThemeMode = 'auto' | 'light' | 'dark';
const THEMES: ThemeMode[] = ['auto', 'light', 'dark'];
const LANG_NAMES = { fr: 'Français', en: 'English' } as const;
const card = { p: 2, py: 0.5, border: 1, borderColor: 'divider', borderRadius: 1 } as const;

export default function SettingsDialog({ open, onClose, onLogout, themeMode, onThemeMode, expandTools, onExpandTools }: {
  open: boolean; onClose: () => void; onLogout: () => void;
  themeMode: ThemeMode; onThemeMode: (m: ThemeMode) => void;
  expandTools: boolean; onExpandTools: (v: boolean) => void;
}) {
  useBackClose(open, onClose);
  const { pref } = useLang();
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontWeight: 650 }}>{t('settings.title')}</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: 1 }}>
        <Select size="small" value={themeMode} onChange={(e) => onThemeMode(e.target.value as ThemeMode)}>
          {THEMES.map((k) => <MenuItem key={k} value={k}>{t('settings.theme', { value: t(`settings.theme.${k}`) })}</MenuItem>)}
        </Select>
        <Select size="small" value={pref} onChange={(e) => setLangPref(e.target.value as LangPref)}>
          {(['auto', ...LANGS] as LangPref[]).map((k) => <MenuItem key={k} value={k}>{t('settings.language', { value: k === 'auto' ? t('settings.language.auto') : LANG_NAMES[k] })}</MenuItem>)}
        </Select>
        <FormControlLabel sx={{ mx: 0, ...card }} control={<Switch checked={expandTools} onChange={(e) => onExpandTools(e.target.checked)} />} label={t('settings.expandTools')} />
        <PushToggle />
        <UpdateButton />
        <PasswordForm />
      </DialogContent>
      <DialogActions>
        <Button color="error" onClick={onLogout}>{t('settings.logout')}</Button>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function UpdateButton() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async () => {
    setBusy(true); setErr('');
    try { await forceUpdate(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Box sx={{ p: 2, py: 1, border: 1, borderColor: 'divider', borderRadius: 1, display: 'grid', gap: 0.5, justifyItems: 'start' }}>
      <Button size="small" startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <SystemUpdateAlt />} disabled={busy} onClick={run}>{t('settings.update')}</Button>
      <Typography variant="caption" color={err ? 'error' : 'text.secondary'}>{err || t('settings.updateHelp')}</Typography>
    </Box>
  );
}

function PushToggle() {
  const [st, setSt] = useState<PushState>('off');
  const [err, setErr] = useState('');
  useEffect(() => { void pushState().then(setSt); }, []);
  const toggle = async () => {
    setErr('');
    try { setSt(st === 'on' ? await disablePush() : await enablePush()); } catch (e) { setErr((e as Error).message); }
  };
  const help = st === 'unsupported' ? t('settings.pushUnsupported')
    : st === 'denied' ? t('settings.pushDenied') : err;
  return (
    <Box sx={{ ...card, py: 1 }}>
      <FormControlLabel sx={{ mx: 0 }} disabled={st === 'unsupported' || st === 'denied'} control={<Switch checked={st === 'on'} onChange={toggle} />} label={t('settings.push')} />
      {help && <Typography variant="caption" color="text.secondary" display="block">{help}</Typography>}
    </Box>
  );
}

function PasswordForm() {
  const [o, setO] = useState(''); const [n, setN] = useState(''); const [msg, setMsg] = useState('');
  return (
    <Box sx={{ display: 'grid', gap: 1, p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Typography variant="subtitle2">{t('settings.password.title')}</Typography>
      <TextField size="small" type="password" label={t('settings.password.current')} value={o} onChange={(e) => setO(e.target.value)} autoComplete="current-password" />
      <TextField size="small" type="password" label={t('settings.password.new')} value={n} onChange={(e) => setN(e.target.value)} autoComplete="new-password" />
      <Button disabled={!o || n.length < 8} onClick={() => api.changePassword(o, n).then(() => { setMsg(t('settings.password.done')); setO(''); setN(''); }).catch((e) => setMsg((e as Error).message))}>{t('settings.password.submit')}</Button>
      {msg && <Typography variant="caption">{msg}</Typography>}
    </Box>
  );
}
