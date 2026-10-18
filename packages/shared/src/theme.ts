/** Design tokens shared by the web app (MUI theme) and the mini-app runtime (CSS variables). Single source of truth. */
export type ThemeMode = 'light' | 'dark';

export const themeTokens = {
  dark: { bg: '#0e1015', paper: '#161a22', raised: '#1c212b', accent: '#ff5c5c', accentHover: '#ff7a7a', line: 'rgba(255,255,255,0.08)', text: '#e8eaf0', muted: '#8b93a5', danger: '#ff6b6b' },
  light: { bg: '#f6f7f9', paper: '#ffffff', raised: '#eef0f4', accent: '#e5484d', accentHover: '#d23a3f', line: 'rgba(15,20,30,0.10)', text: '#171a21', muted: '#5d6575', danger: '#d23a3f' },
} as const;

/** Colors independent of the mode. */
export const themeAccents = { secondary: '#8b6cf0', success: '#22c55e', warning: '#f59e0b', info: '#38bdf8', pink: '#ec4899' } as const;

/** Chart palette (same order as the chat `chart` widget). */
export const chartPalette = (mode: ThemeMode): string[] => [themeTokens[mode].accent, themeAccents.secondary, themeAccents.warning, themeAccents.success, themeAccents.info, themeAccents.pink];

export const FONT_SANS = '"Inter Variable", Inter, system-ui, sans-serif';
export const FONT_MONO = '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace';

/** CSS variables (`--au-*`) pushed by the host to the mini-app iframes. */
export function themeCssVars(mode: ThemeMode): Record<string, string> {
  const t = themeTokens[mode];
  return {
    '--au-bg': t.bg,
    '--au-paper': t.paper,
    '--au-raised': t.raised,
    '--au-accent': t.accent,
    '--au-accent-hover': t.accentHover,
    '--au-on-accent': '#ffffff',
    '--au-line': t.line,
    '--au-text': t.text,
    '--au-muted': t.muted,
    '--au-danger': t.danger,
    '--au-success': themeAccents.success,
    '--au-warning': themeAccents.warning,
    '--au-info': themeAccents.info,
    '--au-secondary': themeAccents.secondary,
    '--au-radius': '12px',
    '--au-radius-sm': '10px',
    '--au-font': FONT_SANS,
    '--au-mono': FONT_MONO,
    '--au-scheme': mode,
  };
}
