"""
AgentUI channel for Hermes Agent (AgentUI Channel Protocol v1, see plugins/protocol/PROTOCOL.md).

The Hermes gateway opens a WebSocket to AgentUI, the way a Telegram bot opens its long-polling:
- ``inbound``  → ``MessageEvent`` (one AgentUI ``conversationId`` = one ``chat_id`` = one Hermes session);
- streaming   → stream consumer previews (``send`` then ``edit_message``) translated into deltas;
- tools, sub-agents, reasoning → plugin hooks (``pre_tool_call``, ``post_tool_call``, ``subagent_*``,
  ``post_llm_call``), attached to the chat through the gateway's session ContextVars;
- approvals → ``send_exec_approval`` / ``resolve_gateway_approval``;
- end of run → ``on_processing_complete``; stop → ``/stop`` command;
- ``send()`` outside a run (crons, send_message) → proactive ``outbound`` message.

Configuration (``~/.hermes/.env``): ``AGENTUI_URL``, ``AGENTUI_TOKEN``. By default the platform streams and shows
no tool progress bubbles (can be overridden via ``display.platforms.agentui.*``).
"""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import hashlib
import json
import logging
import mimetypes
import os
import re
import threading
import time
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from gateway.config import Platform
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    ProcessingOutcome,
    SendResult,
    cache_document_from_bytes,
    cache_image_from_bytes,
)

logger = logging.getLogger(__name__)

PLATFORM = "agentui"
PROTOCOL = 1
HOME_CHAT = "home"  # chat_id of proactive messages without a chat: AgentUI files them in its "home" chat
OWNER_ID = "agentui-owner"  # the user is authenticated by AgentUI, not by Hermes
MAX_RESULT = 20_000
MAX_MEDIA = 20 * 1024 * 1024
OUTBOX_LIMIT = 2_000
PREVIEW_HOLD_S = 10.0  # a streamed preview outside a run waits this long for its next edit before being posted as is
ASK_TIMEOUT = 1800.0  # seconds to wait for the answer to an interactive widget (agentui_ask / confirm / form)

CAPABILITIES = {
    "sessions": True,
    "abort": True,
    "approvals": True,
    "subagents": True,
    "reasoning": True,
    "toolDetails": True,
    "skills": True,
    "jobs": True,
    "jobControl": True,
    "sessionDelete": True,
    "models": True,
    "attachments": {"images": True, "files": True, "maxBytes": MAX_MEDIA},
}

# Live adapter (only one per gateway/profile): hooks run in the agent's thread and find it here.
_ACTIVE: Optional["AgentUIAdapter"] = None


def _hermes_version() -> str:
    try:
        from importlib.metadata import version

        return version("hermes-agent")
    except Exception:
        return ""


def _settings(config=None) -> tuple[str, str, str]:
    extra = getattr(config, "extra", {}) or {}
    url = os.getenv("AGENTUI_URL") or extra.get("url", "")
    token = os.getenv("AGENTUI_TOKEN") or extra.get("token", "")
    name = os.getenv("AGENTUI_NAME") or extra.get("name", "Hermes")
    return url, token, name


def _sub_agents() -> List[dict]:
    """Profile served by this gateway (one Hermes profile = one gateway = one connection), like the api_server adapter."""
    profile = os.getenv("HERMES_PROFILE", "").strip()
    if not profile:
        try:
            from hermes_cli.profiles import get_active_profile_name

            profile = get_active_profile_name()
        except Exception:
            profile = "default"
    return [{"id": profile, "name": profile, "description": "Profil Hermes", "isDefault": True}]


def _iso_ms(v: Any) -> Optional[int]:
    if not v:
        return None
    try:
        from datetime import datetime

        return int(datetime.fromisoformat(str(v)).timestamp() * 1000)
    except Exception:
        return None


def _list_jobs() -> List[dict]:
    """Cron tasks, in AgentUI's Job format (like GET /api/jobs of the api_server)."""
    from cron.jobs import list_jobs

    out = []
    for j in list_jobs(include_disabled=True):
        ex = j.get("latest_execution") or {}
        running = ex.get("status") in ("claimed", "running") and not ex.get("finished_at")
        deliver = str(j.get("deliver") or "")
        deliver_to = deliver.split(":", 1)[1] if deliver.startswith(PLATFORM + ":") else (HOME_CHAT if deliver == PLATFORM else None)
        sched = j.get("schedule")
        schedule = j.get("schedule_display") or (sched.get("display") or sched.get("expr") if isinstance(sched, dict) else sched) or ""
        out.append({
            "id": str(j.get("id")),
            "name": j.get("name") or str(j.get("id")),
            "schedule": str(schedule),
            "mode": "script" if j.get("no_agent") else "agent",
            "prompt": None if j.get("no_agent") else (j.get("prompt") or None),
            "script": j.get("script") or None,
            "enabled": j.get("enabled", True) is not False and j.get("state") != "paused" and not j.get("paused_at"),
            "nextRunAt": _iso_ms(j.get("next_run_at")),
            "lastRunAt": _iso_ms(j.get("last_run_at")),
            "lastStatus": j.get("last_status") or None,
            # "Run now" sets manual_run_at; the scheduler picks it up at the next tick (≤ 1 min).
            "queued": bool(j.get("manual_run_at")) and not running,
            "running": running,
            "lastError": ex.get("error") or j.get("last_error") or None,
            "deliverTo": deliver_to,
        })
    return out


MAX_SCRIPT_BYTES = 200_000


def _read_job_script(job_id: str) -> dict:
    """Source of the script of a cron task (``scripts/`` folder of the Hermes home; nothing outside it)."""
    from cron.jobs import get_job
    from hermes_constants import get_hermes_home

    job = get_job(job_id)
    if not job:
        raise ValueError(f"task not found: {job_id}")
    name = str(job.get("script") or "")
    if not name:
        raise ValueError("this task has no script")
    root = (get_hermes_home() / "scripts").resolve()
    path = (root / name).resolve()
    if root not in path.parents or not path.is_file():
        raise ValueError(f"script not found: {name}")
    data = path.read_bytes()[:MAX_SCRIPT_BYTES]
    return {"name": name, "content": data.decode("utf-8", errors="replace")}


def _job_action(job_id: str, action: str) -> dict:
    from cron import jobs as cron_jobs

    ops = {"pause": cron_jobs.pause_job, "resume": cron_jobs.resume_job, "run": cron_jobs.trigger_job, "delete": cron_jobs.remove_job}
    op = ops.get(action)
    if op is None:
        raise ValueError(f"unknown action: {action}")
    if not op(job_id):
        raise ValueError(f"task not found: {job_id}")
    return {"ok": True}


def _list_skills() -> List[dict]:
    """Installed skills (same list as /skills list), with their enabled/disabled state."""
    from tools.skills_tool import _find_all_skills, _sort_skills

    enabled = {s.get("name") for s in _find_all_skills(skip_disabled=True)}
    return [
        {"id": s.get("name"), "name": s.get("name"), "description": s.get("description"), "category": s.get("category"), "enabled": s.get("name") in enabled}
        for s in _sort_skills(_find_all_skills(skip_disabled=False))
    ]


def _read_skill(skill_id: str) -> dict:
    """Content of SKILL.md (like the agent's skill_view tool)."""
    import json
    from tools.skills_tool import skill_view

    res = json.loads(skill_view(skill_id, preprocess=False))
    if not res.get("success"):
        raise ValueError(res.get("error") or f"skill illisible : {skill_id}")
    return {"content": str(res.get("content") or "")}


def _hello(token: str, name: str, mode: Optional[str] = None, active_runs: Optional[list] = None) -> dict:
    msg = {
        "type": "hello",
        "protocol": PROTOCOL,
        "token": token,
        "agent": {"type": "hermes", "name": name, "version": _hermes_version()},
        "capabilities": CAPABILITIES,
    }
    msg["subAgents"] = _sub_agents()
    if active_runs:
        msg["activeRuns"] = active_runs
    if mode:
        msg["mode"] = mode
    return msg


CRON_PREFIX = "cron-"


def _cron_title(chat_id: str, job_id: Optional[str] = None) -> Optional[str]:
    """Title of the AgentUI chat of a cron task ("⏰ name"): the task name if known, otherwise derived
    from an ``agentui:cron-<name>`` target. None for an ordinary chat."""
    if job_id:
        try:
            from cron.jobs import get_job

            job = get_job(job_id)
            if job and job.get("name"):
                return f"⏰ {job['name']}"
        except Exception:
            pass
    if chat_id and chat_id.startswith(CRON_PREFIX) and len(chat_id) > len(CRON_PREFIX):
        return f"⏰ {chat_id[len(CRON_PREFIX):]}"
    return None


def _media(name: str, data: bytes, mime: Optional[str] = None) -> dict:
    mime = mime or mimetypes.guess_type(name)[0] or "application/octet-stream"
    return {"name": name, "mimeType": mime, "data": base64.b64encode(data).decode("ascii")}


def _read_source(src: str) -> tuple[str, bytes, Optional[str]]:
    """Reads a media designated by path, file://, data: or http(s):// (blocking call)."""
    if src.startswith("data:"):
        head, _, payload = src.partition(",")
        mime = head[5:].split(";")[0] or None
        ext = mimetypes.guess_extension(mime or "") or ""
        return f"image{ext}", base64.b64decode(payload), mime
    if src.startswith(("http://", "https://")):
        with urllib.request.urlopen(src, timeout=30) as resp:  # noqa: S310 (URL provided by the agent)
            data = resp.read(MAX_MEDIA + 1)
            mime = resp.headers.get_content_type()
        return Path(src.split("?")[0]).name or "media", data, mime
    path = Path(src[7:] if src.startswith("file://") else src)
    return path.name, path.read_bytes(), None


def _strip_cursor(text: str) -> str:
    """Removes the streaming cursor ("▉") added to previews by the stream consumer."""
    try:
        from gateway.stream_consumer import StreamConsumerConfig

        cursor = StreamConsumerConfig().cursor or "▉"
    except Exception:
        cursor = "▉"
    text = text or ""
    stripped = text.rstrip()
    if cursor.strip() and stripped.endswith(cursor.strip()):
        return stripped[: -len(cursor.strip())].rstrip()
    return text


_FAILURE_MARKERS = ("❌", "✗", "🟡", "⚠")


def _session_usage(conversation_id: str) -> Optional[dict]:
    """Model and accumulated consumption of the Hermes session of a chat, read from its database (None if unknown)."""
    import sqlite3

    from hermes_state import SessionDB

    db = SessionDB(read_only=True)
    try:
        path = str(db.db_path)
    finally:
        db.close()
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    try:
        con.row_factory = sqlite3.Row
        row = con.execute(
            "SELECT model, billing_provider, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens,"
            " estimated_cost_usd, actual_cost_usd FROM sessions WHERE source = ? AND chat_id = ? ORDER BY started_at DESC LIMIT 1",
            (PLATFORM, conversation_id),
        ).fetchone()
    finally:
        con.close()
    if row is None:
        return None
    model = row["model"] or _default_model()
    usage: Dict[str, Any] = {"inputTokens": int(row["input_tokens"] or 0), "outputTokens": int(row["output_tokens"] or 0)}
    if model:
        usage["model"] = str(model)
    if row["billing_provider"]:
        usage["provider"] = str(row["billing_provider"])
    for key, col in (("cacheReadTokens", "cache_read_tokens"), ("reasoningTokens", "reasoning_tokens")):
        if row[col]:
            usage[key] = int(row[col])
    actual, estimated = row["actual_cost_usd"], row["estimated_cost_usd"]
    if actual or estimated:
        usage["costUsd"] = float(actual or estimated)
        usage["costEstimated"] = not actual
    return usage


def _default_model() -> Optional[str]:
    """Default model of the Hermes configuration (for a session that has not recorded one yet)."""
    try:
        from hermes_cli.config import load_config

        model = (load_config() or {}).get("model")
        return (model.get("default") if isinstance(model, dict) else model) or None
    except Exception:
        return None


def _list_models() -> List[dict]:
    """Models of authenticated providers, flattened: [{provider, providerName, id}]."""
    from hermes_cli.model_switch import list_authenticated_providers

    cfg_model: Any = {}
    try:
        from hermes_cli.config import load_config

        cfg_model = (load_config() or {}).get("model") or {}
    except Exception:
        pass
    current_provider = cfg_model.get("provider", "") if isinstance(cfg_model, dict) else ""
    out: List[dict] = []
    for p in list_authenticated_providers(current_provider=current_provider):
        for m in p.get("models") or []:
            out.append({"provider": str(p.get("slug", "")), "providerName": str(p.get("name") or p.get("slug", "")), "id": str(m)})
    return out


@dataclass
class _Ask:
    """Question asked by an interactive tool (`agentui_ask`…): the agent's thread waits on `event`."""
    id: str
    event: threading.Event = field(default_factory=threading.Event)
    answer: Optional[str] = None  # None at the end of the wait = cancelled (run finished) or expired


@dataclass
class _Run:
    run_id: str
    conversation_id: str
    message_id: str
    # Messages "posted" by the gateway during the run (streamed previews, edited in place, then final reply),
    # in order: the AgentUI text is their concatenation.
    bubbles: Dict[str, str] = field(default_factory=dict)
    emitted: str = ""  # text already sent to AgentUI (accumulated deltas)
    settled: bool = False  # the last send was a complete message.final
    # Serializes `_sync`: called from the asyncio loop and the agent's thread, two simultaneous calls
    # would start from the same `emitted` and send overlapping deltas (repeated text on screen).
    sync_lock: threading.RLock = field(default_factory=threading.RLock)
    aborted: bool = False


class AgentUIAdapter(BasePlatformAdapter):
    supports_code_blocks = True  # AgentUI renders Markdown
    splits_long_messages = True  # no splitting on the gateway side: AgentUI accepts long messages
    interactive_resume = True

    def __init__(self, config, **kwargs):
        super().__init__(config=config, platform=Platform(PLATFORM))
        self.url, self.token, self.display_name = _settings(config)
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._ws = None
        self._conn_task: Optional[asyncio.Task] = None
        self._writer_task: Optional[asyncio.Task] = None
        self._outbox: Optional[asyncio.Queue] = None
        self._unsent: Optional[dict] = None
        self._welcomed: Optional[asyncio.Event] = None
        self._captures: Dict[str, asyncio.Future] = {}  # replies to control commands (/model) to send back as rpc
        self._muted_until: Dict[str, float] = {}  # stopped chats: the /stop confirmation is ignored
        self._lock = threading.Lock()  # protects the tables below (agent thread + asyncio loop)
        self._runs: Dict[str, _Run] = {}  # conversationId → run en cours
        # Streamed previews sent outside any run (message_id → [chat, text, flush timer]): held until the final edit, then posted once.
        self._previews: Dict[str, list] = {}
        self._approvals: Dict[str, str] = {}  # approval id → Hermes session_key
        self._clarifies: Dict[str, Tuple[str, str]] = {}  # chat → (session_key, clarify_id) of the pending question
        self._asks: Dict[str, _Ask] = {}  # chat → question of a pending interactive tool
        self._thread_ops: Dict[str, concurrent.futures.Future] = {}  # thread.get id → future resolved by thread.result
        self._notify_ops: Dict[str, concurrent.futures.Future] = {}  # notify id → future resolved by notify.result
        self._miniapp_ops: Dict[str, concurrent.futures.Future] = {}  # miniapp.op id → future resolved by miniapp.result
        self._session_chat: Dict[str, str] = {}  # Hermes session_id (agent or sub-agent) → conversationId
        self._session_subagent: Dict[str, str] = {}  # session_id of a sub-agent → AgentUI sub-agent id
        self._closing = False

    @property
    def name(self) -> str:
        return "AgentUI"

    @property
    def authorization_is_upstream(self) -> bool:
        # The user is authenticated by AgentUI and the transport by the token: no Hermes allowlist to apply.
        return True

    # ── Connection ────────────────────────────────────────────────────────────

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        global _ACTIVE
        if not self.url or not self.token:
            self._set_fatal_error("config_missing", "AGENTUI_URL and AGENTUI_TOKEN are required", retryable=False)
            return False
        self._loop = asyncio.get_running_loop()
        self._closing = False
        if self._outbox is None:  # kept across reconnections: nothing is lost during a cut
            self._outbox = asyncio.Queue()
        self._welcomed = asyncio.Event()
        _ACTIVE = self
        self._conn_task = asyncio.create_task(self._connection_loop())
        try:
            await asyncio.wait_for(self._welcomed.wait(), timeout=15)
        except asyncio.TimeoutError:
            logger.warning("AgentUI: no response from %s, retrying in the background", self.url)
        return True  # the loop reconnects by itself; the real state goes through _mark_connected/_mark_disconnected

    async def disconnect(self) -> None:
        global _ACTIVE
        self._closing = True
        self._mark_disconnected()
        for task in (self._conn_task, self._writer_task):
            if task and not task.done():
                task.cancel()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
        self._ws = None
        if _ACTIVE is self:
            _ACTIVE = None

    async def _connection_loop(self) -> None:
        import websockets

        delay = 1.0
        while not self._closing:
            try:
                async with websockets.connect(self.url, max_size=64 * 1024 * 1024, ping_interval=None) as ws:
                    with self._lock:
                        active = [{"runId": r.run_id, "conversationId": c} for c, r in self._runs.items()]
                    await ws.send(json.dumps(_hello(self.token, self.display_name, active_runs=active)))
                    welcome = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
                    if welcome.get("type") != "welcome":
                        raise ConnectionError(f"unexpected response: {welcome.get('type')}")
                    self._ws = ws
                    self._mark_connected()
                    self._welcomed.set()
                    delay = 1.0
                    logger.info("AgentUI: connected to %s", self.url)
                    self._writer_task = asyncio.create_task(self._writer(ws))
                    async for raw in ws:
                        try:
                            await self._on_frame(json.loads(raw))
                        except Exception:
                            logger.exception("AgentUI: frame ignored")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                code = getattr(getattr(e, "rcvd", None), "code", None)
                if code in (4001, 4002):
                    self._set_fatal_error("auth", f"AgentUI refused the connection ({code})", retryable=False)
                    return
                logger.warning("AgentUI: connection lost (%s), reconnecting in %.0f s", e, delay)
            finally:
                self._ws = None
                if self._writer_task:
                    self._writer_task.cancel()
                if not self._closing:
                    self._mark_disconnected()
            if self._closing:
                return
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)

    async def _writer(self, ws) -> None:
        """Flushes the send queue in order; frames stay queued during a cut."""
        while True:
            msg = self._unsent or await self._outbox.get()
            self._unsent = msg  # sent back first after reconnection if the send fails
            await ws.send(json.dumps(msg, ensure_ascii=False, default=str))
            self._unsent = None

    def _post(self, msg: dict) -> None:
        """Thread-safe send (asyncio loop or agent thread)."""
        if self._loop is None or self._outbox is None:
            return
        def put():
            if self._outbox.qsize() < OUTBOX_LIMIT:
                self._outbox.put_nowait(msg)
        try:
            in_loop = asyncio.get_running_loop() is self._loop
        except RuntimeError:  # agent thread: no current loop
            in_loop = False
        if in_loop:
            put()
        else:
            self._loop.call_soon_threadsafe(put)

    def _emit(self, conversation_id: str, event: dict) -> bool:
        with self._lock:
            run = self._runs.get(conversation_id)
        if run is None:
            return False
        self._post({"type": "event", "conversationId": conversation_id, "runId": run.run_id, "event": event})
        return True

    def _finish(self, conversation_id: str, event: dict) -> None:
        with self._lock:
            run = self._runs.pop(conversation_id, None)
            self._clarifies.pop(conversation_id, None)
            ask = self._asks.pop(conversation_id, None)
        if ask is not None:
            ask.event.set()  # run finished or stopped: the waiting tool hands control back without an answer
        if run is not None:
            self._post({"type": "event", "conversationId": conversation_id, "runId": run.run_id, "event": event})

    # ── AgentUI → Hermes ─────────────────────────────────────────────────────

    async def _on_frame(self, msg: dict) -> None:
        kind = msg.get("type")
        if kind == "inbound":
            await self._on_inbound(msg)
        elif kind == "abort":
            await self._on_abort(msg)
        elif kind == "approval":
            self._on_approval(msg)
        elif kind == "reply":
            self._on_reply(msg)
        elif kind == "rpc":
            asyncio.create_task(self._on_rpc(msg))
        elif kind == "miniapp.result":
            with self._lock:
                fut = self._miniapp_ops.pop(str(msg.get("id")), None)
            if fut is not None and not fut.done():
                if msg.get("ok"):
                    fut.set_result(msg.get("result"))
                else:
                    fut.set_exception(RuntimeError(msg.get("error") or "Miniapp operation failed."))
        elif kind == "notify.result":
            with self._lock:
                fut = self._notify_ops.pop(str(msg.get("id")), None)
            if fut is not None and not fut.done():
                if msg.get("ok"):
                    fut.set_result(msg.get("result"))
                else:
                    fut.set_exception(RuntimeError(msg.get("error") or "Notification failed."))
        elif kind == "thread.result":
            with self._lock:
                fut = self._thread_ops.pop(str(msg.get("id")), None)
            if fut is not None and not fut.done():
                if msg.get("ok"):
                    fut.set_result(msg.get("result"))
                else:
                    fut.set_exception(RuntimeError(msg.get("error") or "Conversation not found."))
        elif kind == "ping":
            self._post({"type": "pong"})

    def miniapp_op(self, op: str, args: Dict[str, Any], timeout: float = 60.0) -> Any:
        """Runs a miniapp operation (create, write…) on the AgentUI server and waits for its result (agent thread)."""
        fut: concurrent.futures.Future = concurrent.futures.Future()
        op_id = f"app_{uuid.uuid4().hex[:12]}"
        with self._lock:
            self._miniapp_ops[op_id] = fut
        self._post({"type": "miniapp.op", "id": op_id, "op": op, "args": args})
        try:
            return fut.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            raise RuntimeError("No answer from AgentUI (is the server up to date? miniapps need a recent AgentUI).")
        finally:
            with self._lock:
                self._miniapp_ops.pop(op_id, None)

    def thread_title(self, conversation_id: str, timeout: float = 15.0) -> Any:
        """Current title of the chat, asked to AgentUI (agent thread)."""
        fut: concurrent.futures.Future = concurrent.futures.Future()
        op_id = f"thread_{uuid.uuid4().hex[:12]}"
        with self._lock:
            self._thread_ops[op_id] = fut
        self._post({"type": "thread.get", "id": op_id, "conversationId": conversation_id})
        try:
            return fut.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            raise RuntimeError("No answer from AgentUI (is the server up to date? reading the title needs a recent AgentUI).")
        finally:
            with self._lock:
                self._thread_ops.pop(op_id, None)

    def notify(self, title: str, body: str = "", url: str = "", timeout: float = 30.0) -> Any:
        """Sends a push notification to the user's devices through AgentUI and waits for its result (agent thread)."""
        fut: concurrent.futures.Future = concurrent.futures.Future()
        op_id = f"notify_{uuid.uuid4().hex[:12]}"
        with self._lock:
            self._notify_ops[op_id] = fut
        frame: Dict[str, Any] = {"type": "notify", "id": op_id, "title": title}
        if body:
            frame["body"] = body
        if url:
            frame["url"] = url
        self._post(frame)
        try:
            return fut.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            raise RuntimeError("No answer from AgentUI (is the server up to date? notifications need a recent AgentUI).")
        finally:
            with self._lock:
                self._notify_ops.pop(op_id, None)

    async def _on_inbound(self, msg: dict) -> None:
        conv, run_id = msg["conversationId"], msg["runId"]
        media_urls: List[str] = []
        media_types: List[str] = []
        message_type = MessageType.TEXT
        for att in msg.get("attachments") or []:
            data = base64.b64decode(att["data"])
            mime = att.get("mimeType") or "application/octet-stream"
            if mime.startswith("image/"):
                media_urls.append(cache_image_from_bytes(data, mimetypes.guess_extension(mime) or ".jpg"))
                message_type = MessageType.PHOTO
            else:
                media_urls.append(cache_document_from_bytes(data, att.get("name") or "file"))
                if message_type is MessageType.TEXT:
                    message_type = MessageType.DOCUMENT
            media_types.append(mime)
        with self._lock:
            self._runs[conv] = _Run(run_id=run_id, conversation_id=conv, message_id=run_id)
        source = self.build_source(chat_id=conv, chat_name=conv, chat_type="dm", user_id=OWNER_ID, user_name="AgentUI")
        event = MessageEvent(
            text=msg.get("text", ""),
            message_type=message_type,
            source=source,
            message_id=run_id,
            media_urls=media_urls,
            media_types=media_types,
        )
        try:
            await self.handle_message(event)
        except Exception as e:
            logger.exception("AgentUI: dispatch failed")
            self._finish(conv, {"type": "run.failed", "error": str(e)})

    async def _on_abort(self, msg: dict) -> None:
        conv = msg["conversationId"]
        with self._lock:
            run = self._runs.get(conv)
            if run is None or run.run_id != msg.get("runId"):
                return
            run.aborted = True
            self._muted_until[conv] = time.monotonic() + 10
        source = self.build_source(chat_id=conv, chat_name=conv, chat_type="dm", user_id=OWNER_ID, user_name="AgentUI")
        # /stop interrupts the agent immediately and frees the session (gateway/run.py, _interrupt_and_clear_session)
        await self.handle_message(MessageEvent(text="/stop", message_type=MessageType.COMMAND, source=source, message_id=f"stop-{uuid.uuid4().hex[:8]}"))
        self._finish(conv, {"type": "run.aborted"})

    def _on_approval(self, msg: dict) -> None:
        with self._lock:
            session_key = self._approvals.pop(msg.get("id", ""), None)
        if not session_key:
            return
        choice = (msg.get("scope") or "once") if msg.get("approve") else "deny"
        try:
            from tools.approval import resolve_gateway_approval

            resolve_gateway_approval(session_key, choice)
        except Exception:
            logger.exception("AgentUI: approval resolution failed")

    def _on_reply(self, msg: dict) -> None:
        """Answer to a pending `clarify` question: it unblocks the tool, the current run resumes."""
        conv, text = msg.get("conversationId", ""), msg.get("text", "")
        with self._lock:
            ask = self._asks.get(conv)
            if ask is not None and not ask.event.is_set():
                ask.answer = text
                ask.event.set()  # unblocks the interactive tool, which emits `question.resolved` itself
                return
            pending = self._clarifies.pop(conv, None)
        if pending is None:
            logger.warning("AgentUI: answer without a pending question (chat %s)", conv)
            return
        session_key, clarify_id = pending
        try:
            from tools import clarify_gateway as cg

            # "2" or an option label → the option; an invalid selection or a free answer → the text as is
            if cg.attempt_text_response_for_session(session_key, text) != cg.TEXT_RESOLVED:
                cg.resolve_gateway_clarify(clarify_id, text)
        except Exception:
            logger.exception("AgentUI: question resolution failed")
            with self._lock:
                self._clarifies.setdefault(conv, pending)  # still pending: the user can retry
            return
        self._emit(conv, {"type": "question.resolved", "id": clarify_id})

    def _delete_session(self, conversation_id: str) -> dict:
        """Deletes the Hermes session of an AgentUI chat (one chat = one chat_id = one session).

        Same sequence as the official ``session.delete`` RPC: a live session is refused (the agent
        would trip over the foreign key at its next flush), otherwise the row, its messages and the
        transcript files are erased. Unknown chat: success (idempotent).
        """
        if not conversation_id:
            raise ValueError("conversationId manquant")
        with self._lock:
            if conversation_id in self._runs:
                raise RuntimeError("a run is in progress in this chat")
        from hermes_constants import get_hermes_home
        from hermes_state import SessionDB

        db = SessionDB(read_only=False)
        try:
            session_id = db.find_session_by_origin(platform=PLATFORM, chat_id=conversation_id)
            if not session_id:
                return {"ok": True, "deleted": False}
            deleted = db.delete_session(session_id, sessions_dir=get_hermes_home() / "sessions")
        finally:
            db.close()  # 0.19 has no context manager on SessionDB
        return {"ok": True, "deleted": bool(deleted)}

    async def _control(self, conversation_id: str, text: str, timeout: float = 20.0) -> str:
        """Passes a control command (/model…) to the gateway as if the user had typed it, and returns its
        reply instead of displaying it in the chat."""
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        with self._lock:
            if conversation_id in self._captures:
                raise RuntimeError("a command is already in progress in this chat")
            self._captures[conversation_id] = fut
        source = self.build_source(chat_id=conversation_id, chat_name=conversation_id, chat_type="dm", user_id=OWNER_ID, user_name="AgentUI")
        try:
            await self.handle_message(MessageEvent(text=text, message_type=MessageType.COMMAND, source=source, message_id=f"ctl-{uuid.uuid4().hex[:8]}"))
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise RuntimeError("Hermes did not respond in time")
        finally:
            with self._lock:
                self._captures.pop(conversation_id, None)

    async def _set_model(self, params: dict) -> dict:
        """Sets the model of a chat's session (the gateway's /model command, limited to the session)."""
        conv, model, provider = str(params.get("conversationId", "")), str(params.get("model", "")).strip(), str(params.get("provider", "")).strip()
        if not conv or not model:
            raise ValueError("conversationId and model are required")
        with self._lock:
            if conv in self._runs:
                raise RuntimeError("a run is in progress in this chat")
        reply = await self._control(conv, f"/model {model}" + (f" --provider {provider}" if provider else "") + " --session")
        text = reply.strip()
        # The gateway replies "Model switched to `x` …" on success; a refusal starts with an error marker
        # (❌ unknown model, 🟡 change cancelled…). A warning in the middle of the text is not a failure.
        if text.startswith(_FAILURE_MARKERS):
            raise RuntimeError(text.lstrip("".join(_FAILURE_MARKERS) + "\ufe0f \n").strip() or "model change refused")
        usage = await asyncio.to_thread(_session_usage, conv)
        return {"model": (usage or {}).get("model") or model, **({"provider": provider} if provider else {}), "message": text}

    async def _on_rpc(self, msg: dict) -> None:
        method, params = msg.get("method"), msg.get("params") or {}
        if method == "setModel":
            try:
                self._post({"type": "rpc.result", "id": msg.get("id"), "result": await self._set_model(params)})
            except Exception as e:
                logger.warning("AgentUI: rpc setModel failed: %s", e)
                self._post({"type": "rpc.result", "id": msg.get("id"), "error": str(e) or type(e).__name__})
            return
        handlers = {
            "listModels": _list_models,
            "sessionUsage": lambda: _session_usage(str(params.get("conversationId", ""))),
            "listSubAgents": _sub_agents,
            "listJobs": _list_jobs,
            "listSkills": _list_skills,
            "readSkill": lambda: _read_skill(str(params.get("skillId", ""))),
            "readJobScript": lambda: _read_job_script(str(params.get("jobId", ""))),
            "jobAction": lambda: _job_action(str(params.get("jobId", "")), str(params.get("action", ""))),
            "deleteSession": lambda: self._delete_session(str(params.get("conversationId", ""))),
        }
        handler = handlers.get(str(method))
        if handler is None:
            self._post({"type": "rpc.result", "id": msg.get("id"), "error": f"unsupported method: {method}"})
            return
        try:
            result = await asyncio.to_thread(handler)  # disk read / state files: off the loop
            self._post({"type": "rpc.result", "id": msg.get("id"), "result": result})
        except Exception as e:
            logger.warning("AgentUI: rpc %s failed: %s", method, e)
            self._post({"type": "rpc.result", "id": msg.get("id"), "error": str(e) or type(e).__name__})

    # ── Hermes → AgentUI: lifecycle ──────────────────────────────────────

    async def on_processing_complete(self, event: MessageEvent, outcome: ProcessingOutcome) -> None:
        conv = event.source.chat_id
        with self._lock:
            run = self._runs.get(conv)
        if run is None or run.message_id != event.message_id:
            return  # /stop or message already finished
        if run.emitted and not run.settled:
            self._emit(conv, {"type": "message.final", "text": run.emitted})  # freezes the text (without cursor)
        try:  # accumulated consumption of the session (even interrupted, tokens are consumed): AgentUI shows it
            usage = await asyncio.to_thread(_session_usage, conv)
            if usage:
                self._emit(conv, {"type": "usage", "usage": usage})
        except Exception:
            logger.debug("AgentUI: cannot read the consumption", exc_info=True)
        if outcome is ProcessingOutcome.SUCCESS:
            self._finish(conv, {"type": "run.completed"})
        elif outcome is ProcessingOutcome.CANCELLED or run.aborted:
            self._finish(conv, {"type": "run.aborted"})
        else:
            self._finish(conv, {"type": "run.failed", "error": "Hermes processing failed"})

    # ── Hermes → AgentUI : streaming ─────────────────────────────────────────
    # Standard adapter contract: the gateway's stream consumer posts a message (send) then edits it
    # (edit_message) as tokens arrive. We translate these edits into AgentUI deltas; this works whatever the
    # internal streaming mechanics of the Hermes version.

    def _sync(self, run: "_Run") -> None:
        with run.sync_lock:
            with self._lock:
                texts = list(run.bubbles.values())
            full = "\n\n".join(t.strip() for t in texts if t.strip())
            if full == run.emitted:
                return
            if full.startswith(run.emitted):
                self._emit(run.conversation_id, {"type": "message.delta", "text": full[len(run.emitted):]})
                run.settled = False
            else:  # rewrite (cursor end, preview removed…): AgentUI replaces the accumulated text
                self._emit(run.conversation_id, {"type": "message.final", "text": full})
                run.settled = True
            run.emitted = full

    def format_tool_event(self, event: Any, *, mode: str = "all", preview_max_len: int = 40) -> Optional[str]:
        return None  # no tool "bubbles": cards come from the pre/post_tool_call hooks

    # ── Hermes → AgentUI : messages ──────────────────────────────────────────

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        message_id = uuid.uuid4().hex
        with self._lock:
            capture = self._captures.get(chat_id)
        if capture is not None:  # reply to a control command (rpc setModel), not a message of the chat
            if not capture.done():
                self._loop.call_soon_threadsafe(lambda: capture.done() or capture.set_result(content))
            return SendResult(success=True, message_id=message_id)
        job_id = (metadata or {}).get("job_id")
        if job_id:
            # Cron task delivery: always a separate message, never mixed with a reply in progress.
            self._outbound(chat_id, content, [], title=_cron_title(chat_id, str(job_id)))
            return SendResult(success=True, message_id=message_id)
        with self._lock:
            run = self._runs.get(chat_id)
            muted = self._muted_until.get(chat_id, 0) > time.monotonic()
        if muted or (run is not None and run.aborted):
            return SendResult(success=True, message_id=message_id)  # "stopped" confirmation of /stop
        if run is not None:
            with self._lock:
                run.bubbles[message_id] = _strip_cursor(content)
            self._sync(run)
        elif _strip_cursor(content) != content:
            # Stream consumer preview (text + cursor) outside a run: the protocol cannot edit an outbound message,
            # so keep it until the final edit instead of posting every partial text as a message of its own.
            with self._lock:
                self._previews[message_id] = [chat_id, _strip_cursor(content), None]
            self._arm_preview(message_id)
        else:
            self._outbound(chat_id, content, [])
        return SendResult(success=True, message_id=message_id)

    def _arm_preview(self, message_id: str) -> None:
        """(Re)starts the safety timer that posts a held preview if its final edit never comes."""
        timer = threading.Timer(PREVIEW_HOLD_S, self._flush_preview, args=(message_id,))
        timer.daemon = True
        with self._lock:
            entry = self._previews.get(message_id)
            if entry is None:
                return
            if entry[2] is not None:
                entry[2].cancel()
            entry[2] = timer
        timer.start()

    def _flush_preview(self, message_id: str) -> None:
        with self._lock:
            entry = self._previews.pop(message_id, None)
        if entry is None:
            return
        if entry[2] is not None:
            entry[2].cancel()
        if entry[1].strip():
            self._outbound(entry[0], entry[1], [])

    def _outbound(self, chat_id: str, text: Optional[str], media: List[dict], title: Optional[str] = None) -> None:
        msg: Dict[str, Any] = {"type": "outbound", "id": uuid.uuid4().hex}
        if chat_id and chat_id != HOME_CHAT:
            msg["conversationId"] = chat_id
        title = title or _cron_title(chat_id)
        if title:
            msg["title"] = title
        if text:
            msg["text"] = text
        if media:
            msg["media"] = media
        self._post(msg)

    async def _send_media(self, chat_id: str, src: str, caption: Optional[str], name: Optional[str] = None) -> SendResult:
        try:
            src_name, data, mime = await asyncio.to_thread(_read_source, src)
        except Exception as e:
            return SendResult(success=False, error=f"unreadable media: {e}")
        if len(data) > MAX_MEDIA:
            return SendResult(success=False, error="media too large")
        media = _media(name or src_name, data, mime)
        if not self._emit(chat_id, {"type": "message.media", **media}):
            self._outbound(chat_id, caption, [media])
        elif caption:
            with self._lock:
                run = self._runs.get(chat_id)
                if run is not None:
                    run.bubbles[uuid.uuid4().hex] = caption
            if run is not None:
                self._sync(run)
        return SendResult(success=True, message_id=uuid.uuid4().hex)

    async def send_image(self, chat_id: str, image_url: str, caption: Optional[str] = None, reply_to: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        return await self._send_media(chat_id, image_url, caption)

    async def send_image_file(self, chat_id: str, image_path: str, caption: Optional[str] = None, reply_to: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_media(chat_id, image_path, caption)

    async def send_document(self, chat_id: str, file_path: str, caption: Optional[str] = None, file_name: Optional[str] = None, reply_to: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_media(chat_id, file_path, caption, name=file_name)

    async def send_voice(self, chat_id: str, audio_path: str, caption: Optional[str] = None, reply_to: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_media(chat_id, audio_path, caption)

    async def send_video(self, chat_id: str, video_path: str, caption: Optional[str] = None, reply_to: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_media(chat_id, video_path, caption)

    async def send_exec_approval(self, chat_id: str, command: str, session_key: str, description: str = "dangerous command", metadata: Optional[Dict[str, Any]] = None, allow_permanent: bool = True, smart_denied: bool = False, **flags: Any) -> SendResult:
        # **flags: options added by recent versions (allow_session in 0.21…), passed through as is.
        approval_id = uuid.uuid4().hex[:12]
        with self._lock:
            self._approvals[approval_id] = session_key
        sent = self._emit(chat_id, {
            "type": "approval.request",
            "id": approval_id,
            "description": f"{description}\n\n```\n{command}\n```",
            "payload": {"command": command, "allowPermanent": allow_permanent, "smartDenied": smart_denied, **flags},
        })
        if not sent:
            with self._lock:
                self._approvals.pop(approval_id, None)
            return SendResult(success=False, error="no AgentUI run for this chat")
        return SendResult(success=True, message_id=approval_id)

    async def send_clarify(self, chat_id: str, question: str, choices: Optional[list], clarify_id: str, session_key: str, metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        """Agent question mid-run (`clarify` tool). With choices: `ask` widget (buttons); the answer comes back
        through the `reply` frame and unblocks the tool, instead of passing for a new message (the run is still going)."""
        from tools import clarify_gateway as cg

        with self._lock:
            self._clarifies[chat_id] = (session_key, clarify_id)
        # Before the prompt: when the widget arrives, AgentUI already knows the answer is expected.
        self._emit(chat_id, {"type": "question.requested", "id": clarify_id})
        if choices:
            multi = bool(getattr(cg._entries.get(clarify_id), "multi_select", False))  # same reading as the base adapter
            cg.mark_awaiting_text(clarify_id)  # answers by text ("2", label, free text) are also accepted
            widget = {"type": "ask", "arguments": {"question": question, "options": [str(c) for c in choices], **({"multiple": True} if multi else {})}}
            content = "```widget\n" + json.dumps(widget, ensure_ascii=False) + "\n```"
        else:
            content = f"❓ {question}"
        return await self.send(chat_id=chat_id, content=content, metadata=metadata)

    def ask_blocking(self, chat: str, key: str, args: Dict[str, Any]) -> Dict[str, Any]:
        """Interactive tool (agent thread): displays the `key` widget then waits for the user's answer,
        which arrives through the `reply` frame as for `clarify`. Returns `{"answer": …}` or `{"error": …}`."""
        ask = _Ask(id=uuid.uuid4().hex[:12])
        live = key == "custom_wait"
        try:
            wait = min(max(float(args.get("timeout_s") or 600), 1.0), 1800.0) if live else ASK_TIMEOUT
        except (TypeError, ValueError):
            wait = 600.0
        with self._lock:
            run = self._runs.get(chat)
            if run is None:
                return {"error": "No AgentUI exchange in progress for this chat."}
            if chat in self._asks:
                return {"error": "A question is already awaiting an answer: wait for it before asking another one."}
            self._asks[chat] = ask
            if not live:  # `custom_wait` (live session with a widget) displays nothing: the widget is already there
                run.bubbles[uuid.uuid4().hex] = "```widget\n" + json.dumps({"type": key, "arguments": args}, ensure_ascii=False) + "\n```"
        # Before the widget: when it arrives, AgentUI already knows the answer is expected.
        self._emit(chat, {"type": "question.requested", "id": ask.id})
        self._sync(run)
        signalled = ask.event.wait(wait)  # False = nothing happened for `wait` seconds
        with self._lock:
            if self._asks.get(chat) is ask:
                del self._asks[chat]
        self._emit(chat, {"type": "question.resolved", "id": ask.id})
        if ask.answer is None:
            if live and not signalled:  # a normal outcome for a live session, the agent decides whether to keep listening
                return {"timeout": True}
            return {"error": "No answer from the user (exchange interrupted or timed out)."}
        if live:
            return _wait_result(ask.answer)
        return {"answer": ask.answer}

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        pass  # AgentUI already shows the run state

    async def edit_message(self, chat_id: str, message_id: str, content: str, *, finalize: bool = False, **kwargs) -> SendResult:
        with self._lock:
            preview = self._previews.get(message_id)
            if preview is not None:
                preview[1] = _strip_cursor(content)
        if preview is not None:
            if finalize or _strip_cursor(content) == content:  # final text (no cursor): post it once
                self._flush_preview(message_id)
            else:
                self._arm_preview(message_id)
            return SendResult(success=True, message_id=message_id)
        with self._lock:
            run = self._runs.get(chat_id)
            if run is None or message_id not in run.bubbles:
                return SendResult(success=False, error="unknown message")
            run.bubbles[message_id] = _strip_cursor(content)
        self._sync(run)
        return SendResult(success=True, message_id=message_id)

    async def delete_message(self, chat_id: str, message_id: str, *args, **kwargs) -> bool:
        with self._lock:
            run = self._runs.get(chat_id)
            removed = run is not None and run.bubbles.pop(message_id, None) is not None
            held = self._previews.pop(message_id, None)
        if held is not None:
            if held[2] is not None:
                held[2].cancel()
            removed = True
        if removed and run is not None:
            self._sync(run)
        return removed

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "dm"}

    # ── Hooks (agent thread) ────────────────────────────────────────────

    def _chat_for(self, session_id: Optional[str]) -> Optional[str]:
        """AgentUI chat of the current context: gateway ContextVars, otherwise the sessions table (sub-agents)."""
        try:
            from gateway.session_context import get_session_env

            if get_session_env("HERMES_SESSION_PLATFORM") == PLATFORM:
                chat = get_session_env("HERMES_SESSION_CHAT_ID")
                if chat:
                    if session_id:
                        with self._lock:
                            self._session_chat.setdefault(session_id, chat)
                    return chat
        except Exception:
            pass
        with self._lock:
            return self._session_chat.get(session_id or "")

    def hook_pre_tool_call(self, **kw: Any) -> None:
        session_id = kw.get("session_id") or ""
        chat = self._chat_for(session_id)
        if not chat:
            return
        event: Dict[str, Any] = {
            "type": "tool.started",
            "id": kw.get("tool_call_id") or uuid.uuid4().hex,
            "name": kw.get("tool_name") or "outil",
            "args": kw.get("args"),
        }
        with self._lock:
            parent = self._session_subagent.get(session_id)
        if parent:
            event["parentSubAgentRunId"] = parent
        self._emit(chat, event)

    def hook_post_tool_call(self, **kw: Any) -> None:
        chat = self._chat_for(kw.get("session_id"))
        if not chat or not kw.get("tool_call_id"):
            return
        if kw.get("tool_name") == "clarify":  # answered, cancelled or expired: nothing is awaited anymore
            with self._lock:
                pending = self._clarifies.pop(chat, None)
            if pending:
                self._emit(chat, {"type": "question.resolved", "id": pending[1]})
        result = kw.get("result")
        text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
        self._emit(chat, {
            "type": "tool.completed",
            "id": kw["tool_call_id"],
            "name": kw.get("tool_name"),
            "result": text[:MAX_RESULT],
            "truncated": len(text) > MAX_RESULT,
            "failed": kw.get("status") not in (None, "ok"),
        })

    def hook_subagent_start(self, **kw: Any) -> None:
        chat = self._chat_for(kw.get("parent_session_id"))
        child = kw.get("child_session_id")
        if not chat or not child:
            return
        sub_id = str(kw.get("child_subagent_id") or child)
        with self._lock:
            self._session_chat[child] = chat
            self._session_subagent[child] = sub_id
        name = kw.get("child_role") or (kw.get("child_goal") or "sous-agent")[:60]
        self._emit(chat, {"type": "subagent.start", "id": sub_id, "name": str(name), "sessionId": child})

    def hook_subagent_stop(self, **kw: Any) -> None:
        child = kw.get("child_session_id") or ""
        with self._lock:
            chat = self._session_chat.get(child)
            sub_id = self._session_subagent.get(child)
        if chat and sub_id:
            self._emit(chat, {"type": "subagent.end", "id": sub_id, "failed": kw.get("child_status") not in (None, "completed", "success", "ok")})

    def hook_post_llm_call(self, **kw: Any) -> None:
        if kw.get("platform") not in (PLATFORM, ""):
            return
        chat = self._chat_for(kw.get("session_id"))
        if not chat:
            return
        history = kw.get("conversation_history") or []
        start = max((i for i, m in enumerate(history) if isinstance(m, dict) and m.get("role") == "user"), default=-1)
        parts = []
        for m in history[start + 1:]:
            if isinstance(m, dict) and m.get("role") == "assistant":
                r = m.get("reasoning") or m.get("reasoning_content")
                if isinstance(r, str) and r.strip():
                    parts.append(r.strip())
        if parts:
            self._emit(chat, {"type": "reasoning.delta", "text": "\n\n".join(parts)})


def _hook(name: str):
    def call(**kw: Any) -> None:
        adapter = _ACTIVE
        if adapter is not None:
            try:
                getattr(adapter, f"hook_{name}")(**kw)
            except Exception:
                logger.debug("AgentUI: hook %s failed", name, exc_info=True)
    return call


# ── Enregistrement ───────────────────────────────────────────────────────────

def check_requirements() -> bool:
    try:
        import websockets  # noqa: F401
    except ImportError:
        return False
    return True


def validate_config(config) -> bool:
    url, token, _ = _settings(config)
    return bool(url and token)


def is_connected(config) -> bool:
    return validate_config(config)


def _env_enablement() -> dict | None:
    url, token = os.getenv("AGENTUI_URL", "").strip(), os.getenv("AGENTUI_TOKEN", "").strip()
    if not (url and token):
        return None
    home = os.getenv("AGENTUI_HOME_CHANNEL") or HOME_CHAT
    return {"url": url, "token": token, "home_channel": {"chat_id": home, "name": "AgentUI"}}


async def _standalone_send(pconfig, chat_id: str, message: str, *, thread_id: Optional[str] = None, media_files: Optional[List[str]] = None, force_document: bool = False) -> Dict[str, Any]:
    """Delivery of a cron run outside the gateway: ephemeral "send-only" connection."""
    import websockets

    url, token, name = _settings(pconfig)
    if not (url and token):
        return {"error": "AgentUI: AGENTUI_URL and AGENTUI_TOKEN are required"}
    media = []
    for path in media_files or []:
        try:
            src_name, data, mime = await asyncio.to_thread(_read_source, path)
            media.append(_media(src_name, data, mime))
        except Exception as e:
            logger.warning("AgentUI: media ignored (%s): %s", path, e)
    msg_id = uuid.uuid4().hex
    out: Dict[str, Any] = {"type": "outbound", "id": msg_id, "text": message}
    if chat_id and chat_id != HOME_CHAT:
        out["conversationId"] = chat_id
    title = _cron_title(chat_id)
    if title:
        out["title"] = title
    if media:
        out["media"] = media
    try:
        async with websockets.connect(url, max_size=64 * 1024 * 1024, open_timeout=15) as ws:
            await ws.send(json.dumps(_hello(token, name, mode="send-only")))
            welcome = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
            if welcome.get("type") != "welcome":
                return {"error": f"AgentUI: unexpected response {welcome.get('type')}"}
            await ws.send(json.dumps(out, ensure_ascii=False))
        return {"success": True, "message_id": msg_id}
    except Exception as e:
        return {"error": f"AgentUI: send failed ({e})"}


def _set_display_defaults() -> None:
    """Default display values for "agentui" (overridden by display.platforms.agentui.* of config.yaml):
    streaming enabled, and no tool progress bubbles (cards come from the hooks)."""
    try:
        from gateway.display_config import _PLATFORM_DEFAULTS

        _PLATFORM_DEFAULTS.setdefault(PLATFORM, {}).update({"streaming": True, "tool_progress": "off"})
    except Exception:
        logger.debug("AgentUI: default display values not applied", exc_info=True)


def _widget_error(key: str, args: Dict[str, Any]) -> Optional[str]:
    """Checks the JSON schema cannot express: the model corrects and retries based on this message."""
    if key == "chart":
        x, series = args.get("x") or [], args.get("series") or []
        for s in series:
            if len(s.get("y") or []) != len(x):
                return f"Series \"{s.get('name')}\" must have {len(x)} values (as many as x), it has {len(s.get('y') or [])}."
        if args.get("kind") == "pie" and len(series) != 1:
            return "A pie chart has only one series."
    elif key == "table":
        n = len(args.get("columns") or [])
        for i, row in enumerate(args.get("rows") or []):
            if len(row) != n:
                return f"Row {i + 1} has {len(row)} values, {n} are needed (one per column)."
            if any(isinstance(v, (dict, list)) for v in row):
                return f"Row {i + 1} contains a value that is neither text, number, boolean nor null."
    elif key == "progress":
        update = args.get("update")
        if update is not None and not re.fullmatch(r"\[\[agentui:[0-9a-f]+\]\]", str(update)):
            return "`update` must be the [[agentui:…]] token returned by the first call."
    elif key == "map" and not args.get("points"):
        return "At least one point is required."
    elif key == "code" and not str(args.get("code") or "").strip():
        return "The code is empty."
    elif key == "custom":
        state = args.get("state")
        if state is not None and len(json.dumps(state, ensure_ascii=False).encode("utf-8")) > 32 * 1024:
            return "The state is too large (max 32 KB)."
        update = args.get("update")
        if update is not None:
            if not re.fullmatch(r"\[\[agentui:[0-9a-f]+\]\]", str(update)):
                return "`update` must be the [[agentui:…]] token of the widget to update."
            if state is None:
                return "An update needs a `state`."
            return None
        code = str(args.get("code") or "")
        if not code.strip():
            return "The code is empty."
        if len(code.encode("utf-8")) > 64 * 1024:
            return "The code is too large (max 64 KB)."
        if not re.search(r"export\s+default\b", code):
            return "The module must default-export the React component (`export default function Widget() { … }`)."
    return None


def _wait_result(answer: str) -> Dict[str, Any]:
    """Result of `agentui_widget_custom_wait`: a widget event (wrapped by the server in a small JSON object so it is not mistaken for a chat
    message) or a chat message the user typed meanwhile."""
    try:
        o = json.loads(answer)
        if isinstance(o, dict) and o.get("agentui") == "widget-event":
            return {"from": "widget", "widget": o.get("widget"), "event": o.get("text") or ""}
    except ValueError:
        pass
    return {"from": "user", "message": answer}


def _ask_error(key: str, args: Dict[str, Any]) -> Optional[str]:
    """Semantic checks of the interactive tools (the JSON schema cannot express them)."""
    if key == "custom_wait" and not re.fullmatch(r"\[\[agentui:[0-9a-f]+\]\]", str(args.get("widget") or "")):
        return "`widget` must be the [[agentui:…]] token of the widget returned by agentui_widget_custom."
    if key == "ask" and not str(args.get("question") or "").strip():
        return "The question is empty."
    if key == "confirm" and not str(args.get("title") or "").strip():
        return "The title is empty."
    if key == "form":
        names = set()
        for f in args.get("fields") or []:
            name = f.get("name")
            if name in names:
                return f"Field \"{name}\" appears twice: names must be unique."
            names.add(name)
            if f.get("kind") == "select" and not f.get("options"):
                return f"Field \"{name}\" is of type select: it needs options."
    return None


IMAGE_PREFIX = "agentui-img-"  # attachments copied for an image widget: the front does not display them on top of the widget
MAX_IMAGES = 12


def _sniff_image(b: bytes) -> Optional[str]:
    """Real type of an image from its first bytes (not the extension): what the attachments endpoint displays inline."""
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if b[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if b[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "image/webp"
    return None


def _images_error(args: Dict[str, Any]) -> Optional[str]:
    """Shape check of the `agentui_widget_image` sources (before any file read)."""
    images = args.get("images") or []
    if not images or len(images) > MAX_IMAGES:
        return f"Between 1 and {MAX_IMAGES} images are required."
    for i, im in enumerate(images):
        src = str(im.get("src") or "")
        if not (re.match(r"https?://", src, re.I) or src.startswith("/")):
            return f"Image {i + 1}: src must be an https://… URL or an absolute path (no data:, file: or relative path)."
    return None


def _read_local_image(path: str) -> dict:
    """Reads a local image (blocking call); ValueError readable by the agent if missing, too large or not an image."""
    try:
        data = Path(path).read_bytes()
    except OSError:
        raise ValueError(f"File not found or unreadable: {path}")
    if len(data) > MAX_MEDIA:
        raise ValueError(f"{path} exceeds {MAX_MEDIA // 1024 // 1024} MB.")
    mime = _sniff_image(data)
    if not mime:
        raise ValueError(f"{path} is not a png, jpeg, gif or webp image.")
    name = f"{IMAGE_PREFIX}{hashlib.sha1(data).hexdigest()[:8]}-{re.sub(r'[^A-Za-z0-9_.-]+', '_', Path(path).name)}"
    return _media(name, data, mime)


def _usage_guide() -> str:
    """System-prompt hint of AgentUI chats: when to reach for the `agentui_*` tools (the tool descriptions say how)."""
    try:
        spec = json.loads((Path(__file__).parent / "widget_tools.json").read_text(encoding="utf-8"))
        return spec["usageGuide"]
    except Exception:
        logger.warning("AgentUI: usage guide unavailable", exc_info=True)
        return "You are chatting through AgentUI, a web chat client that renders full Markdown (code blocks, tables, images). Long answers are fine."


def _register_widget_tools(ctx) -> None:
    """One tool per widget (`agentui_widget_chart`, `agentui_widget_map`, `agentui_widget_code`, `agentui_widget_table`): the model validates its arguments with the tool's
    schema instead of writing a ```widget block. The tool returns a `[[agentui:<id>]]` token that the agent places in its
    text; AgentUI replaces it with the widget (arguments of `tool.started`, token in the result of `tool.completed`)."""
    spec = json.loads((Path(__file__).parent / "widget_tools.json").read_text(encoding="utf-8"))

    def make_handler(key: str):
        def handler(args: Dict[str, Any], **_kw: Any) -> str:
            # Hermes exposes a plugin's tools on all platforms (the `check_fn` is cached for 30 s, so
            # unusable to filter by session): outside AgentUI, the call is refused with a fallback instruction.
            try:
                from gateway.session_context import get_session_env

                if get_session_env("HERMES_SESSION_PLATFORM") != PLATFORM:
                    return json.dumps({"error": "This component only exists in AgentUI; present the content in Markdown."}, ensure_ascii=False)
            except Exception:
                pass
            problem = _widget_error(key, args) or (_images_error(args) if key == "image" else None)
            if problem:
                return json.dumps({"error": problem}, ensure_ascii=False)
            files: Dict[str, str] = {}
            if key == "image":
                # Local images: copied into the chat (message.media); the result says which attachment matches which path.
                try:
                    from gateway.session_context import get_session_env

                    chat = get_session_env("HERMES_SESSION_CHAT_ID")
                except Exception:
                    chat = None
                for im in args.get("images") or []:
                    src = im["src"]
                    if not src.startswith("/") or src in files:
                        continue
                    try:
                        media = _read_local_image(src)
                    except ValueError as e:
                        return json.dumps({"error": str(e)}, ensure_ascii=False)
                    if not chat or _ACTIVE is None or not _ACTIVE._emit(chat, {"type": "message.media", **media}):
                        return json.dumps({"error": "No AgentUI exchange in progress: cannot copy the image."}, ensure_ascii=False)
                    files[src] = media["name"]
            update = args.get("update") if key in ("progress", "custom") else None
            if update:  # update: same token, the front shows the state of the latest call
                return json.dumps({"widget": update, "updated": True, "instruction": spec["updateInstruction"]}, ensure_ascii=False)
            instruction = spec["progressInstruction"] if key == "progress" else spec["tokenInstruction"]
            return json.dumps({"widget": f"[[agentui:{uuid.uuid4().hex[:6]}]]", "instruction": instruction, **({"files": files} if key == "image" else {})}, ensure_ascii=False)

        return handler

    def make_blocking_handler(key: str):
        def handler(args: Dict[str, Any], **_kw: Any) -> str:
            try:
                from gateway.session_context import get_session_env

                chat = get_session_env("HERMES_SESSION_CHAT_ID") if get_session_env("HERMES_SESSION_PLATFORM") == PLATFORM else None
            except Exception:
                chat = None
            adapter = _ACTIVE
            if not chat or adapter is None:
                return json.dumps({"error": "This component only exists in AgentUI; ask your question in your reply."}, ensure_ascii=False)
            problem = _ask_error(key, args)
            if problem:
                return json.dumps({"error": problem}, ensure_ascii=False)
            return json.dumps(adapter.ask_blocking(chat, key, args), ensure_ascii=False)

        return handler

    def make_app_handler(op: str):
        def handler(args: Dict[str, Any], **_kw: Any) -> str:
            try:
                from gateway.session_context import get_session_env

                if get_session_env("HERMES_SESSION_PLATFORM") != PLATFORM:
                    return json.dumps({"error": "Miniapps only exist in AgentUI."}, ensure_ascii=False)
            except Exception:
                pass
            if op == "guide":
                return json.dumps({"guide": spec["miniappGuide"]}, ensure_ascii=False)
            adapter = _ACTIVE
            if adapter is None:
                return json.dumps({"error": "AgentUI is not connected."}, ensure_ascii=False)
            try:
                return json.dumps(adapter.miniapp_op(op, args), ensure_ascii=False, default=str)
            except Exception as e:
                return json.dumps({"error": str(e) or type(e).__name__}, ensure_ascii=False)

        return handler

    def make_notify_handler(_key: str):
        def handler(args: Dict[str, Any], **_kw: Any) -> str:
            adapter = _ACTIVE
            if adapter is None:
                return json.dumps({"error": "AgentUI is not connected."}, ensure_ascii=False)
            if not str(args.get("title", "")).strip():
                return json.dumps({"error": "The title is empty."}, ensure_ascii=False)
            try:
                return json.dumps(adapter.notify(str(args.get("title")), str(args.get("body") or ""), str(args.get("url") or "")), ensure_ascii=False, default=str)
            except Exception as e:
                return json.dumps({"error": str(e) or type(e).__name__}, ensure_ascii=False)

        return handler

    def make_title_handler(key: str):
        def handler(args: Dict[str, Any], **_kw: Any) -> str:
            try:
                from gateway.session_context import get_session_env

                chat = get_session_env("HERMES_SESSION_CHAT_ID") if get_session_env("HERMES_SESSION_PLATFORM") == PLATFORM else None
            except Exception:
                chat = None
            if key == "get_thread_title":
                if not chat or _ACTIVE is None:
                    return json.dumps({"error": "This tool only works within an AgentUI discussion."}, ensure_ascii=False)
                try:
                    return json.dumps(_ACTIVE.thread_title(chat), ensure_ascii=False)
                except Exception as e:
                    return json.dumps({"error": str(e) or type(e).__name__}, ensure_ascii=False)
            title = " ".join(str(args.get("title") or "").split())[:80]
            if not title:
                return json.dumps({"error": "The title is empty."}, ensure_ascii=False)
            if not chat or _ACTIVE is None or not _ACTIVE._emit(chat, {"type": "conversation.title", "title": title}):
                return json.dumps({"error": "This tool only works within an ongoing AgentUI exchange."}, ensure_ascii=False)
            return json.dumps({"title": title}, ensure_ascii=False)

        return handler

    for kind, handlers in (("tools", make_handler), ("blockingTools", make_blocking_handler), ("miniappTools", None), ("notifyTool", make_notify_handler), ("titleTool", make_title_handler)):
        for key, tool in spec.get(kind, {}).items():
            name = (spec["widgetPrefix"] if kind == "tools" or (kind == "blockingTools" and tool.get("widget")) else spec["prefix"]) + ("miniapp_" if kind == "miniappTools" else "") + key
            ctx.register_tool(
                name=name,
                toolset="agentui",
                schema={"name": name, "description": tool["description"], "parameters": tool["parameters"]},
                handler=(make_app_handler(key) if kind == "miniappTools" else handlers(key)),
                description=tool["description"],
                emoji="🖥️",
            )


def register(ctx):
    """Entry point of the Hermes plugin."""
    _set_display_defaults()
    _register_widget_tools(ctx)
    ctx.register_platform(
        name=PLATFORM,
        label="AgentUI",
        adapter_factory=lambda cfg: AgentUIAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["AGENTUI_URL", "AGENTUI_TOKEN"],
        install_hint="No additional dependency (websockets is provided by Hermes)",
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="AGENTUI_HOME_CHANNEL",
        standalone_sender_fn=_standalone_send,
        allowed_users_env="AGENTUI_ALLOWED_USERS",
        allow_all_env="AGENTUI_ALLOW_ALL_USERS",
        max_message_length=100_000,
        emoji="🖥️",
        pii_safe=False,
        platform_hint=_usage_guide(),
    )
    for name in ("pre_tool_call", "post_tool_call", "subagent_start", "subagent_stop", "post_llm_call"):
        ctx.register_hook(name, _hook(name))
