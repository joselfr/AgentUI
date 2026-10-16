"""Test d'intégration du plugin contre le vrai ``BasePlatformAdapter`` de Hermes.

Un faux AgentUI (serveur WebSocket) joue le protocole ; un faux agent remplace le GatewayRunner (handler de
messages) et simule streaming, hooks d'outils, approbation et réponse finale.

    <venv Hermes>/bin/python plugins/hermes-agentui/tests/test_adapter.py
"""

import os
import shutil
import tempfile

# Données Hermes isolées : le test crée et supprime des tâches cron.
os.environ["HERMES_HOME"] = tempfile.mkdtemp(prefix="hermes-agentui-test-")

import asyncio
import contextvars
import importlib.util
import json
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import websockets
from gateway.config import PlatformConfig
from gateway.session_context import clear_session_vars, set_session_vars

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("agentui_plugin", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
plugin = importlib.util.module_from_spec(spec)
sys.modules["agentui_plugin"] = plugin
spec.loader.exec_module(plugin)
adapter_mod = sys.modules["agentui_plugin.adapter"]

TOKEN = "secret"


from hermes_cli.plugins import VALID_HOOKS, PluginContext, PluginManager

try:  # 0.21+ : manifeste dans son propre module
    from hermes_cli.plugins_manifest import PluginManifest
except ImportError:
    from hermes_cli.plugins import PluginManifest


class Ctx(PluginContext):
    """Vrai PluginContext (register_platform valide les arguments de PlatformEntry) ; hooks seulement collectés."""

    hooks: dict = {}

    def register_hook(self, name, fn):
        assert name in VALID_HOOKS, name
        self.hooks[name] = fn


plugin.register(Ctx(PluginManifest(name="agentui-platform"), PluginManager()))
assert set(Ctx.hooks) == {"pre_tool_call", "post_tool_call", "subagent_start", "subagent_stop", "post_llm_call"}


class FakeAgentUI:
    def __init__(self):
        self.frames: asyncio.Queue = asyncio.Queue()
        self.ws = None
        self.hello = None

    async def handler(self, ws):
        hello = json.loads(await ws.recv())
        if hello.get("token") != TOKEN:
            await ws.close(4001, "token invalide")
            return
        if hello.get("mode") == "send-only":
            await ws.send(json.dumps({"type": "welcome", "protocol": 1}))
            async for raw in ws:
                await self.frames.put(json.loads(raw))
            return
        self.hello, self.ws = hello, ws
        await ws.send(json.dumps({"type": "welcome", "protocol": 1}))
        async for raw in ws:
            await self.frames.put(json.loads(raw))

    async def send(self, msg):
        await self.ws.send(json.dumps(msg))

    async def until(self, pred, timeout=5.0):
        """Frames reçues jusqu'à la première qui satisfait pred (incluse)."""
        got = []
        async def loop():
            while True:
                f = await self.frames.get()
                got.append(f)
                if pred(f):
                    return got
        return await asyncio.wait_for(loop(), timeout)


def events_of(frames, run_id):
    return [f["event"] for f in frames if f.get("type") == "event" and f["runId"] == run_id]


class FakeAgent:
    """Remplace le GatewayRunner : exécute un « tour » dans un thread, avec les ContextVars de session."""

    def __init__(self, adapter):
        self.adapter = adapter
        self.chats = []
        self.release = threading.Event()
        self.answers = {}

    async def __call__(self, event):
        if event.text == "/stop":
            return "⏹ Stopped."
        if event.text.startswith("/model"):
            if "refusé" in event.text:
                return "❌ Modèle inconnu"
            if "annulé" in event.text:
                return "🟡 Model switch cancelled. Current model unchanged (deepseek-flash)."
            # format réel de la gateway : pas de ✓, un avertissement peut figurer dans le texte
            return f"Model switched to `{event.text.split()[1]}`\nProvider: DeepSeek\nWarning: Auto-corrected `x` → `y`\n_(session only)_"
        chat = event.source.chat_id
        self.chats.append(chat)
        ctx = contextvars.copy_context()
        return await asyncio.get_running_loop().run_in_executor(None, ctx.run, self.turn, event)

    def turn(self, event):
        chat = event.source.chat_id
        tokens = set_session_vars(platform="agentui", chat_id=chat, session_id=f"s-{chat}")
        try:
            loop = self.adapter._loop
            call = lambda coro: asyncio.run_coroutine_threadsafe(coro, loop).result(5)
            hook = adapter_mod._hook
            if event.text == "approve":
                hook("pre_tool_call")(tool_name="terminal", args={"command": "rm -rf build"}, session_id=f"s-{chat}", tool_call_id="t-appr")
                fut = asyncio.run_coroutine_threadsafe(
                    self.adapter.send_exec_approval(chat_id=chat, command="rm -rf build", session_key=f"k-{chat}", description="commande dangereuse", allow_session=True),
                    self.adapter._loop,
                )
                assert fut.result(5).success
                self.release.wait(5)
                return "fait"
            if event.text.startswith("clarify"):  # outil clarify : question en plein run, le tour attend la réponse
                from tools import clarify_gateway as cg

                choices = ["Un", "Deux"] if event.text == "clarify-choix" else None
                cg.register(clarify_id=f"cl-{chat}", session_key=f"k-{chat}", question="Lequel ?", choices=choices)
                hook("pre_tool_call")(tool_name="clarify", args={}, session_id=f"s-{chat}", tool_call_id="t-cl")
                fut = asyncio.run_coroutine_threadsafe(
                    self.adapter.send_clarify(chat_id=chat, question="Lequel ?", choices=choices, clarify_id=f"cl-{chat}", session_key=f"k-{chat}"),
                    self.adapter._loop,
                )
                assert fut.result(5).success
                self.answers[chat] = cg.wait_for_response(f"cl-{chat}", 5)
                return "fait"
            if event.text == "long":
                self.release.wait(10)
                return "trop tard"
            if event.text == "nostream":  # streaming désactivé : la gateway livre la réponse via send()
                return "Réponse d'un bloc"
            # Comme le stream consumer : aperçu avec curseur, éditions, puis nouvelle bulle après l'outil.
            first = call(self.adapter.send(chat, "Je ▉")).message_id
            call(self.adapter.edit_message(chat, first, "Je regarde. ▉"))
            call(self.adapter.edit_message(chat, first, "Je regarde.", finalize=True))
            hook("pre_tool_call")(tool_name="terminal", args={"command": "ls"}, session_id=f"s-{chat}", tool_call_id="t1")
            hook("post_tool_call")(tool_name="terminal", args={"command": "ls"}, result="a.txt\nb.txt", session_id=f"s-{chat}", tool_call_id="t1", status="ok")
            hook("subagent_start")(parent_session_id=f"s-{chat}", child_session_id="child-1", child_subagent_id="sa-1", child_role="chercheur", child_goal="chercher")
            hook("pre_tool_call")(tool_name="web_search", args={"q": "x"}, session_id="child-1", tool_call_id="t2")
            hook("subagent_stop")(parent_session_id=f"s-{chat}", child_session_id="child-1", child_status="completed")
            hook("post_llm_call")(session_id=f"s-{chat}", platform="agentui", conversation_history=[
                {"role": "user", "content": event.text},
                {"role": "assistant", "content": "", "reasoning": "Il faut lister les fichiers."},
            ])
            second = call(self.adapter.send(chat, "Deux ▉")).message_id
            call(self.adapter.edit_message(chat, second, "Deux fichiers : a.txt, b.txt", finalize=True))
            return None  # déjà livré par le streaming
        finally:
            clear_session_vars(tokens)


async def main():
    server = FakeAgentUI()
    approvals = []
    import tools.approval as approval_mod
    approval_mod.resolve_gateway_approval = lambda key, choice, **kw: approvals.append((key, choice)) or 1

    async with websockets.serve(server.handler, "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        url = f"ws://127.0.0.1:{port}"
        adapter = adapter_mod.AgentUIAdapter(PlatformConfig(enabled=True, extra={"url": url, "token": TOKEN}))
        agent = FakeAgent(adapter)
        adapter.set_message_handler(agent)
        assert await adapter.connect()
        for _ in range(50):
            if server.ws is not None:
                break
            await asyncio.sleep(0.05)
        assert server.hello["agent"]["type"] == "hermes" and server.hello["capabilities"]["toolDetails"] is True
        assert server.hello["subAgents"] == [{"id": "default", "name": "default", "description": "Profil Hermes", "isDefault": True}], server.hello.get("subAgents")
        print("✓ hello / welcome")

        # 1. run complet : deltas, outils, sous-agent, raisonnement, final, fin
        await server.send({"type": "inbound", "conversationId": "c1", "runId": "r1", "text": "liste"})
        frames = await server.until(lambda f: f.get("event", {}).get("type", "").startswith("run."))
        ev = events_of(frames, "r1")
        types = [e["type"] for e in ev]
        deltas = "".join(e["text"] for e in ev if e["type"] == "message.delta")
        assert deltas == "Je regarde.\n\nDeux fichiers : a.txt, b.txt", repr(deltas)
        assert "▉" not in json.dumps(ev, ensure_ascii=False), "curseur retiré"
        assert {"type": "tool.started", "id": "t1", "name": "terminal", "args": {"command": "ls"}} in ev, ev
        assert any(e["type"] == "tool.completed" and e["id"] == "t1" and e["result"] == "a.txt\nb.txt" and not e["failed"] for e in ev)
        assert any(e["type"] == "subagent.start" and e["id"] == "sa-1" for e in ev)
        assert any(e["type"] == "tool.started" and e["id"] == "t2" and e.get("parentSubAgentRunId") == "sa-1" for e in ev), "outil du sous-agent rattaché"
        assert any(e["type"] == "subagent.end" and e["id"] == "sa-1" and not e["failed"] for e in ev)
        assert any(e["type"] == "reasoning.delta" and "lister" in e["text"] for e in ev)
        final = [e for e in ev if e["type"] == "message.final"]
        assert final and final[-1]["text"] == "Je regarde.\n\nDeux fichiers : a.txt, b.txt", final
        assert types[-1] == "run.completed", types
        print("✓ run complet (streaming, outils, sous-agent, raisonnement, final, fin)")

        await server.send({"type": "inbound", "conversationId": "c0", "runId": "r0", "text": "nostream"})
        ev = events_of(await server.until(lambda f: f.get("runId") == "r0" and f["event"]["type"].startswith("run.")), "r0")
        assert [e["type"] for e in ev] == ["message.delta", "message.final", "run.completed"], ev
        assert ev[1]["text"] == "Réponse d'un bloc"
        print("✓ réponse sans streaming (send final)")

        # 2. fils multiples : deux conversations = deux chat_id distincts
        await server.send({"type": "inbound", "conversationId": "c2", "runId": "r2", "text": "liste"})
        await server.until(lambda f: f.get("runId") == "r2" and f["event"]["type"] == "run.completed")
        assert agent.chats == ["c1", "c0", "c2"], agent.chats
        print("✓ fils multiples (un conversationId = un chat_id)")

        # 3. message proactif (cron / send_message) hors run
        await adapter.send("home", "Rappel : réunion à 14 h")
        await adapter.send("c1", "Tâche terminée")
        frames = await server.until(lambda f: f.get("type") == "outbound" and f.get("conversationId") == "c1")
        outs = [f for f in frames if f["type"] == "outbound"]
        assert outs[0]["text"] == "Rappel : réunion à 14 h" and "conversationId" not in outs[0], outs
        print("✓ messages proactifs (outbound)")

        # 3bis. livraison cron (metadata job_id) pendant une réponse en cours dans la même discussion
        await server.send({"type": "inbound", "conversationId": "cron-veille", "runId": "rc", "text": "long"})
        await asyncio.sleep(0.3)
        await adapter.send("cron-veille", "Résultat de la tâche", metadata={"job_id": "inconnu", "notify": True})
        await adapter.send("cron-veille", "texte de la réponse en cours")
        frames = await server.until(lambda f: f.get("type") == "outbound")
        out = frames[-1]
        assert out["conversationId"] == "cron-veille" and out["title"] == "⏰ veille" and out["text"] == "Résultat de la tâche", out
        assert not any(f.get("runId") == "rc" and "Résultat" in json.dumps(f, ensure_ascii=False) for f in frames), "pas mêlé à la réponse"
        agent.release.set()
        await server.until(lambda f: f.get("runId") == "rc" and f["event"]["type"].startswith("run."))
        agent.release.clear()
        print("✓ livraison cron séparée et titrée, même pendant une réponse")

        # 4. approbation
        await server.send({"type": "inbound", "conversationId": "c3", "runId": "r3", "text": "approve"})
        frames = await server.until(lambda f: f.get("event", {}).get("type") == "approval.request")
        req = frames[-1]["event"]
        assert "rm -rf build" in req["description"]
        await server.send({"type": "approval", "conversationId": "c3", "runId": "r3", "id": req["id"], "approve": True, "scope": "session"})
        for _ in range(50):
            if approvals:
                break
            await asyncio.sleep(0.05)
        assert approvals == [("k-c3", "session")], approvals
        agent.release.set()
        await server.until(lambda f: f.get("runId") == "r3" and f["event"]["type"] == "run.completed")
        agent.release.clear()
        print("✓ approbation (resolve_gateway_approval)")

        # 4bis. question de l'agent (clarify) : widget ask, puis la réponse (trame reply) débloque l'outil dans le run en cours
        await server.send({"type": "inbound", "conversationId": "c3b", "runId": "r3b", "text": "clarify-choix"})
        frames = await server.until(lambda f: "```widget" in json.dumps(f, ensure_ascii=False))
        blob = json.dumps(frames[-1], ensure_ascii=False)
        assert '\\"type\\": \\"ask\\"' in blob and "Lequel ?" in blob and "Deux" in blob, blob
        await server.send({"type": "reply", "conversationId": "c3b", "runId": "r3b", "text": "2"})
        await server.until(lambda f: f.get("runId") == "r3b" and f["event"]["type"] == "run.completed")
        assert agent.answers["c3b"] == "Deux", agent.answers  # « 2 » → la 2e option, comme sur Telegram
        await server.send({"type": "inbound", "conversationId": "c3c", "runId": "r3c", "text": "clarify-libre"})
        await server.until(lambda f: f.get("runId") == "r3c" and "Lequel ?" in json.dumps(f, ensure_ascii=False))
        await server.send({"type": "reply", "conversationId": "c3c", "runId": "r3c", "text": "ma réponse"})
        await server.until(lambda f: f.get("runId") == "r3c" and f["event"]["type"] == "run.completed")
        assert agent.answers["c3c"] == "ma réponse", agent.answers
        print("✓ question clarify : réponse reply → outil débloqué, run mené à terme")

        # 5. arrêt : run.aborted, et la confirmation de /stop n'est pas relayée
        await server.send({"type": "inbound", "conversationId": "c4", "runId": "r4", "text": "long"})
        await asyncio.sleep(0.3)
        await server.send({"type": "abort", "conversationId": "c4", "runId": "r4"})
        frames = await server.until(lambda f: f.get("runId") == "r4" and f["event"]["type"].startswith("run."))
        assert frames[-1]["event"]["type"] == "run.aborted", frames
        agent.release.set()
        await asyncio.sleep(0.5)
        agent.release.clear()  # sans quoi le run « long » de 5quater se terminerait aussitôt
        stray = [f for f in iter(lambda: server.frames.get_nowait() if not server.frames.empty() else None, None)]
        assert not any(f.get("type") == "outbound" for f in stray), stray
        assert not any(f.get("runId") == "r4" for f in stray), stray
        print("✓ arrêt (run.aborted, pas de message parasite)")

        # 5bis. tâches et skills (pages « Tâches » et « Skills » d'AgentUI)
        from cron.jobs import create_job

        job = create_job("Dis bonjour.", "every 1h", name="test-agentui", deliver="agentui:cron-test-agentui")
        async def rpc(method, params=None):
            rid = f"rpc-{method}-{id(params)}"
            await server.send({"type": "rpc", "id": rid, "method": method, "params": params or {}})
            frames = await server.until(lambda f: f.get("type") == "rpc.result" and f.get("id") == rid)
            return frames[-1]
        res = await rpc("listJobs")
        mine = [j for j in res["result"] if j["id"] == job["id"]]
        assert mine and mine[0]["name"] == "test-agentui" and mine[0]["enabled"] is True and mine[0]["schedule"], res
        assert mine[0]["deliverTo"] == "cron-test-agentui" and mine[0]["running"] is False and "queued" in mine[0], mine[0]
        assert (await rpc("jobAction", {"jobId": job["id"], "action": "pause"}))["result"] == {"ok": True}
        assert [j for j in (await rpc("listJobs"))["result"] if j["id"] == job["id"]][0]["enabled"] is False
        assert (await rpc("jobAction", {"jobId": job["id"], "action": "resume"}))["result"] == {"ok": True}
        assert "introuvable" in (await rpc("jobAction", {"jobId": "inexistant", "action": "run"}))["error"]
        assert (await rpc("jobAction", {"jobId": job["id"], "action": "delete"}))["result"] == {"ok": True}
        assert not [j for j in (await rpc("listJobs"))["result"] if j["id"] == job["id"]]
        skills = (await rpc("listSkills"))["result"]
        assert isinstance(skills, list) and all({"id", "name", "enabled"} <= set(x) for x in skills), skills[:2]
        assert server.hello["capabilities"]["jobs"] and server.hello["capabilities"]["jobControl"] and server.hello["capabilities"]["skills"]
        print(f"✓ tâches (liste, pause, reprise, suppression) et skills ({len(skills)})")

        # 5ter. suppression de la discussion côté plateforme (rpc deleteSession)
        from hermes_constants import get_hermes_home
        from hermes_state import SessionDB

        assert server.hello["capabilities"]["sessionDelete"] is True
        session_id, conv = "s-del-1", "c-del"
        transcript = Path(get_hermes_home()) / "sessions" / f"{session_id}.json"
        transcript.parent.mkdir(parents=True, exist_ok=True)
        transcript.write_text("{}")
        seeded = SessionDB(read_only=False)
        seeded.create_session(session_id, "agentui")
        seeded.record_gateway_session_peer(session_id, source="agentui", session_key=f"agent:main:agentui:dm:{conv}", chat_id=conv)
        seeded.close()
        assert (await rpc("deleteSession", {"conversationId": conv}))["result"] == {"ok": True, "deleted": True}
        assert not transcript.exists(), "transcription effacée du disque"
        check = SessionDB(read_only=True)
        assert check.find_session_by_origin(platform="agentui", chat_id=conv) is None
        check.close()
        assert (await rpc("deleteSession", {"conversationId": "inconnue"}))["result"] == {"ok": True, "deleted": False}, "idempotent"
        print("✓ suppression de session (deleteSession)")

        # 5quater. refus tant qu'un run est en cours dans la discussion
        await server.send({"type": "inbound", "conversationId": "c9", "runId": "r9", "text": "long"})
        await asyncio.sleep(0.3)
        res = await rpc("deleteSession", {"conversationId": "c9"})
        assert "run est en cours" in res["error"], res
        agent.release.set()
        await server.until(lambda f: f.get("runId") == "r9" and f["event"]["type"].startswith("run."))
        agent.release.clear()
        print("✓ suppression refusée pendant un run")

        # 5quinquies. modèle et coût : sessionUsage, listModels, setModel, événement usage en fin de run
        import sqlite3

        assert server.hello["capabilities"]["models"] is True
        assert (await rpc("sessionUsage", {"conversationId": "inconnue"}))["result"] is None
        seeded = SessionDB(read_only=False)
        seeded.create_session("s-use-1", "agentui")
        seeded.record_gateway_session_peer("s-use-1", source="agentui", session_key="agent:main:agentui:dm:c-use", chat_id="c-use")
        db_path = str(seeded.db_path)
        seeded.close()
        con = sqlite3.connect(db_path)
        con.execute("UPDATE sessions SET model = 'deepseek-flash', billing_provider = 'deepseek', input_tokens = 1200, output_tokens = 340,"
                    " cache_read_tokens = 5000, estimated_cost_usd = 0.0123 WHERE id = 's-use-1'")
        con.commit()
        con.close()
        usage = (await rpc("sessionUsage", {"conversationId": "c-use"}))["result"]
        assert usage == {"inputTokens": 1200, "outputTokens": 340, "model": "deepseek-flash", "provider": "deepseek",
                         "cacheReadTokens": 5000, "costUsd": 0.0123, "costEstimated": True}, usage
        models = (await rpc("listModels", {}))
        assert "error" not in models and isinstance(models["result"], list), models
        for m in models["result"]:
            assert set(m) == {"provider", "providerName", "id"}, m
        # setModel : la commande /model est exécutée par la gateway, sa réponse n'apparaît pas dans la discussion
        res = await rpc("setModel", {"conversationId": "c-use", "model": "deepseek-v4-pro", "provider": "deepseek"})
        assert res["result"]["model"] == "deepseek-flash" and "Model switched to `deepseek-v4-pro`" in res["result"]["message"], res  # modèle relu en base
        res = await rpc("setModel", {"conversationId": "c-use", "model": "refusé"})
        assert "Modèle inconnu" in res["error"], res
        res = await rpc("setModel", {"conversationId": "c-use", "model": "annulé"})
        assert res["error"].startswith("Model switch cancelled"), res
        assert "error" in await rpc("setModel", {"conversationId": "c-use"}), "paramètres manquants"
        # fin de run : la consommation de la session suit run.completed
        await server.send({"type": "inbound", "conversationId": "c-use", "runId": "r-use", "text": "bonjour"})
        got = await server.until(lambda f: f.get("runId") == "r-use" and f["event"]["type"].startswith("run."))
        kinds = [e["type"] for e in events_of(got, "r-use")]
        assert kinds.index("usage") < kinds.index("run.completed"), kinds
        assert [e for e in events_of(got, "r-use") if e["type"] == "usage"][0]["usage"]["costUsd"] == 0.0123
        # setModel refusé pendant un run
        await server.send({"type": "inbound", "conversationId": "c9", "runId": "r-use2", "text": "long"})
        await asyncio.sleep(0.3)
        assert "run est en cours" in (await rpc("setModel", {"conversationId": "c9", "model": "x"}))["error"]
        agent.release.set()
        await server.until(lambda f: f.get("runId") == "r-use2" and f["event"]["type"].startswith("run."))
        agent.release.clear()
        print("✓ modèle et coût (sessionUsage, listModels, setModel, événement usage)")

        # 6. livraison cron hors gateway (connexion send-only)
        res = await adapter_mod._standalone_send(PlatformConfig(enabled=True, extra={"url": url, "token": TOKEN}), "home", "Cron du matin")
        assert res.get("success"), res
        frames = await server.until(lambda f: f.get("type") == "outbound")
        assert frames[-1]["text"] == "Cron du matin"
        assert server.hello.get("mode") is None, "la connexion principale n'est pas remplacée"
        print("✓ cron hors gateway (standalone_sender_fn)")

        await adapter.disconnect()
    shutil.rmtree(os.environ["HERMES_HOME"], ignore_errors=True)  # sinon chaque exécution laisse un dossier
    print("\nTous les tests passent.")


asyncio.run(main())
