import type { AgentEvent, Message, ToolCall } from '@agentui/shared';

/** Applique un événement normalisé au dernier message assistant en streaming (miroir du serveur). */
export function applyEvent(messages: Message[], ev: AgentEvent): Message[] | null {
  const i = messages.findLastIndex((m) => m.role === 'assistant' && m.status === 'streaming');
  if (i < 0) return null; // run lancé ailleurs → l'appelant recharge via REST
  const m = { ...messages[i]! };
  const now = Date.now();
  switch (ev.type) {
    case 'message.delta': m.text += ev.text; break;
    case 'message.final': m.text = ev.text; break;
    case 'reasoning.delta': m.reasoning = (m.reasoning ?? '') + ev.text; break;
    case 'tool.started':
      m.toolCalls = [...(m.toolCalls ?? []).filter((t) => t.id !== ev.id),
        { id: ev.id, name: ev.name, status: 'running', args: ev.args, startedAt: now, parentSubAgentRunId: ev.parentSubAgentRunId }];
      break;
    case 'tool.completed':
      m.toolCalls = (m.toolCalls ?? []).map<ToolCall>((t) =>
        t.id === ev.id ? { ...t, status: ev.failed ? 'failed' : 'done', resultPreview: ev.result, resultTruncated: ev.truncated, endedAt: now } : t);
      break;
    case 'subagent.start':
      m.subAgentRuns = [...(m.subAgentRuns ?? []), { id: ev.id, name: ev.name, status: 'running', startedAt: now }];
      break;
    case 'subagent.end':
      m.subAgentRuns = (m.subAgentRuns ?? []).map((s) => (s.id === ev.id ? { ...s, status: ev.failed ? 'failed' : 'done', endedAt: now } : s));
      break;
    case 'run.completed': m.status = 'done'; break;
    case 'run.aborted': m.status = 'aborted'; break;
    case 'run.failed': m.status = 'failed'; m.text += `\n\n⚠️ ${ev.error}`; break;
    default: return messages;
  }
  const next = messages.slice();
  next[i] = m;
  return next;
}
