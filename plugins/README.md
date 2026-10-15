# Plugins canal AgentUI

AgentUI joue le rôle de **gateway**, comme Telegram pour un bot : ce sont les plateformes d'agents qui s'y connectent,
via un plugin canal qui traduit leurs spécificités vers un protocole unique.

| Dossier | Contenu |
|---|---|
| [`SPIKE.md`](SPIKE.md) | Étude de faisabilité : matrice des capacités Hermes / OpenClaw, API utilisées, risques |
| [`protocol/`](protocol/PROTOCOL.md) | **AgentUI Channel Protocol v1** (`PROTOCOL.md` + `channel.schema.json`) |
| [`hermes-agentui/`](hermes-agentui/) | Plugin plateforme Hermes Agent (Python) |
| [`openclaw-agentui/`](openclaw-agentui/) | Plugin canal OpenClaw (TypeScript) |
| [`dev/mock-gateway.mjs`](dev/mock-gateway.mjs) | Faux AgentUI interactif pour tester un plugin sans l'app |

Supprimer une discussion dans AgentUI demande au plugin d'effacer la session correspondante côté plateforme (`rpc
deleteSession`, capacité `sessionDelete`) : la discussion n'est effacée localement **que** si le plugin a confirmé. Un agent
dont le plugin ne sait pas le faire — adaptateurs directs, plugin pas encore mis à jour — refuse la suppression (message
explicite, discussion conservée) ; une discussion sans session côté plateforme (jamais utilisée, ou « maison ») reste
supprimable normalement.

Côté AgentUI : déclarer l'agent dans `agents.config.yaml` (`type: gateway`, `token` de 16 caractères minimum).
Le plugin se connecte à `ws(s)://<agentui>/gateway` ; en Docker sur le même réseau : `ws://agentui:8080/gateway`.
Les adapters directs (`hermes` via api_server, `openclaw` via le WebSocket opérateur) restent disponibles en parallèle.

## Tester un plugin sans AgentUI (faux serveur)

```bash
AGENTUI_TOKEN=dev node plugins/dev/mock-gateway.mjs --port 8790
# puis taper un message ; /new pour une nouvelle discussion (= nouvelle session côté agent),
# /agent [nom] pour choisir l'agent ciblé (plusieurs plugins peuvent être connectés),
# /abort, /approve [once|session|always], /deny, /attach <fichier>, /rpc <méthode> [json]
# (ex. /rpc listSubAgents ; /rpc deleteSession = efface la session de la discussion courante)
```

L'URL à donner aux plugins est `ws://<hôte>:8790/gateway`. Si l'agent tourne sur un autre serveur, ouvrir un tunnel,
par exemple `ssh -R 8790:127.0.0.1:8790 root@jlfr.io`, puis utiliser `ws://127.0.0.1:8790/gateway` côté serveur.

## Hermes Agent (≥ 0.19, validé en 0.21)

```bash
cp plugins/hermes-agentui/{plugin.yaml,__init__.py,adapter.py} ~/.hermes/plugins/agentui/
hermes plugins enable agentui-platform     # les plugins sont opt-in
```

`~/.hermes/.env` :

```env
AGENTUI_URL=wss://agentui.example.com/gateway
AGENTUI_TOKEN=…            # token de l'agent dans agents.config.yaml d'AgentUI
# AGENTUI_NAME=Hermes
```

Le plugin active par défaut le streaming et coupe les bulles de progression d'outils pour la plateforme. Mais un
réglage **global** `display.tool_progress` du `config.yaml` prend le pas : dans ce cas, le fixer pour la plateforme :

```bash
hermes config set display.platforms.agentui.tool_progress off
hermes config set display.platforms.agentui.streaming true
```

Redémarrer `hermes gateway` ; `hermes gateway status` doit lister **AgentUI**. Les crons `deliver=agentui` arrivent dans
la discussion « maison » d'AgentUI (`AGENTUI_HOME_CHANNEL` pour en choisir une autre). Avec plusieurs profils, chaque
profil lance sa gateway et donc sa propre connexion.

Test d'intégration, contre la vraie classe `BasePlatformAdapter`, dans un environnement où Hermes est installé :

```bash
<python de Hermes> plugins/hermes-agentui/tests/test_adapter.py
```

## OpenClaw (≥ 2026.9.9, validé en 2026.9.9)

L'installation d'un paquet exige le JavaScript compilé (`dist/`, non versionné) :

```bash
cd plugins/openclaw-agentui && npm install && npm run build
openclaw plugins install ./plugins/openclaw-agentui --force
openclaw config set channels.agentui.url wss://agentui.example.com/gateway
openclaw config set channels.agentui.token …
```

La gateway applique l'installation et la configuration à chaud ; `openclaw channels status` doit afficher **AgentUI** connecté. Chaque discussion AgentUI est un
pair direct isolé (le plugin impose `dmScope: "per-channel-peer"`). Le sous-agent choisi dans AgentUI est transmis comme
agent par défaut de la route ; les bindings de configuration restent prioritaires.

Développement :

```bash
cd plugins/openclaw-agentui
npm install            # openclaw (types) + typescript
npm run typecheck      # contre les vrais types du SDK
npm test               # runtime OpenClaw simulé + faux AgentUI
```

## Limites connues

- **Hermes** : le raisonnement arrive en un bloc en fin de tour (hook `post_llm_call`), pas en streaming.
- **OpenClaw** : sous-agents pas encore relayés (`subagents: false`) ; approbations par commande `/approve` dans le même chat
  (le natif `approvalCapability` reste à faire).
- Aucune des deux plateformes n'expose aux canaux la liste des sessions, des skills ou des jobs : AgentUI s'appuie sur
  sa propre base de messages.
- Envois directs : cible = id de discussion AgentUI ou `home` (`openclaw message send --channel agentui --target home …`).
  Hors du processus de la gateway (CLI, cron isolé), les deux plugins ouvrent une connexion ponctuelle `send-only`.

## Validation sur jlfr.io (15/10/2026)

Faux AgentUI lancé sur le serveur (`agentui-mock` dans `media_default`), plugins installés dans les instances réelles,
puis tout remis en état (configs restaurées à l'identique, plugins désinstallés).

| Scénario | Hermes 0.21.0 | OpenClaw 2026.9.9 |
|---|---|---|
| Connexion, reconnexion après coupure du serveur | ✅ | ✅ |
| Outil réel : carte avec arguments + résultat, texte streamé, réponse, fin | ✅ | ✅ |
| Fils isolés (un mot confié dans le fil A, inconnu du fil B, retrouvé dans A) | ✅ | ✅ |
| Arrêt en cours d'outil (`sleep 120` interrompu, `run.aborted`) | ✅ | ✅ |
| Raisonnement | ✅ (en fin de tour) | non observé avec le modèle actuel |
| Message proactif | ✅ cron `--deliver agentui` | ✅ `openclaw message send` |
| Approbation | ⚠️ non déclenchée : le serveur auto-approuve (« smart approval ») ; couverte par les tests | ⚠️ aucune demande d'approbation pendant les essais ; couverte par les tests |

Défauts trouvés et corrigés pendant la validation : streaming Hermes 0.21 (passage par `send`/`edit_message`),
argument `allow_session` ajouté en 0.21, bulles d'outils malgré le défaut du plugin (réglage global), paquet OpenClaw sans
`dist/`, cibles d'envoi direct non résolues, envoi depuis la CLI hors gateway.

## En production sur jlfr.io (15/10/2026)

Agents `hermes-canal` et `openclaw-canal` déclarés dans `config/agentui/agents.config.yaml` (tokens générés, fichier en
640), à côté de `hermes` et `openclaw` inchangés. Plugins installés : `config/hermes-agent/plugins/agentui` (+
`AGENTUI_URL`/`AGENTUI_TOKEN` dans son `.env`, `display.platforms.agentui.*`) et extension OpenClaw `agentui`
(`channels.agentui.*`). Vérifié via l'API d'AgentUI : les 4 agents connectés, un message avec outil traité par chaque
canal, un cron Hermes et un envoi OpenClaw livrés dans « Messages de … ».

Puis, le même jour, la suppression propagée : `apps/agentui` reconstruit, `adapter.py` du plugin Hermes remplacé
(`hermes-agent` redémarré, sauvegarde `adapter.py.bak-session-delete`) et extension OpenClaw réinstallée à chaud
(`plugins install … --force`, sans redémarrage). Les adaptateurs directs, dépréciés, ont été retirés de la
configuration. Vérifié sur une discussion jetable de chaque canal : la discussion supprimée dans l'app disparaît de sa
base et sa session de plateforme avec elle — plus aucune ligne `sessions` chez Hermes, une seule clé de session effacée
chez OpenClaw (les autres intactes).
