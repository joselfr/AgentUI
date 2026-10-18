import { useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import { MONO } from '../theme';
import { t as tr } from '../i18n';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);

interface Code { code: string; language?: string; filename?: string; highlight: Set<number>; start: number }

const FOLD_LINES = 15;
const MAX_LINES = 2000;
const ALIAS: Record<string, string> = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', html: 'xml', svg: 'xml' };

/** Line numbers of a `highlight`: `[4, "6-7"]` → {4, 6, 7}. `undefined` if an entry is invalid. */
function parseLines(v: unknown): Set<number> | undefined {
  const out = new Set<number>();
  if (v === undefined) return out;
  if (!Array.isArray(v)) return undefined;
  for (const x of v) {
    // A lone number may arrive as a string ("7"): the range-end group is then absent, not NaN.
    const m = typeof x === 'number' ? [x, x] : typeof x === 'string' ? /^(\d+)(?:-(\d+))?$/.exec(x.trim())?.slice(1).map((n) => (n === undefined ? undefined : Number(n))) : undefined;
    const [a, b = a] = m ?? [];
    if (a === undefined || b === undefined || !Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b - a > MAX_LINES) return undefined;
    for (let i = a; i <= b; i++) out.add(i);
  }
  return out;
}

/** Arguments of the `code` widget: `{ code, language?, filename?, highlight?, start? }`. `undefined` if invalid. */
export function parseCode(a: Record<string, unknown>): Code | undefined {
  if (typeof a.code !== 'string' || !a.code.trim()) return undefined;
  const highlight = parseLines(a.highlight);
  if (!highlight) return undefined;
  const start = a.start === undefined ? 1 : a.start;
  if (typeof start !== 'number' || !Number.isInteger(start) || start < 1) return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return { code: a.code.replace(/\n$/, ''), language: str(a.language)?.toLowerCase(), filename: str(a.filename), highlight, start };
}

/** Per-line colored HTML: a `<span>` spanning several lines is closed then reopened at each line break. `undefined` if the language is unknown. */
function highlightLines(code: string, language?: string): string[] | undefined {
  const lang = language && (ALIAS[language] ?? language);
  if (!lang || !hljs.getLanguage(lang)) return undefined;
  const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  const open: string[] = [];
  return html.split('\n').map((line) => {
    const prefix = open.join('');
    for (const m of line.matchAll(/<span[^>]*>|<\/span>/g)) m[0] === '</span>' ? open.pop() : open.push(m[0]);
    return prefix + line + '</span>'.repeat(open.length);
  });
}

export default function CodeCard({ code: c }: { code: Code }) {
  const t = useTheme();
  const dark = t.palette.mode === 'dark';
  const lines = c.code.split('\n');
  const diff = c.language === 'diff';
  const colored = diff ? undefined : highlightLines(c.code, c.language);
  const foldable = lines.length > FOLD_LINES;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard?.writeText(c.code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  const tok = dark
    ? { kw: '#b794f6', str: '#6ee7a0', com: '#6b7385', num: '#fbbf6a', fn: '#7db4ff' }
    : { kw: '#8b3fd1', str: '#1a7f4b', com: '#7b8494', num: '#c2410c', fn: '#1d6fd6' };
  const folded = foldable && !open;

  return (
    <Box sx={{ my: 1, border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.default', overflow: 'hidden', minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 1.5, pr: 1, py: 0.75, borderBottom: 1, borderColor: 'divider', bgcolor: 'action.hover' }}>
        <Typography noWrap sx={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 12, fontWeight: 600 }}>{c.filename ?? ''}</Typography>
        {c.language && <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{c.language}</Typography>}
        <Button size="small" variant="outlined" color={copied ? 'success' : 'inherit'} onClick={copy} sx={{ py: 0, fontSize: 12, borderColor: copied ? undefined : 'divider' }}>{copied ? tr('code.copied') : tr('code.copy')}</Button>
      </Box>
      <Box sx={{
        position: 'relative', overflow: folded ? 'hidden' : 'auto', maxHeight: folded ? `calc(${FOLD_LINES} * 1.55em + 20px)` : undefined,
        '&::after': folded ? { content: '""', position: 'absolute', left: 0, right: 0, bottom: 0, height: 56, background: (th) => `linear-gradient(transparent, ${th.palette.background.default})` } : undefined,
      }}>
        <Box sx={{ // not a <code>: the message bubble would apply its inline code style to it (background, margins, rounded corners)
          display: 'block', py: 1.25, minWidth: 'max-content', fontFamily: MONO, fontSize: 12.5, lineHeight: 1.55,
          '& .hljs-keyword, & .hljs-built_in, & .hljs-literal, & .hljs-selector-tag, & .hljs-tag, & .hljs-name': { color: tok.kw },
          '& .hljs-string, & .hljs-regexp, & .hljs-attr': { color: tok.str },
          '& .hljs-comment, & .hljs-quote, & .hljs-meta': { color: tok.com, fontStyle: 'italic' },
          '& .hljs-number, & .hljs-symbol, & .hljs-variable': { color: tok.num },
          '& .hljs-title, & .hljs-function, & .hljs-section, & .hljs-type': { color: tok.fn },
        }}>
          {lines.map((l, i) => {
            const mark = diff ? (l[0] === '+' ? 'success' : l[0] === '-' ? 'error' : undefined) : undefined;
            const hl = !diff && c.highlight.has(c.start + i);
            return (
              <Box key={i} sx={{
                display: 'flex',
                ...(mark && { bgcolor: alpha(t.palette[mark].main, 0.15) }),
                ...(hl && { bgcolor: alpha(t.palette.primary.main, dark ? 0.13 : 0.1), boxShadow: `inset 2px 0 ${t.palette.primary.main}` }),
              }}>
                <Box component="i" sx={{ flex: 'none', width: diff ? 12 : 44, pr: diff ? 0 : 1.5, textAlign: 'right', color: 'text.secondary', fontStyle: 'normal', userSelect: 'none', opacity: 0.7 }}>{diff ? '' : c.start + i}</Box>
                {colored
                  ? <Box component="span" sx={{ flex: 1, whiteSpace: 'pre', pr: 1.5 }} dangerouslySetInnerHTML={{ __html: colored[i] ?? '' }} />
                  : <Box component="span" sx={{ flex: 1, whiteSpace: 'pre', pr: 1.5 }}>{l}</Box>}
              </Box>);
          })}
        </Box>
      </Box>
      {foldable && (
        <Button fullWidth size="small" onClick={() => setOpen(!open)} sx={{ borderRadius: 0, borderTop: 1, borderColor: 'divider', bgcolor: 'action.hover', color: 'text.primary', fontSize: 12 }}>
          {open ? tr('code.fold') : tr('code.showLines', { count: lines.length })}
        </Button>)}
    </Box>
  );
}
