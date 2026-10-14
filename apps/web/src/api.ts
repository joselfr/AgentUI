import type { AgentInfo, Job, Message, OutgoingAttachment, Skill, SubAgent } from '@agentui/shared';

export interface Conversation {
  id: string;
  agentId: string;
  subAgentId?: string;
  title: string;
  updatedAt: number;
  running: boolean;
}

export class UnauthorizedError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'agentui', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith('/auth/login')) throw new UnauthorizedError();
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(e.error ?? e.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const q = (sub?: string) => (sub ? `?sub=${encodeURIComponent(sub)}` : '');

export const api = {
  me: () => call<{ user: { id: number; username: string } | null }>('GET', '/auth/me'),
  login: (username: string, password: string) => call<{ user: { username: string } }>('POST', '/auth/login', { username, password }),
  logout: () => call<{ ok: true }>('POST', '/auth/logout'),
  changePassword: (oldPassword: string, newPassword: string) => call<{ ok: true }>('POST', '/auth/password', { oldPassword, newPassword }),
  pushKey: () => call<{ publicKey: string }>('GET', '/push/key'),
  pushSubscribe: (sub: PushSubscriptionJSON) => call<{ ok: true }>('POST', '/push/subscribe', sub),
  pushUnsubscribe: (endpoint: string) => call<{ ok: true }>('POST', '/push/unsubscribe', { endpoint }),
  agents: () => call<AgentInfo[]>('GET', '/agents'),
  subAgents: (id: string) => call<SubAgent[]>('GET', `/agents/${id}/subagents`),
  skills: (id: string, sub?: string) => call<Skill[]>('GET', `/agents/${id}/skills${q(sub)}`),
  jobs: (id: string, sub?: string) => call<Job[]>('GET', `/agents/${id}/jobs${q(sub)}`),
  jobAction: (id: string, jobId: string, action: string, sub?: string) =>
    call<{ ok: true }>('POST', `/agents/${id}/jobs/${encodeURIComponent(jobId)}/${action}${q(sub)}`),
  conversations: () => call<Conversation[]>('GET', '/conversations'),
  createConversation: (agentId: string, subAgentId?: string) => call<Conversation>('POST', '/conversations', { agentId, subAgentId }),
  messages: (id: string) => call<{ conversation: Conversation; messages: Message[] }>('GET', `/conversations/${id}/messages`),
  rename: (id: string, title: string) => call('PATCH', `/conversations/${id}`, { title }),
  remove: (id: string) => call('DELETE', `/conversations/${id}`),
  send: (id: string, text: string, attachments: OutgoingAttachment[] = []) =>
    call<{ runId: string; messageId: string }>('POST', `/conversations/${id}/send`, { text, attachments }),
  abort: (id: string) => call('POST', `/conversations/${id}/abort`),
  approval: (id: string, approvalId: string, approve: boolean) => call('POST', `/conversations/${id}/approval`, { approvalId, approve }),
};
