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
  /** Suppression de la session de plateforme quand l'utilisateur supprime la discussion (rpc deleteSession). */
  sessionDelete?: boolean;
  /** Modèle d'une discussion : rpc listModels / setModel / sessionUsage et événement `usage`. */
  models?: boolean;
  attachments: { images: boolean; files: boolean; maxBytes: number };
}

/** Modèle et consommation cumulée d'une session. */
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
  | { type: 'usage'; usage: Usage }
  | { type: 'approval.request'; id: string; description: string; payload?: unknown }
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
  | { type: 'pong' };

export type GatewayMessage =
  | { type: 'welcome'; protocol: number }
  | { type: 'inbound'; conversationId: string; runId: string; text: string; subAgentId?: string; attachments?: Media[] }
  | { type: 'abort'; conversationId: string; runId: string }
  | { type: 'approval'; conversationId: string; runId: string; id: string; approve: boolean; scope?: 'once' | 'session' | 'always' }
  | { type: 'rpc'; id: string; method: string; params?: unknown }
  | { type: 'ping' };
