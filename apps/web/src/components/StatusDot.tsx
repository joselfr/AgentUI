import { Box } from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { ConnStatus } from '@agentui/shared';

const dot: Record<ConnStatus, string> = { connected: 'success.main', connecting: 'warning.main', error: 'error.main', disconnected: 'text.disabled' };

/** Connection status dot of an agent. */
export default function StatusDot({ status, size = 8 }: { status: ConnStatus; size?: number }) {
  return (
    <Box component="span" aria-hidden sx={{
      width: size, height: size, borderRadius: '50%', bgcolor: dot[status], flexShrink: 0, display: 'inline-block',
      boxShadow: status === 'connected' ? (t) => `0 0 0 3px ${alpha(t.palette.success.main, 0.18)}` : 'none',
    }} />
  );
}
