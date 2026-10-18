import type { AgentEvent, Message, ToolCall } from '@agentui/shared';

/** A finished run leaves no tool or sub-agent "running" (mirror of the server). */
function closeRunning(m: Message, status: 'done' | 'failed', now: number) {
  m.pendingQuestion = undefined;
  m.toolCalls = m.toolCalls?.map((t) => (t.status === 'running' ? { ...t, status, endedAt: now } : t));
  m.subAgentRuns = m.subAgentRuns?.map((s) => (s.status === 'running' && !s.sessionId ? { ...s, status, endedAt: now } : s));
}

/** The agent is waiting for an answer mid-run (question pending): its text is complete, the next message is the answer. */
export function isAwaiting(m: Message): boolean {
  return m.status === 'streaming' && !!m.pendingQuestion;
}

export function awaitingReply(messages: Message[]): boolean {
  const m = messages.findLast((x) => x.role === 'assistant' && x.status === 'streaming');
  return !!m && isAwaiting(m);
}

/** Applies a normalized event to the last streaming assistant message (mirror of the server). */
export function applyEvent(messages: Message[], ev: AgentEvent): Message[] | null {
  const i = messages.findLastIndex((m) => m.role === 'assistant' && m.status === 'streaming');
  if (i < 0) return null; // run started elsewhere → the caller reloads via REST
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
    case 'question.requested': m.pendingQuestion = ev.id; break;
    case 'question.resolved': if (m.pendingQuestion === ev.id) m.pendingQuestion = undefined; break;
    case 'attachment.added': m.attachments = [...(m.attachments ?? []), ev.attachment]; break;
    case 'subagent.start':
      m.subAgentRuns = [...(m.subAgentRuns ?? []), { id: ev.id, name: ev.name, status: 'running', startedAt: now, sessionId: ev.sessionId }];
      break;
    case 'subagent.end':
      m.subAgentRuns = (m.subAgentRuns ?? []).map((s) => (s.id === ev.id ? { ...s, status: ev.failed ? 'failed' : 'done', endedAt: now } : s));
      break;
    case 'run.completed': m.status = 'done'; closeRunning(m, 'done', now); break;
    case 'run.aborted': m.status = 'aborted'; closeRunning(m, 'failed', now); break;
    case 'run.failed': m.status = 'failed'; m.text += `\n\n⚠️ ${ev.error}`; closeRunning(m, 'failed', now); break;
    case 'subagent.sync': return null; // the caller reloads the messages
    default: return messages;
  }
  const next = messages.slice();
  next[i] = m;
  return next;
}
