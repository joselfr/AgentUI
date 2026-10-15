import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppBar, Box, Button, Chip, CircularProgress, CssBaseline, Dialog, DialogActions, DialogContent, DialogTitle, Drawer, FormControlLabel,
  IconButton, MenuItem, Select, Switch, TextField, ThemeProvider, Toolbar, Typography, useMediaQuery,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import MenuIcon from '@mui/icons-material/Menu';
import SystemUpdateAlt from '@mui/icons-material/SystemUpdateAlt';
import type { AgentInfo, Message } from '@agentui/shared';
import { api, UnauthorizedError, type Conversation } from './api';
import { makeTheme } from './theme';
import { applyEvent } from './reducer';
import { useLive, type LiveEvent } from './useLive';
import Login from './components/Login';
import Sidebar, { DRAWER, StatusDot } from './components/Sidebar';
import NavRail, { NAV, type View } from './components/NavRail';
import Chat from './components/Chat';
import NewConversation from './components/NewConversation';
import { AgentsPage, JobsPage, SkillsPage } from './components/Pages';
import { toOutgoing, type AttachmentView } from './attachments';
import { forceUpdate } from './pwa';
import { disablePush, enablePush, pushState, type PushState } from './push';

const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v === null ? d : (JSON.parse(v) as T); } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignoré */ } };

export default function App() {
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const [themeMode, setThemeMode] = useState<'auto' | 'light' | 'dark'>(() => load('themeMode', 'dark'));
  const [askUser, setAskUser] = useState<boolean>(() => load('askUser', true));
  const [expandTools, setExpandTools] = useState<boolean>(() => load('expandTools', false));
  const theme = useMemo(() => makeTheme(themeMode === 'auto' ? (prefersDark ? 'dark' : 'light') : themeMode), [themeMode, prefersDark]);
  const wide = useMediaQuery(theme.breakpoints.up('md'));

  const [auth, setAuth] = useState<'loading' | 'out' | 'in'>('loading');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string | undefined>(() => load<string | null>('currentId', null) ?? undefined);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const msgCache = useRef(new Map<string, Message[]>()); // dernier état connu de chaque conversation (affiché hors ligne)
  const createdRef = useRef<string>(); // conversation créée par l'envoi en cours : ses messages optimistes sont déjà affichés
  const [running, setRunning] = useState(false);
  const [approval, setApproval] = useState<{ id: string; description: string }>();
  const [error, setError] = useState<string>();
  const [drawer, setDrawer] = useState(false);
  const [listOpen, setListOpen] = useState(() => load<boolean>('listOpen', true));
  const [view, setView] = useState<View>(() => load<View>('view', 'chats'));
  const [settings, setSettings] = useState(false);
  const [newDlg, setNewDlg] = useState(false);
  const [sub, setSub] = useState<string | undefined>(() => load<string | null>('newSub', null) ?? undefined);
  const [newAgent, setNewAgent] = useState<string | undefined>(() => load<string | null>('newAgent', null) ?? undefined);
  const [convsLoaded, setConvsLoaded] = useState(false);
  const currentRef = useRef<string>();
  currentRef.current = currentId;
  // « Lu » = discussion ouverte, page Discussions affichée et onglet visible ; sinon les nouveaux messages restent non lus.
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible');
  const viewing = view === 'chats' && pageVisible;
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  const openedRef = useRef<string>(); // discussion dont le repère « non lus » a déjà été calculé pour cette ouverture
  const [unreadMark, setUnreadMark] = useState<{ id: string; count: number }>(); // premier message non lu à l'ouverture
  useEffect(() => {
    const onVis = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const current = convs.find((c) => c.id === currentId);
  const agent = agents.find((a) => a.id === (current?.agentId ?? newAgent));

  const onUnauth = useCallback(() => setAuth('out'), []);
  const guard = useCallback((e: unknown) => { if (e instanceof UnauthorizedError) setAuth('out'); else setError((e as Error).message); }, []);

  /** Rafraîchit la liste ; si la discussion est en cours de lecture, la marque lue d'abord (pas de flash « non lu »). */
  const syncConvs = useCallback((id?: string) => {
    const refresh = () => api.conversations().then(setConvs).catch(() => {});
    if (id && id === currentRef.current && viewingRef.current) {
      setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, unread: false } : c)));
      api.markRead(id).catch(() => {}).finally(refresh);
    } else refresh();
  }, []);

  const refreshLists = useCallback(() => {
    api.agents().then(setAgents).catch(guard);
    api.conversations().then((c) => { setConvs(c); setConvsLoaded(true); }).catch(guard);
  }, [guard]);

  const loadMessages = useCallback((id: string) => {
    api.messages(id).then((r) => {
      msgCache.current.set(id, r.messages);
      if (currentRef.current !== id) return;
      setMessages(r.messages);
      setRunning(r.conversation.running);
      setLoadingMsgs(false);
      if (openedRef.current !== id) { // première lecture de cette ouverture : repère du premier message non lu
        openedRef.current = id;
        const fresh = r.messages.filter((m) => m.role === 'assistant' && m.status !== 'streaming' && m.createdAt > r.conversation.lastReadAt);
        setUnreadMark(fresh.length ? { id: fresh[0]!.id, count: fresh.length } : undefined);
      }
      if (viewingRef.current && r.conversation.unread) syncConvs(id);
    }).catch((e) => { if (currentRef.current === id) { setLoadingMsgs(false); guard(e); } });
  }, [guard, syncConvs]);

  useEffect(() => { api.me().then((r) => setAuth(r.user ? 'in' : 'out')).catch(() => setAuth('out')); }, []);
  useEffect(() => { if (auth === 'in') refreshLists(); }, [auth, refreshLists]);
  // Ouverture d'une conversation depuis une notification (?c=<id> ou message du service worker)
  useEffect(() => {
    if (auth !== 'in') return;
    const open = (url: string) => { const id = new URL(url, location.origin).searchParams.get('c'); if (id) { setCurrentId(id); setView('chats'); history.replaceState(null, '', '/'); } };
    open(location.href);
    const onMsg = (e: MessageEvent) => { if (e.data?.type === 'open-conversation') { open(e.data.url); refreshLists(); } };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, [auth, refreshLists]);
  useEffect(() => {
    if (agents.length && !agents.some((a) => a.id === newAgent)) setNewAgent(agents[0]!.id);
  }, [agents, newAgent]);
  // Reprise de l'état au rechargement : page, conversation ouverte, agent de la prochaine conversation
  useEffect(() => { save('view', view); }, [view]);
  useEffect(() => { save('listOpen', listOpen); }, [listOpen]);
  useEffect(() => { save('currentId', currentId ?? null); }, [currentId]);
  useEffect(() => { save('newAgent', newAgent ?? null); save('newSub', sub ?? null); }, [newAgent, sub]);
  useEffect(() => { if (convsLoaded && currentId && !convs.some((c) => c.id === currentId)) setCurrentId(undefined); }, [convsLoaded, convs, currentId]);
  useEffect(() => {
    setApproval(undefined); setError(undefined);
    openedRef.current = undefined; setUnreadMark(undefined);
    if (auth !== 'in') return;
    // Jamais les messages de la conversation précédente : cache local ou vide, le temps du chargement
    if (currentId && currentId === createdRef.current) { createdRef.current = undefined; openedRef.current = currentId; return; }
    setRunning(false);
    if (currentId) { setMessages(msgCache.current.get(currentId) ?? []); setLoadingMsgs(true); loadMessages(currentId); }
    else { setMessages([]); setLoadingMsgs(false); }
  }, [auth, currentId, loadMessages]);

  // Retour sur la page Discussions / l'onglet : ce qui est arrivé entre-temps est repéré comme non lu, puis marqué lu
  const wasViewing = useRef(viewing);
  useEffect(() => {
    if (viewing && !wasViewing.current && currentId && auth === 'in') { openedRef.current = undefined; loadMessages(currentId); }
    wasViewing.current = viewing;
  }, [viewing, currentId, auth, loadMessages]);

  const onEvent = useCallback((e: LiveEvent) => {
    if (e.event.type === 'message.added') { // message proactif (cron, envoi spontané) : hors de tout run
      syncConvs(e.sessionId);
      if (e.sessionId === currentRef.current) loadMessages(e.sessionId);
      return;
    }
    if (e.event.type === 'approval.request' && e.sessionId === currentRef.current) setApproval({ id: e.event.id, description: e.event.description });
    const terminal = ['run.completed', 'run.failed', 'run.aborted'].includes(e.event.type);
    if (terminal) { setApproval(undefined); syncConvs(e.sessionId); }
    if (e.sessionId !== currentRef.current) return;
    if (e.event.type === 'subagent.sync' || e.event.type === 'attachment.added') { loadMessages(e.sessionId); return; } // mise à jour hors flux (sous-agent suivi, média tardif) : pas de run en cours
    if (terminal) setRunning(false);
    setMessages((prev) => {
      const next = applyEvent(prev, e.event);
      if (next === null) { loadMessages(e.sessionId); return prev; } // run lancé depuis un autre appareil
      return next;
    });
    if (!terminal) setRunning(true);
  }, [loadMessages, syncConvs]);

  useLive({
    enabled: auth === 'in',
    onEvent,
    onStatus: (id, status, detail) => setAgents((as) => as.map((a) => (a.id === id ? { ...a, status, statusDetail: detail } : a))),
    onRead: (id) => setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, unread: false } : c))),
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
        currentRef.current = createdRef.current = id = c.id;
        setCurrentId(id);
      }
      const attachments = await toOutgoing(files);
      const views: AttachmentView[] = files.map((f, i) => ({ id: `local-${Date.now()}-${i}`, name: f.name, mimeType: f.type, size: f.size, url: URL.createObjectURL(f) }));
      setMessages((m) => [...m,
        { id: `local-${Date.now()}`, role: 'user', text, attachments: views, createdAt: Date.now(), status: 'done' },
        { id: `local-a-${Date.now()}`, role: 'assistant', text: '', createdAt: Date.now(), status: 'streaming' }]);
      optimistic = true;
      setRunning(true);
      await api.send(id, text, attachments, askUser);
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
  // Sur mobile, la barre de navigation vit dans le tiroir des discussions : fermer la liste libère toute la largeur.
  // La discussion qu'on est en train de lire n'est jamais « non lue » à l'écran (le marquage côté serveur suit)
  const shownConvs = useMemo(() => convs.map((c) => (c.unread && viewing && c.id === currentId ? { ...c, unread: false } : c)), [convs, viewing, currentId]);
  const unreadCount = shownConvs.filter((c) => c.unread).length;
  const nav = <NavRail unread={unreadCount} view={view} onView={(v) => { setView(v); if (v === 'chats') setDrawer(true); else closeDrawer(); }} onSettings={() => { setSettings(true); closeDrawer(); }} settingsOpen={settings} />;
  const sidebar = (
    <Sidebar agents={agents} convs={shownConvs} currentId={currentId}
      onSelectConv={(id) => { setCurrentId(id); closeDrawer(); }}
      onNew={() => { setNewDlg(true); closeDrawer(); }}
      onDelete={deleteConv} onClose={() => (wide ? setListOpen(false) : setDrawer(false))} />
  );
  const drawerContent = wide ? sidebar : <Box sx={{ display: 'flex', height: '100%' }}>{nav}<Box sx={{ flex: 1, minWidth: 0 }}>{sidebar}</Box></Box>;
  const boot = (child: React.ReactNode) => <ThemeProvider theme={theme}><CssBaseline />{child}</ThemeProvider>;

  if (auth === 'loading') return boot(<Box sx={{ display: 'grid', placeItems: 'center', height: 'var(--app-height, 100dvh)' }}><CircularProgress color="primary" /></Box>);
  if (auth === 'out') return boot(<Login onDone={() => setAuth('in')} />);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: 'flex', height: 'var(--app-height, 100dvh)' }}>
        {(wide || view !== 'chats') && nav}
        {view === 'chats' && (!wide || listOpen) && (
          <Drawer variant={wide ? 'permanent' : 'temporary'} open={wide || drawer} onClose={() => setDrawer(false)}
            sx={{ width: wide ? DRAWER : 0, flexShrink: 0, '& .MuiDrawer-paper': { width: wide ? DRAWER : `min(${NAV + DRAWER}px, 90vw)`, overflowX: 'hidden', position: wide ? 'relative' : 'fixed', borderWidth: '0 1px 0 0', borderStyle: 'solid' } }}>{drawerContent}</Drawer>)}
        {view === 'chats' ? (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <AppBar position="static" color="transparent" elevation={0}
            sx={{ border: 0, borderBottom: 1, borderColor: 'divider', backdropFilter: 'blur(12px)', bgcolor: (t) => alpha(t.palette.background.default, 0.8) }}>
            <Toolbar sx={{ gap: 1.5, minHeight: { xs: 56, md: 64 } }}>
              {(!wide || !listOpen) && <IconButton edge="start" onClick={() => (wide ? setListOpen(true) : setDrawer(true))} aria-label="Afficher les discussions" title="Afficher les discussions"><MenuIcon /></IconButton>}
              <Typography variant="subtitle1" noWrap sx={{ flex: 1 }}>{current?.title ?? 'Nouvelle conversation'}</Typography>
              {agent && (
                <Chip size="small" variant="outlined"
                  label={<Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><StatusDot status={agent.status} /><Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.name}</Box></Box>}
                  title={agent.status === 'connected' ? agent.type : agent.statusDetail ?? agent.status}
                  sx={{ height: 32, fontWeight: 600, maxWidth: { xs: 140, sm: 260 }, '& .MuiChip-label': { px: 1.5 } }} />)}
            </Toolbar>
          </AppBar>
          <Box sx={{ flex: 1, minHeight: 0 }}>
            {agent ? (
              <Chat title={current?.title ?? ''} agentName={agent.name} messages={messages} loading={loadingMsgs} isNew={!currentId} running={running} expandTools={expandTools}
                unreadMark={unreadMark} canAbort={agent.capabilities.abort} attach={agent.capabilities.attachments} error={error} approval={approval}
                onApprove={(ok) => currentId && approval && api.approval(currentId, approval.id, ok).then(() => setApproval(undefined)).catch(guard)}
                onSend={send} onAbort={() => currentId && api.abort(currentId).catch(guard)} />
            ) : <Typography sx={{ p: 4 }} color="text.secondary">Aucun agent configuré.</Typography>}
          </Box>
        </Box>
        ) : (
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {view === 'agents' && <AgentsPage agents={agents} onStart={(id, s) => { setNewAgent(id); setSub(s); setCurrentId(undefined); setView('chats'); }} />}
            {view === 'skills' && <SkillsPage agents={agents} />}
            {view === 'jobs' && <JobsPage agents={agents} onOpenConversation={(id) => { setCurrentId(id); setView('chats'); }} />}
          </Box>)}
        <NewConversation open={newDlg} agents={agents} agentId={newAgent} sub={sub} onClose={() => setNewDlg(false)}
          onStart={(id, s) => { setNewAgent(id); setSub(s); setCurrentId(undefined); setNewDlg(false); }} />
        <Dialog open={settings} onClose={() => setSettings(false)} fullWidth maxWidth="xs">
          <DialogTitle sx={{ fontWeight: 650 }}>Réglages</DialogTitle>
          <DialogContent sx={{ display: 'grid', gap: 2, pt: 1 }}>
            <Select size="small" value={themeMode} onChange={(e) => { const v = e.target.value as 'auto' | 'light' | 'dark'; setThemeMode(v); save('themeMode', v); }}>
              {(Object.keys(themeLabel) as Array<keyof typeof themeLabel>).map((k) => <MenuItem key={k} value={k}>Thème : {themeLabel[k]}</MenuItem>)}
            </Select>
            <FormControlLabel sx={{ mx: 0, p: 2, py: 0.5, border: 1, borderColor: 'divider', borderRadius: 3 }} control={<Switch checked={expandTools} onChange={(e) => { setExpandTools(e.target.checked); save('expandTools', e.target.checked); }} />} label="Déplier les outils par défaut" />
            <FormControlLabel sx={{ mx: 0, p: 2, py: 0.5, border: 1, borderColor: 'divider', borderRadius: 3 }} control={<Switch checked={askUser} onChange={(e) => { setAskUser(e.target.checked); save('askUser', e.target.checked); }} />} label="Questions interactives de l'agent (bloc ask)" />
            <PushToggle />
            <UpdateButton />
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
