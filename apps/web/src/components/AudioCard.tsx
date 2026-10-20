import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Box, IconButton, Link, Typography } from '@mui/material';
import { PauseRounded, PlayArrowRounded } from '@mui/icons-material';
import { t } from '../i18n';
import { formatTime, isHttp, optText, validSrc } from './media';
import type { Resolved } from './ImageCard';

export interface Audio { src: string; title?: string }

/** Arguments of the `audio` widget: `{ src, title? }`; `src`: http(s) URL or absolute path. `undefined` if invalid. */
export function parseAudio(a: Record<string, unknown>): Audio | undefined {
  if (!validSrc(a.src)) return undefined;
  return { src: a.src, title: optText(a.title, 120) };
}

const BARS = 46;
const SPEEDS = [1, 1.5, 2];

/** Decorative waveform (the same one for the same source): a seeded pseudo-random series, which also serves as a seek bar. */
export function waveform(seed: string, n = BARS): number[] {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    out.push(0.25 + 0.75 * Math.abs(Math.sin(i * 0.6 + (h % 628) / 100) * Math.cos(i * 0.21)));
  }
  return out;
}

let playing: HTMLAudioElement | null = null; // a single audio plays at a time

export default function AudioCard({ audio, resolve }: { audio: Audio; resolve: (src: string) => Resolved }) {
  const r = resolve(audio.src);
  const el = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [broken, setBroken] = useState(false);
  const bars = useMemo(() => waveform(audio.src), [audio.src]);
  useEffect(() => () => { if (playing === el.current) playing = null; }, []);
  const failed = r.state === 'error' || broken;
  const name = audio.title ?? decodeURIComponent(audio.src.split('/').pop()?.split('?')[0] ?? '') ?? '';
  const toggle = () => {
    const a = el.current;
    if (!a) return;
    if (a.paused) { if (playing && playing !== a) playing.pause(); playing = a; void a.play().catch(() => setBroken(true)); } else a.pause();
  };
  const seek = (ratio: number) => { const a = el.current; if (a && duration) a.currentTime = Math.min(1, Math.max(0, ratio)) * duration; };
  const onKey = (e: KeyboardEvent) => {
    const a = el.current;
    if (!a) return;
    if (e.key === 'ArrowRight') a.currentTime = Math.min(duration, a.currentTime + 5);
    else if (e.key === 'ArrowLeft') a.currentTime = Math.max(0, a.currentTime - 5);
    else return;
    e.preventDefault();
  };
  const progress = duration ? time / duration : 0;
  return (
    <Box sx={{ my: 1, p: 1.25, border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.default', minWidth: 0 }}>
      {failed ? (
        <Typography color="text.secondary" sx={{ fontSize: 12, textAlign: 'center', py: 0.5 }}>
          {t('audio.unavailable')} {r.state === 'ok' && <Link href={r.url} {...(isHttp(audio.src) ? { target: '_blank', rel: 'noreferrer noopener' } : { download: true })} underline="always" sx={{ color: 'primary.main' }}>{isHttp(audio.src) ? t('media.open') : t('media.download')}</Link>}
        </Typography>
      ) : (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
          {r.state === 'ok' && <audio ref={el} src={r.url} preload="metadata"
            onPlay={() => setOn(true)} onPause={() => setOn(false)} onEnded={() => { setOn(false); setTime(0); }} onError={() => setBroken(true)}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} onLoadedMetadata={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)} />}
          <IconButton onClick={toggle} disabled={r.state !== 'ok'} aria-label={on ? t('audio.pause') : t('audio.play')}
            sx={{ width: 38, height: 38, flex: 'none', bgcolor: 'primary.main', color: 'primary.contrastText', '&:hover': { bgcolor: 'primary.dark' }, '&.Mui-disabled': { bgcolor: 'action.disabledBackground' } }}>
            {on ? <PauseRounded /> : <PlayArrowRounded />}
          </IconButton>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {name && <Typography noWrap sx={{ fontWeight: 600, fontSize: 14 }}>{name}</Typography>}
            <Box role="slider" tabIndex={0} aria-label={t('audio.seek')} aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)} aria-valuetext={formatTime(time)} onKeyDown={onKey}
              onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); seek((e.clientX - b.left) / b.width); }}
              sx={{ display: 'flex', alignItems: 'center', gap: '2px', height: 28, cursor: 'pointer', touchAction: 'pan-y', '&:focus-visible': { outline: 2, outlineColor: 'primary.main', borderRadius: 1 } }}>
              {bars.map((v, i) => <Box key={i} component="span" sx={{ flex: 1, maxWidth: 4, height: `${Math.round(v * 100)}%`, borderRadius: '2px', bgcolor: i / BARS < progress ? 'primary.main' : 'divider' }} />)}
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
              <span>{formatTime(time)}</span><span>{duration ? formatTime(duration) : ''}</span>
            </Box>
          </Box>
          <Box component="button" type="button" aria-label={t('audio.speed')} onClick={() => { const n = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!; setSpeed(n); if (el.current) el.current.playbackRate = n; }}
            sx={{ flex: 'none', border: 1, borderColor: 'divider', borderRadius: '8px', bgcolor: 'transparent', color: 'text.primary', font: 'inherit', fontWeight: 600, fontSize: 12, px: 1, py: 0.5, cursor: 'pointer', minWidth: 40 }}>{speed}×</Box>
        </Box>
      )}
    </Box>
  );
}
