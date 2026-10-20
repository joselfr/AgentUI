import { z } from 'zod';

// ---------- Capabilities ----------
export const CapabilitiesSchema = z.object({
  sessions: z.boolean(),
  abort: z.boolean(),
  approvals: z.boolean(),
  subagents: z.boolean(),
  reasoning: z.boolean(),
  toolDetails: z.boolean(), // tool args/result available
  skills: z.boolean(),
  jobs: z.boolean(),
  jobControl: z.boolean(), // pause/resume/run/delete
  sessionDelete: z.boolean().optional(), // deletion of the platform session along with the chat
  models: z.boolean().optional(), // model choice per chat + model and cost of a session
  attachments: z.object({
    images: z.boolean(), // PNG/JPEG/GIF/WebP sent natively
    files: z.boolean(), // binary files (PDF, zip…); text files are always inserted in the message
    maxBytes: z.number(), // max size per file
  }),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export type ConnStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

// ---------- Entities ----------
export interface AgentInfo {
  id: string;
  name: string;
  type: string;
  status: ConnStatus;
  statusDetail?: string;
  capabilities: Capabilities;
}

export interface SubAgent {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
}

export interface Skill {
  id: string;
  name: string;
  description?: string;
  category?: string;
  enabled?: boolean;
}

export interface Job {
  id: string;
  name: string;
  schedule: string;
  /** `agent`: a prompt is given to the agent; `script`: a script/command runs without an agent. */
  mode?: 'agent' | 'script';
  prompt?: string;
  /** Executed script (path, command or source): the job itself in `script` mode, prior collection in `agent` mode. */
  script?: string;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: string;
  /** Run requested ("Run now"), not yet picked up by the scheduler. */
  queued?: boolean;
  /** Run in progress. */
  running?: boolean;
  lastError?: string;
  /** Platform-side destination (channel plugin): id of the chat that receives the results. */
  deliverTo?: string;
  /** Matching AgentUI chat, if it already exists (filled in by the server). */
  conversationId?: string;
  /** Miniapp this task belongs to (tagged by the agent); deleted along with it. */
  miniappId?: string;
}

/** Search result: a chat whose title or a message matches all the words of the query. */
export interface SearchHit {
  id: string;
  agentId: string;
  title: string;
  updatedAt: number;
  favorite: boolean;
  archived?: boolean;
  /** The title matches (otherwise only a message matches). */
  inTitle: boolean;
  /** Excerpt of the most recent matching message. */
  snippet?: string;
  /** Ranges [start, length] to highlight in `snippet`. */
  marks?: [number, number][];
}

/** Consumption of an agent session: model used, tokens and cost accumulated since its start. */
export interface Usage {
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
  /** Accumulated cost in US dollars. */
  costUsd?: number;
  /** The cost is an estimate (public prices), not a billed amount. */
  costEstimated?: boolean;
}

/** A model the agent can use, with its provider. */
export interface ModelOption {
  provider: string;
  providerName: string;
  id: string;
}

export interface Session {
  id: string; // id on the agent side
  title: string;
  subAgentId?: string;
  updatedAt: number;
}

export type ToolStatus = 'running' | 'done' | 'failed';

export interface ToolCall {
  id: string;
  name: string;
  status: ToolStatus;
  args?: unknown;
  resultPreview?: string;
  resultTruncated?: boolean;
  startedAt: number;
  endedAt?: number;
  parentSubAgentRunId?: string;
}

export interface SubAgentRun {
  id: string;
  name: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  endedAt?: number;
  reasoning?: string;
  summary?: string;
  /** Session of the remote agent where the sub-agent works (tracked until it ends). */
  sessionId?: string;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

/** Attachment as sent by the browser (content in base64). */
export interface OutgoingAttachment {
  name: string;
  mimeType: string;
  data: string;
}

/** Origin of a user message that is an event of a dynamic widget (`token`: the `[[agentui:…]]` token of that widget). */
export interface WidgetEvent { token?: string }

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** Event of a dynamic widget (`reply(text, { silent: true })`) sent to the agent over its live session (`agentui_widget_custom_wait`): not shown in the chat. */
  hidden?: boolean;
  reasoning?: string;
  toolCalls?: ToolCall[];
  subAgentRuns?: SubAgentRun[];
  attachments?: AttachmentMeta[];
  createdAt: number;
  runId?: string;
  status?: 'streaming' | 'done' | 'failed' | 'aborted';
  /** Question asked by the agent mid-run, awaiting an answer (the prompt is in the text, as a widget). */
  pendingQuestion?: string;
}

// ---------- Normalized events ----------
export type AgentEvent =
  | { type: 'message.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'message.final'; text: string }
  | {
      type: 'tool.started';
      id: string;
      name: string;
      args?: unknown;
      parentSubAgentRunId?: string;
    }
  | {
      type: 'tool.completed';
      id: string;
      name?: string;
      result?: string;
      truncated?: boolean;
      failed?: boolean;
    }
  | { type: 'subagent.start'; id: string; name: string; sessionId?: string }
  | { type: 'subagent.sync'; id: string }
  | { type: 'subagent.end'; id: string; failed?: boolean }
  | { type: 'message.media'; url: string; name: string; mimeType?: string }
  | { type: 'attachment.added'; attachment: AttachmentMeta }
  /** The agent renames the conversation (tool `agentui_set_thread_title`); applied by the server, not shown in the chat. */
  | { type: 'conversation.title'; title: string }
  /** Accumulated consumption of the session, emitted at the end of a run. */
  | { type: 'usage'; usage: Usage }
  | { type: 'approval.request'; id: string; description: string; payload?: unknown }
  /** The agent waits for an answer mid-run: the user's next message hands it over, without a new run. */
  | { type: 'question.requested'; id: string }
  /** Question `id` no longer awaits an answer (answered, cancelled or expired). */
  | { type: 'question.resolved'; id: string }
  | { type: 'run.completed' }
  | { type: 'run.failed'; error: string }
  | { type: 'run.aborted' }
  /** Proactive message from the agent (cron, spontaneous send) recorded outside a run: reload the conversation. */
  | { type: 'message.added'; messageId: string };

export interface SendInput {
  text: string;
  subAgentId?: string;
  attachments?: AdapterAttachment[];
}

/** Validated attachment, ready for an adapter. `image` = native send, `file` = binary file. */
export interface AdapterAttachment {
  kind: 'image' | 'file';
  name: string;
  mimeType: string;
  data: Uint8Array;
}

// ---------- Agent configuration ----------
export const AgentConfigSchema = z.discriminatedUnion('type', [
  // Agent linked by a channel plugin that connects to AgentUI on /gateway (plugins/protocol/PROTOCOL.md)
  z.object({
    id: z.string().regex(/^[a-z0-9_-]+$/i),
    type: z.literal('gateway'),
    name: z.string(),
    token: z.string().min(16, 'token of at least 16 characters'),
  }),
]);
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ConfigFileSchema = z.object({ agents: z.array(AgentConfigSchema) });
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

// ---------- Protocole front <-> backend (WS /ws) ----------
export type ServerPush =
  | { type: 'event'; seq: number; agentId: string; sessionId: string; runId: string; event: AgentEvent }
  | { type: 'agent.status'; agentId: string; status: ConnStatus; detail?: string }
  /** Chat marked read (from another device): remove its "unread" indicator. */
  | { type: 'conversation.read'; conversationId: string }
  | { type: 'conversation.renamed'; conversationId: string; title: string }
  /** A miniapp was created, rebuilt or removed: refresh the Miniapps tab / reload the open iframe. */
  | { type: 'miniapp.changed'; appId: string; removed?: boolean }
  /** The data of a miniapp changed: its open iframe refetches. */
  | { type: 'miniapp.data'; appId: string };
export * from './theme.js';

/** Mini-app created by an agent, shown in the Miniapps tab. */
export interface MiniApp {
  id: string;
  agentId: string;
  name: string;
  /** Icon name (see the apps skill); the web app falls back to a generic one. */
  icon: string;
  description: string;
  /** Incremented on each build: the open iframe reloads when it changes. */
  version: number;
  updatedAt: number;
}
