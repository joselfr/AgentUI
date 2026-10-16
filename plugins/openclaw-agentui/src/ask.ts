// Questions de l'outil `ask_user` d'OpenClaw ↔ widgets AgentUI (`ask` pour une question, `form` pour plusieurs).
export interface AskQuestion {
  id?: string;
  header?: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
}

/** Questions lues dans les arguments de l'outil ; `undefined` si la forme n'est pas celle attendue. */
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

/** Intitulé d'une question dans l'interface : en-tête et question, descriptions des options en liste Markdown. */
const titleOf = (q: AskQuestion) => [q.header && q.header !== q.question ? `**${q.header}**` : '', q.question].filter(Boolean).join('\n\n');
const describedOptions = (q: AskQuestion) => (q.options?.some((o) => o.description) ? '\n\n' + q.options.map((o) => `- **${o.label}**${o.description ? ` — ${o.description}` : ''}`).join('\n') : '');

/**
 * Bloc Markdown à afficher à la place du texte de la question (« Reply with the number… »).
 * `undefined` : on garde le texte d'OpenClaw (saisie secrète, rien à représenter).
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
    const hint = labels ? (q.multiSelect ? `Plusieurs réponses possibles, séparées par des virgules : ${labels.join(', ')}` : `Ex. : ${labels.join(', ')}`) : undefined;
    return { ...base, kind: 'text', ...(hint ? { hint } : {}) };
  });
  return fence({ type: 'form', arguments: { title: questions.map((q) => q.header).filter(Boolean).join(' · ') || 'Questions de l\'agent', submit: 'Répondre', fields } });
}

/**
 * Réponse de l'interface → réponse attendue par OpenClaw. Une seule question : le texte tel quel (numéro, libellé ou
 * texte libre). Plusieurs : les lignes « Question: valeur » du formulaire deviennent « 1: valeur », « 2: valeur »… (le cœur
 * les associe par numéro d'ordre ; « — » = champ vide).
 */
export function askReplyText(questions: AskQuestion[], text: string): string {
  if (questions.length < 2) return text;
  const answers = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    // Un libellé peut contenir « : » : on reconnaît la question par son texte, la plus longue d'abord.
    const i = questions
      .map((q, index) => ({ index, label: q.question }))
      .sort((a, b) => b.label.length - a.label.length)
      .find((c) => line.startsWith(`${c.label}: `))?.index;
    if (i !== undefined) {
      const value = line.slice(questions[i]!.question.length + 2).trim();
      answers.set(i, value === '—' ? '' : value);
    }
  }
  if (!answers.size) return text; // format inattendu (réponse libre au clavier) : le cœur la lit ligne par ligne
  return questions.map((_, i) => `${i + 1}: ${answers.get(i) ?? ''}`).join('\n');
}
