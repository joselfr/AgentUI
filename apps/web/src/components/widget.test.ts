import { describe, expect, it } from 'vitest';
import { dropStrayFence, expandWidgetTokens, outOfTextWidgets, stepTimes } from './widget';

const chart = { kind: 'bar', x: ['a'], series: [{ name: 's', y: [1] }] };
const tool = (id: string, token = 'a3f9c1', args: unknown = chart, name = 'agentui_widget_chart') =>
  ({ id, name, args, resultPreview: `{"widget": "[[agentui:${token}]]", "instruction": "…"}` });
const widget = `\`\`\`widget\n${JSON.stringify({ type: 'chart', arguments: chart })}\n\`\`\``;

describe('agentui_widget_custom state updates', () => {
  const code = 'export default function W() { return null; }';
  const create = tool('t1', 'a3f9c1', { code, state: { n: 0 } }, 'agentui_widget_custom');
  const update = (id: string, n: number) => ({ id, name: 'agentui_widget_custom', args: { update: '[[agentui:a3f9c1]]', state: { n } }, resultPreview: '{"widget": "[[agentui:a3f9c1]]", "updated": true}' });
  const arg = (out: string) => JSON.parse(/```widget\n(.*)\n```/.exec(out)![1]!).arguments;
  it('keeps the code of the first call and the state of the latest one', () => {
    const out = expandWidgetTokens('[[agentui:a3f9c1]]', [create], [create, update('t2', 1), update('t3', 2)]);
    expect(arg(out)).toEqual({ code, state: { n: 2 }, token: '[[agentui:a3f9c1]]' }); // the widget knows its token (its events say where they come from)
  });
  it('conversations from before the renames (agentui_ui, agentui_custom_widget) still render', () => {
    for (const old of ['agentui_ui', 'agentui_custom_widget']) {
      const legacy = { ...create, name: old };
      const out = expandWidgetTokens('[[agentui:a3f9c1]]', [legacy], [legacy, { ...update('t2', 1), name: old }]);
      expect(arg(out)).toEqual({ code, state: { n: 1 }, token: '[[agentui:a3f9c1]]' });
    }
  });
  it('the display widgets keep rendering under their old tool names (agentui_chart…)', () => {
    expect(expandWidgetTokens('[[agentui:a3f9c1]]', [tool('t1', 'a3f9c1', chart, 'agentui_chart')])).toContain('```widget');
    expect(expandWidgetTokens('[[agentui:a3f9c1]]', [tool('t1', 'a3f9c1', chart, 'agentui_widget_chart')])).toContain('```widget');
    expect(expandWidgetTokens('[[agentui:a3f9c1]]', [tool('t1', 'a3f9c1', chart, 'agentui_miniapp_list')])).toBe('');
  });
  it('an update call does not create a second widget in its own message', () => {
    expect(expandWidgetTokens('Ton coup.', [update('t2', 1)], [create, update('t2', 1)])).toBe('Ton coup.');
  });
});

describe('expandWidgetTokens', () => {
  it('replaces the token in place in the text', () => {
    const out = expandWidgetTokens('Before\n[[agentui:a3f9c1]]\nAfter', [tool('t1')]);
    expect(out).toBe(`Before\n\n\n${widget}\n\n\nAfter`);
  });
  it('remplace plusieurs jetons', () => {
    const out = expandWidgetTokens('[[agentui:a3f9c1]] and [[agentui:b00001]]', [tool('t1'), tool('t2', 'b00001')]);
    expect(out.match(/```widget/g)).toHaveLength(2);
  });
  it('removes an unknown token', () => {
    expect(expandWidgetTokens('Texte [[agentui:ffffff]] fin', [])).toBe('Texte  fin');
  });
  it('hides a token being typed', () => {
    for (const tail of ['[', '[[', '[[agent', '[[agentui:', '[[agentui:a3f', '[[agentui:a3f9c1]']) {
      expect(expandWidgetTokens(`Voici ${tail}`, [tool('t1')], undefined, false)).toBe('Voici ');
    }
  });
  it('keeps an ordinary bracket at the end of the text', () => {
    expect(expandWidgetTokens('liste [1', [], undefined, false)).toBe('liste [1');
  });
  it('appends at the end of the message the widget whose token is missing, only once the message is finished', () => {
    expect(expandWidgetTokens('Texte', [tool('t1')], undefined, false)).toBe('Texte');
    expect(expandWidgetTokens('Texte', [tool('t1')])).toBe(`Texte\n\n${widget}\n\n`);
  });
  it("resolves the token of an earlier message", () => {
    const out = expandWidgetTokens('Again [[agentui:a3f9c1]]', [], [tool('t1')]);
    expect(out).toContain('```widget');
  });
  it('ignores a tool with invalid arguments or another tool', () => {
    expect(expandWidgetTokens('x [[agentui:a3f9c1]]', [tool('t1', 'a3f9c1', null)])).toBe('x ');
    expect(expandWidgetTokens('x [[agentui:a3f9c1]]', [tool('t1', 'a3f9c1', chart, 'terminal')])).toBe('x ');
  });
});

describe('progress widget (out of text)', () => {
  const steps = (...st: string[]) => ({ steps: st.map((status, i) => ({ label: `E${i + 1}`, status })) });
  const prog = (id: string, args: unknown, token = 'c0ffee') => ({ id, name: 'agentui_widget_progress', args, resultPreview: `{"widget": "[[agentui:${token}]]"}` });
  const states = (w: { arguments: Record<string, unknown> }) => (w.arguments.steps as Array<{ status: string }>).map((s) => s.status);

  it("shows from the tool call, without a token in the text, with the state of the latest call", () => {
    const calls = [prog('t1', steps('running', 'pending')), prog('t2', { update: '[[agentui:c0ffee]]', ...steps('done', 'running') })];
    const w = outOfTextWidgets(calls);
    expect(w).toHaveLength(1);
    expect(states(w[0]!)).toEqual(['done', 'running']);
    expect(expandWidgetTokens('', calls, undefined, false)).toBe('');
  });
  it("ignores the token written by the agent and adds nothing to the text", () => {
    const calls = [prog('t1', steps('running'))];
    expect(expandWidgetTokens('Here [[agentui:c0ffee]]', calls)).toBe('Here ');
    expect(expandWidgetTokens('Texte', calls)).toBe('Texte');
  });
  it('a later message does not show it again, but an update changes its state', () => {
    const first = prog('t1', steps('running'));
    const update = prog('t2', { update: '[[agentui:c0ffee]]', ...steps('done') });
    expect(outOfTextWidgets([update], [first, update])).toEqual([]);
    expect(states(outOfTextWidgets([first], [first, update])[0]!)).toEqual(['done']);
  });
  it('two distinct widgets, in creation order', () => {
    const calls = [prog('t1', steps('done'), 'aaaaaa'), prog('t2', steps('running'), 'bbbbbb')];
    expect(outOfTextWidgets(calls).map((w) => w.token)).toEqual(['aaaaaa', 'bbbbbb']);
  });
});

describe('stepTimes: step durations', () => {
  const call = (at: number, ...status: string[]) => ({ name: 'agentui_widget_progress', startedAt: at - 100, endedAt: at, args: { steps: status.map((s) => ({ label: 'x', status: s })) } });

  it('a step lasts from when it becomes running to when it becomes done', () => {
    const t = stepTimes([call(1000, 'running', 'pending'), call(13000, 'done', 'running'), call(20000, 'done', 'done')]);
    expect(t[0]).toEqual({ start: 1000, end: 13000 });
    expect(t[1]).toEqual({ start: 13000, end: 20000 });
  });
  it("a step still running has no end", () => {
    expect(stepTimes([call(1000, 'running'), call(5000, 'running')])[0]).toEqual({ start: 1000 });
  });
  it("a step first seen finished starts at the previous call; unknown at creation", () => {
    const t = stepTimes([call(1000, 'done', 'running'), call(9000, 'done', 'done')]);
    expect(t[0]).toEqual({ end: 1000 });
    expect(t[1]).toEqual({ start: 1000, end: 9000 });
  });
  it('is provided with the widget', () => {
    const calls = [{ ...call(1000, 'running'), id: 't1', resultPreview: '{"widget": "[[agentui:c0ffee]]"}' }, { ...call(4000, 'done'), id: 't2', resultPreview: '{"widget": "[[agentui:c0ffee]]"}' }];
    expect(outOfTextWidgets(calls)[0]!.times).toEqual([{ start: 1000, end: 4000 }]);
  });
});

describe('image widget: mapping of copied files', () => {
  const args = { images: [{ src: '/opt/data/a.png' }, { src: 'https://x.org/b.jpg' }] };
  const t = { id: 't1', name: 'agentui_widget_image', args, resultPreview: '{"widget": "[[agentui:a1b2c3]]", "files": {"/opt/data/a.png": "agentui-img-1234abcd-a.png"}}' };

  it('adds `files` to the widget arguments', () => {
    const out = expandWidgetTokens('Voici [[agentui:a1b2c3]]', [t]);
    const w = JSON.parse(/```widget\n(.*)\n```/.exec(out)![1]!);
    expect(w.type).toBe('image');
    expect(w.arguments.files).toEqual({ '/opt/data/a.png': 'agentui-img-1234abcd-a.png' });
    expect(w.arguments.images).toEqual(args.images);
  });
  it("tolerates a result without `files` or an unreadable one", () => {
    for (const resultPreview of ['{"widget": "[[agentui:a1b2c3]]"}', '[[agentui:a1b2c3]] not JSON']) {
      const w = JSON.parse(/```widget\n(.*)\n```/.exec(expandWidgetTokens('[[agentui:a1b2c3]]', [{ ...t, resultPreview }]))![1]!);
      expect(w.arguments.files).toEqual({});
    }
  });
});


describe('dropStrayFence', () => {
  const w = '```widget\n{"type":"ask","arguments":{"question":"?"}}\n```';
  it('removes an empty fence left open before a widget block', () => {
    expect(dropStrayFence(`Text.\n\`\`\`\n\n${w}`)).toBe(`Text.\n\n${w}`);
  });
  it('keeps a code block that is properly closed before the widget', () => {
    const t = `\`\`\`js\nlet a;\n\`\`\`\n\n${w}`;
    expect(dropStrayFence(t)).toBe(t);
  });
  it('leaves a text without a stray fence untouched', () => {
    expect(dropStrayFence(w)).toBe(w);
  });
});
