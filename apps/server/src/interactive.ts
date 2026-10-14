/** Convention Markdown « ask » : l'agent pose une question à l'utilisateur via un bloc de code annoté. */
export const ASK_INSTRUCTIONS = [
  "[Instructions d'interface AgentUI — ne pas mentionner dans ta réponse]",
  "Pour poser une question à l'utilisateur et attendre sa réponse, termine ta réponse par un bloc de code Markdown de langage `ask` :",
  '```ask',
  'Quelle couleur préfères-tu ?',
  '- Rouge',
  '- Bleu',
  '```',
  '- Première(s) ligne(s) : la question (Markdown permis).',
  '- Liste `- Choix` : l\'utilisateur en choisit un seul. Liste `- [ ] Choix` : il peut en choisir plusieurs. Sans liste : réponse libre.',
  "- N'écris rien après ce bloc et n'en mets qu'un par réponse. Ne l'utilise que si tu as réellement besoin d'une information de l'utilisateur.",
].join('\n');
