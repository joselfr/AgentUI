"""Integration test of the plugin against Hermes' real ``BasePlatformAdapter``.

A fake AgentUI (WebSocket server) plays the protocol; a fake agent replaces the GatewayRunner (message handler) and
simulates streaming, tool hooks, approval and final reply.

    <venv Hermes>/bin/python plugins/hermes-agentui/tests/test_adapter.py
"""

import os
import shutil
import tempfile

# Isolated Hermes data: the test creates and deletes cron tasks.
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

try:  # 0.21+: manifest in its own module
    from hermes_cli.plugins_manifest import PluginManifest
except ImportError:
    from hermes_cli.plugins import PluginManifest


class Ctx(PluginContext):
    """Real PluginContext (register_platform validates the PlatformEntry arguments); hooks only collected."""

    hooks: dict = {}
    tools: dict = {}

    def register_tool(self, name, *args, **kwargs):
        Ctx.tools[name] = kwargs["handler"]
        return super().register_tool(name, *args, **kwargs)

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
            await ws.close(4001, "invalid token")
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
        """Frames received up to the first one that satisfies pred (included)."""
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
    """Replaces the GatewayRunner: runs a "turn" in a thread, with the session ContextVars."""

    def __init__(self, adapter):
        self.adapter = adapter
        self.chats = []
        self.release = threading.Event()
        self.answers = {}

    async def __call__(self, event):
        if event.text == "/stop":
            return "⏹ Stopped."
        if event.text.startswith("/model"):
            if "refused" in event.text:
                return "❌ Unknown model"
            if "cancelled" in event.text:
                return "🟡 Model switch cancelled. Current model unchanged (deepseek-flash)."
            # real gateway format: no ✓, a warning may appear in the text
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
            if event.text.startswith("clarify"):  # clarify tool: question mid-run, the turn waits for the answer
                from tools import clarify_gateway as cg

                choices = ["One", "Two"] if event.text == "clarify-choice" else None
                cg.register(clarify_id=f"cl-{chat}", session_key=f"k-{chat}", question="Which one?", choices=choices)
                hook("pre_tool_call")(tool_name="clarify", args={}, session_id=f"s-{chat}", tool_call_id="t-cl")
                fut = asyncio.run_coroutine_threadsafe(
                    self.adapter.send_clarify(chat_id=chat, question="Which one?", choices=choices, clarify_id=f"cl-{chat}", session_key=f"k-{chat}"),
                    self.adapter._loop,
                )
                assert fut.result(5).success
                self.answers[chat] = cg.wait_for_response(f"cl-{chat}", 5)
                return "fait"
            if event.text.startswith("tool-"):  # interactive tool agentui_ask / agentui_confirm: blocks until the answer
                key = event.text[5:]
                args = {"question": "Quelle couleur ?", "options": ["Rouge", "Bleu"]} if key == "ask" else {"title": "Supprimer ?", "danger": True}
                if key == "form":
                    args = {"fields": [{"name": "a", "label": "A"}, {"name": "a", "label": "B"}]}
                self.answers[chat] = json.loads(Ctx.tools["agentui_" + key](args))
                return "fait"
            if event.text == "app-tools":  # agentui_miniapp_*: guide is local, the others go through miniapp.op / miniapp.result
                guide = json.loads(Ctx.tools["agentui_miniapp_guide"]({}))
                wrote = json.loads(Ctx.tools["agentui_miniapp_write"]({"id": "todo", "files": [{"path": "src/main.tsx", "content": "x"}]}))
                failed = json.loads(Ctx.tools["agentui_miniapp_remove"]({"id": "nope"}))
                self.answers[chat] = (guide, wrote, failed)
                return "fait"
            if event.text == "prog-widget":  # progress widget: the 2nd call (update) returns the same token
                steps = [{"label": "A", "status": "running"}]
                first = json.loads(Ctx.tools["agentui_widget_progress"]({"steps": steps}))
                again = json.loads(Ctx.tools["agentui_widget_progress"]({"steps": [{"label": "A", "status": "done"}], "update": first["widget"]}))
                bad = json.loads(Ctx.tools["agentui_widget_progress"]({"steps": steps, "update": "abc"}))
                self.answers[chat] = (first, again, bad)
                return "fait"
            if event.text == "image-tool":  # agentui_widget_image: copy of a local file into message.media + mapping in the result
                png = Path(tempfile.mkdtemp()) / "plage.png"
                png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
                txt = png.with_name("note.png")
                txt.write_text("some text")
                call = lambda images: json.loads(Ctx.tools["agentui_widget_image"]({"images": images}))
                self.answers[chat] = (
                    call([{"src": "https://exemple.org/a.jpg"}, {"src": str(png)}, {"src": str(png)}]),
                    call([{"src": str(txt)}]),
                    call([{"src": "/does/not/exist.png"}]),
                    call([{"src": "relatif/a.png"}]),
                )
                return "fait"
            if event.text == "long":
                self.release.wait(10)
                return "too late"
            if event.text == "nostream":  # streaming disabled: the gateway delivers the reply via send()
                return "One-block reply"
            # Like the stream consumer: preview with cursor, edits, then a new bubble after the tool.
            first = call(self.adapter.send(chat, "I ▉")).message_id
            call(self.adapter.edit_message(chat, first, "I am looking. ▉"))
            call(self.adapter.edit_message(chat, first, "I am looking.", finalize=True))
            hook("pre_tool_call")(tool_name="terminal", args={"command": "ls"}, session_id=f"s-{chat}", tool_call_id="t1")
            hook("post_tool_call")(tool_name="terminal", args={"command": "ls"}, result="a.txt\nb.txt", session_id=f"s-{chat}", tool_call_id="t1", status="ok")
            hook("subagent_start")(parent_session_id=f"s-{chat}", child_session_id="child-1", child_subagent_id="sa-1", child_role="researcher", child_goal="research")
            hook("pre_tool_call")(tool_name="web_search", args={"q": "x"}, session_id="child-1", tool_call_id="t2")
            hook("subagent_stop")(parent_session_id=f"s-{chat}", child_session_id="child-1", child_status="completed")
            hook("post_llm_call")(session_id=f"s-{chat}", platform="agentui", conversation_history=[
                {"role": "user", "content": event.text},
                {"role": "assistant", "content": "", "reasoning": "Files need to be listed."},
            ])
            second = call(self.adapter.send(chat, "Two ▉")).message_id
            call(self.adapter.edit_message(chat, second, "Two files: a.txt, b.txt", finalize=True))
            return None  # already delivered by the streaming
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
        assert deltas == "I am looking.\n\nTwo files: a.txt, b.txt", repr(deltas)
        assert "▉" not in json.dumps(ev, ensure_ascii=False), "cursor removed"
        assert {"type": "tool.started", "id": "t1", "name": "terminal", "args": {"command": "ls"}} in ev, ev
        assert any(e["type"] == "tool.completed" and e["id"] == "t1" and e["result"] == "a.txt\nb.txt" and not e["failed"] for e in ev)
        assert any(e["type"] == "subagent.start" and e["id"] == "sa-1" for e in ev)
        assert any(e["type"] == "tool.started" and e["id"] == "t2" and e.get("parentSubAgentRunId") == "sa-1" for e in ev), "sub-agent tool attached"
        assert any(e["type"] == "subagent.end" and e["id"] == "sa-1" and not e["failed"] for e in ev)
        assert any(e["type"] == "reasoning.delta" and "listed" in e["text"] for e in ev)
        final = [e for e in ev if e["type"] == "message.final"]
        assert final and final[-1]["text"] == "I am looking.\n\nTwo files: a.txt, b.txt", final
        assert types[-1] == "run.completed", types
        print("✓ run complet (streaming, outils, sous-agent, raisonnement, final, fin)")

        await server.send({"type": "inbound", "conversationId": "c0", "runId": "r0", "text": "nostream"})
        ev = events_of(await server.until(lambda f: f.get("runId") == "r0" and f["event"]["type"].startswith("run.")), "r0")
        assert [e["type"] for e in ev] == ["message.delta", "message.final", "run.completed"], ev
        assert ev[1]["text"] == "One-block reply"
        print("✓ reply without streaming (final send)")

        # 2. fils multiples : deux conversations = deux chat_id distincts
        await server.send({"type": "inbound", "conversationId": "c2", "runId": "r2", "text": "liste"})
        await server.until(lambda f: f.get("runId") == "r2" and f["event"]["type"] == "run.completed")
        assert agent.chats == ["c1", "c0", "c2"], agent.chats
        print("✓ multiple threads (one conversationId = one chat_id)")

        # 3. message proactif (cron / send_message) hors run
        await adapter.send("home", "Reminder: meeting at 2 pm")
        await adapter.send("c1", "Task finished")
        frames = await server.until(lambda f: f.get("type") == "outbound" and f.get("conversationId") == "c1")
        outs = [f for f in frames if f["type"] == "outbound"]
        assert outs[0]["text"] == "Reminder: meeting at 2 pm" and "conversationId" not in outs[0], outs
        print("✓ messages proactifs (outbound)")

        # 3ter. streamed preview outside a run (text + cursor, then edits): ONE outbound with the final text, no cursor
        r = await adapter.send("c1", "Validation run ok, the cha ▉")
        await adapter.edit_message("c1", r.message_id, "Validation run ok, the chain does everything ▉")
        await adapter.edit_message("c1", r.message_id, "Validation run ok, the chain does everything.", finalize=True)
        await adapter.send("c1", "after the preview")
        frames = await server.until(lambda f: f.get("type") == "outbound" and f.get("text") == "after the preview")
        texts = [f["text"] for f in frames if f["type"] == "outbound" and "alidation" in f.get("text", "")]
        assert texts == ["Validation run ok, the chain does everything."], texts
        print("✓ preview outside a run: a single message, cursor removed")

        # 3bis. cron delivery (job_id metadata) during a reply in progress in the same chat
        await server.send({"type": "inbound", "conversationId": "cron-watch", "runId": "rc", "text": "long"})
        await asyncio.sleep(0.3)
        await adapter.send("cron-watch", "Task result", metadata={"job_id": "unknown", "notify": True})
        await adapter.send("cron-watch", "⏳ Working — 3 min — iteration 2/150, terminal", metadata={"_interim_send": True})
        await adapter.send("cron-watch", "↪ Redirected current run (1 min elapsed). I'll adjust using your correction.")
        await adapter.send("cron-watch", "text of the reply in progress")
        frames = await server.until(lambda f: f.get("type") == "outbound")
        out = frames[-1]
        assert out["conversationId"] == "cron-watch" and out["title"] == "⏰ watch" and out["text"] == "Task result", out
        assert not any(f.get("runId") == "rc" and "Task result" in json.dumps(f, ensure_ascii=False) for f in frames), "not mixed with the reply"
        agent.release.set()
        frames += await server.until(lambda f: f.get("runId") == "rc" and f["event"]["type"].startswith("run."))
        agent.release.clear()
        blob = json.dumps(frames, ensure_ascii=False)
        assert "Working" not in blob and "Redirected" not in blob, "gateway notices stay out of the reply"
        print("✓ cron delivery separate and titled, even during a reply")

        # 4. approval
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
        print("✓ approval (resolve_gateway_approval)")

        # 4bis. agent question (clarify): ask widget, then the answer (reply frame) unblocks the tool in the running run
        await server.send({"type": "inbound", "conversationId": "c3b", "runId": "r3b", "text": "clarify-choice"})
        frames = await server.until(lambda f: "```widget" in json.dumps(f, ensure_ascii=False))
        blob = json.dumps(frames[-1], ensure_ascii=False)
        assert '\\"type\\": \\"ask\\"' in blob and "Which one?" in blob and "Two" in blob, blob
        asked = [f["event"] for f in frames if f.get("event", {}).get("type") == "question.requested"]
        assert asked == [{"type": "question.requested", "id": "cl-c3b"}], frames  # emitted before the prompt
        await server.send({"type": "reply", "conversationId": "c3b", "runId": "r3b", "text": "2"})
        await server.until(lambda f: f.get("runId") == "r3b" and f["event"]["type"] == "question.resolved")
        await server.until(lambda f: f.get("runId") == "r3b" and f["event"]["type"] == "run.completed")
        assert agent.answers["c3b"] == "Two", agent.answers  # "2" → the 2nd option, as on Telegram
        await server.send({"type": "inbound", "conversationId": "c3c", "runId": "r3c", "text": "clarify-libre"})
        await server.until(lambda f: f.get("runId") == "r3c" and "Which one?" in json.dumps(f, ensure_ascii=False))
        await server.send({"type": "reply", "conversationId": "c3c", "runId": "r3c", "text": "my answer"})
        await server.until(lambda f: f.get("runId") == "r3c" and f["event"]["type"] == "run.completed")
        assert agent.answers["c3c"] == "my answer", agent.answers
        print("✓ clarify question: reply answer → tool unblocked, run completed")

        # 4ter. interactive tools (agentui_ask…): the widget goes out before the answer, the reply frame unblocks the tool
        await server.send({"type": "inbound", "conversationId": "c3d", "runId": "r3d", "text": "tool-ask"})
        frames = await server.until(lambda f: "```widget" in json.dumps(f, ensure_ascii=False))
        blob = json.dumps(frames, ensure_ascii=False)
        assert '\\"type\\": \\"ask\\"' in blob and "Quelle couleur ?" in blob and "Bleu" in blob, blob
        requested = [f["event"]["id"] for f in frames if f.get("event", {}).get("type") == "question.requested"]
        assert len(requested) == 1, frames  # emitted before the widget
        await server.send({"type": "reply", "conversationId": "c3d", "runId": "r3d", "text": "Bleu"})
        await server.until(lambda f: f.get("runId") == "r3d" and f["event"]["type"] == "question.resolved" and f["event"]["id"] == requested[0])
        await server.until(lambda f: f.get("runId") == "r3d" and f["event"]["type"] == "run.completed")
        assert agent.answers["c3d"] == {"answer": "Bleu"}, agent.answers
        # miniapps: the tool blocks on miniapp.op until the server answers with miniapp.result
        await server.send({"type": "inbound", "conversationId": "c3g", "runId": "r3g", "text": "app-tools"})
        op = (await server.until(lambda f: f.get("type") == "miniapp.op"))[-1]
        assert op["op"] == "write" and op["args"]["id"] == "todo", op
        await server.send({"type": "miniapp.result", "id": op["id"], "ok": True, "result": {"ok": False, "errors": [{"file": "src/main.tsx", "line": 1, "message": "boom"}]}})
        op2 = (await server.until(lambda f: f.get("type") == "miniapp.op"))[-1]
        assert op2["op"] == "remove", op2
        await server.send({"type": "miniapp.result", "id": op2["id"], "ok": False, "error": "Unknown miniapp \"nope\"."})
        await server.until(lambda f: f.get("runId") == "r3g" and f["event"]["type"] == "run.completed")
        guide, wrote, failed = agent.answers["c3g"]
        assert "Building miniapps for AgentUI" in guide["guide"] and wrote["errors"][0]["message"] == "boom" and "Unknown miniapp" in failed["error"], agent.answers
        print("✓ app tools: guide, write (build errors), remove (error)")
        # stop while waiting: the tool hands control back without an answer
        await server.send({"type": "inbound", "conversationId": "c3e", "runId": "r3e", "text": "tool-confirm"})
        await server.until(lambda f: f.get("runId") == "r3e" and '\\"type\\": \\"confirm\\"' in json.dumps(f, ensure_ascii=False))
        await server.send({"type": "abort", "conversationId": "c3e", "runId": "r3e"})
        await server.until(lambda f: f.get("runId") == "r3e" and f["event"]["type"] == "run.aborted")
        for _ in range(50):
            if "error" in agent.answers.get("c3e", {}):
                break
            await asyncio.sleep(0.1)
        assert "error" in agent.answers["c3e"], agent.answers
        # invalid arguments: immediate refusal, without a question
        await server.send({"type": "inbound", "conversationId": "c3f", "runId": "r3f", "text": "tool-form"})
        await server.until(lambda f: f.get("runId") == "r3f" and f["event"]["type"] == "run.completed")
        assert "deux fois" in agent.answers["c3f"]["error"], agent.answers
        print("✓ interactive tools: widget, reply → tool result, stop, validation")

        await server.send({"type": "inbound", "conversationId": "c3g", "runId": "r3g", "text": "prog-widget"})
        await server.until(lambda f: f.get("runId") == "r3g" and f["event"]["type"] == "run.completed")
        first, again, bad = agent.answers["c3g"]
        assert first["widget"].startswith("[[agentui:") and again["widget"] == first["widget"] and again["updated"] is True, agent.answers
        assert "error" in bad, bad
        print("✓ progress widget: token returned then reused by update")

        await server.send({"type": "inbound", "conversationId": "c3h", "runId": "r3h", "text": "image-tool"})
        frames = await server.until(lambda f: f.get("runId") == "r3h" and f["event"]["type"] == "run.completed")
        ok, not_image, missing, relative = agent.answers["c3h"]
        media = [f["event"] for f in frames if f.get("event", {}).get("type") == "message.media"]
        assert len(media) == 1 and media[0]["name"].startswith("agentui-img-") and media[0]["mimeType"] == "image/png", frames
        assert list(ok["files"].values()) == [media[0]["name"]] and ok["widget"].startswith("[[agentui:"), ok
        assert "not a png" in not_image["error"] and "not found" in missing["error"] and "absolute path" in relative["error"], agent.answers
        print("✓ widget image : copie locale en message.media, mapping, rejets")

        # 5. stop: run.aborted, and the /stop confirmation is not relayed
        await server.send({"type": "inbound", "conversationId": "c4", "runId": "r4", "text": "long"})
        await asyncio.sleep(0.3)
        await server.send({"type": "abort", "conversationId": "c4", "runId": "r4"})
        frames = await server.until(lambda f: f.get("runId") == "r4" and f["event"]["type"].startswith("run."))
        assert frames[-1]["event"]["type"] == "run.aborted", frames
        agent.release.set()
        await asyncio.sleep(0.5)
        agent.release.clear()  # otherwise the "long" run of 5quater would end right away
        stray = [f for f in iter(lambda: server.frames.get_nowait() if not server.frames.empty() else None, None)]
        assert not any(f.get("type") == "outbound" for f in stray), stray
        assert not any(f.get("runId") == "r4" for f in stray), stray
        print("✓ stop (run.aborted, no stray message)")

        # 5bis. tasks and skills (AgentUI's "Tasks" and "Skills" pages)
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
        assert "not found" in (await rpc("jobAction", {"jobId": "nonexistent", "action": "run"}))["error"]
        assert (await rpc("jobAction", {"jobId": job["id"], "action": "delete"}))["result"] == {"ok": True}
        assert not [j for j in (await rpc("listJobs"))["result"] if j["id"] == job["id"]]
        skills = (await rpc("listSkills"))["result"]
        assert isinstance(skills, list) and all({"id", "name", "enabled"} <= set(x) for x in skills), skills[:2]
        assert server.hello["capabilities"]["jobs"] and server.hello["capabilities"]["jobControl"] and server.hello["capabilities"]["skills"]
        print(f"✓ tasks (list, pause, resume, deletion) and skills ({len(skills)})")

        # 5ter. deletion of the chat on the platform side (rpc deleteSession)
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
        assert not transcript.exists(), "transcript erased from disk"
        check = SessionDB(read_only=True)
        assert check.find_session_by_origin(platform="agentui", chat_id=conv) is None
        check.close()
        assert (await rpc("deleteSession", {"conversationId": "unknown"}))["result"] == {"ok": True, "deleted": False}, "idempotent"
        print("✓ session deletion (deleteSession)")

        # 5quater. refusal while a run is in progress in the chat
        await server.send({"type": "inbound", "conversationId": "c9", "runId": "r9", "text": "long"})
        await asyncio.sleep(0.3)
        res = await rpc("deleteSession", {"conversationId": "c9"})
        assert "run is in progress" in res["error"], res
        agent.release.set()
        await server.until(lambda f: f.get("runId") == "r9" and f["event"]["type"].startswith("run."))
        agent.release.clear()
        print("✓ deletion refused during a run")

        # 5quinquies. model and cost: sessionUsage, listModels, setModel, usage event at the end of a run
        import sqlite3

        assert server.hello["capabilities"]["models"] is True
        assert (await rpc("sessionUsage", {"conversationId": "unknown"}))["result"] is None
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
        # setModel: the /model command is executed by the gateway, its reply does not appear in the chat
        res = await rpc("setModel", {"conversationId": "c-use", "model": "deepseek-v4-pro", "provider": "deepseek"})
        assert res["result"]["model"] == "deepseek-flash" and "Model switched to `deepseek-v4-pro`" in res["result"]["message"], res  # model re-read from the database
        res = await rpc("setModel", {"conversationId": "c-use", "model": "refused"})
        assert "Unknown model" in res["error"], res
        res = await rpc("setModel", {"conversationId": "c-use", "model": "cancelled"})
        assert res["error"].startswith("Model switch cancelled"), res
        assert "error" in await rpc("setModel", {"conversationId": "c-use"}), "missing parameters"
        # end of run: the session's consumption follows run.completed
        await server.send({"type": "inbound", "conversationId": "c-use", "runId": "r-use", "text": "bonjour"})
        got = await server.until(lambda f: f.get("runId") == "r-use" and f["event"]["type"].startswith("run."))
        kinds = [e["type"] for e in events_of(got, "r-use")]
        assert kinds.index("usage") < kinds.index("run.completed"), kinds
        assert [e for e in events_of(got, "r-use") if e["type"] == "usage"][0]["usage"]["costUsd"] == 0.0123
        # setModel refused during a run
        await server.send({"type": "inbound", "conversationId": "c9", "runId": "r-use2", "text": "long"})
        await asyncio.sleep(0.3)
        assert "run is in progress" in (await rpc("setModel", {"conversationId": "c9", "model": "x"}))["error"]
        agent.release.set()
        await server.until(lambda f: f.get("runId") == "r-use2" and f["event"]["type"].startswith("run."))
        agent.release.clear()
        print("✓ model and cost (sessionUsage, listModels, setModel, usage event)")

        # 6. cron delivery outside the gateway (send-only connection)
        res = await adapter_mod._standalone_send(PlatformConfig(enabled=True, extra={"url": url, "token": TOKEN}), "home", "Morning cron")
        assert res.get("success"), res
        frames = await server.until(lambda f: f.get("type") == "outbound")
        assert frames[-1]["text"] == "Morning cron"
        assert server.hello.get("mode") is None, "the main connection is not replaced"
        print("✓ cron hors gateway (standalone_sender_fn)")

        await adapter.disconnect()
    shutil.rmtree(os.environ["HERMES_HOME"], ignore_errors=True)  # otherwise each run leaves a folder
    print("\nAll tests pass.")


asyncio.run(main())
