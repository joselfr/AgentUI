import { z } from 'zod';

// ---------- Capacités ----------
export const CapabilitiesSchema = z.object({
  sessions: z.boolean(),
  abort: z.boolean(),
  approvals: z.boolean(),
  subagents: z.boolean(),
  reasoning: z.boolean(),
  toolDetails: z.boolean(), // args/résultat des outils disponibles
  skills: z.boolean(),
  jobs: z.boolean(),
  jobControl: z.boolean(), // pause/reprise/exécution/suppression
  sessionDelete: z.boolean().optional(), // suppression de la session de plateforme avec la discussion
  attachments: z.object({
    images: z.boolean(), // PNG/JPEG/GIF/WebP envoyés nativement
    files: z.boolean(), // fichiers binaires (PDF, zip…) ; les fichiers texte sont toujours insérés dans le message
    maxBytes: z.number(), // taille max par fichier
  }),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export type ConnStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

// ---------- Entités ----------
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
  /** `agent` : un prompt est confié à l'agent ; `script` : un script/une commande s'exécute sans agent. */
  mode?: 'agent' | 'script';
  prompt?: string;
  /** Script exécuté (chemin, commande ou source) : le job lui-même en mode `script`, collecte préalable en mode `agent`. */
  script?: string;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: string;
  /** Exécution demandée (« Exécuter maintenant »), pas encore prise par le planificateur. */
  queued?: boolean;
  /** Exécution en cours. */
  running?: boolean;
  lastError?: string;
  /** Destination côté plateforme (plugin canal) : id de la discussion qui reçoit les résultats. */
  deliverTo?: string;
  /** Discussion AgentUI correspondante, si elle existe déjà (renseigné par le serveur). */
  conversationId?: string;
}

/** Résultat de recherche : une discussion dont le titre ou un message correspond à tous les mots de la requête. */
export interface SearchHit {
  id: string;
  agentId: string;
  title: string;
  updatedAt: number;
  favorite: boolean;
  /** Le titre correspond (sinon seul un message correspond). */
  inTitle: boolean;
  /** Extrait du message le plus récent qui correspond. */
  snippet?: string;
  /** Plages [début, longueur] à surligner dans `snippet`. */
  marks?: [number, number][];
}

export interface Session {
  id: string; // id côté agent
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
  /** Session de l'agent distant où le sous-agent travaille (suivie jusqu'à sa fin). */
  sessionId?: string;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

/** Pièce jointe telle qu'envoyée par le navigateur (contenu en base64). */
export interface OutgoingAttachment {
  name: string;
  mimeType: string;
  data: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  subAgentRuns?: SubAgentRun[];
  attachments?: AttachmentMeta[];
  createdAt: number;
  runId?: string;
  status?: 'streaming' | 'done' | 'failed' | 'aborted';
}

// ---------- Événements normalisés ----------
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
  | { type: 'approval.request'; id: string; description: string; payload?: unknown }
  | { type: 'run.completed' }
  | { type: 'run.failed'; error: string }
  | { type: 'run.aborted' }
  /** Message proactif de l'agent (cron, envoi spontané) enregistré hors run : recharger la conversation. */
  | { type: 'message.added'; messageId: string };

export interface SendInput {
  text: string;
  subAgentId?: string;
  attachments?: AdapterAttachment[];
}

/** Pièce jointe validée, prête pour un adapter. `image` = envoi natif, `file` = fichier binaire. */
export interface AdapterAttachment {
  kind: 'image' | 'file';
  name: string;
  mimeType: string;
  data: Uint8Array;
}

// ---------- Configuration des agents ----------
export const AgentConfigSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().regex(/^[a-z0-9_-]+$/i),
    type: z.literal('hermes'),
    name: z.string(),
    url: z.string().url(),
    apiKey: z.string(),
    profiles: z.array(z.string()).default(['default']),
  }),
  z.object({
    id: z.string().regex(/^[a-z0-9_-]+$/i),
    type: z.literal('openclaw'),
    name: z.string(),
    url: z.string(), // ws:// ou wss://
    auth: z.object({ token: z.string().optional(), password: z.string().optional() }),
  }),
  // Agent relié par un plugin canal qui se connecte à AgentUI sur /gateway (plugins/protocol/PROTOCOL.md)
  z.object({
    id: z.string().regex(/^[a-z0-9_-]+$/i),
    type: z.literal('gateway'),
    name: z.string(),
    token: z.string().min(16, 'token de 16 caractères minimum'),
  }),
]);
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ConfigFileSchema = z.object({ agents: z.array(AgentConfigSchema) });
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

// ---------- Protocole front <-> backend (WS /ws) ----------
export type ServerPush =
  | { type: 'event'; seq: number; agentId: string; sessionId: string; runId: string; event: AgentEvent }
  | { type: 'agent.status'; agentId: string; status: ConnStatus; detail?: string }
  /** Discussion marquée lue (depuis un autre appareil) : retirer son indicateur « non lu ». */
  | { type: 'conversation.read'; conversationId: string };
