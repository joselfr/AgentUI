import { useState } from 'react';
import { Box, Button, Checkbox, FormControlLabel, TextField, Typography } from '@mui/material';
import ArticleOutlined from '@mui/icons-material/ArticleOutlined';
import Markdown from './Markdown';
import { fmtNumber, t } from '../i18n';

type Kind = 'text' | 'textarea' | 'number' | 'date' | 'select' | 'checkbox';
interface Field { name: string; label: string; kind: Kind; required: boolean; def?: string | number | boolean; placeholder?: string; hint?: string; options: string[]; min?: number; max?: number; unit?: string }
export interface Parsed { title?: string; text?: string; submit: string; fields: Field[] }

const KINDS: Kind[] = ['text', 'textarea', 'number', 'date', 'select', 'checkbox'];
const MAX_FIELDS = 12;
const EMPTY = '—';

/** Arguments of the `form` widget: `{ title?, text?, submit?, fields: [{ name, label, kind?, required?, default?, placeholder?, hint?, options?, min?, max?, unit? }] }`. `undefined` if invalid. */
export function parseForm(a: Record<string, unknown>): Parsed | undefined {
  if (!Array.isArray(a.fields) || !a.fields.length || a.fields.length > MAX_FIELDS) return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : undefined);
  const names = new Set<string>();
  const fields: Field[] = [];
  for (const f of a.fields as Record<string, unknown>[]) {
    const name = str(f?.name), label = str(f?.label), kind = (f?.kind ?? 'text') as Kind;
    if (!name || !label || names.has(name) || !KINDS.includes(kind)) return undefined;
    names.add(name);
    const options = Array.isArray(f.options) ? f.options.map(String) : [];
    if (kind === 'select' && !options.length) return undefined;
    const d = f.default;
    fields.push({
      name, label, kind, required: f.required === true, options, placeholder: str(f.placeholder), hint: str(f.hint), unit: str(f.unit), min: num(f.min), max: num(f.max),
      def: typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean' ? d : undefined,
    });
  }
  return { title: str(a.title), text: str(a.text), submit: str(a.submit) ?? t('common.send'), fields };
}

type Values = Record<string, string | boolean>;
const initial = (p: Parsed): Values => Object.fromEntries(p.fields.map((f) => [f.name, f.kind === 'checkbox' ? f.def === true : f.def != null ? String(f.def) : '']));

/** Message sent to the agent: one "Label: value" line per field. */
function serialize(p: Parsed, v: Values) {
  return p.fields.map((f) => {
    const x = v[f.name];
    const s = f.kind === 'checkbox' ? (x ? t('common.yes') : t('common.no')) : String(x).trim().replace(/\s*\n\s*/g, ' / ') || EMPTY;
    return `${f.label}: ${s}`;
  }).join('\n');
}

/** Reads back an already sent message to fill in the frozen form. */
function deserialize(p: Parsed, answer: string): Values {
  const lines = answer.split('\n');
  const v = initial(p);
  for (const f of p.fields) {
    const line = lines.find((l) => l.startsWith(`${f.label}: `));
    if (line === undefined) { v[f.name] = f.kind === 'checkbox' ? false : ''; continue; }
    const s = line.slice(f.label.length + 2);
    v[f.name] = f.kind === 'checkbox' ? s === 'Oui' || s === 'Yes' : s === EMPTY ? '' : s;
  }
  return v;
}

function validate(f: Field, x: string | boolean): string | undefined {
  if (f.kind === 'checkbox') return f.required && !x ? t('form.mustCheck') : undefined;
  const s = String(x).trim();
  if (!s) return f.required ? t('form.required') : undefined;
  if (f.kind === 'number') {
    const n = Number(s.replace(',', '.'));
    if (!isFinite(n)) return t('form.invalidNumber');
    if (f.min != null && f.max != null && (n < f.min || n > f.max)) return t('form.between', { min: f.min, max: f.max });
    if (f.min != null && n < f.min) return t('form.atLeast', { min: f.min });
    if (f.max != null && n > f.max) return t('form.atMost', { max: f.max });
  }
  return undefined;
}

/** `answer`: message already sent (frozen, read-back form), `onAnswer` absent: form can no longer be answered. */
export default function FormCard({ form, answer, onAnswer }: { form: Parsed; answer?: string; onAnswer?: (text: string) => void }) {
  const live = !!onAnswer && answer === undefined;
  const [vals, setVals] = useState<Values>(() => initial(form));
  const [tried, setTried] = useState(false);
  const shown = answer !== undefined ? deserialize(form, answer) : vals;
  const errors = Object.fromEntries(form.fields.map((f) => [f.name, validate(f, vals[f.name]!)]));
  const set = (name: string, v: string | boolean) => setVals((o) => ({ ...o, [name]: v }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!live) return;
    if (form.fields.some((f) => errors[f.name])) { setTried(true); return; }
    onAnswer?.(serialize(form, vals));
  };
  return (
    <Box component="form" noValidate onSubmit={submit} sx={{ my: 1, p: 1.5, minWidth: 'min(400px, 72vw)', border: 1, borderColor: live ? 'primary.main' : 'divider', borderRadius: '10px', bgcolor: 'background.default', opacity: live || answer !== undefined ? 1 : 0.7 }}>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mb: 1.25 }}>
        <ArticleOutlined fontSize="small" color={live ? 'primary' : 'action'} sx={{ mt: 0.25 }} />
        <Box>
          <Typography sx={{ fontWeight: 600 }}>{form.title ?? (form.text ? '' : t('form.default'))}</Typography>
          {form.text && <Box sx={{ color: 'text.secondary', fontSize: '0.875rem' }}><Markdown>{form.text}</Markdown></Box>}
        </Box>
      </Box>
      {form.fields.map((f) => {
        const err = tried && live ? errors[f.name] : undefined;
        const label = <>{f.label}{f.required && <Box component="span" sx={{ color: 'primary.main' }}> *</Box>}</>;
        const hint = f.hint && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{f.hint}</Typography>;
        if (f.kind === 'checkbox') return (
          <Box key={f.name} sx={{ mb: 0.5 }}>
            <FormControlLabel disabled={!live} label={<Typography sx={{ fontWeight: 600, fontSize: 13 }}>{label}</Typography>}
              control={<Checkbox size="small" checked={shown[f.name] === true} onChange={(e) => set(f.name, e.target.checked)} />} />
            {err && <Typography variant="caption" color="error" sx={{ display: 'block' }}>{err}</Typography>}{hint}
          </Box>);
        const input = (
          <TextField fullWidth size="small" disabled={!live} error={!!err} value={shown[f.name] as string} onChange={(e) => set(f.name, e.target.value)}
            type={f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text'} multiline={f.kind === 'textarea'} minRows={f.kind === 'textarea' ? 2 : undefined}
            select={f.kind === 'select'} SelectProps={f.kind === 'select' ? { native: true } : undefined} placeholder={f.placeholder}
            inputProps={{ 'aria-label': f.label, ...(f.kind === 'number' ? { min: f.min, max: f.max, step: 'any' } : {}) }}>
            {f.kind === 'select' && [<option key="" value="">{f.required ? t('form.choose') : EMPTY}</option>, ...f.options.map((o) => <option key={o} value={o}>{o}</option>)]}
          </TextField>);
        return (
          <Box key={f.name} sx={{ mb: 1.25 }}>
            <Typography component="label" sx={{ display: 'block', fontWeight: 600, fontSize: 13, mb: 0.25 }}>{label}</Typography>
            {f.unit ? <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>{input}<Typography color="text.secondary">{f.unit}</Typography></Box> : input}
            {err && <Typography variant="caption" color="error" sx={{ display: 'block' }}>{err}</Typography>}{hint}
          </Box>);
      })}
      {live && <Button type="submit" variant="contained" size="small" sx={{ mt: 0.5 }}>{form.submit}</Button>}
      {answer !== undefined && <Typography variant="caption" color="text.secondary">{t('form.sent')}</Typography>}
    </Box>
  );
}
