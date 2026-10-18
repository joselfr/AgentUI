// Answer to an `ask_user` question through OpenClaw's gateway (`question.resolve`), as the control interface does.
// The "text" input captured by the core does not cover questions asked from code mode
// (`exec`): so we resolve the question itself, by its identifier.
import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';

/** Question as returned by `question.get` (useful fields). */
export interface QuestionRecordItem {
  questionId: string;
  options?: Array<{ label: string }>;
  multiSelect?: boolean;
  isOther?: boolean;
}

/** An answer → the option label it designates (number 1…n or label, case-insensitive); otherwise the free text if allowed. */
function pick(q: QuestionRecordItem, raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const options = q.options ?? [];
  const byIndex = /^\d+$/.test(text) ? options[Number(text) - 1] : undefined;
  const found = byIndex ?? options.find((o) => o.label.toLowerCase() === text.toLowerCase());
  if (found) return found.label;
  if (options.length && !q.isOther) throw new Error(`"${text}" does not match any option`);
  return text;
}

function answerOf(q: QuestionRecordItem, raw: string): string[] {
  if (!q.multiSelect) return [pick(q, raw)].filter((v): v is string => !!v);
  return [...new Set(raw.split(/[,;\n]/).map((part) => pick(q, part)).filter((v): v is string => !!v))];
}

/**
 * Interface answer → `answers` of `question.resolve`. One question: the whole text. Several: lines
 * "1: value", "2: value"… (see `askReplyText`), an empty answer leaving the question unanswered.
 */
export function buildQuestionAnswers(questions: QuestionRecordItem[], text: string): { answers: Record<string, string[]> } {
  const answers: Record<string, string[]> = {};
  if (questions.length === 1) {
    answers[questions[0]!.questionId] = answerOf(questions[0]!, text);
    return { answers };
  }
  const lines = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*:\s*(.*)$/.exec(line);
    if (m) lines.set(Number(m[1]), m[2]!);
  }
  questions.forEach((q, i) => {
    answers[q.questionId] = answerOf(q, lines.get(i + 1) ?? '');
  });
  return { answers };
}

/** Resolves the pending question `id` with the user's answer. */
export async function resolveQuestion(id: string, text: string, resolvedBy: string): Promise<void> {
  const call = (method: string, params: unknown) => callGatewayFromCli(method, { json: true, timeout: '15000' }, params);
  const got = (await call('question.get', { id })) as { question?: { status?: string; questions?: QuestionRecordItem[] } };
  const record = got.question;
  if (!record?.questions?.length) throw new Error('question not found');
  if (record.status && record.status !== 'pending') throw new Error(`question already ${record.status}`);
  await call('question.resolve', { id, answers: buildQuestionAnswers(record.questions, text), resolvedBy });
}
