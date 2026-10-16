# Spike : AgentUI comme canal (plugins Hermes / OpenClaw)

Versions étudiées (sources lues, pas seulement la doc) :
- **Hermes Agent 0.19.0** (sdist PyPI : `gateway/platforms/base.py`, `gateway/stream_*.py`, `plugins/platforms/irc`, `plugins/platforms/telegram`, `hermes_cli/plugins.py`, `tools/approval.py`) ;
- **OpenClaw 2026.10.3** (npm : `docs/plugins/*`, types `dist/plugin-sdk/*.d.ts`, canal Telegram compilé `dist/bot-message-*.mjs`).

Conclusion : **les deux plateformes exposent assez de choses à un plugin pour conserver l'essentiel de l'UI riche**
(streaming, cartes d'outils, approbations, arrêt, fils multiples), et un plugin gagne des capacités que l'adapter actuel n'a pas
(messages proactifs, crons livrés dans AgentUI, connexion sortante). Les pertes concernent les listes « d'administration »
(skills, jobs, historique distant), qui ne relèvent pas d'un canal.

## Matrice des capacités

| Capacité AgentUI | Hermes (plugin plateforme) | OpenClaw (plugin canal) |
|---|---|---|
| Message entrant | `MessageEvent` + `self.handle_message(event)` ; `build_source(chat_id=…, chat_type="dm")` | `runtime.channel.inbound.buildContext(...)` puis `runtime.channel.inbound.run({ adapter: { ingest, resolveTurn } })` (même séquence que le canal Telegram) |
| **Fils multiples** | ✅ La clé de session gateway = plateforme + `chat_id` (+ `thread_id`). Un `conversationId` donne une session. | ✅ `routing.resolveAgentRoute({ peer: { kind: "direct", id: conversationId }, dmScope: "per-channel-peer" })`. **Il faut forcer `dmScope`** : avec la valeur par défaut `main`, tous les DM tombent dans la session principale. |
| Choix du sous-agent | Un profil Hermes = une gateway, donc une connexion par profil | `resolveAgentRoute({ defaultAgentId })` ; les bindings de configuration restent prioritaires |
| Deltas de texte | ✅ Surcharge de `render_message_event(event, sink)` : `MessageChunk.text`, `sink.chat_id`. Exige que le streaming soit activé (`streaming.enabled`), sinon le texte final arrive seul. | ✅ `replyOptions.onPartialReply` (+ `onAssistantMessageStart` pour séparer les segments) |
| Texte final | `send(chat_id, content)` | `delivery.deliver(payload)` (`payload.text`, `mediaUrls`) |
| Raisonnement | ⚠️ Pas de flux. Disponible en fin de tour via le hook `post_llm_call(conversation_history=…)` (champ `reasoning` des messages assistant). | ✅ `replyOptions.onReasoningStream` / `onReasoningEnd` |
| Outil démarré | ✅ Hook `pre_tool_call` (nom, args, `tool_call_id`) ; `format_tool_event` en secours | ✅ `replyOptions.onToolStart({ toolCallId, name, args })` |
| Outil terminé (+ résultat) | ✅ Hook `post_tool_call(tool_name, args, result, tool_call_id, duration_ms, status)` | ✅ `api.runtime.events.onAgentEvent` (`stream: "tool"`, filtré par `runId`) ; `onItemEvent` en secours |
| Contexte des hooks | `gateway.session_context.get_session_env("HERMES_SESSION_PLATFORM" / "HERMES_SESSION_CHAT_ID")` : les ContextVars sont propagées au thread de l'agent via `copy_context()` | `runId` imposé par le plugin (`replyOptions.runId`), donc une corrélation directe |
| Sous-agents | ✅ Hooks `subagent_start` / `subagent_stop` (`parent_session_id`) | ⚠️ Possible via les événements `item` / outil `sessions_spawn` (`onAgentEvent`) et `onVisibleWorkSessions`, **pas encore implémenté** dans le plugin |
| Approbations | ✅ Méthode `send_exec_approval(chat_id, command, session_key, description, …)` puis `tools.approval.resolve_gateway_approval(session_key, choice)` (`once` / `session` / `always` / `deny`) | ✅ Livrées par le cœur comme payload « même chat » (texte + boutons `/approve <id> …`). Le plugin en extrait l'id et répond avec une commande `/approve`. (`approvalCapability` natif : à faire plus tard.) |
| Arrêt | ✅ Injection d'un `MessageEvent` `/stop`, qui interrompt immédiatement le run (`_interrupt_and_clear_session`) | ✅ `replyOptions.abortSignal` (un `AbortController` par run) |
| Fin de run | ✅ Hook adaptateur `on_processing_complete(event, ProcessingOutcome.SUCCESS / FAILURE / CANCELLED)` | ✅ Résolution de `inbound.run(...)` + `onAgentRunTerminalOutcome("completed" / "failed")` |
| Médias sortants | `send_image` / `send_image_file` / `send_document` / `send_voice` / `send_video` (URL ou chemin local) | `payload.mediaUrls` (chemins ou URL locales) dans `deliver` |
| Pièces jointes entrantes | `cache_image_from_bytes` / `cache_document_from_bytes`, puis `MessageEvent.media_urls` + `media_types` | `toInboundMediaFacts([{ path, contentType }])`, puis `buildContext({ media })` (enregistrement via `runtime.channel.media`) |
| **Messages proactifs / crons** | ✅ `send()` hors run actif ; `cron_deliver_env_var` (`deliver=agentui`) ; `standalone_sender_fn` pour les crons exécutés hors de la gateway | ✅ `outbound.sendText` / `sendMedia` appelés par le cœur (cron, outil `message`) avec `to = conversationId` |
| Autorisation | `trusted_inbound` **interdit** ; le token AgentUI suffit, avec `AGENTUI_ALLOW_ALL_USERS=true` et un `user_id` fixe | `security.dm` en `open` ; l'authentification se fait au niveau du token WS |
| Liste des sessions distantes | ❌ (non exposé aux plateformes) → AgentUI garde sa propre base | ❌ (idem ; `runtime.agent` permet de lire les transcripts, à voir plus tard) |
| Skills / jobs / administration | ❌ Hors du périmètre d'un canal | ❌ Hors du périmètre d'un canal |

## Décisions issues du spike

1. **Protocole unique** (`protocol/PROTOCOL.md`) qui reprend tel quel le type `AgentEvent` d'AgentUI ; seuls les médias
   voyagent en base64 au lieu d'une URL.
2. **Le plugin possède le cycle de vie du run** : chaque `inbound` reçoit exactement un `run.completed`, `run.failed` ou `run.aborted`.
   Cela supprime les heuristiques de fin de run de l'adapter OpenClaw actuel.
3. **Hermes** : le streaming doit être activé pour la plateforme `agentui` (le plugin l'impose dans `plugin.yaml` / la doc).
   Le raisonnement arrive d'un bloc en fin de tour.
4. **OpenClaw** : `dmScope: "per-channel-peer"` est forcé dans le plugin, et non laissé à la configuration globale.
5. **Approbations OpenClaw** : phase 1 par commande `/approve` dans le même chat. Le natif `approvalCapability` est différé
   (API lourde et peu documentée pour un canal externe).

## Risques identifiés

- Le SDK canal d'OpenClaw évolue vite (plusieurs alias marqués `removeAfter 2026-10-01`). Le plugin s'appuie sur les
  surfaces **non dépréciées** (`runtime.channel.inbound.run` / `buildContext`, `routing.resolveAgentRoute`).
- Hermes publie plusieurs versions par semaine. Les points d'ancrage retenus (`BasePlatformAdapter`, `register_platform`,
  hooks `VALID_HOOKS`) sont l'API publique documentée des plugins.
- Ni l'un ni l'autre n'a été exécuté contre une vraie instance pendant ce spike (les agents tournent sur jlfr.io). Il faudra
  valider avec `dev/mock-gateway.mjs`.

## Widgets comme outils de plugin (`agentui_chart`, `agentui_map`, `agentui_code`) : jetons

Au lieu du bloc ```` ```widget ````, chaque widget d'affichage est un outil fourni par le plugin. L'outil valide ses arguments
(schéma JSON + contrôles sémantiques : longueur de `y`, un seul camembert…) et renvoie un **jeton** `[[agentui:<id>]]` que
l'agent écrit dans son texte, à l'endroit voulu. AgentUI remplace le jeton par le widget **au rendu** (front,
`expandWidgetTokens`) : les arguments viennent de `tool.started`, le jeton de `tool.completed`. Aucun événement nouveau,
rien à développer dans les plugins pour l'expansion, et l'historique rechargé fonctionne tel quel.

- Schémas : source unique `protocol/widget-tools.json`, copiée dans chaque plugin par `node plugins/sync-widget-tools.mjs` (à relancer après modification).
- Les sections `chart`/`map`/`code` ont été **retirées** des instructions d'interface (`WIDGET_INSTRUCTIONS`) : seuls les outils existent pour ces widgets, donc un agent sans plugin ne les a pas. `ask`/`confirm`/`form` restent en convention.
- Jeton en cours de frappe (streaming) : masqué ; jeton inconnu : supprimé ; widget dont le jeton n'a jamais été écrit : ajouté en fin de message une fois terminé.

| | Hermes 0.19 | OpenClaw 2026.10.3 |
|---|---|---|
| Enregistrement | `ctx.register_tool(name, toolset, schema, handler)` ✅ vérifié sur une vraie instance | `api.registerTool(factory, { names })` + `contracts.tools` dans le manifeste ✅ (tests + `tsc`, pas de vraie gateway) |
| Visible seulement dans AgentUI | ❌ les outils de plugin sont activés sur **toutes** les plateformes (vérifié : Telegram les voit) ; `check_fn` est mis en cache 30 s donc inutilisable par session. Repli : le handler refuse hors AgentUI. Ou désactiver le toolset `agentui` des autres plateformes (`hermes tools`). | ✅ la fabrique reçoit `ctx.messageChannel` et renvoie `null` hors `agentui` |
| Outil bloquant (widgets interactifs, non migrés) | possible (handler synchrone dans le thread de l'agent, comme `clarify`) | possible (`execute` asynchrone) ; `ctx.nativeChannelId` = `conversationId` |

## Widgets interactifs comme outils bloquants (`agentui_ask`, `agentui_confirm`, `agentui_form`)

Schémas dans `protocol/widget-tools.json`, section `blockingTools`. Contrairement aux outils d'affichage, l'outil **bloque** :
il émet `question.requested`, ajoute le bloc ```` ```widget ```` au texte de la réponse en cours, puis attend la trame `reply`
(déjà utilisée pour `clarify` / `ask_user`). La réponse de l'utilisateur (libellé du bouton, `Libellé: valeur` par champ d'un
formulaire) devient le résultat de l'outil `{"answer": …}`, `question.resolved` est émis, et le tour de l'agent se poursuit.
Un arrêt, la fin du run ou un délai de 30 min débloquent l'outil avec une erreur ; une seule question à la fois par discussion.

- **Hermes** : le handler s'exécute dans le thread de l'agent et attend un `threading.Event` (`AgentUIAdapter.ask_blocking`) ; la discussion vient des ContextVars de session.
- **OpenClaw** : `execute` asynchrone, discussion déduite de `sessionKey` (`…:agentui:direct:<conversationId>`) ; le bridge du compte détient la promesse (`AgentUIBridge.askBlocking`, registre `asks.ts`).
- Non vérifié sur de vraies instances : tests avec faux AgentUI (Hermes 0.19, OpenClaw simulé). Le test `clarify` existant exige Hermes ≥ 0.21 (`attempt_text_response_for_session`).
