import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import { alpha, createTheme } from '@mui/material/styles';
import { FONT_MONO, FONT_SANS, themeAccents, themeTokens } from '@agentui/shared';

export const MONO = FONT_MONO;

const tokens = themeTokens;

export const makeTheme = (mode: 'light' | 'dark') => {
  const t = tokens[mode];
  return createTheme({
    palette: {
      mode,
      primary: { main: t.accent, dark: t.accentHover, contrastText: '#fff' },
      secondary: { main: themeAccents.secondary },
      success: { main: themeAccents.success },
      warning: { main: themeAccents.warning },
      error: { main: t.danger },
      background: { default: t.bg, paper: t.paper },
      text: { primary: t.text, secondary: t.muted },
      divider: t.line,
    },
    shape: { borderRadius: 12 },
    typography: {
      fontFamily: FONT_SANS,
      h5: { fontWeight: 650, letterSpacing: '-0.02em' },
      h6: { fontWeight: 650, letterSpacing: '-0.01em' },
      subtitle1: { fontWeight: 600, letterSpacing: '-0.01em' },
      button: { textTransform: 'none', fontWeight: 600 },
      overline: { fontWeight: 600, letterSpacing: '0.1em', fontSize: 11, lineHeight: 1.5 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          // Slightly more compact text, like a native app (MUI typography is in rem)
          html: { touchAction: 'manipulation', fontSize: 14 }, // manipulation: no zoom on double tap
          // Frozen page: only the app (height --app-height) scrolls internally, even with the keyboard open.
          'html, body': { height: '100%', overflow: 'hidden', overscrollBehavior: 'none' },
          body: { backgroundColor: t.bg },
          '::selection': { background: alpha(t.accent, 0.35) },
          '*::-webkit-scrollbar': { width: 8, height: 8 },
          '*::-webkit-scrollbar-thumb': { background: t.line, borderRadius: 8 },
          '*::-webkit-scrollbar-thumb:hover': { background: alpha(t.muted, 0.5) },
          'code, pre': { fontFamily: MONO },
        },
      },
      MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { backgroundImage: 'none', border: `1px solid ${t.line}` } } },
      MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { borderRadius: 10 } } },
      MuiIconButton: { styleOverrides: { root: { borderRadius: 10 } } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            backgroundColor: t.raised, borderRadius: 12,
            '& fieldset': { borderColor: t.line },
            '&:hover fieldset': { borderColor: alpha(t.muted, 0.5) },
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 10, marginBottom: 2,
            '&.Mui-selected': { backgroundColor: alpha(t.accent, 0.14), '&:hover': { backgroundColor: alpha(t.accent, 0.2) } },
          },
        },
      },
      MuiChip: { styleOverrides: { root: { fontWeight: 500 } } },
      MuiTab: { styleOverrides: { root: { textTransform: 'none', fontWeight: 600 } } },
      MuiDialog: { styleOverrides: { paper: { borderRadius: 16 } } },
      MuiDrawer: { styleOverrides: { paper: { backgroundImage: 'none', backgroundColor: t.paper, borderColor: t.line } } },
      MuiTooltip: { styleOverrides: { tooltip: { backgroundColor: t.raised, color: t.text, border: `1px solid ${t.line}`, fontSize: 12 } } },
    },
  });
};
