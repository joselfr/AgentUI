"""
Canal AgentUI pour Hermes Agent (AgentUI Channel Protocol v1, voir plugins/protocol/PROTOCOL.md).

Le gateway Hermes ouvre une WebSocket vers AgentUI, comme un bot Telegram ouvre son long-polling :
- ``inbound``  → ``MessageEvent`` (un ``conversationId`` AgentUI = un ``chat_id`` = une session Hermes) ;
- streaming   → aperçus du stream consumer (``send`` puis ``edit_message``) traduits en deltas ;
- outils, sous-agents, raisonnement → hooks de plugin (``pre_tool_call``, ``post_tool_call``, ``subagent_*``,
  ``post_llm_call``), rattachés à la discussion par les ContextVars de session du gateway ;
- approbations → ``send_exec_approval`` / ``resolve_gateway_approval`` ;
- fin de run → ``on_processing_complete`` ; arrêt → commande ``/stop`` ;
- ``send()`` hors run (crons, send_message) → message proactif ``outbound``.

Configuration (``~/.hermes/.env``) : ``AGENTUI_URL``, ``AGENTUI_TOKEN``. Par défaut la plateforme streame et n'affiche
pas de bulles de progression d'outils (surcharge possible via ``display.platforms.agentui.*``).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import os
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
HOME_CHAT = "home"  # chat_id des messages proactifs sans discussion : AgentUI les range dans sa discussion « maison »
OWNER_ID = "agentui-owner"  # l'utilisateur est authentifié par AgentUI, pas par Hermes
MAX_RESULT = 20_000
MAX_MEDIA = 20 * 1024 * 1024
OUTBOX_LIMIT = 2_000

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

# Adapter vivant (un seul par gateway/profil) : les hooks s'exécutent dans le thread de l'agent et le retrouvent ici.
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
    """Profil servi par cette gateway (un profil Hermes = une gateway = une connexion), comme l'adapter api_server."""
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
    """Tâches cron, au format Job d'AgentUI (comme GET /api/jobs de l'api_server)."""
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
            # « Exécuter maintenant » pose manual_run_at ; le planificateur le prend au tick suivant (≤ 1 min).
            "queued": bool(j.get("manual_run_at")) and not running,
            "running": running,
            "lastError": ex.get("error") or j.get("last_error") or None,
            "deliverTo": deliver_to,
        })
    return out


def _job_action(job_id: str, action: str) -> dict:
    from cron import jobs as cron_jobs

    ops = {"pause": cron_jobs.pause_job, "resume": cron_jobs.resume_job, "run": cron_jobs.trigger_job, "delete": cron_jobs.remove_job}
    op = ops.get(action)
    if op is None:
        raise ValueError(f"action inconnue : {action}")
    if not op(job_id):
        raise ValueError(f"tâche introuvable : {job_id}")
    return {"ok": True}


def _list_skills() -> List[dict]:
    """Skills installés (même liste que /skills list), avec leur état activé/désactivé."""
    from tools.skills_tool import _find_all_skills, _sort_skills

    enabled = {s.get("name") for s in _find_all_skills(skip_disabled=True)}
    return [
        {"id": s.get("name"), "name": s.get("name"), "description": s.get("description"), "category": s.get("category"), "enabled": s.get("name") in enabled}
        for s in _sort_skills(_find_all_skills(skip_disabled=False))
    ]


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
    """Titre de la discussion AgentUI d'une tâche cron (« ⏰ nom ») : nom de la tâche si connue, sinon déduit
    d'une cible ``agentui:cron-<nom>``. None pour une discussion ordinaire."""
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
    """Lit un média désigné par chemin, file://, data: ou http(s):// (appel bloquant)."""
    if src.startswith("data:"):
        head, _, payload = src.partition(",")
        mime = head[5:].split(";")[0] or None
        ext = mimetypes.guess_extension(mime or "") or ""
        return f"image{ext}", base64.b64decode(payload), mime
    if src.startswith(("http://", "https://")):
        with urllib.request.urlopen(src, timeout=30) as resp:  # noqa: S310 (URL fournie par l'agent)
            data = resp.read(MAX_MEDIA + 1)
            mime = resp.headers.get_content_type()
        return Path(src.split("?")[0]).name or "media", data, mime
    path = Path(src[7:] if src.startswith("file://") else src)
    return path.name, path.read_bytes(), None


def _strip_cursor(text: str) -> str:
    """Retire le curseur de streaming (« ▉ ») ajouté aux aperçus par le stream consumer."""
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
    """Modèle et consommation cumulée de la session Hermes d'une discussion, lus dans sa base (None si inconnue)."""
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
    """Modèle par défaut de la configuration Hermes (pour une session qui n'en a pas encore enregistré)."""
    try:
        from hermes_cli.config import load_config

        model = (load_config() or {}).get("model")
        return (model.get("default") if isinstance(model, dict) else model) or None
    except Exception:
        return None


def _list_models() -> List[dict]:
    """Modèles des fournisseurs authentifiés, à plat : [{provider, providerName, id}]."""
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
class _Run:
    run_id: str
    conversation_id: str
    message_id: str
    # Messages « posés » par la gateway pendant le run (aperçus streamés, édités en place, puis réponse finale),
    # dans l'ordre : le texte AgentUI est leur concaténation.
    bubbles: Dict[str, str] = field(default_factory=dict)
    emitted: str = ""  # texte déjà transmis à AgentUI (deltas cumulés)
    settled: bool = False  # le dernier envoi était un message.final complet
    # Sérialise `_sync` : appelé depuis la boucle asyncio et le thread de l'agent, deux appels simultanés
    # partiraient du même `emitted` et enverraient des deltas qui se chevauchent (texte répété à l'écran).
    sync_lock: threading.RLock = field(default_factory=threading.RLock)
    aborted: bool = False


class AgentUIAdapter(BasePlatformAdapter):
    supports_code_blocks = True  # AgentUI rend le Markdown
    splits_long_messages = True  # pas de découpage côté gateway : AgentUI accepte les longs messages
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
        self._captures: Dict[str, asyncio.Future] = {}  # réponses de commandes de contrôle (/model) à renvoyer en rpc
        self._muted_until: Dict[str, float] = {}  # discussions arrêtées : on ignore la confirmation de /stop
        self._lock = threading.Lock()  # protège les tables ci-dessous (thread de l'agent + boucle asyncio)
        self._runs: Dict[str, _Run] = {}  # conversationId → run en cours
        self._approvals: Dict[str, str] = {}  # id d'approbation → session_key Hermes
        self._clarifies: Dict[str, Tuple[str, str]] = {}  # discussion → (session_key, clarify_id) de la question en attente
        self._session_chat: Dict[str, str] = {}  # session_id Hermes (agent ou sous-agent) → conversationId
        self._session_subagent: Dict[str, str] = {}  # session_id d'un sous-agent → id de sous-agent AgentUI
        self._closing = False

    @property
    def name(self) -> str:
        return "AgentUI"

    @property
    def authorization_is_upstream(self) -> bool:
        # L'utilisateur est authentifié par AgentUI et le transport par le token : pas d'allowlist Hermes à appliquer.
        return True

    # ── Connexion ────────────────────────────────────────────────────────────

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        global _ACTIVE
        if not self.url or not self.token:
            self._set_fatal_error("config_missing", "AGENTUI_URL et AGENTUI_TOKEN sont requis", retryable=False)
            return False
        self._loop = asyncio.get_running_loop()
        self._closing = False
        if self._outbox is None:  # conservée entre reconnexions : rien n'est perdu pendant une coupure
            self._outbox = asyncio.Queue()
        self._welcomed = asyncio.Event()
        _ACTIVE = self
        self._conn_task = asyncio.create_task(self._connection_loop())
        try:
            await asyncio.wait_for(self._welcomed.wait(), timeout=15)
        except asyncio.TimeoutError:
            logger.warning("AgentUI: pas de réponse de %s, nouvel essai en arrière-plan", self.url)
        return True  # la boucle se reconnecte seule ; l'état réel passe par _mark_connected/_mark_disconnected

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
                        raise ConnectionError(f"réponse inattendue : {welcome.get('type')}")
                    self._ws = ws
                    self._mark_connected()
                    self._welcomed.set()
                    delay = 1.0
                    logger.info("AgentUI: connecté à %s", self.url)
                    self._writer_task = asyncio.create_task(self._writer(ws))
                    async for raw in ws:
                        try:
                            await self._on_frame(json.loads(raw))
                        except Exception:
                            logger.exception("AgentUI: trame ignorée")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                code = getattr(getattr(e, "rcvd", None), "code", None)
                if code in (4001, 4002):
                    self._set_fatal_error("auth", f"AgentUI a refusé la connexion ({code})", retryable=False)
                    return
                logger.warning("AgentUI: connexion perdue (%s), reconnexion dans %.0f s", e, delay)
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
        """Vide la file d'envoi dans l'ordre ; les trames restent en file pendant une coupure."""
        while True:
            msg = self._unsent or await self._outbox.get()
            self._unsent = msg  # renvoyée en premier après reconnexion si l'envoi échoue
            await ws.send(json.dumps(msg, ensure_ascii=False, default=str))
            self._unsent = None

    def _post(self, msg: dict) -> None:
        """Envoi thread-safe (boucle asyncio ou thread de l'agent)."""
        if self._loop is None or self._outbox is None:
            return
        def put():
            if self._outbox.qsize() < OUTBOX_LIMIT:
                self._outbox.put_nowait(msg)
        try:
            in_loop = asyncio.get_running_loop() is self._loop
        except RuntimeError:  # thread de l'agent : pas de boucle courante
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
        elif kind == "ping":
            self._post({"type": "pong"})

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
                media_urls.append(cache_document_from_bytes(data, att.get("name") or "fichier"))
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
            logger.exception("AgentUI: échec de dispatch")
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
        # /stop interrompt immédiatement l'agent et libère la session (gateway/run.py, _interrupt_and_clear_session)
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
            logger.exception("AgentUI: échec de résolution de l'approbation")

    def _on_reply(self, msg: dict) -> None:
        """Réponse à une question `clarify` en attente : elle débloque l'outil, le run en cours reprend."""
        conv, text = msg.get("conversationId", ""), msg.get("text", "")
        with self._lock:
            pending = self._clarifies.pop(conv, None)
        if pending is None:
            logger.warning("AgentUI: réponse sans question en attente (discussion %s)", conv)
            return
        session_key, clarify_id = pending
        try:
            from tools import clarify_gateway as cg

            # « 2 » ou le libellé d'une option → l'option ; une sélection invalide ou une réponse libre → le texte tel quel
            if cg.attempt_text_response_for_session(session_key, text) != cg.TEXT_RESOLVED:
                cg.resolve_gateway_clarify(clarify_id, text)
        except Exception:
            logger.exception("AgentUI: échec de résolution de la question")
            with self._lock:
                self._clarifies.setdefault(conv, pending)  # toujours en attente : l'utilisateur peut réessayer
            return
        self._emit(conv, {"type": "question.resolved", "id": clarify_id})

    def _delete_session(self, conversation_id: str) -> dict:
        """Supprime la session Hermes d'une discussion AgentUI (une discussion = un chat_id = une session).

        Même séquence que le RPC officiel ``session.delete`` : une session vivante est refusée (l'agent
        tripperait sur la clé étrangère à son prochain flush), sinon on efface la ligne, ses messages et les
        fichiers de transcription. Discussion inconnue : succès (idempotent).
        """
        if not conversation_id:
            raise ValueError("conversationId manquant")
        with self._lock:
            if conversation_id in self._runs:
                raise RuntimeError("un run est en cours dans cette discussion")
        from hermes_constants import get_hermes_home
        from hermes_state import SessionDB

        db = SessionDB(read_only=False)
        try:
            session_id = db.find_session_by_origin(platform=PLATFORM, chat_id=conversation_id)
            if not session_id:
                return {"ok": True, "deleted": False}
            deleted = db.delete_session(session_id, sessions_dir=get_hermes_home() / "sessions")
        finally:
            db.close()  # 0.19 n'a pas de gestionnaire de contexte sur SessionDB
        return {"ok": True, "deleted": bool(deleted)}

    async def _control(self, conversation_id: str, text: str, timeout: float = 20.0) -> str:
        """Passe une commande de contrôle (/model…) à la gateway comme si l'utilisateur l'avait tapée, et renvoie sa
        réponse au lieu de l'afficher dans la discussion."""
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        with self._lock:
            if conversation_id in self._captures:
                raise RuntimeError("une commande est déjà en cours dans cette discussion")
            self._captures[conversation_id] = fut
        source = self.build_source(chat_id=conversation_id, chat_name=conversation_id, chat_type="dm", user_id=OWNER_ID, user_name="AgentUI")
        try:
            await self.handle_message(MessageEvent(text=text, message_type=MessageType.COMMAND, source=source, message_id=f"ctl-{uuid.uuid4().hex[:8]}"))
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise RuntimeError("Hermes n'a pas répondu à temps")
        finally:
            with self._lock:
                self._captures.pop(conversation_id, None)

    async def _set_model(self, params: dict) -> dict:
        """Fixe le modèle de la session d'une discussion (commande /model de la gateway, limitée à la session)."""
        conv, model, provider = str(params.get("conversationId", "")), str(params.get("model", "")).strip(), str(params.get("provider", "")).strip()
        if not conv or not model:
            raise ValueError("conversationId et model sont requis")
        with self._lock:
            if conv in self._runs:
                raise RuntimeError("un run est en cours dans cette discussion")
        reply = await self._control(conv, f"/model {model}" + (f" --provider {provider}" if provider else "") + " --session")
        text = reply.strip()
        # La gateway répond « Model switched to `x` … » en cas de succès ; un refus commence par une pastille d'erreur
        # (❌ modèle inconnu, 🟡 changement annulé…). Un avertissement en cours de texte n'est pas un échec.
        if text.startswith(_FAILURE_MARKERS):
            raise RuntimeError(text.lstrip("".join(_FAILURE_MARKERS) + "\ufe0f \n").strip() or "changement de modèle refusé")
        usage = await asyncio.to_thread(_session_usage, conv)
        return {"model": (usage or {}).get("model") or model, **({"provider": provider} if provider else {}), "message": text}

    async def _on_rpc(self, msg: dict) -> None:
        method, params = msg.get("method"), msg.get("params") or {}
        if method == "setModel":
            try:
                self._post({"type": "rpc.result", "id": msg.get("id"), "result": await self._set_model(params)})
            except Exception as e:
                logger.warning("AgentUI: rpc setModel en échec : %s", e)
                self._post({"type": "rpc.result", "id": msg.get("id"), "error": str(e) or type(e).__name__})
            return
        handlers = {
            "listModels": _list_models,
            "sessionUsage": lambda: _session_usage(str(params.get("conversationId", ""))),
            "listSubAgents": _sub_agents,
            "listJobs": _list_jobs,
            "listSkills": _list_skills,
            "jobAction": lambda: _job_action(str(params.get("jobId", "")), str(params.get("action", ""))),
            "deleteSession": lambda: self._delete_session(str(params.get("conversationId", ""))),
        }
        handler = handlers.get(str(method))
        if handler is None:
            self._post({"type": "rpc.result", "id": msg.get("id"), "error": f"méthode non supportée : {method}"})
            return
        try:
            result = await asyncio.to_thread(handler)  # lecture disque / fichiers d'état : hors de la boucle
            self._post({"type": "rpc.result", "id": msg.get("id"), "result": result})
        except Exception as e:
            logger.warning("AgentUI: rpc %s en échec : %s", method, e)
            self._post({"type": "rpc.result", "id": msg.get("id"), "error": str(e) or type(e).__name__})

    # ── Hermes → AgentUI : cycle de vie ──────────────────────────────────────

    async def on_processing_complete(self, event: MessageEvent, outcome: ProcessingOutcome) -> None:
        conv = event.source.chat_id
        with self._lock:
            run = self._runs.get(conv)
        if run is None or run.message_id != event.message_id:
            return  # /stop ou message déjà terminé
        if run.emitted and not run.settled:
            self._emit(conv, {"type": "message.final", "text": run.emitted})  # fige le texte (sans curseur)
        try:  # consommation cumulée de la session (même interrompue, les tokens sont consommés) : AgentUI l'affiche
            usage = await asyncio.to_thread(_session_usage, conv)
            if usage:
                self._emit(conv, {"type": "usage", "usage": usage})
        except Exception:
            logger.debug("AgentUI: lecture de la consommation impossible", exc_info=True)
        if outcome is ProcessingOutcome.SUCCESS:
            self._finish(conv, {"type": "run.completed"})
        elif outcome is ProcessingOutcome.CANCELLED or run.aborted:
            self._finish(conv, {"type": "run.aborted"})
        else:
            self._finish(conv, {"type": "run.failed", "error": "échec du traitement par Hermes"})

    # ── Hermes → AgentUI : streaming ─────────────────────────────────────────
    # Contrat standard des adaptateurs : le stream consumer de la gateway pose un message (send) puis l'édite
    # (edit_message) au fil des tokens. On traduit ces éditions en deltas AgentUI ; ça marche quelle que soit la
    # mécanique interne de streaming de la version de Hermes.

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
            else:  # réécriture (fin de curseur, aperçu supprimé…) : AgentUI remplace le texte accumulé
                self._emit(run.conversation_id, {"type": "message.final", "text": full})
                run.settled = True
            run.emitted = full

    def format_tool_event(self, event: Any, *, mode: str = "all", preview_max_len: int = 40) -> Optional[str]:
        return None  # pas de « bulles » d'outils : les cartes viennent des hooks pre/post_tool_call

    # ── Hermes → AgentUI : messages ──────────────────────────────────────────

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        message_id = uuid.uuid4().hex
        with self._lock:
            capture = self._captures.get(chat_id)
        if capture is not None:  # réponse d'une commande de contrôle (rpc setModel), pas un message de la discussion
            if not capture.done():
                self._loop.call_soon_threadsafe(lambda: capture.done() or capture.set_result(content))
            return SendResult(success=True, message_id=message_id)
        job_id = (metadata or {}).get("job_id")
        if job_id:
            # Livraison d'une tâche cron : toujours un message à part, jamais mêlé à une réponse en cours.
            self._outbound(chat_id, content, [], title=_cron_title(chat_id, str(job_id)))
            return SendResult(success=True, message_id=message_id)
        with self._lock:
            run = self._runs.get(chat_id)
            muted = self._muted_until.get(chat_id, 0) > time.monotonic()
        if muted or (run is not None and run.aborted):
            return SendResult(success=True, message_id=message_id)  # confirmation « stopped » de /stop
        if run is not None:
            with self._lock:
                run.bubbles[message_id] = _strip_cursor(content)
            self._sync(run)
        else:
            self._outbound(chat_id, content, [])
        return SendResult(success=True, message_id=message_id)

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
            return SendResult(success=False, error=f"média illisible : {e}")
        if len(data) > MAX_MEDIA:
            return SendResult(success=False, error="média trop volumineux")
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
        # **flags : options ajoutées par les versions récentes (allow_session en 0.21…), transmises telles quelles.
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
            return SendResult(success=False, error="aucun run AgentUI pour cette discussion")
        return SendResult(success=True, message_id=approval_id)

    async def send_clarify(self, chat_id: str, question: str, choices: Optional[list], clarify_id: str, session_key: str, metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        """Question de l'agent en plein run (outil `clarify`). Avec des choix : widget `ask` (boutons) ; la réponse revient
        par la trame `reply` et débloque l'outil, au lieu de passer pour un nouveau message (le run est toujours en cours)."""
        from tools import clarify_gateway as cg

        with self._lock:
            self._clarifies[chat_id] = (session_key, clarify_id)
        # Avant le prompt : au moment où le widget arrive, AgentUI sait déjà que la réponse est attendue.
        self._emit(chat_id, {"type": "question.requested", "id": clarify_id})
        if choices:
            multi = bool(getattr(cg._entries.get(clarify_id), "multi_select", False))  # même lecture que l'adaptateur de base
            cg.mark_awaiting_text(clarify_id)  # les réponses par texte (« 2 », libellé, texte libre) sont aussi acceptées
            widget = {"type": "ask", "arguments": {"question": question, "options": [str(c) for c in choices], **({"multiple": True} if multi else {})}}
            content = "```widget\n" + json.dumps(widget, ensure_ascii=False) + "\n```"
        else:
            content = f"❓ {question}"
        return await self.send(chat_id=chat_id, content=content, metadata=metadata)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        pass  # AgentUI affiche déjà l'état du run

    async def edit_message(self, chat_id: str, message_id: str, content: str, *, finalize: bool = False, **kwargs) -> SendResult:
        with self._lock:
            run = self._runs.get(chat_id)
            if run is None or message_id not in run.bubbles:
                return SendResult(success=False, error="message inconnu")
            run.bubbles[message_id] = _strip_cursor(content)
        self._sync(run)
        return SendResult(success=True, message_id=message_id)

    async def delete_message(self, chat_id: str, message_id: str, *args, **kwargs) -> bool:
        with self._lock:
            run = self._runs.get(chat_id)
            removed = run is not None and run.bubbles.pop(message_id, None) is not None
        if removed:
            self._sync(run)
        return removed

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "dm"}

    # ── Hooks (thread de l'agent) ────────────────────────────────────────────

    def _chat_for(self, session_id: Optional[str]) -> Optional[str]:
        """Discussion AgentUI du contexte courant : ContextVars du gateway, sinon table des sessions (sous-agents)."""
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
        if kw.get("tool_name") == "clarify":  # répondue, annulée ou expirée : plus rien n'est attendu
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
                logger.debug("AgentUI: hook %s en échec", name, exc_info=True)
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
    """Livraison d'un cron exécuté hors du gateway : connexion éphémère « send-only »."""
    import websockets

    url, token, name = _settings(pconfig)
    if not (url and token):
        return {"error": "AgentUI : AGENTUI_URL et AGENTUI_TOKEN sont requis"}
    media = []
    for path in media_files or []:
        try:
            src_name, data, mime = await asyncio.to_thread(_read_source, path)
            media.append(_media(src_name, data, mime))
        except Exception as e:
            logger.warning("AgentUI: média ignoré (%s) : %s", path, e)
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
                return {"error": f"AgentUI : réponse inattendue {welcome.get('type')}"}
            await ws.send(json.dumps(out, ensure_ascii=False))
        return {"success": True, "message_id": msg_id}
    except Exception as e:
        return {"error": f"AgentUI : envoi impossible ({e})"}


def _set_display_defaults() -> None:
    """Valeurs par défaut d'affichage pour « agentui » (surchargées par display.platforms.agentui.* du config.yaml) :
    streaming activé, et pas de bulles de progression d'outils (les cartes viennent des hooks)."""
    try:
        from gateway.display_config import _PLATFORM_DEFAULTS

        _PLATFORM_DEFAULTS.setdefault(PLATFORM, {}).update({"streaming": True, "tool_progress": "off"})
    except Exception:
        logger.debug("AgentUI: valeurs d'affichage par défaut non appliquées", exc_info=True)


def register(ctx):
    """Point d'entrée du plugin Hermes."""
    _set_display_defaults()
    ctx.register_platform(
        name=PLATFORM,
        label="AgentUI",
        adapter_factory=lambda cfg: AgentUIAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["AGENTUI_URL", "AGENTUI_TOKEN"],
        install_hint="Aucune dépendance supplémentaire (websockets est fourni par Hermes)",
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="AGENTUI_HOME_CHANNEL",
        standalone_sender_fn=_standalone_send,
        allowed_users_env="AGENTUI_ALLOWED_USERS",
        allow_all_env="AGENTUI_ALLOW_ALL_USERS",
        max_message_length=100_000,
        emoji="🖥️",
        pii_safe=False,
        platform_hint=(
            "You are chatting through AgentUI, a web chat client that renders full Markdown "
            "(code blocks, tables, images). Long answers are fine."
        ),
    )
    for name in ("pre_tool_call", "post_tool_call", "subagent_start", "subagent_stop", "post_llm_call"):
        ctx.register_hook(name, _hook(name))
