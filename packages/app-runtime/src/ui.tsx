/** `@agentui/ui`: components, hooks and bridge for mini-apps. Everything is themed by the host through `--au-*` CSS variables. */
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Chart as ChartJS } from 'chart.js';
import { Icon } from './icons';
import { getTheme, onTheme, useTheme } from './host';

export * from './host';
export { Icon, ICON_NAMES } from './icons';

const cx = (...c: (string | false | undefined | null)[]) => c.filter(Boolean).join(' ');

// ---------- Layout ----------
export function Page({ title, actions, children, maxWidth = 860 }: { title?: ReactNode; actions?: ReactNode; children?: ReactNode; maxWidth?: number | string }) {
  return (
    <div className="au-page">
      <div className="au-page-in" style={{ maxWidth }}>
        {(title || actions) && (
          <div className="au-page-head">
            <h1 className="au-page-title">{title}</h1>
            {actions}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function Stack({ gap = 12, direction = 'column', align, justify, wrap, style, className, children }: {
  gap?: number; direction?: 'row' | 'column'; align?: CSSProperties['alignItems']; justify?: CSSProperties['justifyContent']; wrap?: boolean; style?: CSSProperties; className?: string; children?: ReactNode;
}) {
  return <div className={cx('au-stack', wrap && 'au-wrap', className)} style={{ flexDirection: direction, gap, alignItems: align, justifyContent: justify, ...style }}>{children}</div>;
}
export const Row = (p: Omit<Parameters<typeof Stack>[0], 'direction'>) => <Stack align="center" {...p} direction="row" />;

export function Card({ children, padding = 16, onClick, style, className }: { children?: ReactNode; padding?: number | string; onClick?: () => void; style?: CSSProperties; className?: string }) {
  return (
    <div className={cx('au-card', onClick && 'au-click', className)} style={{ padding, ...style }} onClick={onClick}
      role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick()) : undefined}>
      {children}
    </div>
  );
}

export function Text({ variant = 'body', muted, mono, style, children }: { variant?: 'h5' | 'h6' | 'subtitle' | 'body' | 'caption' | 'overline'; muted?: boolean; mono?: boolean; style?: CSSProperties; children?: ReactNode }) {
  return <span className={cx(`au-text-${variant}`, muted && 'au-muted', mono && 'au-text-mono')} style={{ display: variant === 'body' || variant === 'caption' ? undefined : 'block', ...style }}>{children}</span>;
}
export const Divider = () => <hr className="au-divider" />;

// ---------- Actions ----------
export function Button({ variant = 'contained', color = 'primary', size, icon, loading, children, ...rest }: {
  variant?: 'contained' | 'outlined' | 'text'; color?: 'primary' | 'danger' | 'neutral'; size?: 'small' | 'medium'; icon?: string; loading?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'>) {
  return (
    <button type="button" {...rest} disabled={rest.disabled || loading}
      className={cx('au-btn', `au-${variant}`, color === 'danger' && 'au-danger', color === 'neutral' && 'au-neutral', size === 'small' && 'au-small', rest.className)}>
      {loading ? <span className="au-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> : icon && <Icon name={icon} size="1.25em" />}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, active, ...rest }: { icon: string; label: string; active?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" title={label} aria-label={label} {...rest} className={cx('au-iconbtn', active && 'au-active', rest.className)}><Icon name={icon} /></button>;
}

// ---------- Forms ----------
interface FieldProps { label?: ReactNode; helperText?: ReactNode; error?: boolean | string; style?: CSSProperties }
function Field({ label, helperText, error, id, style, children }: FieldProps & { id: string; children: ReactNode }) {
  const msg = typeof error === 'string' ? error : helperText;
  return (
    <div className="au-field" style={style}>
      {label && <label className="au-label" htmlFor={id}>{label}</label>}
      {children}
      {msg && <span className={cx('au-help', !!error && 'au-err')}>{msg}</span>}
    </div>
  );
}

export function TextField({ label, helperText, error, value, onChange, onEnter, multiline, rows, style, ...rest }: FieldProps & {
  value: string; onChange: (value: string) => void; onEnter?: () => void; multiline?: boolean; rows?: number;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'style'>) {
  const id = useId();
  const common = { id, value, className: cx('au-input', !!error && 'au-err') };
  return (
    <Field label={label} helperText={helperText} error={error} id={id} style={style}>
      {multiline
        ? <textarea {...common} rows={rows ?? 4} placeholder={rest.placeholder} disabled={rest.disabled} onChange={(e) => onChange(e.target.value)} />
        : <input {...rest} {...common} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { rest.onKeyDown?.(e); if (e.key === 'Enter' && onEnter) onEnter(); }} />}
    </Field>
  );
}

export function Select({ label, helperText, error, value, onChange, options, style, disabled }: FieldProps & {
  value: string; onChange: (value: string) => void; options: (string | { value: string; label: ReactNode })[]; disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field label={label} helperText={helperText} error={error} id={id} style={style}>
      <select id={id} className={cx('au-input', !!error && 'au-err')} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => { const v = typeof o === 'string' ? o : o.value; const l = typeof o === 'string' ? o : o.label; return <option key={v} value={v}>{l as string}</option>; })}
      </select>
    </Field>
  );
}

function Toggle({ kind, checked, onChange, label, disabled }: { kind: 'box' | 'switch'; checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="au-check" style={{ opacity: disabled ? 0.5 : 1 }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} role={kind === 'switch' ? 'switch' : undefined} />
      {kind === 'box' ? <span className="au-box">{checked && <Icon name="check" size={16} />}</span> : <span className="au-track" />}
      {label && <span>{label}</span>}
    </label>
  );
}
export const Checkbox = (p: Omit<Parameters<typeof Toggle>[0], 'kind'>) => <Toggle kind="box" {...p} />;
export const Switch = (p: Omit<Parameters<typeof Toggle>[0], 'kind'>) => <Toggle kind="switch" {...p} />;

// ---------- Data display ----------
export function List({ children }: { children?: ReactNode }) { return <div className="au-list">{children}</div>; }
export function ListItem({ primary, secondary, leading, trailing, onClick, selected }: { primary: ReactNode; secondary?: ReactNode; leading?: ReactNode; trailing?: ReactNode; onClick?: () => void; selected?: boolean }) {
  return (
    <div className={cx('au-item', onClick && 'au-click', selected && 'au-sel')} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick() : undefined}>
      {leading}
      <div className="au-item-main"><div className="au-item-1">{primary}</div>{secondary && <div className="au-item-2">{secondary}</div>}</div>
      {trailing}
    </div>
  );
}

export interface Column<R> { key: string; label: ReactNode; align?: 'left' | 'right'; render?: (row: R) => ReactNode }
export function Table<R extends Record<string, any>>({ columns, rows, onRowClick, rowKey }: { columns: Column<R>[]; rows: R[]; onRowClick?: (row: R) => void; rowKey?: (row: R, i: number) => string }) {
  return (
    <div className="au-tablewrap">
      <table className="au-table">
        <thead><tr>{columns.map((c) => <th key={c.key} className={c.align === 'right' ? 'au-r' : undefined}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey ? rowKey(r, i) : (r.id ?? i)} className={onRowClick ? 'au-click' : undefined} onClick={onRowClick && (() => onRowClick(r))}>
              {columns.map((c) => <td key={c.key} className={c.align === 'right' ? 'au-r' : undefined}>{c.render ? c.render(r) : (r[c.key] as ReactNode)}</td>)}
            </tr>))}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({ value, onChange, tabs }: { value: string; onChange: (value: string) => void; tabs: { value: string; label: ReactNode }[] }) {
  return <div className="au-tabs" role="tablist">{tabs.map((t) => <button key={t.value} role="tab" aria-selected={t.value === value} className={cx('au-tab', t.value === value && 'au-on')} onClick={() => onChange(t.value)}>{t.label}</button>)}</div>;
}

export function Chip({ label, color, onDelete }: { label: ReactNode; color?: 'primary' | 'success' | 'warning' | 'danger'; onDelete?: () => void }) {
  return <span className={cx('au-chip', color && `au-c-${color}`)}>{label}{onDelete && <button type="button" aria-label="Remove" onClick={onDelete}><Icon name="close" size={14} /></button>}</span>;
}

export function Alert({ severity = 'info', children }: { severity?: 'info' | 'success' | 'warning' | 'error'; children?: ReactNode }) {
  return <div className={cx('au-alert', `au-${severity}`)} role="alert"><Icon name={severity === 'success' ? 'check' : severity} size="1.25em" /><div>{children}</div></div>;
}

export const Spinner = ({ center }: { center?: boolean }) => (center ? <div className="au-center"><span className="au-spinner" /></div> : <span className="au-spinner" />);

export function EmptyState({ icon = 'info', title, description, action }: { icon?: string; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return <div className="au-empty"><Icon name={icon} /><div className="au-empty-title">{title}</div>{description && <div>{description}</div>}{action}</div>;
}

export function Dialog({ open, title, onClose, actions, children }: { open: boolean; title?: ReactNode; onClose: () => void; actions?: ReactNode; children?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="au-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="au-dialog" role="dialog" aria-modal="true">
        {title && <div className="au-dialog-t">{title}</div>}
        <div className="au-dialog-b">{children}</div>
        {actions && <div className="au-dialog-a">{actions}</div>}
      </div>
    </div>
  );
}

// ---------- Toast ----------
let toastSet: ((m: string | null) => void) | undefined;
/** Shows a short message at the bottom (mounted automatically by the runtime). */
export const toast = (message: string) => toastSet?.(message);
export function ToastHost() {
  const [m, setM] = useState<string | null>(null);
  useEffect(() => { toastSet = setM; return () => { toastSet = undefined; }; }, []);
  useEffect(() => { if (m) { const t = setTimeout(() => setM(null), 3000); return () => clearTimeout(t); } }, [m]);
  return m ? <div className="au-toast" role="status">{m}</div> : null;
}

// ---------- Chart ----------
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const chartColors = () => [css('--au-accent'), css('--au-secondary'), css('--au-warning'), css('--au-success'), css('--au-info'), '#ec4899'];

/**
 * Themed chart.js chart. `series`: `[{ name, data: number[] }]`, `labels`: x axis (or slices for doughnut).
 * For anything custom, import `chart.js/auto` and use `chartColors()` / the `--au-*` variables.
 */
export function Chart({ type = 'line', labels, series, height = 240, options }: { type?: 'line' | 'bar' | 'doughnut'; labels: string[]; series: { name: string; data: number[] }[]; height?: number; options?: Record<string, unknown> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { mode } = useTheme();
  const key = JSON.stringify([type, labels, series, options]);
  useEffect(() => {
    const text = css('--au-muted'), line = css('--au-line'), bg = css('--au-bg'), colors = chartColors();
    const pie = type === 'doughnut';
    const ch = new ChartJS(ref.current!, {
      type,
      data: {
        labels,
        datasets: series.map((s, k) => (pie
          ? { label: s.name, data: s.data, backgroundColor: labels.map((_, i) => colors[i % colors.length]), borderColor: bg, borderWidth: 2 }
          : { label: s.name, data: s.data, borderColor: colors[k % colors.length], backgroundColor: colors[k % colors.length], ...(type === 'line' ? { borderWidth: 2.5, tension: 0, pointRadius: 3 } : { borderRadius: 4, borderSkipped: false }) })),
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 400 }, color: text,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: series.length > 1 || pie, labels: { color: text, boxWidth: 10, boxHeight: 10 } } },
        ...(pie ? { cutout: '60%' } : {
          scales: {
            x: { grid: { display: false }, border: { display: false }, ticks: { color: text, maxRotation: 0, autoSkipPadding: 12 } },
            y: { border: { display: false }, grid: { color: line }, ticks: { color: text } },
          },
        }),
        ...options,
      } as never,
    });
    return () => ch.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, mode]);
  return <div className="au-chart" style={{ height }}><canvas ref={ref} /></div>;
}

export { getTheme, onTheme };
export const useStable = <A extends unknown[], R>(fn: (...a: A) => R) => { const r = useRef(fn); r.current = fn; return useCallback((...a: A) => r.current(...a), []); };
