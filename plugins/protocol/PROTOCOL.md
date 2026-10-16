# AgentUI Channel Protocol — v1

Protocole entre AgentUI (la « gateway », comme Telegram pour un bot) et un **plugin canal** installé dans une plateforme
d'agents (Hermes, OpenClaw…). Schéma JSON : [`channel.schema.json`](channel.schema.json).

## Transport

- WebSocket, **ouverte par le plugin** vers AgentUI : `wss://<agentui>/gateway` (ws:// en local).
- Une trame = un objet JSON texte, avec un champ `type`.
- Le plugin s'authentifie dans son premier message (`hello.token`). AgentUI ferme avec le code **4001** si le token est
  invalide, et **4002** si la version de protocole n'est pas supportée.
- Le plugin se reconnecte tout seul (backoff exponentiel plafonné à 30 s). AgentUI envoie `ping` toutes les 30 s ; le
  plugin répond `pong`.

## Messages plugin → AgentUI

| `type` | Champs | Rôle |
|---|---|---|
| `hello` | `protocol: 1`, `token`, `agent: { type, name, version }`, `capabilities`, `subAgents?: [{ id, name, description?, isDefault? }]`, `activeRuns?: [{ runId, conversationId }]`, `mode?: "send-only"` | Premier message. `capabilities` reprend le type `Capabilities` d'AgentUI. `activeRuns` liste les runs encore en cours après une reconnexion : AgentUI les rattache au lieu de les marquer en échec. `mode: "send-only"` : connexion éphémère (cron exécuté hors du processus principal) qui n'envoie que des `outbound` et **ne remplace pas** la connexion principale. |
| `event` | `conversationId`, `runId`, `event` | Un événement de run, au format `AgentEvent` d'AgentUI (voir plus bas). |
| `outbound` | `id`, `conversationId?`, `title?`, `text?`, `media?: Media[]` | **Message proactif** (cron, rappel, outil `send_message`…) hors de tout run. Sans `conversationId`, AgentUI le range dans la discussion « maison » de l'agent. `title` : titre proposé si la discussion doit être créée (ex. « ⏰ nom-de-la-tâche » pour un cron). |
| `rpc.result` | `id`, `result?` \| `error?` | Réponse à un `rpc`. |
| `pong` | — | Réponse à `ping`. |

## Messages AgentUI → plugin

| `type` | Champs | Rôle |
|---|---|---|
| `welcome` | `protocol: 1` | Accepte le `hello`. |
| `inbound` | `conversationId`, `runId`, `text`, `subAgentId?`, `attachments?: Media[]` | Message de l'utilisateur. **Chaque `conversationId` est un chat distinct** pour la plateforme, et donc une session distincte (fils multiples). Le `runId` est choisi par AgentUI. |
| `abort` | `conversationId`, `runId` | Arrêter le run. |
| `reply` | `conversationId`, `runId`, `text` | Réponse de l'utilisateur à une question que l'agent pose **en plein run** (annoncée par `question.requested`). Le plugin la remet à l'agent en attente : le run se poursuit et se termine normalement, ce n'est pas un nouvel `inbound`. Facultatif : AgentUI n'en envoie que tant qu'une question est ouverte. |
| `approval` | `conversationId`, `runId`, `id`, `approve: boolean`, `scope?: "once" \| "session" \| "always"` | Réponse à un `approval.request`. |
| `rpc` | `id`, `method`, `params?` | Appel optionnel. Méthode inconnue : `rpc.result` avec `error`. Méthodes : `listSubAgents` → `[{ id, name, description?, isDefault? }]` ; `listJobs {subAgentId?}` → `[{ id, name, schedule, mode?: agent\|script, prompt?, script?, enabled, nextRunAt?, lastRunAt?, lastStatus? }]` (si `capabilities.jobs`) ; `jobAction {jobId, action: pause\|resume\|run\|delete}` → `{ ok: true }` (si `capabilities.jobControl`) ; `listSkills {subAgentId?}` → `[{ id, name, description?, category?, enabled? }]` (si `capabilities.skills`) ; `deleteSession {conversationId}` → `{ ok: true }` (si `capabilities.sessionDelete`) ; `listModels` → `[{ provider, providerName, id }]`, `setModel {conversationId, model, provider?, subAgentId?}` → `{ model, provider?, message? }` et `sessionUsage {conversationId, subAgentId?}` → `Usage` ou `null` (si `capabilities.models`). Dates en millisecondes. |
| `ping` | — | Maintien de la connexion. |

## Événements (`event.event`)

Identiques au type `AgentEvent` de `packages/shared` (une seule exception : `message.media`) :

| `type` | Champs |
|---|---|
| `message.delta` | `text` (incrément) |
| `message.final` | `text` (texte complet du message ; remplace les deltas accumulés) |
| `reasoning.delta` | `text` |
| `tool.started` | `id`, `name`, `args?`, `parentSubAgentRunId?` |
| `tool.completed` | `id`, `name?`, `result?`, `truncated?`, `failed?` |
| `subagent.start` / `subagent.sync` / `subagent.end` | `id`, `name`, `sessionId?` / `id` / `id`, `failed?` |
| `message.media` | `name`, `mimeType`, `data` (base64) — **au lieu de `url`** : le plugin pousse le contenu |
| `usage` | `usage` : `{ model?, provider?, inputTokens, outputTokens, cacheReadTokens?, reasoningTokens?, costUsd?, costEstimated? }` — consommation **cumulée de la session**, émise avant `run.completed` (si `capabilities.models`) |
| `approval.request` | `id`, `description`, `payload?` |
| `question.requested` | `id` | L'agent attend une réponse de l'utilisateur **sans terminer le run** (outil `clarify` d'Hermes, `ask_user` d'OpenClaw…). À émettre **avant** le message qui porte la question, que le plugin rend dans le texte (widget `ask`, ou `form` pour plusieurs questions à la fois). Tant qu'elle est ouverte, AgentUI accepte un message de l'utilisateur comme réponse (trame `reply`) au lieu de refuser « run déjà en cours ». |
| `question.resolved` | `id` | La question `id` n'attend plus de réponse : répondue, annulée ou expirée. Un `run.*` terminal la ferme aussi. |
| `run.completed` / `run.failed` (`error`) / `run.aborted` | — |

## Règles

1. **Le plugin possède le cycle de vie du run** : tout `inbound` reçoit exactement **un** événement terminal
   (`run.completed`, `run.failed` ou `run.aborted`), y compris en cas d'erreur de la plateforme.
2. Un même `conversationId` donne toujours la même session côté plateforme. Un nouveau `conversationId` donne une
   nouvelle session, sans `/new`.
3. Les messages produits pendant un run (y compris les médias) sont des `event` portant ce `runId`. En dehors d'un run,
   ce sont des `outbound`.
4. `Media` = `{ name, mimeType, data }`, `data` en base64. Les plugins limitent la taille annoncée dans
   `capabilities.attachments.maxBytes`.
5. Champs inconnus : à ignorer (compatibilité ascendante). Changement incompatible : `protocol: 2`.
6. `deleteSession` (si `capabilities.sessionDelete`) : supprime la session de plateforme liée à ce
   `conversationId` — la discussion n'est effacée côté AgentUI que si le plugin répond `ok`. Une discussion
   inconnue de la plateforme n'est **pas** une erreur (idempotent) ; un refus (session active, erreur interne)
   se répond par `rpc.result` avec `error`.

## Exemple

```jsonc
// plugin → AgentUI
{"type":"hello","protocol":1,"token":"…","agent":{"type":"hermes","name":"Hermes","version":"0.19.0"},
 "capabilities":{"sessions":true,"abort":true,"approvals":true,"subagents":true,"reasoning":true,"toolDetails":true,
  "skills":false,"jobs":false,"jobControl":false,"attachments":{"images":true,"files":true,"maxBytes":20971520}}}
// AgentUI → plugin
{"type":"welcome","protocol":1}
{"type":"inbound","conversationId":"c_42","runId":"r_1","text":"Liste les fichiers"}
// plugin → AgentUI
{"type":"event","conversationId":"c_42","runId":"r_1","event":{"type":"tool.started","id":"t1","name":"terminal","args":{"command":"ls"}}}
{"type":"event","conversationId":"c_42","runId":"r_1","event":{"type":"tool.completed","id":"t1","result":"a.txt\nb.txt"}}
{"type":"event","conversationId":"c_42","runId":"r_1","event":{"type":"message.delta","text":"Voici "}}
{"type":"event","conversationId":"c_42","runId":"r_1","event":{"type":"message.final","text":"Voici les fichiers : a.txt, b.txt"}}
{"type":"event","conversationId":"c_42","runId":"r_1","event":{"type":"run.completed"}}
// plus tard, un cron :
{"type":"outbound","id":"o_7","text":"Rappel : réunion à 14 h"}
```
