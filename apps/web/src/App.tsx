import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import { Box, CircularProgress, CssBaseline, Drawer, ThemeProvider, Typography, useMediaQuery } from '@mui/material';
import type { AgentInfo, Message, ModelOption, Usage, WidgetEvent } from '@agentui/shared';
import { api, UnauthorizedError, type Conversation } from './api';
import { makeTheme } from './theme';
import { applyEvent, awaitingReply } from './reducer';
import { useLive, type LiveEvent } from './useLive';
import { useConversationActions } from './useConversationActions';
import Login from './components/Login';
import { useConfirm } from './components/Confirm';
import { useBackClose } from './useBackClose';
import { load, save, usePersisted } from './storage';
import Sidebar, { DRAWER } from './components/Sidebar';
import NavRail, { NAV, type View } from './components/NavRail';
import Chat from './components/Chat';
import ChatHeader from './components/ChatHeader';
import { useSubAgents } from './useSubAgents';
import ModelChip from './components/ModelChip';
import NewConversation from './components/NewConversation';
import SettingsDialog, { type ThemeMode } from './components/SettingsDialog';
import { AgentsPage } from './components/pages/AgentsPage';
import { JobsPage } from './components/pages/JobsPage';
import { SkillsPage } from './components/pages/SkillsPage';
import { MiniappsPage } from './components/pages/MiniappsPage';
import MiniappView from './components/miniapps/MiniappView';
import { toOutgoing, type AttachmentView } from './attachments';
import { t, useLang } from './i18n';

export default function App() {
  useLang(); // re-renders the whole tree on language change: components call `t()` directly
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const [themeMode, setThemeMode] = usePersisted<ThemeMode>('themeMode', 'dark');
  const [expandTools, setExpandTools] = usePersisted<boolean>('expandTools', false);
  const theme = useMemo(() => makeTheme(themeMode === 'auto' ? (prefersDark ? 'dark' : 'light') : themeMode), [themeMode, prefersDark]);
  const wide = useMediaQuery(theme.breakpoints.up('md'));

  const [auth, setAuth] = useState<'loading' | 'out' | 'in'>('loading');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [convs, setConvs] = useState<Conversation[]>([]);
  // The route is the source of truth: `/` new conversation, `/c/:id` a chat, `/agents` `/skills` `/jobs` `/miniapps` (`/miniapps/:id` one miniapp) the other pages.
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const currentId = matchPath('/c/:id', pathname)?.params.id;
  const appId = matchPath('/miniapps/:id', pathname)?.params.id;
  const view: View = appId ? 'miniapps' : (['agents', 'skills', 'jobs', 'miniapps'] as const).find((v) => pathname === `/${v}`) ?? 'chats';
  const setCurrentId = useCallback((id: string | undefined, replace = false) => navigate(id ? `/c/${id}` : '/', { replace }), [navigate]);
  const chatPath = useRef('/'); // last Chats route, reopened when coming back from another page
  if (view === 'chats') chatPath.current = pathname;
  const [savedId] = useState(() => load<string | null>('currentId', null)); // chat open at the last visit, reopened if the app starts on `/`
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const msgCache = useRef(new Map<string, Message[]>()); // last known state of each conversation (shown offline)
  const createdRef = useRef<string>(); // conversation created by the send in progress: its optimistic messages are already displayed
  const [running, setRunning] = useState(false);
  const [approval, setApproval] = useState<{ id: string; description: string }>();
  const [error, setError] = useState<string>();
  const [drawer, setDrawer] = useState(false);
  useBackClose(!wide && drawer, () => setDrawer(false));
  const [listOpen, setListOpen] = useState(() => load<boolean>('listOpen', true));
  const [settings, setSettings] = useState(false);
  const [newDlg, setNewDlg] = useState(false);
  const [sub, setSub] = useState<string | undefined>(() => load<string | null>('newSub', null) ?? undefined);
  const [newAgent, setNewAgent] = useState<string | undefined>(() => load<string | null>('newAgent', null) ?? undefined);
  const [convsLoaded, setConvsLoaded] = useState(false);
  const [dataTick, setDataTick] = useState<{ appId: string; n: number }>({ appId: '', n: 0 }); // data of a miniapp changed
  const [appName, setAppName] = useState<string>(); // name of the open miniapp (reported by MiniappView)
  const [miniappsTick, setMiniappsTick] = useState(0); // bumped when a miniapp changes (refresh of the Miniapps pages)
  const currentRef = useRef<string>();
  currentRef.current = currentId;
  // "Read" = chat open, Chats page shown and tab visible; otherwise new messages stay unread.
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible');
  const viewing = view === 'chats' && pageVisible;
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  const openedRef = useRef<string>(); // chat whose "unread" marker was already computed for this opening
  const [unreadMark, setUnreadMark] = useState<{ id: string; count: number }>(); // first unread message at opening
  useEffect(() => {
    const onVis = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const current = convs.find((c) => c.id === currentId);
  const agent = agents.find((a) => a.id === (current?.agentId ?? newAgent));
  const subLabel = useSubAgents(agents);

  const onUnauth = useCallback(() => setAuth('out'), []);
  const { ask: askConfirm, dialog: confirmDialog } = useConfirm();
  const guard = useCallback((e: unknown) => { if (e instanceof UnauthorizedError) setAuth('out'); else setError((e as Error).message); }, []);

  const setConvUsage = useCallback((id: string, usage: Usage) => setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, usage } : c))), []);

  /** Refreshes the list; if the chat is being read, marks it read first (no "unread" flash). */
  const syncConvs = useCallback((id?: string) => {
    const refresh = () => api.conversations().then(setConvs).catch(() => {});
    if (id && id === currentRef.current && viewingRef.current) {
      setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, unread: false } : c)));
      api.markRead(id).catch(() => {}).finally(refresh);
    } else refresh();
  }, []);

  const refreshLists = useCallback(() => {
    api.agents().then(setAgents).catch(guard);
    return api.conversations().then((c) => { setConvs(c); setConvsLoaded(true); }).catch(guard);
  }, [guard]);

  const loadMessages = useCallback((id: string) => {
    api.messages(id).then((r) => {
      msgCache.current.set(id, r.messages);
      if (currentRef.current !== id) return;
      setMessages(r.messages);
      setRunning(r.conversation.running);
      setLoadingMsgs(false);
      if (openedRef.current !== id) { // first read of this opening: marker of the first unread message
        openedRef.current = id;
        const fresh = r.messages.filter((m) => m.role === 'assistant' && m.status !== 'streaming' && m.createdAt > r.conversation.lastReadAt);
        setUnreadMark(fresh.length ? { id: fresh[0]!.id, count: fresh.length } : undefined);
      }
      if (viewingRef.current && r.conversation.unread) syncConvs(id);
    }).catch((e) => { if (currentRef.current === id) { setLoadingMsgs(false); guard(e); } });
  }, [guard, syncConvs]);

  useEffect(() => { api.me().then((r) => setAuth(r.user ? 'in' : 'out')).catch(() => setAuth('out')); }, []);
  useEffect(() => { if (auth === 'in') refreshLists(); }, [auth, refreshLists]);
  // Notification link: the old `/?c=<id>` becomes `/c/<id>`, and the service worker asks to open a route in an already open window
  const restored = useRef(false);
  useEffect(() => {
    if (auth !== 'in') return;
    const legacy = new URLSearchParams(search).get('c');
    if (legacy) navigate(`/c/${legacy}`, { replace: true });
    else if (!restored.current && pathname === '/' && savedId) navigate(`/c/${savedId}`, { replace: true });
    restored.current = true;
  }, [auth, pathname, search, savedId, navigate]);
  // Unknown route: back to home
  useEffect(() => {
    if (auth === 'in' && !currentId && !appId && !['/', '/agents', '/skills', '/jobs', '/miniapps'].includes(pathname)) navigate('/', { replace: true });
  }, [auth, currentId, pathname, navigate]);
  useEffect(() => {
    if (auth !== 'in') return;
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type !== 'open-conversation') return;
      const u = new URL(e.data.url, location.origin);
      const id = u.searchParams.get('c');
      const to = id ? `/c/${id}` : u.pathname + u.search;
      // Refresh the list first: a chat created by a cron is not in it yet, and would be dropped as unknown
      void Promise.resolve(refreshLists()).then(() => navigate(to));
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, [auth, refreshLists, navigate]);
  useEffect(() => {
    if (agents.length && !agents.some((a) => a.id === newAgent)) setNewAgent(agents[0]!.id);
  }, [agents, newAgent]);
  // Tab title: `AgentUI - {conversation or miniapp}` when one is open
  const pageTitle = appId ? appName : view === 'chats' ? current?.title : undefined;
  useEffect(() => { document.title = pageTitle ? `AgentUI - ${pageTitle}` : 'AgentUI'; }, [pageTitle]);
  // Restore state on reload: page, open chat, agent of the next conversation
  useEffect(() => { save('listOpen', listOpen); }, [listOpen]);
  useEffect(() => { save('currentId', currentId ?? null); }, [currentId]);
  useEffect(() => { save('newAgent', newAgent ?? null); save('newSub', sub ?? null); }, [newAgent, sub]);
  useEffect(() => { if (convsLoaded && currentId && !convs.some((c) => c.id === currentId)) setCurrentId(undefined, true); }, [convsLoaded, convs, currentId, setCurrentId]);
  useEffect(() => {
    setApproval(undefined); setError(undefined);
    openedRef.current = undefined; setUnreadMark(undefined);
    if (auth !== 'in') return;
    // Never the previous conversation's messages: local cache or empty, while loading
    if (currentId && currentId === createdRef.current) { createdRef.current = undefined; openedRef.current = currentId; return; }
    setRunning(false);
    if (currentId) {
      setMessages(msgCache.current.get(currentId) ?? []); setLoadingMsgs(true); loadMessages(currentId);
      api.usage(currentId).then((u) => { if (u) setConvUsage(currentId, u); }).catch(() => {}); // model and cost even for an old chat
    }
    else { setMessages([]); setLoadingMsgs(false); }
  }, [auth, currentId, loadMessages, setConvUsage]);

  // Back on the Chats page / tab: what arrived in the meantime is flagged as unread, then marked read
  const wasViewing = useRef(viewing);
  useEffect(() => {
    if (viewing && !wasViewing.current && currentId && auth === 'in') { openedRef.current = undefined; loadMessages(currentId); }
    wasViewing.current = viewing;
  }, [viewing, currentId, auth, loadMessages]);

  const onEvent = useCallback((e: LiveEvent) => {
    if (e.event.type === 'usage') { setConvUsage(e.sessionId, e.event.usage); return; } // session consumption: not a message
    if (e.event.type === 'message.added') { // proactive message (cron, spontaneous send): outside any run
      syncConvs(e.sessionId);
      if (e.sessionId === currentRef.current) loadMessages(e.sessionId);
      return;
    }
    if (e.event.type === 'approval.request' && e.sessionId === currentRef.current) setApproval({ id: e.event.id, description: e.event.description });
    const terminal = ['run.completed', 'run.failed', 'run.aborted'].includes(e.event.type);
    if (terminal) { setApproval(undefined); syncConvs(e.sessionId); }
    if (e.sessionId !== currentRef.current) return;
    if (e.event.type === 'subagent.sync' || e.event.type === 'attachment.added') { loadMessages(e.sessionId); return; } // out-of-stream update (tracked sub-agent, late media): no run in progress
    if (terminal) setRunning(false);
    setMessages((prev) => {
      const next = applyEvent(prev, e.event);
      if (next === null) { loadMessages(e.sessionId); return prev; } // run started from another device
      return next;
    });
    if (!terminal) setRunning(true);
  }, [loadMessages, syncConvs, setConvUsage]);

  useLive({
    enabled: auth === 'in',
    onEvent,
    onStatus: (id, status, detail) => setAgents((as) => as.map((a) => (a.id === id ? { ...a, status, statusDetail: detail } : a))),
    onMiniappChanged: () => setMiniappsTick((n) => n + 1),
    onMiniappData: (appId) => setDataTick((d) => ({ appId, n: d.n + 1 })),
    onRenamed: (id, title) => setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, title } : c))),
    onRead: (id) => setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, unread: false } : c))),
    onOpen: () => { refreshLists(); if (currentRef.current) loadMessages(currentRef.current); },
    onUnauthorized: onUnauth,
  });

  const send = async (text: string, files: File[], widget?: WidgetEvent): Promise<boolean> => {
    setError(undefined);
    let optimistic = false;
    try {
      let id = currentId;
      if (!id) {
        if (!newAgent) return false;
        const c = await api.createConversation(newAgent, sub);
        setConvs((cs) => [c, ...cs]);
        currentRef.current = createdRef.current = id = c.id;
        setCurrentId(id, true);
      }
      const answering = running && awaitingReply(messages); // reply to an agent question: the current run continues
      const attachments = await toOutgoing(files);
      const views: AttachmentView[] = files.map((f, i) => ({ id: `local-${Date.now()}-${i}`, name: f.name, mimeType: f.type, size: f.size, url: URL.createObjectURL(f) }));
      setMessages((m) => [...m,
        { id: `local-${Date.now()}`, role: 'user', text, ...(widget ? { hidden: true } : {}), attachments: views, createdAt: Date.now(), status: 'done' },
        ...(answering ? [] : [{ id: `local-a-${Date.now()}`, role: 'assistant' as const, text: '', createdAt: Date.now(), status: 'streaming' as const }])]);
      optimistic = true;
      setRunning(true);
      await api.send(id, text, attachments, widget);
      return true;
    } catch (e) {
      setRunning(false);
      guard(e);
      if (optimistic && currentRef.current) loadMessages(currentRef.current);
      return false;
    }
  };

  const agentId = agent?.id;
  const loadModels = useCallback(() => api.models(agentId!), [agentId]);
  /** Changes the model of the open chat; without a chat, creates an empty one to attach the choice to. */
  const pickModel = async (o: ModelOption) => {
    let id = currentId;
    if (!id) {
      if (!newAgent) throw new Error(t('common.noAgentError'));
      const c = await api.createConversation(newAgent, sub);
      setConvs((cs) => [c, ...cs]);
      currentRef.current = createdRef.current = id = c.id;
      setCurrentId(id, true);
    }
    const r = await api.setModel(id, o.id, o.provider);
    setConvUsage(id, r.usage ?? { inputTokens: 0, outputTokens: 0, model: r.model, provider: r.provider });
  };
  const closeDrawer = () => { if (!wide) setDrawer(false); };
  const { toggleFavorite, renameConv, archiveConv, archiveMany, deleteConv, deleteMany } = useConversationActions({ setConvs, setCurrentId, currentRef, guard, ask: askConfirm });
  // On mobile, the navigation bar lives in the chats drawer: closing the list frees the full width.
  // The chat being read is never "unread" on screen (the server-side marking follows)
  const shownConvs = useMemo(() => convs.map((c) => (c.unread && viewing && c.id === currentId ? { ...c, unread: false } : c)), [convs, viewing, currentId]);
  const unreadCount = shownConvs.filter((c) => c.unread && !c.archived).length;
  const nav = <NavRail unread={unreadCount} view={view} onView={(v) => { navigate(v === 'chats' ? chatPath.current : `/${v}`, { replace: !wide && drawer && v !== 'chats' }); if (v === 'chats') setDrawer(true); else closeDrawer(); }} onSettings={() => { setSettings(true); closeDrawer(); }} settingsOpen={settings} />;
  const sidebar = (
    <Sidebar agents={agents} subLabel={subLabel} convs={shownConvs} currentId={currentId}
      onSelectConv={(id) => { setCurrentId(id, !wide && drawer); closeDrawer(); }}
      onNew={() => { setNewDlg(true); closeDrawer(); }}
      onDelete={deleteConv} onArchive={archiveConv} onArchiveMany={archiveMany} onDeleteMany={deleteMany} onToggleFavorite={toggleFavorite} onRename={renameConv} onClose={() => (wide ? setListOpen(false) : setDrawer(false))} />
  );
  const drawerContent = wide ? sidebar : <Box sx={{ display: 'flex', height: '100%' }}>{nav}<Box sx={{ flex: 1, minWidth: 0 }}>{sidebar}</Box></Box>;
  const boot = (child: React.ReactNode) => <ThemeProvider theme={theme}><CssBaseline />{child}</ThemeProvider>;

  if (auth === 'loading') return boot(<Box sx={{ display: 'grid', placeItems: 'center', height: 'var(--app-height, 100dvh)' }}><CircularProgress color="primary" /></Box>);
  if (auth === 'out') return boot(<Login onDone={() => setAuth('in')} />);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: 'flex', height: 'var(--app-height, 100dvh)' }}>
        {(wide || (view !== 'chats' && !appId)) && nav}
        {view === 'chats' && (!wide || listOpen) && (
          <Drawer variant={wide ? 'permanent' : 'temporary'} open={wide || drawer} onClose={() => setDrawer(false)}
            sx={{ width: wide ? DRAWER : 0, flexShrink: 0, '& .MuiDrawer-paper': { width: wide ? DRAWER : `min(${NAV + DRAWER}px, 90vw)`, overflowX: 'hidden', position: wide ? 'relative' : 'fixed', borderWidth: '0 1px 0 0', borderStyle: 'solid' } }}>{drawerContent}</Drawer>)}
        {view === 'chats' ? (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <ChatHeader title={current?.title ?? t('chat.new')} agent={agent} sub={current ? subLabel(current.agentId, current.subAgentId) : subLabel(newAgent ?? '', sub)} showListButton={!wide || !listOpen} onShowList={() => (wide ? setListOpen(true) : setDrawer(true))} />
          <Box sx={{ flex: 1, minHeight: 0 }}>
            {agent ? (
              <Chat title={current?.title ?? ''} agentName={agent.name} messages={messages} loading={loadingMsgs} isNew={!currentId} running={running} awaiting={running && awaitingReply(messages)} expandTools={expandTools}
                modelPicker={<ModelChip key={agent.id} usage={current?.usage} canPick={!!agent.capabilities.models} disabled={running} load={loadModels} onPick={pickModel} />}
                unreadMark={unreadMark} canAbort={agent.capabilities.abort} attach={agent.capabilities.attachments} error={error} approval={approval}
                onApprove={(ok) => currentId && approval && api.approval(currentId, approval.id, ok).then(() => setApproval(undefined)).catch(guard)}
                onSend={send} onAbort={() => currentId && api.abort(currentId).catch(guard)} />
            ) : <Typography sx={{ p: 4 }} color="text.secondary">{t('common.noAgent')}</Typography>}
          </Box>
        </Box>
        ) : (
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {view === 'agents' && <AgentsPage agents={agents} onStart={(id, s) => { setNewAgent(id); setSub(s); navigate('/'); }} />}
            {view === 'skills' && <SkillsPage agents={agents} />}
            {view === 'miniapps' && (appId ? <MiniappView key={appId} id={appId} refreshKey={miniappsTick} dataKey={dataTick.appId === appId ? dataTick.n : 0} onBack={() => navigate('/miniapps')} onName={setAppName} onOpenJobs={() => navigate('/jobs')} /> : <MiniappsPage agents={agents} refreshKey={miniappsTick} onOpen={(id) => navigate(`/miniapps/${id}`)} />)}
            {view === 'jobs' && <JobsPage agents={agents} onOpenConversation={(id) => navigate(`/c/${id}`)} onOpenMiniapp={(id) => navigate(`/miniapps/${id}`)} />}
          </Box>)}
        <NewConversation open={newDlg} agents={agents} agentId={newAgent} sub={sub} onClose={() => setNewDlg(false)}
          onStart={(id, s) => { setNewAgent(id); setSub(s); setCurrentId(undefined); setNewDlg(false); }} />
        {confirmDialog}
        <SettingsDialog open={settings} onClose={() => setSettings(false)} onLogout={() => api.logout().finally(() => { setAuth('out'); setCurrentId(undefined); })}
          themeMode={themeMode} onThemeMode={setThemeMode} expandTools={expandTools} onExpandTools={setExpandTools} />
      </Box>
    </ThemeProvider>
  );
}
