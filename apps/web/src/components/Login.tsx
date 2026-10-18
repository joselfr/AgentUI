import { useState } from 'react';
import { Alert, Box, Button, Paper, TextField, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { api } from '../api';
import { t } from '../i18n';

export default function Login({ onDone }: { onDone: () => void }) {
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.login(username, password);
      onDone();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box sx={{ height: 'var(--app-height, 100dvh)', overflow: 'auto', display: 'grid', placeItems: 'center', p: 2, background: (t) => `radial-gradient(60% 50% at 50% 0%, ${alpha(t.palette.primary.main, 0.14)}, transparent)` }}>
      <Paper component="form" onSubmit={submit} sx={{ p: 4, width: 'min(400px, 100%)', display: 'grid', gap: 2, borderRadius: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
          <Box component="img" src="/icon.svg" alt="" sx={{ width: 40, height: 40, borderRadius: '11px' }} />
          <Box>
            <Typography variant="h5" sx={{ lineHeight: 1.1 }}>AgentUI</Typography>
            <Typography variant="caption" color="text.secondary">{t('login.subtitle')}</Typography>
          </Box>
        </Box>
        {err && <Alert severity="error" variant="outlined">{err}</Alert>}
        <TextField label={t('login.username')} value={username} onChange={(e) => setU(e.target.value)} autoComplete="username" autoFocus />
        <TextField label={t('login.password')} type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" />
        <Button type="submit" variant="contained" size="large" disabled={busy || !username || !password}>{t('login.submit')}</Button>
      </Paper>
    </Box>
  );
}
