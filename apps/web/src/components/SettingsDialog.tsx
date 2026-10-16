import { useEffect, useState } from 'react';
import { Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Select, Switch, TextField, Typography } from '@mui/material';
import SystemUpdateAlt from '@mui/icons-material/SystemUpdateAlt';
import { api } from '../api';
import { forceUpdate } from '../pwa';
import { useBackClose } from '../useBackClose';
import { disablePush, enablePush, pushState, type PushState } from '../push';

export type ThemeMode = 'auto' | 'light' | 'dark';
const themeLabel: Record<ThemeMode, string> = { auto: 'Système', light: 'Clair', dark: 'Sombre' };
const card = { p: 2, py: 0.5, border: 1, borderColor: 'divider', borderRadius: 1 } as const;

export default function SettingsDialog({ open, onClose, onLogout, themeMode, onThemeMode, expandTools, onExpandTools }: {
  open: boolean; onClose: () => void; onLogout: () => void;
  themeMode: ThemeMode; onThemeMode: (m: ThemeMode) => void;
  expandTools: boolean; onExpandTools: (v: boolean) => void;
}) {
  useBackClose(open, onClose);
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontWeight: 650 }}>Réglages</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: 1 }}>
        <Select size="small" value={themeMode} onChange={(e) => onThemeMode(e.target.value as ThemeMode)}>
          {(Object.keys(themeLabel) as ThemeMode[]).map((k) => <MenuItem key={k} value={k}>Thème : {themeLabel[k]}</MenuItem>)}
        </Select>
        <FormControlLabel sx={{ mx: 0, ...card }} control={<Switch checked={expandTools} onChange={(e) => onExpandTools(e.target.checked)} />} label="Déplier les outils par défaut" />
        <PushToggle />
        <UpdateButton />
        <PasswordForm />
      </DialogContent>
      <DialogActions>
        <Button color="error" onClick={onLogout}>Se déconnecter</Button>
        <Button onClick={onClose}>Fermer</Button>
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
      <Button size="small" startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <SystemUpdateAlt />} disabled={busy} onClick={run}>Forcer la mise à jour de l'app</Button>
      <Typography variant="caption" color={err ? 'error' : 'text.secondary'}>{err || 'Récupère la dernière version puis recharge la page.'}</Typography>
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
  const help = st === 'unsupported' ? 'Non supporté par ce navigateur (sur iPhone : ajouter l\'app à l\'écran d\'accueil).'
    : st === 'denied' ? 'Bloquées dans le navigateur : à réactiver dans les réglages du site.' : err;
  return (
    <Box sx={{ ...card, py: 1 }}>
      <FormControlLabel sx={{ mx: 0 }} disabled={st === 'unsupported' || st === 'denied'} control={<Switch checked={st === 'on'} onChange={toggle} />} label="Notifications quand un agent répond" />
      {help && <Typography variant="caption" color="text.secondary" display="block">{help}</Typography>}
    </Box>
  );
}

function PasswordForm() {
  const [o, setO] = useState(''); const [n, setN] = useState(''); const [msg, setMsg] = useState('');
  return (
    <Box sx={{ display: 'grid', gap: 1, p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Typography variant="subtitle2">Changer le mot de passe</Typography>
      <TextField size="small" type="password" label="Actuel" value={o} onChange={(e) => setO(e.target.value)} autoComplete="current-password" />
      <TextField size="small" type="password" label="Nouveau (8+ caractères)" value={n} onChange={(e) => setN(e.target.value)} autoComplete="new-password" />
      <Button disabled={!o || n.length < 8} onClick={() => api.changePassword(o, n).then(() => { setMsg('Mot de passe modifié'); setO(''); setN(''); }).catch((e) => setMsg((e as Error).message))}>Modifier</Button>
      {msg && <Typography variant="caption">{msg}</Typography>}
    </Box>
  );
}
