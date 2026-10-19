// OpenClaw cron tasks exposed to AgentUI ("Tasks" page), via the scheduler the gateway hands to services.
type Json = Record<string, any>;

interface CronAccess {
  list: (opts?: { includeDisabled?: boolean }) => Promise<unknown[]>;
  update: (id: string, patch: any) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  enqueueRun?: (id: string, mode?: 'due' | 'force' | 'if-enabled') => Promise<unknown>;
}

let getCron: (() => CronAccess | undefined) | undefined;

/** Wired by the "agentui-cron" service at gateway start (removed when it stops). */
export function setCronAccess(getter: (() => CronAccess | undefined) | undefined): void {
  getCron = getter;
}

function cron(): CronAccess {
  const c = getCron?.();
  if (!c) throw new Error('OpenClaw scheduler unavailable');
  return c;
}

const scheduleLabel = (s: Json | undefined): string => {
  if (!s) return '';
  if (s.kind === 'cron') return s.tz ? `${s.expr} (${s.tz})` : String(s.expr);
  if (s.kind === 'every') {
    const m = Math.round(Number(s.everyMs) / 60000);
    return m >= 60 && m % 60 === 0 ? `every ${m / 60} h` : `every ${m} min`;
  }
  if (s.kind === 'at') return `on ${new Date(s.at ?? s.atMs).toLocaleString('en-US')}`;
  return JSON.stringify(s);
};

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Mode and detail of a job according to its payload: prompt (agentTurn, systemEvent) or script (command, script). */
const jobPayload = (j: Json) => {
  const p = j.payload ?? {};
  if (p.kind === 'command') return { mode: 'script', script: Array.isArray(p.argv) ? p.argv.join(' ') : undefined };
  if (p.kind === 'script') return { mode: 'script', script: text(p.script) };
  return { mode: 'agent', prompt: text(p.message) ?? text(p.text) ?? text(j.description) };
};

/** Same shape as the operator WebSocket adapter (cron.list method). */
export async function listJobs(subAgentId?: string) {
  const jobs = (await cron().list({ includeDisabled: true })) as Json[];
  return jobs
    .filter((j) => !subAgentId || !(j.agentId ?? j.owner?.agentId) || (j.agentId ?? j.owner?.agentId) === subAgentId)
    .map((j) => ({
      id: String(j.id),
      name: String(j.displayName ?? j.name ?? j.id),
      schedule: scheduleLabel(j.schedule),
      ...jobPayload(j),
      enabled: !!j.enabled,
      nextRunAt: j.state?.nextRunAtMs ?? j.nextRunAtMs,
      lastRunAt: j.state?.lastRunAtMs ?? j.lastRunAtMs,
      lastStatus: j.state?.lastStatus ?? j.lastRunStatus,
      running: typeof j.state?.runningAtMs === 'number',
      queued: typeof j.state?.queuedAtMs === 'number' && typeof j.state?.runningAtMs !== 'number',
      lastError: typeof j.state?.lastError === 'string' ? j.state.lastError : undefined,
      deliverTo: j.delivery?.channel === 'agentui' && typeof j.delivery?.to === 'string' ? j.delivery.to : undefined,
    }));
}

/** Source of the script of a task: the inline `script` payload, or the command line of a `command` payload. */
export async function readJobScript(jobId: string): Promise<{ name: string; content: string }> {
  const job = ((await cron().list({ includeDisabled: true })) as Json[]).find((j) => String(j.id) === jobId);
  if (!job) throw new Error(`task not found: ${jobId}`);
  const p = job.payload ?? {};
  const content = p.kind === 'command' && Array.isArray(p.argv) ? p.argv.join(' ') : text(p.script);
  if (!content) throw new Error('this task has no script');
  return { name: String(job.displayName ?? job.name ?? job.id), content };
}

export async function jobAction(jobId: string, action: string): Promise<{ ok: true }> {
  const c = cron();
  if (action === 'delete') await c.remove(jobId);
  else if (action === 'pause' || action === 'resume') await c.update(jobId, { enabled: action === 'resume' });
  else if (action === 'run') {
    if (!c.enqueueRun) throw new Error('immediate execution not supported by this OpenClaw version');
    await c.enqueueRun(jobId, 'force');
  } else throw new Error(`unknown action: ${action}`);
  return { ok: true };
}
