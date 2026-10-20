// AgentUI Channel Protocol v1 — voir plugins/protocol/PROTOCOL.md.

export const PROTOCOL = 1;

export interface Media {
  name: string;
  mimeType: string;
  /** base64 */
  data: string;
}

export interface Capabilities {
  sessions: boolean;
  abort: boolean;
  approvals: boolean;
  subagents: boolean;
  reasoning: boolean;
  toolDetails: boolean;
  skills: boolean;
  jobs: boolean;
  jobControl: boolean;
  /** Deletion of the platform session when the user deletes the chat (rpc deleteSession). */
  sessionDelete?: boolean;
  /** Model of a chat: rpc listModels / setModel / sessionUsage and `usage` event. */
  models?: boolean;
  attachments: { images: boolean; files: boolean; maxBytes: number };
}

/** Model and accumulated consumption of a session. */
export interface Usage {
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  costEstimated?: boolean;
}

export type AgentEvent =
  | { type: 'message.delta'; text: string }
  | { type: 'message.final'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'tool.started'; id: string; name: string; args?: unknown; parentSubAgentRunId?: string }
  | { type: 'tool.completed'; id: string; name?: string; result?: string; truncated?: boolean; failed?: boolean }
  | { type: 'subagent.start'; id: string; name: string; sessionId?: string }
  | { type: 'subagent.sync'; id: string }
  | { type: 'subagent.end'; id: string; failed?: boolean }
  | ({ type: 'message.media' } & Media)
  | { type: 'conversation.title'; title: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'approval.request'; id: string; description: string; payload?: unknown }
  | { type: 'question.requested'; id: string }
  | { type: 'question.resolved'; id: string }
  | { type: 'run.completed' }
  | { type: 'run.failed'; error: string }
  | { type: 'run.aborted' };

export type PluginMessage =
  | {
      type: 'hello';
      protocol: typeof PROTOCOL;
      token: string;
      agent: { type: string; name: string; version?: string };
      capabilities: Capabilities;
      subAgents?: Array<{ id: string; name: string; description?: string; isDefault?: boolean }>;
      activeRuns?: Array<{ runId: string; conversationId: string }>;
      mode?: 'send-only';
    }
  | { type: 'event'; conversationId: string; runId: string; event: AgentEvent }
  | { type: 'outbound'; id: string; conversationId?: string; title?: string; text?: string; media?: Media[] }
  | { type: 'rpc.result'; id: string; result?: unknown; error?: string }
  /** Request on the agent's miniapps (create, write files…); answered by `miniapp.result`. */
  | { type: 'miniapp.op'; id: string; op: string; args?: unknown }
  /** Push notification to the user's devices; answered by `notify.result`. */
  | { type: 'notify'; id: string; title: string; body?: string; url?: string }
  /** Current title of a chat; answered by `thread.result`. */
  | { type: 'thread.get'; id: string; conversationId: string }
  | { type: 'pong' };

export type GatewayMessage =
  | { type: 'welcome'; protocol: number; miniapps?: boolean; notify?: boolean }
  | { type: 'miniapp.result'; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'notify.result'; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'thread.result'; id: string; ok: boolean; result?: { title: string }; error?: string }
  | { type: 'inbound'; conversationId: string; runId: string; text: string; subAgentId?: string; attachments?: Media[] }
  | { type: 'abort'; conversationId: string; runId: string }
  | { type: 'reply'; conversationId: string; runId: string; text: string }
  | { type: 'approval'; conversationId: string; runId: string; id: string; approve: boolean; scope?: 'once' | 'session' | 'always' }
  | { type: 'rpc'; id: string; method: string; params?: unknown }
  | { type: 'ping' };
