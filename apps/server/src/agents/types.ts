import type {
  AgentEvent,
  Capabilities,
  ConnStatus,
  Job,
  Message,
  SendInput,
  Session,
  Skill,
  SubAgent,
} from '@agentui/shared';

export interface RunHandle {
  runId: string;
  /** Session distante (créée si absente). */
  sessionId: string;
  events: AsyncIterable<AgentEvent>;
}

/** Interface commune à tous les agents : un nouvel agent = un nouvel adapter. */
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
  listJobs(subAgentId?: string): Promise<Job[]>;
  jobAction?(jobId: string, action: 'pause' | 'resume' | 'run' | 'delete', subAgentId?: string): Promise<void>;
  /** Supprime la session de la plateforme (adaptateurs canal) ; absent = l'agent ne sait pas le faire. */
  deleteSession?(sessionId: string): Promise<void>;

  listSessions(): Promise<Session[]>;
  getMessages(sessionId: string): Promise<Message[]>;
  /** Télécharge un média produit par l'agent (image…) à partir de l'URL fournie dans ses événements. */
  /** Médias de la réponse d'un run apparus dans le transcript après sa fin (hors `seen`), sans attendre. */
  collectMedia?(runId: string, sessionId: string, seen: Set<string>): Promise<AgentEvent[]>;
  fetchMedia?(url: string): Promise<{ data: Buffer; mimeType: string }>;
  /** Session d'un sous-agent (raisonnement, outils, réponse) et indicateur de fin. */
  subSession?(sessionId: string): Promise<{ messages: Message[]; ended: boolean }>;

  send(sessionId: string | undefined, input: SendInput): Promise<RunHandle>;
  /** Rattache un run lancé avant un redémarrage d'AgentUI ; `null` si impossible. */
  resume?(runId: string, sessionId: string, subAgentId?: string): Promise<RunHandle | null>;
  abort(runId: string, sessionId: string): Promise<void>;
  resolveApproval?(runId: string, approvalId: string, approve: boolean): Promise<void>;
}

export type AdapterFactory<C> = (config: C) => AgentAdapter;
