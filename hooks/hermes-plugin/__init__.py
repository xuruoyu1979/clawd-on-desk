"""Clawd on Desk plugin for Hermes Agent.

This is intentionally stdlib-only. It forwards conservative Hermes state events
to Clawd's local /state endpoint when Clawd is running and never raises out of
a Hermes hook callback.
"""

from __future__ import annotations

import json
import os
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib import request
from urllib.error import URLError

AGENT_ID = "hermes"
CLAWD_SERVER_HEADER = "x-clawd-server"
CLAWD_SERVER_ID = "clawd-on-desk"
SERVER_PORTS = (23333, 23334, 23335, 23336, 23337)
POST_TIMEOUT_SECONDS = 0.25
NO_SERVER_COOLDOWN_SECONDS = 2.0
TASK_SESSION_TTL_SECONDS = 10 * 60
MAX_TASK_SESSION_IDS = 256
MAX_STRING = 2000
MAX_LIST = 20
MAX_DICT = 60
MAX_DEPTH = 4

HOOK_TO_STATE: Dict[str, Tuple[str, str]] = {
    "on_session_start": ("idle", "SessionStart"),
    "pre_llm_call": ("thinking", "UserPromptSubmit"),
    "post_llm_call": ("attention", "Stop"),
    "pre_tool_call": ("working", "PreToolUse"),
    "post_tool_call": ("working", "PostToolUse"),
    # Hermes on_session_end fires at the end of every run_conversation turn,
    # not only when the CLI exits, so Clawd should treat it like turn stop.
    "on_session_end": ("attention", "Stop"),
    # Hermes on_session_finalize is the real boundary for session rotation and
    # gateway eviction; one-shot `hermes -z` did not emit it in local QA.
    "on_session_finalize": ("sleeping", "SessionEnd"),
    "on_session_reset": ("idle", "SessionStart"),
}

HOOKS = tuple(HOOK_TO_STATE.keys())
TOOL_HOOKS = {"pre_tool_call", "post_tool_call"}

_cached_port: Optional[int] = None
_no_server_until = 0.0
_log_lock = threading.Lock()
_session_lock = threading.Lock()
_active_session_id = ""
_task_session_ids: Dict[str, Tuple[str, float]] = {}


def _debug_enabled() -> bool:
    value = os.environ.get("CLAWD_HERMES_DEBUG", "").strip().lower()
    return value in ("1", "true", "yes", "on")


def _hermes_home() -> Path:
    value = os.environ.get("HERMES_HOME", "").strip()
    if value:
        return Path(value)

    local = os.environ.get("LOCALAPPDATA", "").strip()
    if local:
        candidate = Path(local) / "hermes"
        if (candidate / "config.yaml").exists():
            return candidate

    return Path.home() / ".hermes"


def _log_path() -> Path:
    return _hermes_home() / "logs" / "clawd-hermes-plugin.jsonl"


def _runtime_path() -> Path:
    return Path.home() / ".clawd" / "runtime.json"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _is_secret_key(key: Any) -> bool:
    text = str(key).lower()
    return any(part in text for part in ("token", "secret", "api_key", "apikey", "authorization"))


def _safe_value(value: Any, depth: int = 0) -> Any:
    if depth > MAX_DEPTH:
        return f"<{type(value).__name__}>"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if len(value) > MAX_STRING:
            return value[:MAX_STRING] + f"...<truncated {len(value) - MAX_STRING} chars>"
        return value
    if isinstance(value, bytes):
        return f"<bytes {len(value)}>"
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        out = [_safe_value(item, depth + 1) for item in items[:MAX_LIST]]
        if len(items) > MAX_LIST:
            out.append(f"<truncated {len(items) - MAX_LIST} items>")
        return out
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        items = list(value.items())
        for key, entry in items[:MAX_DICT]:
            key_text = str(key)
            out[key_text] = "<redacted>" if _is_secret_key(key_text) else _safe_value(entry, depth + 1)
        if len(items) > MAX_DICT:
            out["<truncated>"] = len(items) - MAX_DICT
        return out
    return repr(value)[:MAX_STRING]


def _append_log(record: Dict[str, Any], force: bool = False) -> None:
    if not force and not _debug_enabled():
        return
    try:
        path = _log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False, default=str)
        with _log_lock:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
    except Exception:
        # Hooks must never interfere with Hermes.
        pass


def _read_runtime_port() -> Optional[int]:
    try:
        data = json.loads(_runtime_path().read_text(encoding="utf-8"))
        port = int(data.get("port"))
        if port in SERVER_PORTS:
            return port
    except Exception:
        return None
    return None


def _port_candidates() -> list[int]:
    ports: list[int] = []
    seen = set()

    def add(port: Optional[int]) -> None:
        if port in SERVER_PORTS and port not in seen:
            seen.add(port)
            ports.append(int(port))

    add(_cached_port)
    if _cached_port is None:
        add(_read_runtime_port())
    for port in SERVER_PORTS:
        add(port)
    return ports


def _post_state(body: Dict[str, Any]) -> None:
    global _cached_port, _no_server_until
    now = time.monotonic()
    if _cached_port is None and _no_server_until > now:
        _append_log({
            "ts": _utc_now(),
            "event": "post_state_skipped_no_server",
            "cooldown_ms": int((_no_server_until - now) * 1000),
        })
        return

    payload = json.dumps(body).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Content-Length": str(len(payload)),
    }
    for port in _port_candidates():
        req = request.Request(
            f"http://127.0.0.1:{port}/state",
            data=payload,
            headers=headers,
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=POST_TIMEOUT_SECONDS) as response:
                if response.headers.get(CLAWD_SERVER_HEADER) == CLAWD_SERVER_ID:
                    _cached_port = port
                    _no_server_until = 0.0
                    try:
                        response.read()
                    except Exception:
                        pass
                    return
                _append_log({
                    "ts": _utc_now(),
                    "event": "post_state_header_mismatch",
                    "port": port,
                    "header": response.headers.get(CLAWD_SERVER_HEADER),
                })
        except (OSError, URLError) as exc:
            _append_log({
                "ts": _utc_now(),
                "event": "post_state_failed",
                "port": port,
                "error": str(exc),
            })
            continue
        except Exception as exc:
            _append_log({
                "ts": _utc_now(),
                "event": "post_state_error",
                "port": port,
                "error": str(exc),
            })
            continue
    _cached_port = None
    _no_server_until = time.monotonic() + NO_SERVER_COOLDOWN_SECONDS


def _first_string(*values: Any) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _prune_task_session_ids(now: Optional[float] = None) -> None:
    if now is None:
        now = time.time()
    stale = [
        task_id for task_id, (_, seen_at) in _task_session_ids.items()
        if now - seen_at > TASK_SESSION_TTL_SECONDS
    ]
    for task_id in stale:
        _task_session_ids.pop(task_id, None)
    if len(_task_session_ids) <= MAX_TASK_SESSION_IDS:
        return
    overflow = len(_task_session_ids) - MAX_TASK_SESSION_IDS
    oldest = sorted(_task_session_ids.items(), key=lambda item: item[1][1])[:overflow]
    for task_id, _ in oldest:
        _task_session_ids.pop(task_id, None)


def _remember_task_session(task_id: str, session_id: str) -> None:
    if not task_id or not session_id:
        return
    _prune_task_session_ids()
    _task_session_ids[task_id] = (session_id, time.time())


def _lookup_task_session(task_id: str) -> str:
    if not task_id:
        return ""
    entry = _task_session_ids.get(task_id)
    if not entry:
        return ""
    session_id, seen_at = entry
    if time.time() - seen_at > TASK_SESSION_TTL_SECONDS:
        _task_session_ids.pop(task_id, None)
        return ""
    return session_id


def _forget_task_session(event_name: str, kwargs: Dict[str, Any]) -> None:
    if event_name != "post_tool_call":
        return
    task_id = _first_string(kwargs.get("task_id"))
    if task_id:
        _task_session_ids.pop(task_id, None)


def _forget_session_task_mappings(session_id: str) -> None:
    if not session_id:
        return
    stale = [
        task_id for task_id, (mapped_session_id, _) in _task_session_ids.items()
        if mapped_session_id == session_id
    ]
    for task_id in stale:
        _task_session_ids.pop(task_id, None)


def _session_id(event_name: str, kwargs: Dict[str, Any]) -> str:
    explicit = _first_string(kwargs.get("session_id"), kwargs.get("session_key"))
    task_id = _first_string(kwargs.get("task_id"))
    parent_id = _first_string(kwargs.get("parent_session_id"))
    if explicit:
        return explicit

    with _session_lock:
        remembered = _lookup_task_session(task_id)
        if remembered:
            return remembered
        if event_name == "pre_tool_call" and task_id and _active_session_id:
            _remember_task_session(task_id, _active_session_id)
            return _active_session_id
        if parent_id:
            return parent_id
        if event_name == "post_tool_call" and task_id:
            return ""
        if _active_session_id:
            return _active_session_id

    if event_name in TOOL_HOOKS:
        return ""

    return task_id or "hermes:default"


def _remember_session(event_name: str, kwargs: Dict[str, Any]) -> None:
    global _active_session_id
    explicit = _first_string(kwargs.get("session_id"), kwargs.get("session_key"))
    task_id = _first_string(kwargs.get("task_id"))
    if not explicit:
        return
    with _session_lock:
        if event_name == "on_session_reset":
            _task_session_ids.clear()
        if event_name in (
            "on_session_start",
            "pre_llm_call",
            "post_llm_call",
            "on_session_end",
            "on_session_reset",
        ):
            _active_session_id = explicit
        if task_id:
            _remember_task_session(task_id, explicit)


def _finish_session_boundary(event_name: str, payload: Dict[str, Any]) -> None:
    global _active_session_id
    if event_name != "on_session_finalize":
        return
    session_id = _first_string(payload.get("session_id"))
    if not session_id:
        return
    with _session_lock:
        if _active_session_id == session_id:
            _active_session_id = ""
        _forget_session_task_mappings(session_id)


def _event_extra(event_name: str, kwargs: Dict[str, Any]) -> Dict[str, Any]:
    extra: Dict[str, Any] = {}
    tool_name = _first_string(kwargs.get("tool_name"))
    if tool_name:
        extra["tool_name"] = tool_name
    tool_call_id = _first_string(kwargs.get("tool_call_id"))
    if tool_call_id:
        extra["tool_use_id"] = tool_call_id
    return extra


def _state_payload(event_name: str, kwargs: Dict[str, Any]) -> Dict[str, Any]:
    state, clawd_event = HOOK_TO_STATE[event_name]
    if event_name == "post_tool_call" and _tool_result_has_error(kwargs.get("result")):
        state, clawd_event = "error", "PostToolUseFailure"
    if event_name == "on_session_end":
        completed = kwargs.get("completed")
        interrupted = kwargs.get("interrupted")
        if completed is False and interrupted is not True:
            state, clawd_event = "error", "StopFailure"

    payload: Dict[str, Any] = {
        "agent_id": AGENT_ID,
        "hook_source": "hermes-plugin",
        "state": state,
        "event": clawd_event,
        "session_id": _session_id(event_name, kwargs),
        "cwd": _first_string(os.environ.get("TERMINAL_CWD"), os.environ.get("PWD"), os.getcwd()),
        "agent_pid": os.getpid(),
    }
    payload.update(_event_extra(event_name, kwargs))
    return payload


def _tool_result_has_error(result: Any) -> bool:
    if isinstance(result, dict):
        exit_code = result.get("exit_code")
        return bool(result.get("error")) or (isinstance(exit_code, int) and exit_code != 0)
    if not isinstance(result, str):
        return False
    text = result.strip()
    if not text:
        return False
    try:
        parsed = json.loads(text)
        if not isinstance(parsed, dict):
            return False
        exit_code = parsed.get("exit_code")
        return bool(parsed.get("error")) or (isinstance(exit_code, int) and exit_code != 0)
    except Exception:
        return '"error"' in text[:500].lower()


def _handle_hook(event_name: str, **kwargs: Any) -> None:
    started = time.time()
    try:
        _remember_session(event_name, kwargs)
        payload = _state_payload(event_name, kwargs)
        if not payload.get("session_id"):
            _append_log({
                "ts": _utc_now(),
                "event": event_name,
                "dropped": "missing_session_id",
                "pid": os.getpid(),
                "kwargs": _safe_value(kwargs),
            })
            return
        if _debug_enabled():
            _append_log({
                "ts": _utc_now(),
                "event": event_name,
                "pid": os.getpid(),
                "cwd": os.getcwd(),
                "state_payload": payload,
                "kwargs": _safe_value(kwargs),
            })
        _post_state(payload)
        _finish_session_boundary(event_name, payload)
    except Exception as exc:
        _append_log({
            "ts": _utc_now(),
            "event": event_name,
            "error": str(exc),
            "traceback": traceback.format_exc(),
        }, force=True)
    finally:
        with _session_lock:
            _forget_task_session(event_name, kwargs)
        elapsed_ms = int((time.time() - started) * 1000)
        if elapsed_ms > 100:
            _append_log({"ts": _utc_now(), "event": event_name, "slow_ms": elapsed_ms})


def _make_callback(event_name: str):
    def callback(**kwargs: Any) -> None:
        _handle_hook(event_name, **kwargs)
        return None

    callback.__name__ = f"clawd_{event_name}"
    return callback


def register(ctx) -> None:
    for hook_name in HOOKS:
        ctx.register_hook(hook_name, _make_callback(hook_name))
    _append_log({
        "ts": _utc_now(),
        "event": "plugin_registered",
        "pid": os.getpid(),
        "hermes_home": str(_hermes_home()),
        "cwd": os.getcwd(),
        "hooks": list(HOOKS),
    })
