import type {
  AgentEvent,
  Capabilities,
  ConnStatus,
  Job,
  Message,
  ModelOption,
  SendInput,
  Session,
  Skill,
  SubAgent,
  Usage,
} from '@agentui/shared';

export interface RunHandle {
  runId: string;
  /** Remote session (created if absent). */
  sessionId: string;
  events: AsyncIterable<AgentEvent>;
}

/** Interface common to all agents: a new agent = a new adapter. */
export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  status(): { status: ConnStatus; detail?: string };
  onStatus(cb: (s: ConnStatus, detail?: string) => void): void;
  capabilities(): Capabilities;

  listSubAgents(): Promise<SubAgent[]>;
  listSkills(subAgentId?: string): Promise<Skill[]>;
  /** Content (Markdown) of a skill; absent = the agent cannot read it. */
  readSkill?(skillId: string, subAgentId?: string): Promise<string>;
  listJobs(subAgentId?: string): Promise<Job[]>;
  jobAction?(jobId: string, action: 'pause' | 'resume' | 'run' | 'delete', subAgentId?: string): Promise<void>;
  /** Deletes the platform session (channel adapters); absent = the agent cannot do it. */
  deleteSession?(sessionId: string): Promise<void>;
  /** Available models (adapters that can switch per session). */
  listModels?(): Promise<ModelOption[]>;
  /** Sets the model of a session; returns the model actually retained. */
  setModel?(sessionId: string, model: string, provider?: string, subAgentId?: string): Promise<{ model: string; provider?: string; message?: string }>;
  /** Current model and consumption of an existing session (without waiting for a new run). */
  sessionUsage?(sessionId: string, subAgentId?: string): Promise<Usage | undefined>;

  listSessions(): Promise<Session[]>;
  getMessages(sessionId: string): Promise<Message[]>;
  /** Downloads a media produced by the agent (image…) from the URL given in its events. */
  /** Media of a run's reply that appeared in the transcript after it ended (outside `seen`), without waiting. */
  collectMedia?(runId: string, sessionId: string, seen: Set<string>): Promise<AgentEvent[]>;
  fetchMedia?(url: string): Promise<{ data: Buffer; mimeType: string }>;
  /** Session of a sub-agent (reasoning, tools, reply) and end indicator. */
  subSession?(sessionId: string): Promise<{ messages: Message[]; ended: boolean }>;

  send(sessionId: string | undefined, input: SendInput): Promise<RunHandle>;
  /** Reattaches a run started before an AgentUI restart; `null` if impossible. */
  resume?(runId: string, sessionId: string, subAgentId?: string): Promise<RunHandle | null>;
  abort(runId: string, sessionId: string): Promise<void>;
  resolveApproval?(runId: string, approvalId: string, approve: boolean): Promise<void>;
  /** Answers a question the agent asks mid-run (`question.requested`): the run resumes, it does not start another one. */
  reply?(runId: string, sessionId: string, text: string): Promise<void>;
}

export type AdapterFactory<C> = (config: C) => AgentAdapter;
