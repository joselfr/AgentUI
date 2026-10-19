import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastHost, toHost } from '@agentui/ui';

declare global { interface Window { __AGENTUI: { appId: string; entry: string } } }

class Boundary extends Component<{ children: ReactNode }, { err?: Error }> {
  state: { err?: Error } = {};
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) { toHost({ type: 'agentui:error', message: String(err.stack ?? err).slice(0, 2000) }); }
  render() { return this.state.err ? <div className="au-error-boundary">{String(this.state.err.stack ?? this.state.err)}</div> : this.props.children; }
}

async function main() {
  const root = createRoot(document.getElementById('root')!);
  try {
    const mod = await import(/* @vite-ignore */ window.__AGENTUI.entry);
    const App = mod.default;
    if (typeof App !== 'function') throw new Error('src/main.tsx must default-export a React component.');
    root.render(<Boundary><App /><ToastHost /></Boundary>);
  } catch (e) {
    const msg = String((e as Error).stack ?? e);
    root.render(<div className="au-error-boundary">{msg}</div>);
    toHost({ type: 'agentui:error', message: msg.slice(0, 2000) });
  }
  toHost({ type: 'agentui:ready' });
  if (window.__AGENTUI.appId === 'widget') inlineWidget();
}

/** `agentui_widget_custom` widget shown in the chat: no full-height page, the iframe is sized to its content and transparent. */
function inlineWidget() {
  const style = document.createElement('style');
  style.textContent = 'html, body, #root { height: auto; } body { background: transparent; overflow-x: hidden; overflow-y: auto; } html.au-fullscreen, html.au-fullscreen body, html.au-fullscreen #root { height: 100%; }';
  document.head.appendChild(style);
  let last = 0;
  const report = () => {
    if (document.documentElement.classList.contains('au-fullscreen')) return; // the host gives the whole screen: nothing to size
    const h = Math.ceil(document.body.getBoundingClientRect().height);
    if (h !== last) { last = h; toHost({ type: 'agentui:resize', height: h }); }
  };
  new ResizeObserver(report).observe(document.body);
  report();
}
void main();
window.addEventListener('error', (e) => toHost({ type: 'agentui:error', message: String(e.message).slice(0, 2000) }));
window.addEventListener('unhandledrejection', (e) => toHost({ type: 'agentui:error', message: String((e.reason as Error)?.stack ?? e.reason).slice(0, 2000) }));
