import { Box, Button, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import HelpOutline from '@mui/icons-material/HelpOutline';

export interface Parsed { title: string; text: string; danger: boolean; yes: string; no: string }

/** Bloc ```confirm : JSON `{ title, text?, danger?, yes?, no? }`. Un JSON invalide s'affiche comme un bloc de code. */
export function parseConfirm(raw: string): Parsed | undefined {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (!j || typeof j.title !== 'string') return undefined;
    const s = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v : d);
    return { title: j.title, text: s(j.text, ''), danger: j.danger === true, yes: s(j.yes, 'Confirmer'), no: s(j.no, 'Annuler') };
  } catch { return undefined; }
}

/** `answer` : réponse déjà envoyée (libellé du bouton choisi), `onAnswer` absent : demande plus répondable. */
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
          {text && <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>{text}</Typography>}
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
      {done && !live && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, ml: 5.25 }}>✓ Répondu : {answer}</Typography>}
    </Box>
  );
}
