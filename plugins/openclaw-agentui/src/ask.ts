// `ask_user` tool questions of OpenClaw ↔ AgentUI widgets (`ask` for one question, `form` for several).
export interface AskQuestion {
  id?: string;
  header?: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
}

/** Questions read from the tool arguments; `undefined` if the shape is not the expected one. */
export function parseAskQuestions(args: unknown): AskQuestion[] | undefined {
  const list = (args as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(list) || !list.length) return undefined;
  const out: AskQuestion[] = [];
  for (const q of list as Array<Record<string, unknown>>) {
    if (typeof q?.question !== 'string') return undefined;
    const options = Array.isArray(q.options)
      ? (q.options as Array<Record<string, unknown>>).filter((o) => typeof o?.label === 'string').map((o) => ({ label: o.label as string, ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}) }))
      : undefined;
    out.push({
      ...(typeof q.id === 'string' ? { id: q.id } : {}),
      ...(typeof q.header === 'string' && q.header ? { header: q.header } : {}),
      question: q.question,
      ...(options?.length ? { options } : {}),
      multiSelect: q.multiSelect === true,
      isOther: q.isOther === true,
      isSecret: q.isSecret === true,
    });
  }
  return out;
}

const fence = (widget: object) => '```widget\n' + JSON.stringify(widget) + '\n```';

/** Label of a question in the interface: header and question, option descriptions as a Markdown list. */
const titleOf = (q: AskQuestion) => [q.header && q.header !== q.question ? `**${q.header}**` : '', q.question].filter(Boolean).join('\n\n');
const describedOptions = (q: AskQuestion) => (q.options?.some((o) => o.description) ? '\n\n' + q.options.map((o) => `- **${o.label}**${o.description ? ` — ${o.description}` : ''}`).join('\n') : '');

/**
 * Markdown block to display in place of the question text ("Reply with the number…").
 * `undefined`: keep OpenClaw's text (secret input, nothing to represent).
 */
export function askWidget(questions: AskQuestion[]): string | undefined {
  if (questions.some((q) => q.isSecret)) return undefined;
  if (questions.length === 1) {
    const q = questions[0]!;
    return fence({ type: 'ask', arguments: { question: titleOf(q) + describedOptions(q), ...(q.options ? { options: q.options.map((o) => o.label) } : {}), ...(q.multiSelect ? { multiple: true } : {}) } });
  }
  const fields = questions.slice(0, 12).map((q, i) => {
    const labels = q.options?.map((o) => o.label);
    const base = { name: `q${i + 1}`, label: q.question, required: true };
    if (labels && !q.multiSelect && !q.isOther) return { ...base, kind: 'select', options: labels };
    const hint = labels ? (q.multiSelect ? `Several answers possible, separated by commas: ${labels.join(', ')}` : `E.g.: ${labels.join(', ')}`) : undefined;
    return { ...base, kind: 'text', ...(hint ? { hint } : {}) };
  });
  return fence({ type: 'form', arguments: { title: questions.map((q) => q.header).filter(Boolean).join(' · ') || 'Agent questions', submit: 'Answer', fields } });
}

/**
 * Interface answer → answer expected by OpenClaw. A single question: the text as is (number, label or
 * free text). Several: the "Question: value" lines of the form become "1: value", "2: value"… (the core
 * matches them by order number; "—" = empty field).
 */
export function askReplyText(questions: AskQuestion[], text: string): string {
  if (questions.length < 2) return text;
  const answers = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    // A label may contain ": ": the question is recognized by its text, the longest first.
    const i = questions
      .map((q, index) => ({ index, label: q.question }))
      .sort((a, b) => b.label.length - a.label.length)
      .find((c) => line.startsWith(`${c.label}: `))?.index;
    if (i !== undefined) {
      const value = line.slice(questions[i]!.question.length + 2).trim();
      answers.set(i, value === '—' ? '' : value);
    }
  }
  if (!answers.size) return text; // unexpected format (free keyboard answer): the core reads it line by line
  return questions.map((_, i) => `${i + 1}: ${answers.get(i) ?? ''}`).join('\n');
}
