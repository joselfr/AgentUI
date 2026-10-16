// Réponse à une question `ask_user` par la passerelle d'OpenClaw (`question.resolve`), comme le fait l'interface
// de contrôle. La saisie « texte » captée par le cœur ne couvre pas les questions posées depuis le mode code
// (`exec`) : on résout donc la question elle-même, par son identifiant.
import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';

/** Question telle que la renvoie `question.get` (champs utiles). */
export interface QuestionRecordItem {
  questionId: string;
  options?: Array<{ label: string }>;
  multiSelect?: boolean;
  isOther?: boolean;
}

/** Une réponse → le libellé d'option qu'elle désigne (numéro 1…n ou libellé, sans tenir compte de la casse) ; sinon le texte libre si permis. */
function pick(q: QuestionRecordItem, raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const options = q.options ?? [];
  const byIndex = /^\d+$/.test(text) ? options[Number(text) - 1] : undefined;
  const found = byIndex ?? options.find((o) => o.label.toLowerCase() === text.toLowerCase());
  if (found) return found.label;
  if (options.length && !q.isOther) throw new Error(`« ${text} » ne correspond à aucune option`);
  return text;
}

function answerOf(q: QuestionRecordItem, raw: string): string[] {
  if (!q.multiSelect) return [pick(q, raw)].filter((v): v is string => !!v);
  return [...new Set(raw.split(/[,;\n]/).map((part) => pick(q, part)).filter((v): v is string => !!v))];
}

/**
 * Réponse de l'interface → `answers` de `question.resolve`. Une question : le texte entier. Plusieurs : lignes
 * « 1: valeur », « 2: valeur »… (voir `askReplyText`), une réponse vide laissant la question sans réponse.
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

/** Résout la question en attente `id` avec la réponse de l'utilisateur. */
export async function resolveQuestion(id: string, text: string, resolvedBy: string): Promise<void> {
  const call = (method: string, params: unknown) => callGatewayFromCli(method, { json: true, timeout: '15000' }, params);
  const got = (await call('question.get', { id })) as { question?: { status?: string; questions?: QuestionRecordItem[] } };
  const record = got.question;
  if (!record?.questions?.length) throw new Error('question introuvable');
  if (record.status && record.status !== 'pending') throw new Error(`question déjà ${record.status}`);
  await call('question.resolve', { id, answers: buildQuestionAnswers(record.questions, text), resolvedBy });
}
