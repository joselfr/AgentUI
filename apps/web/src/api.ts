import { t } from './i18n';
import type { AgentInfo, Job, Message, ModelOption, OutgoingAttachment, SearchHit, Skill, SubAgent, Usage } from '@agentui/shared';

export interface Conversation {
  id: string;
  agentId: string;
  subAgentId?: string;
  title: string;
  updatedAt: number;
  running: boolean;
  /** An agent message arrived since the last read. */
  unread: boolean;
  /** Pinned at the top of the list. */
  favorite: boolean;
  /** Filed in the "Archived" section. */
  archived: boolean;
  /** Model, tokens and cost of the session (latest known). */
  usage?: Usage;
  /** Chat dedicated to a cron task. */
  cron: boolean;
  /** Last read before the current opening (ms): used to spot unread messages. */
  lastReadAt: number;
}

export class UnauthorizedError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'agentui', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => { throw new Error(t('api.offline')); });
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
  skill: (id: string, skillId: string, sub?: string) => call<{ content: string }>('GET', `/agents/${id}/skills/${encodeURIComponent(skillId)}${q(sub)}`),
  jobs: (id: string, sub?: string) => call<Job[]>('GET', `/agents/${id}/jobs${q(sub)}`),
  jobAction: (id: string, jobId: string, action: string, sub?: string) =>
    call<{ ok: true }>('POST', `/agents/${id}/jobs/${encodeURIComponent(jobId)}/${action}${q(sub)}`),
  models: (agentId: string) => call<ModelOption[]>('GET', `/agents/${agentId}/models`),
  usage: (id: string) => call<Usage | null>('GET', `/conversations/${id}/usage`),
  setModel: (id: string, model: string, provider?: string) =>
    call<{ model: string; provider?: string; message?: string; usage?: Usage }>('PUT', `/conversations/${id}/model`, { model, provider }),
  search: (query: string) => call<SearchHit[]>('GET', `/search?q=${encodeURIComponent(query)}`),
  conversations: () => call<Conversation[]>('GET', '/conversations'),
  createConversation: (agentId: string, subAgentId?: string) => call<Conversation>('POST', '/conversations', { agentId, subAgentId }),
  markRead: (id: string) => call<{ ok: true }>('POST', `/conversations/${id}/read`),
  messages: (id: string) => call<{ conversation: Conversation; messages: Message[] }>('GET', `/conversations/${id}/messages`),
  rename: (id: string, title: string) => call('PATCH', `/conversations/${id}`, { title }),
  setFavorite: (id: string, favorite: boolean) => call('PATCH', `/conversations/${id}`, { favorite }),
  setArchived: (id: string, archived: boolean) => call('PATCH', `/conversations/${id}`, { archived }),
  remove: (id: string) => call('DELETE', `/conversations/${id}`),
  send: (id: string, text: string, attachments: OutgoingAttachment[] = []) =>
    call<{ runId: string; messageId: string }>('POST', `/conversations/${id}/send`, { text, attachments }),
  abort: (id: string) => call('POST', `/conversations/${id}/abort`),
  approval: (id: string, approvalId: string, approve: boolean) => call('POST', `/conversations/${id}/approval`, { approvalId, approve }),
};
