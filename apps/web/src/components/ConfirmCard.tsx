import { Box, Button, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import HelpOutline from '@mui/icons-material/HelpOutline';
import Markdown from './Markdown';
import { t } from '../i18n';

export interface Parsed { title: string; text: string; danger: boolean; yes: string; no: string }

/** Arguments of the `confirm` widget: `{ title, text?, danger?, yes?, no? }`. */
export function parseConfirm(j: Record<string, unknown>): Parsed | undefined {
  if (typeof j.title !== 'string') return undefined;
  const s = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v : d);
  return { title: j.title, text: s(j.text, ''), danger: j.danger === true, yes: s(j.yes, t('common.confirm')), no: s(j.no, t('common.cancel')) };
}

/** `answer`: answer already sent (label of the chosen button), `onAnswer` absent: request can no longer be answered. */
export default function ConfirmCard({ confirm: { title, text, danger, yes, no }, answer, onAnswer }: { confirm: Parsed; answer?: string; onAnswer?: (text: string) => void }) {
  const live = !!onAnswer;
  const color = danger ? 'error' : 'primary';
  const done = answer === yes || answer === no;
  return (
    <Box sx={{ my: 1, p: 1.5, border: 1, borderColor: live ? `${color}.main` : 'divider', borderRadius: '10px', bgcolor: 'background.default', opacity: live || answer ? 1 : 0.7 }}>
      <Box sx={{ display: 'flex', gap: 1.25, alignItems: 'flex-start' }}>
        <Box aria-hidden sx={{ width: 32, height: 32, borderRadius: '50%', display: 'grid', placeItems: 'center', flexShrink: 0,
          color: live || done ? `${color}.main` : 'text.secondary', bgcolor: (t) => alpha(t.palette[color].main, 0.14) }}>
          {danger ? <DeleteOutline fontSize="small" /> : <HelpOutline fontSize="small" />}
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 600, whiteSpace: 'pre-wrap' }}>{title}</Typography>
          {text && <Box sx={{ color: 'text.secondary', fontSize: '0.875rem' }}><Markdown>{text}</Markdown></Box>}
        </Box>
      </Box>
      <Box sx={{ display: 'flex', gap: 1, mt: 1.25, ml: 5.25, flexWrap: 'wrap' }}>
        {([[no, false], [yes, true]] as const).map(([label, ok]) => {
          const chosen = answer === label;
          return (
            <Button key={label} size="small" disabled={!live} color={ok ? color : 'inherit'} variant={ok || chosen ? 'contained' : 'outlined'}
              onClick={() => onAnswer?.(label)}
              sx={chosen ? { '&.Mui-disabled': { bgcolor: ok ? `${color}.main` : 'action.selected', color: ok ? `${color}.contrastText` : 'text.primary' } } : undefined}>{label}</Button>);
        })}
      </Box>
      {done && !live && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, ml: 5.25 }}>{t('confirm.answered', { answer })}</Typography>}
    </Box>
  );
}
