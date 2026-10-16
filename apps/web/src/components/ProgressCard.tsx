import { Box, Typography } from '@mui/material';
import { alpha, keyframes } from '@mui/material/styles';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
interface Step { label: string; status: StepStatus; detail?: string }
interface Progress { title?: string; steps: Step[] }

const STATUSES: StepStatus[] = ['pending', 'running', 'done', 'failed', 'skipped'];
const MAX_STEPS = 20;
const FOLD_OVER = 8; // au-delà, les étapes terminées en tête de liste se replient en une ligne
const FOLD_MIN = 3;

/** Arguments du widget `progress` : `{ title?, steps: [{ label, status, detail? }] }` (+ `update`, propre à l'outil, ignoré ici). `undefined` si invalide. */
export function parseProgress(a: Record<string, unknown>): Progress | undefined {
  const { steps } = a as { steps?: unknown };
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) return undefined;
  const out: Step[] = [];
  for (const s of steps as Array<Record<string, unknown>>) {
    if (!s || typeof s.label !== 'string' || !STATUSES.includes(s.status as StepStatus)) return undefined;
    out.push({ label: s.label, status: s.status as StepStatus, ...(typeof s.detail === 'string' && s.detail ? { detail: s.detail } : {}) });
  }
  return { ...(typeof a.title === 'string' && a.title ? { title: a.title } : {}), steps: out };
}

const spin = keyframes`to { transform: rotate(360deg); }`;

type Shown = StepStatus | 'interrupted';

function Icon({ status }: { status: Shown }) {
  const base = { width: 18, height: 18, flex: 'none', mt: '1px', display: 'grid', placeItems: 'center', borderRadius: '50%', fontSize: 11, fontWeight: 700, border: 2, boxSizing: 'border-box' } as const;
  if (status === 'done') return <Box sx={{ ...base, bgcolor: 'success.main', borderColor: 'success.main', color: '#fff' }}>✓</Box>;
  if (status === 'failed') return <Box sx={{ ...base, bgcolor: 'error.main', borderColor: 'error.main', color: '#fff' }}>✕</Box>;
  if (status === 'interrupted') return <Box sx={{ ...base, borderColor: 'text.secondary', color: 'text.secondary', fontSize: 9 }}>■</Box>;
  if (status === 'running') {
    return <Box sx={{ ...base, borderColor: (t) => alpha(t.palette.secondary.main, 0.25), borderTopColor: 'secondary.main', animation: `${spin} 1s linear infinite`, '@media (prefers-reduced-motion: reduce)': { animation: 'none' } }} />;
  }
  return <Box sx={{ ...base, borderColor: (t) => alpha(t.palette.text.secondary, 0.55), borderStyle: status === 'skipped' ? 'dashed' : 'solid' }} />;
}

/** `ended` : le message est terminé (ou arrêté) : une étape encore en cours ou en attente n'a pas été mise à jour par l'agent, on la montre « interrompue ». */
export default function ProgressCard({ progress: p, ended = false }: { progress: Progress; ended?: boolean }) {
  const steps = p.steps.map((s) => (ended && (s.status === 'running' || s.status === 'pending') ? { ...s, shown: 'interrupted' as Shown } : { ...s, shown: s.status as Shown }));
  const counted = p.steps.filter((s) => s.status !== 'skipped');
  const done = counted.filter((s) => s.status === 'done').length;
  const failed = p.steps.some((s) => s.status === 'failed');
  const all = counted.length > 0 && done === counted.length;
  const barColor = all ? 'success.main' : failed ? 'error.main' : 'secondary.main';

  let lead = 0;
  if (steps.length > FOLD_OVER) while (lead < steps.length && (steps[lead]!.status === 'done' || steps[lead]!.status === 'skipped')) lead++;
  const folded = lead >= FOLD_MIN && lead < steps.length ? lead : 0;

  return (
    <Box sx={{ my: 1, p: 1.5, border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.default', minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.25 }}>
        <Typography sx={{ fontWeight: 600, flex: 1 }}>{p.title ?? 'Progression'}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{all ? '✓ Terminé' : `${done}/${counted.length}`}</Typography>
      </Box>
      <Box role="progressbar" aria-valuemin={0} aria-valuemax={counted.length} aria-valuenow={done} sx={{ height: 6, borderRadius: '3px', bgcolor: 'action.hover', overflow: 'hidden', my: 1 }}>
        <Box sx={{ height: '100%', width: `${counted.length ? (100 * done) / counted.length : 0}%`, bgcolor: barColor, borderRadius: '3px', transition: 'width .3s' }} />
      </Box>
      <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: '2px' }}>
        {folded > 0 && (
          <Box component="li" sx={{ display: 'flex', gap: 1.25, py: 0.5, alignItems: 'flex-start' }}>
            <Icon status="done" /><Typography sx={{ color: 'text.secondary' }}>{folded} étapes terminées</Typography>
          </Box>
        )}
        {steps.slice(folded).map((s, i) => (
          <Box component="li" key={folded + i} sx={{ display: 'flex', gap: 1.25, py: 0.5, alignItems: 'flex-start' }}>
            <Icon status={s.shown} />
            <Typography component="span" sx={{
              fontWeight: s.shown === 'running' ? 600 : 400,
              color: s.shown === 'failed' ? 'error.main' : s.shown === 'pending' || s.shown === 'skipped' || s.shown === 'interrupted' ? 'text.secondary' : 'text.primary',
              textDecoration: s.shown === 'skipped' ? 'line-through' : 'none',
            }}>
              {s.label}
              {(s.detail || s.shown === 'interrupted') && (
                <Typography component="span" variant="caption" sx={{ display: 'block', color: 'text.secondary', fontWeight: 400, textDecoration: 'none' }}>
                  {[s.detail, s.shown === 'interrupted' ? 'interrompu' : ''].filter(Boolean).join(' · ')}
                </Typography>
              )}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
