import { useState } from 'react';
import { Box, Button, Checkbox, FormControlLabel, Typography } from '@mui/material';
import QuestionAnswerOutlined from '@mui/icons-material/QuestionAnswerOutlined';

interface Parsed { question: string; choices: string[]; multiple: boolean }

/** Bloc ```ask : question en tête, puis `- choix` (un seul) ou `- [ ] choix` (plusieurs). Sans liste : réponse libre. */
export function parseAsk(raw: string): Parsed {
  const question: string[] = [];
  const choices: string[] = [];
  let multiple = false;
  for (const line of raw.split('\n')) {
    const m = /^\s*[-*]\s+(\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
    if (m) { if (m[1]) multiple = true; choices.push(m[2]!); } else if (!choices.length) question.push(line);
  }
  return { question: question.join('\n').trim(), choices, multiple };
}

/** `answer` : réponse déjà envoyée (message utilisateur suivant), `onAnswer` absent : question plus répondable. */
export default function AskCard({ raw, answer, onAnswer }: { raw: string; answer?: string; onAnswer?: (text: string) => void }) {
  const { question, choices, multiple } = parseAsk(raw);
  const [picked, setPicked] = useState<string[]>([]);
  const live = !!onAnswer;
  const answered = (c: string) => (answer ? answer.split(/,\s*/).includes(c) || answer === c : false);
  return (
    <Box sx={{ my: 1, p: 1.5, border: 1, borderColor: live ? 'primary.main' : 'divider', borderRadius: '10px', bgcolor: 'background.default', opacity: live || answer ? 1 : 0.7 }}>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
        <QuestionAnswerOutlined fontSize="small" color={live ? 'primary' : 'action'} sx={{ mt: 0.25 }} />
        <Typography sx={{ whiteSpace: 'pre-wrap', fontWeight: 600 }}>{question || 'Question de l\'agent'}</Typography>
      </Box>
      {choices.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1.25, ml: 3.5 }}>
          {multiple ? (
            <Box sx={{ display: 'grid', width: '100%' }}>
              {choices.map((c) => (
                <FormControlLabel key={c} disabled={!live} label={c}
                  control={<Checkbox size="small" checked={live ? picked.includes(c) : answered(c)} onChange={(e) => setPicked(e.target.checked ? [...picked, c] : picked.filter((x) => x !== c))} />} />))}
              {live && <Button variant="contained" size="small" sx={{ justifySelf: 'start', mt: 0.5 }} disabled={!picked.length}
                onClick={() => onAnswer(choices.filter((c) => picked.includes(c)).join(', '))}>Envoyer</Button>}
            </Box>
          ) : choices.map((c) => (
            <Button key={c} size="small" variant={answered(c) ? 'contained' : 'outlined'} disabled={!live} onClick={() => onAnswer?.(c)}
              sx={answered(c) ? { '&.Mui-disabled': { bgcolor: 'primary.main', color: 'primary.contrastText' } } : undefined}>{c}</Button>))}
        </Box>)}
      {live && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, ml: 3.5 }}>{choices.length ? 'Ou répondez librement dans le champ ci-dessous.' : 'Répondez dans le champ ci-dessous.'}</Typography>}
    </Box>
  );
}
