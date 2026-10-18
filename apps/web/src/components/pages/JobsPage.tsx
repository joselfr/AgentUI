import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Snackbar, Tooltip, Typography } from '@mui/material';
import Pause from '@mui/icons-material/Pause';
import PlayArrow from '@mui/icons-material/PlayArrow';
import Bolt from '@mui/icons-material/Bolt';
import Delete from '@mui/icons-material/Delete';
import Forum from '@mui/icons-material/Forum';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import type { AgentInfo, Job } from '@agentui/shared';
import { api } from '../../api';
import { useBackClose } from '../../useBackClose';
import { MONO } from '../../theme';
import { useConfirm } from '../Confirm';
import { card, useLoad, Page, Status, Pickers, useScope } from './shared';
import { fmtDateTime, t } from '../../i18n';

const RUN_TIMEOUT_MS = 15 * 60_000;
const timeOf = (ms: number) => fmtDateTime(ms, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const nextRun = (j: Job) => (j.nextRunAt && j.enabled ? ` · ${t('jobs.next', { date: fmtDateTime(j.nextRunAt) })}` : '');

/** Task status chip: pending / running / result of the last run. */
function RunState({ j, launched }: { j: Job; launched: boolean }) {
  if (j.running) return <Chip size="small" color="info" icon={<CircularProgress size={12} color="inherit" sx={{ ml: '6px !important' }} />} label={t('jobs.running')} />;
  if (j.queued || launched) return <Chip size="small" variant="outlined" color="warning" icon={<CircularProgress size={12} color="inherit" sx={{ ml: '6px !important' }} />} label={t('jobs.queued')} />;
  if (!j.lastStatus) return null;
  const ok = /^(ok|success|completed)$/i.test(j.lastStatus);
  const chip = <Chip size="small" variant="outlined" color={ok ? 'success' : 'error'} label={`${ok ? 'ok' : j.lastStatus}${j.lastRunAt ? ` · ${timeOf(j.lastRunAt)}` : ''}`} />;
  return j.lastError && !ok ? <Tooltip title={j.lastError}>{chip}</Tooltip> : chip;
}

/** Task detail popup: schedule, last run, executed script and prompt given to the agent. */
function JobDialog({ j, onClose }: { j?: Job; onClose: () => void }) {
  useBackClose(!!j, onClose);
  const field = (label: string, value: ReactNode) => (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>{label}</Typography>
      <Box sx={{ mt: 0.25 }}>{value}</Box>
    </Box>);
  const block = (text: string, mono: boolean) => (
    <Box sx={{ p: 1.25, borderRadius: '8px', bgcolor: 'action.hover', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, maxHeight: 360, overflow: 'auto', ...(mono ? { fontFamily: MONO } : {}) }}>{text}</Box>);
  return (
    <Dialog open={!!j} onClose={onClose} fullWidth maxWidth="sm">
      {j && (<>
        <DialogTitle sx={{ fontWeight: 650, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          {j.name}
          {j.mode && <Chip size="small" variant="outlined" label={j.mode} />}
          {!j.enabled && <Chip size="small" label={t('jobs.paused')} />}
        </DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 2 }}>
          {field(t('jobs.schedule'), <Typography variant="body2"><code style={{ fontFamily: MONO }}>{j.schedule}</code>{nextRun(j)}</Typography>)}
          {(j.lastStatus || j.running || j.queued) && field(t('jobs.lastRun'), <Box sx={{ display: 'grid', gap: 1, justifyItems: 'start' }}>
            <RunState j={j} launched={false} />
            {j.lastError && block(j.lastError, true)}
          </Box>)}
          {j.script && field(j.mode === 'script' ? t('jobs.script') : t('jobs.preScript'), block(j.script, true))}
          {j.prompt && field(t('jobs.prompt'), block(j.prompt, false))}
        </DialogContent>
        <DialogActions><Button onClick={onClose}>{t('common.close')}</Button></DialogActions>
      </>)}
    </Dialog>);
}

export function JobsPage({ agents, onOpenConversation }: { agents: AgentInfo[]; onOpenConversation: (id: string) => void }) {
  const { ask, dialog: confirmDialog } = useConfirm();
  const sc = useScope(agents, (a) => a.capabilities.jobs);
  const jobs = useLoad<Job[]>(() => (sc.agent ? api.jobs(sc.agent.id, sc.sub) : Promise.resolve([])), [sc.agent?.id, sc.sub]);
  // Runs launched from this page, tracked until they end (lastRunAt later than the launch).
  const [launched, setLaunched] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<{ text: string; ok: boolean; conversationId?: string }>();
  const [detail, setDetail] = useState<string>();
  const launchedRef = useRef(launched);
  launchedRef.current = launched;

  const act = async (j: Job, a: string) => {
    if (!sc.agent) return;
    try {
      await api.jobAction(sc.agent.id, j.id, a, sc.sub);
      if (a === 'run') setLaunched((l) => ({ ...l, [j.id]: Date.now() }));
    } catch (e) {
      setNotice({ text: (e as Error).message, ok: false });
    }
    jobs.reload();
  };

  const active = !!jobs.data?.some((j) => j.running || j.queued) || Object.keys(launched).length > 0;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      jobs.refresh().then((list) => {
        const now = Date.now();
        const done: Record<string, true> = {};
        for (const [id, at] of Object.entries(launchedRef.current)) {
          const j = list.find((x) => x.id === id);
          if (!j) { done[id] = true; continue; }
          if (!j.running && !j.queued && (j.lastRunAt ?? 0) >= at - 1000) {
            done[id] = true;
            const ok = !j.lastStatus || /^(ok|success|completed)$/i.test(j.lastStatus);
            setNotice({ text: ok ? t('jobs.finished', { name: j.name }) : j.lastError ? t('jobs.failedWith', { name: j.name, error: j.lastError }) : t('jobs.failed', { name: j.name }), ok, conversationId: j.conversationId });
          } else if (now - at > RUN_TIMEOUT_MS) {
            done[id] = true;
            setNotice({ text: t('jobs.timeout', { name: j.name }), ok: false, conversationId: j.conversationId });
          }
        }
        if (Object.keys(done).length) setLaunched((l) => Object.fromEntries(Object.entries(l).filter(([id]) => !done[id])));
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [active, jobs.refresh]);

  return (
    <Page title={t('jobs.title')} actions={<Pickers agents={sc.ok} agentId={sc.agent?.id} sub={sc.sub} onAgent={sc.setAgent} onSub={sc.setSub} subs={sc.subs} />}>
      <Status loading={jobs.loading} err={jobs.err} empty={!sc.agent || !jobs.data?.length} />
      <Box sx={{ display: 'grid', gap: 1 }}>
        {jobs.data?.map((j) => {
          const busy = !!(j.running || j.queued || launched[j.id]);
          return (
            <Box key={j.id} sx={card}>
              <Box onClick={() => setDetail(j.id)} sx={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>{j.name}</Typography>
                  {j.mode && <Chip size="small" variant="outlined" label={j.mode === 'script' ? t('jobs.modeScript') : t('jobs.modeAgent')} />}
                  {!j.enabled && <Chip size="small" label={t('jobs.paused')} />}
                  <RunState j={j} launched={!!launched[j.id]} />
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  <code style={{ fontFamily: MONO }}>{j.schedule}</code>{nextRun(j)}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', flexShrink: 0 }}>
                <Tooltip title={t('jobs.details')}><IconButton size="small" onClick={() => setDetail(j.id)}><InfoOutlined /></IconButton></Tooltip>
                {j.conversationId && (
                  <Tooltip title={t('jobs.results')}><IconButton size="small" onClick={() => onOpenConversation(j.conversationId!)}><Forum /></IconButton></Tooltip>)}
                {sc.agent?.capabilities.jobControl && (<>
                  <Tooltip title={j.enabled ? t('jobs.pause') : t('jobs.resume')}><IconButton size="small" onClick={() => act(j, j.enabled ? 'pause' : 'resume')}>{j.enabled ? <Pause /> : <PlayArrow />}</IconButton></Tooltip>
                  <Tooltip title={busy ? t('jobs.runBusy') : t('jobs.runNow')}><span><IconButton size="small" disabled={busy} onClick={() => act(j, 'run')}><Bolt /></IconButton></span></Tooltip>
                  <Tooltip title={t('common.delete')}><IconButton size="small" onClick={async () => { if (await ask({ title: t('jobs.deleteTitle'), text: t('jobs.deleteText', { name: j.name }), confirmLabel: t('common.delete'), danger: true })) act(j, 'delete'); }}><Delete /></IconButton></Tooltip>
                </>)}
              </Box>
            </Box>);
        })}
      </Box>
      {confirmDialog}
      <JobDialog j={jobs.data?.find((x) => x.id === detail)} onClose={() => setDetail(undefined)} />
      <Snackbar open={!!notice} autoHideDuration={notice?.conversationId ? 15000 : 6000} onClose={() => setNotice(undefined)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={notice?.ok ? 'success' : 'error'} variant="filled" onClose={() => setNotice(undefined)}
          action={notice?.conversationId ? <Button color="inherit" size="small" onClick={() => { onOpenConversation(notice.conversationId!); setNotice(undefined); }}>{t('jobs.seeResult')}</Button> : undefined}>
          {notice?.text}
        </Alert>
      </Snackbar>
    </Page>
  );
}
