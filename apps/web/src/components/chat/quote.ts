/** Quoting in the chat: a quote travels as a Markdown blockquote at the start of the user's message (`> line`), so the agent reads it
 *  as is, it survives a reload and needs no protocol change; the bubble renders it as a quote. */
const MAX_QUOTE = 400;

/** Text of a message without its widget fences and `[[agentui:…]]` tokens (what a person would copy or quote). */
export function plainText(text: string): string {
  return text
    .replace(/```(?:widget|ask)[^\S\n]*\n[\s\S]*?\n?```/g, '')
    .replace(/\[\[agentui:[0-9a-f]*\]?\]?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `quote` + the user's `text` → the message sent. The quote is cut to 400 characters. */
export function withQuote(quote: string | null | undefined, text: string): string {
  const q = (quote ?? '').trim();
  if (!q) return text;
  const cut = q.length > MAX_QUOTE ? `${q.slice(0, MAX_QUOTE).trimEnd()}…` : q;
  return `${cut.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')}\n\n${text}`;
}

/** Inverse of `withQuote`: the leading blockquote of a message and the rest. */
export function splitQuote(text: string): { quote?: string; body: string } {
  const lines = text.split('\n');
  let n = 0;
  while (n < lines.length && /^>( |$)/.test(lines[n]!)) n++;
  if (!n) return { body: text };
  const quote = lines.slice(0, n).map((l) => l.replace(/^> ?/, '')).join('\n').trim();
  return quote ? { quote, body: lines.slice(n).join('\n').replace(/^\n+/, '') } : { body: text };
}
