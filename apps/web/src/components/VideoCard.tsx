import { useState } from 'react';
import { Box, Link, Typography } from '@mui/material';
import { t } from '../i18n';
import { isHttp, optText, validSrc } from './media';
import type { Resolved } from './ImageCard';

export interface Video { src: string; title?: string; caption?: string }

/** Arguments of the `video` widget: `{ src, title?, caption? }`; `src`: http(s) URL or absolute path. `undefined` if invalid. */
export function parseVideo(a: Record<string, unknown>): Video | undefined {
  if (!validSrc(a.src)) return undefined;
  return { src: a.src, title: optText(a.title, 120), caption: optText(a.caption) };
}

/** Native player (fullscreen, AirPlay, speed): the first frame stands for the poster (`#t=0.001`, also what makes iOS draw it). */
export default function VideoCard({ video, resolve, bare }: { video: Video; resolve: (src: string) => Resolved; bare?: boolean }) {
  const r = resolve(video.src);
  const [broken, setBroken] = useState(false);
  const frame = { borderRadius: '8px', overflow: 'hidden', bgcolor: 'action.hover', border: 1, borderColor: 'divider' } as const;
  const failed = r.state === 'error' || broken;
  return (
    <Box sx={{ my: 1, p: 1.25, border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.default', minWidth: 0 }}>
      {video.title && <Typography sx={{ fontWeight: 600, mx: 0.25, mb: 1 }}>{video.title}</Typography>}
      {r.state === 'loading' ? <Box sx={{ ...frame, aspectRatio: '16 / 9' }} />
        : failed ? (
          <Box sx={{ ...frame, aspectRatio: '16 / 9', display: 'grid', placeItems: 'center', alignContent: 'center', gap: 0.75, p: 1, textAlign: 'center', color: 'text.secondary', fontSize: 12 }}>
            <span>{t('video.unavailable')}</span>
            {r.state === 'ok' && <Link href={r.url} {...(isHttp(video.src) ? { target: '_blank', rel: 'noreferrer noopener' } : { download: true })} underline="always" sx={{ color: 'primary.main' }}>{isHttp(video.src) ? t('media.open') : t('media.download')}</Link>}
          </Box>
        ) : (
          <Box component="video" controls playsInline preload="metadata" src={`${r.url}#t=0.001`} onError={() => setBroken(true)}
            sx={{ ...frame, display: 'block', width: '100%', maxHeight: 'min(480px, 70dvh)', bgcolor: '#000' }} />
        )}
      {!bare && video.caption && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mx: 0.25, mt: 0.5 }}>{video.caption}</Typography>}
    </Box>
  );
}
