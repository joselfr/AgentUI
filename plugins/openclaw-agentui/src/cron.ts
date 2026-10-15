// Tâches cron OpenClaw exposées à AgentUI (page « Tâches »), via le planificateur que la gateway confie aux services.
type Json = Record<string, any>;

interface CronAccess {
  list: (opts?: { includeDisabled?: boolean }) => Promise<unknown[]>;
  update: (id: string, patch: any) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  enqueueRun?: (id: string, mode?: 'due' | 'force' | 'if-enabled') => Promise<unknown>;
}

let getCron: (() => CronAccess | undefined) | undefined;

/** Branché par le service « agentui-cron » au démarrage de la gateway (retiré à son arrêt). */
export function setCronAccess(getter: (() => CronAccess | undefined) | undefined): void {
  getCron = getter;
}

function cron(): CronAccess {
  const c = getCron?.();
  if (!c) throw new Error('planificateur OpenClaw indisponible');
  return c;
}

const scheduleLabel = (s: Json | undefined): string => {
  if (!s) return '';
  if (s.kind === 'cron') return s.tz ? `${s.expr} (${s.tz})` : String(s.expr);
  if (s.kind === 'every') {
    const m = Math.round(Number(s.everyMs) / 60000);
    return m >= 60 && m % 60 === 0 ? `toutes les ${m / 60} h` : `toutes les ${m} min`;
  }
  if (s.kind === 'at') return `le ${new Date(s.at ?? s.atMs).toLocaleString('fr-FR')}`;
  return JSON.stringify(s);
};

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Mode et détail d'un job selon son payload : prompt (agentTurn, systemEvent) ou script (command, script). */
const jobPayload = (j: Json) => {
  const p = j.payload ?? {};
  if (p.kind === 'command') return { mode: 'script', script: Array.isArray(p.argv) ? p.argv.join(' ') : undefined };
  if (p.kind === 'script') return { mode: 'script', script: text(p.script) };
  return { mode: 'agent', prompt: text(p.message) ?? text(p.text) ?? text(j.description) };
};

/** Même forme que l'adapter WebSocket opérateur (méthode cron.list). */
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

export async function jobAction(jobId: string, action: string): Promise<{ ok: true }> {
  const c = cron();
  if (action === 'delete') await c.remove(jobId);
  else if (action === 'pause' || action === 'resume') await c.update(jobId, { enabled: action === 'resume' });
  else if (action === 'run') {
    if (!c.enqueueRun) throw new Error('exécution immédiate non supportée par cette version d’OpenClaw');
    await c.enqueueRun(jobId, 'force');
  } else throw new Error(`action inconnue : ${action}`);
  return { ok: true };
}
