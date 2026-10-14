import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppBar, Badge, Box, Button, Chip, CircularProgress, CssBaseline, Dialog, DialogActions, DialogContent, DialogTitle, Drawer, FormControlLabel,
  IconButton, MenuItem, Select, Switch, TextField, ThemeProvider, Toolbar, Typography, useMediaQuery,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import MenuIcon from '@mui/icons-material/Menu';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import type { AgentInfo, Message } from '@agentui/shared';
import { api, UnauthorizedError, type Conversation } from './api';
import { makeTheme } from './theme';
import { applyEvent } from './reducer';
import { useLive, type LiveEvent } from './useLive';
import Login from './components/Login';
import Sidebar, { DRAWER, RAIL, StatusDot } from './components/Sidebar';
import Chat from './components/Chat';
import AgentPanels from './components/AgentPanels';
import { toOutgoing, type AttachmentView } from './attachments';
import { disablePush, enablePush, pushState, type PushState } from './push';

const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v === null ? d : (JSON.parse(v) as T); } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignoré */ } };

export default function App() {
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const [themeMode, setThemeMode] = useState<'auto' | 'light' | 'dark'>(() => load('themeMode', 'dark'));
  const [expandTools, setExpandTools] = useState<boolean>(() => load('expandTools', false));
  const theme = useMemo(() => makeTheme(themeMode === 'auto' ? (prefersDark ? 'dark' : 'light') : themeMode), [themeMode, prefersDark]);
  const wide = useMediaQuery(theme.breakpoints.up('md'));

  const [auth, setAuth] = useState<'loading' | 'out' | 'in'>('loading');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [running, setRunning] = useState(false);
  const [approval, setApproval] = useState<{ id: string; description: string }>();
  const [error, setError] = useState<string>();
  const [drawer, setDrawer] = useState(false);
  const [rail, setRail] = useState<boolean>(() => load('sidebarCollapsed', false));
  const [info, setInfo] = useState(false);
  const [settings, setSettings] = useState(false);
  const [sub, setSub] = useState<string>();
  const [newAgent, setNewAgent] = useState<string>();
  const currentRef = useRef<string>();
  currentRef.current = currentId;

  const current = convs.find((c) => c.id === currentId);
  const agent = agents.find((a) => a.id === (current?.agentId ?? newAgent));

  const onUnauth = useCallback(() => setAuth('out'), []);
  const guard = useCallback((e: unknown) => { if (e instanceof UnauthorizedError) setAuth('out'); else setError((e as Error).message); }, []);

  const refreshLists = useCallback(() => {
    api.agents().then(setAgents).catch(guard);
    api.conversations().then(setConvs).catch(guard);
  }, [guard]);

  const loadMessages = useCallback((id: string) => {
    api.messages(id).then((r) => {
      if (currentRef.current !== id) return;
      setMessages(r.messages);
      setRunning(r.conversation.running);
    }).catch(guard);
  }, [guard]);

  useEffect(() => { api.me().then((r) => setAuth(r.user ? 'in' : 'out')).catch(() => setAuth('out')); }, []);
  useEffect(() => { if (auth === 'in') refreshLists(); }, [auth, refreshLists]);
  // Ouverture d'une conversation depuis une notification (?c=<id> ou message du service worker)
  useEffect(() => {
    if (auth !== 'in') return;
    const open = (url: string) => { const id = new URL(url, location.origin).searchParams.get('c'); if (id) { setCurrentId(id); history.replaceState(null, '', '/'); } };
    open(location.href);
    const onMsg = (e: MessageEvent) => { if (e.data?.type === 'open-conversation') { open(e.data.url); refreshLists(); } };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, [auth, refreshLists]);
  useEffect(() => {
    if (!newAgent && agents.length) setNewAgent(agents[0]!.id);
  }, [agents, newAgent]);
  useEffect(() => {
    setApproval(undefined); setError(undefined);
    if (currentId) loadMessages(currentId); else { setMessages([]); setRunning(false); }
  }, [currentId, loadMessages]);

  const onEvent = useCallback((e: LiveEvent) => {
    if (e.event.type === 'approval.request' && e.sessionId === currentRef.current) setApproval({ id: e.event.id, description: e.event.description });
    const terminal = ['run.completed', 'run.failed', 'run.aborted'].includes(e.event.type);
    if (terminal) { setApproval(undefined); api.conversations().then(setConvs).catch(() => {}); }
    if (e.sessionId !== currentRef.current) return;
    if (terminal) setRunning(false);
    setMessages((prev) => {
      const next = applyEvent(prev, e.event);
      if (next === null) { loadMessages(e.sessionId); return prev; } // run lancé depuis un autre appareil
      return next;
    });
    if (!terminal) setRunning(true);
  }, [loadMessages]);

  useLive({
    enabled: auth === 'in',
    onEvent,
    onStatus: (id, status, detail) => setAgents((as) => as.map((a) => (a.id === id ? { ...a, status, statusDetail: detail } : a))),
    onOpen: () => { refreshLists(); if (currentRef.current) loadMessages(currentRef.current); },
    onUnauthorized: onUnauth,
  });

  const send = async (text: string, files: File[]): Promise<boolean> => {
    setError(undefined);
    let optimistic = false;
    try {
      let id = currentId;
      if (!id) {
        if (!newAgent) return false;
        const c = await api.createConversation(newAgent, sub);
        setConvs((cs) => [c, ...cs]);
        currentRef.current = id = c.id;
        setCurrentId(id);
      }
      const attachments = await toOutgoing(files);
      const views: AttachmentView[] = files.map((f, i) => ({ id: `local-${Date.now()}-${i}`, name: f.name, mimeType: f.type, size: f.size, url: URL.createObjectURL(f) }));
      setMessages((m) => [...m,
        { id: `local-${Date.now()}`, role: 'user', text, attachments: views, createdAt: Date.now(), status: 'done' },
        { id: `local-a-${Date.now()}`, role: 'assistant', text: '', createdAt: Date.now(), status: 'streaming' }]);
      optimistic = true;
      setRunning(true);
      await api.send(id, text, attachments);
      return true;
    } catch (e) {
      setRunning(false);
      guard(e);
      if (optimistic && currentRef.current) loadMessages(currentRef.current);
      return false;
    }
  };

  const themeLabel = { auto: 'Système', light: 'Clair', dark: 'Sombre' };

  const closeDrawer = () => { if (!wide) setDrawer(false); };
  const deleteConv = (c: Conversation) => {
    if (confirm('Supprimer cette conversation ?')) {
      api.remove(c.id).then(() => { setConvs((cs) => cs.filter((x) => x.id !== c.id)); if (c.id === currentId) setCurrentId(undefined); }).catch(guard);
    }
  };
  const collapsed = wide && rail;
  const drawerContent = (
    <Sidebar agents={agents} convs={convs} agentId={agent?.id} currentId={currentId} collapsed={collapsed} canCollapse={wide}
      onToggle={() => { setRail(!rail); save('sidebarCollapsed', !rail); }}
      onSelectAgent={(id) => { setNewAgent(id); setCurrentId(undefined); setSub(undefined); closeDrawer(); }}
      onSelectConv={(id) => { setCurrentId(id); closeDrawer(); }}
      onNew={() => { setCurrentId(undefined); closeDrawer(); }}
      onDelete={deleteConv} onSettings={() => setSettings(true)} />
  );
  const boot = (child: React.ReactNode) => <ThemeProvider theme={theme}><CssBaseline />{child}</ThemeProvider>;

  if (auth === 'loading') return boot(<Box sx={{ display: 'grid', placeItems: 'center', height: '100dvh' }}><CircularProgress color="primary" /></Box>);
  if (auth === 'out') return boot(<Login onDone={() => setAuth('in')} />);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: 'flex', height: '100dvh' }}>
        <Drawer variant={wide ? 'permanent' : 'temporary'} open={wide || drawer} onClose={() => setDrawer(false)}
          sx={{ width: wide ? (collapsed ? RAIL : DRAWER) : 0, flexShrink: 0, transition: 'width .2s', '& .MuiDrawer-paper': { width: wide ? 'auto' : DRAWER, borderWidth: '0 1px 0 0', borderStyle: 'solid' } }}>{drawerContent}</Drawer>
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <AppBar position="static" color="transparent" elevation={0}
            sx={{ border: 0, borderBottom: 1, borderColor: 'divider', backdropFilter: 'blur(12px)', bgcolor: (t) => alpha(t.palette.background.default, 0.8) }}>
            <Toolbar sx={{ gap: 1.5, minHeight: { xs: 56, md: 64 } }}>
              {!wide && <IconButton edge="start" onClick={() => setDrawer(true)} aria-label="Menu"><MenuIcon /></IconButton>}
              <Typography variant="subtitle1" noWrap sx={{ flex: 1 }}>{current?.title ?? 'Nouvelle conversation'}</Typography>
              {agent && (
                <Chip size="small" variant="outlined"
                  label={<Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><StatusDot status={agent.status} /><Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.name}</Box></Box>}
                  title={agent.status === 'connected' ? agent.type : agent.statusDetail ?? agent.status}
                  sx={{ height: 32, fontWeight: 600, maxWidth: { xs: 140, sm: 260 }, '& .MuiChip-label': { px: 1.5 } }} />)}
              {agent && <IconButton onClick={() => setInfo(true)} aria-label="Agents, skills et tâches"><Badge color="primary" variant="dot" invisible={!agent.capabilities.jobs}><InfoOutlined /></Badge></IconButton>}
            </Toolbar>
          </AppBar>
          <Box sx={{ flex: 1, minHeight: 0 }}>
            {agent ? (
              <Chat title={current?.title ?? ''} agentName={agent.name} messages={messages} running={running} expandTools={expandTools}
                canAbort={agent.capabilities.abort} attach={agent.capabilities.attachments} error={error} approval={approval}
                onApprove={(ok) => currentId && approval && api.approval(currentId, approval.id, ok).then(() => setApproval(undefined)).catch(guard)}
                onSend={send} onAbort={() => currentId && api.abort(currentId).catch(guard)} />
            ) : <Typography sx={{ p: 4 }} color="text.secondary">Aucun agent configuré.</Typography>}
          </Box>
        </Box>
        <Drawer anchor="right" open={info} onClose={() => setInfo(false)} sx={{ '& .MuiDrawer-paper': { width: 'min(420px, 100vw)' } }}>
          {agent && <AgentPanels agent={agent} sub={current?.subAgentId ?? sub} onSubChange={(s) => setSub(s)} />}
        </Drawer>
        <Dialog open={settings} onClose={() => setSettings(false)} fullWidth maxWidth="xs">
          <DialogTitle sx={{ fontWeight: 650 }}>Réglages</DialogTitle>
          <DialogContent sx={{ display: 'grid', gap: 2, pt: 1 }}>
            <Select size="small" value={themeMode} onChange={(e) => { const v = e.target.value as 'auto' | 'light' | 'dark'; setThemeMode(v); save('themeMode', v); }}>
              {(Object.keys(themeLabel) as Array<keyof typeof themeLabel>).map((k) => <MenuItem key={k} value={k}>Thème : {themeLabel[k]}</MenuItem>)}
            </Select>
            <FormControlLabel sx={{ mx: 0, p: 2, py: 0.5, border: 1, borderColor: 'divider', borderRadius: 3 }} control={<Switch checked={expandTools} onChange={(e) => { setExpandTools(e.target.checked); save('expandTools', e.target.checked); }} />} label="Déplier les outils par défaut" />
            <PushToggle />
            <PasswordForm />
          </DialogContent>
          <DialogActions>
            <Button color="error" onClick={() => api.logout().finally(() => { setAuth('out'); setCurrentId(undefined); })}>Se déconnecter</Button>
            <Button onClick={() => setSettings(false)}>Fermer</Button>
          </DialogActions>
        </Dialog>
      </Box>
    </ThemeProvider>
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
    <Box sx={{ p: 2, py: 1, border: 1, borderColor: 'divider', borderRadius: 3 }}>
      <FormControlLabel disabled={st === 'unsupported' || st === 'denied'} control={<Switch checked={st === 'on'} onChange={toggle} />} label="Notifications quand un agent répond" />
      {help && <Typography variant="caption" color="text.secondary" display="block">{help}</Typography>}
    </Box>
  );
}

function PasswordForm() {
  const [o, setO] = useState(''); const [n, setN] = useState(''); const [msg, setMsg] = useState('');
  return (
    <Box sx={{ display: 'grid', gap: 1, p: 2, border: 1, borderColor: 'divider', borderRadius: 3 }}>
      <Typography variant="subtitle2">Changer le mot de passe</Typography>
      <TextField size="small" type="password" label="Actuel" value={o} onChange={(e) => setO(e.target.value)} autoComplete="current-password" />
      <TextField size="small" type="password" label="Nouveau (8+ caractères)" value={n} onChange={(e) => setN(e.target.value)} autoComplete="new-password" />
      <Button disabled={!o || n.length < 8} onClick={() => api.changePassword(o, n).then(() => { setMsg('Mot de passe modifié'); setO(''); setN(''); }).catch((e) => setMsg((e as Error).message))}>Modifier</Button>
      {msg && <Typography variant="caption">{msg}</Typography>}
    </Box>
  );
}
