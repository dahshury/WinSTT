"""Property-based tests for the WebSocket control-handler dispatch logic.

The full ``control_handler`` coroutine in
:mod:`src.stt_server.control_handler` is hard to drive in isolation
(needs a real ``ServerConnection`` + asyncio loop + initialised
``ServerState``). These tests focus on the public-facing dispatch
surface that *can* be exercised deterministically:

  * ``is_pre_ready_command`` — registry lookup for boot-time commands
  * ``_dispatch_command`` — the JSON-command router that ``control_handler``
    delegates to once a message is parsed

Properties target the graceful-failure invariants the production
control loop relies on:

  * Unknown command types are rejected with a JSON error payload
    (never raise an exception that would terminate the connection).
  * The pre-ready set is stable: never depends on call ordering or
    argument values.
  * Malformed/garbage command names route through the unknown-command
    path without crashing.
"""

from __future__ import annotations

import asyncio
import json
import string
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, cast

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from src.stt_server.control_handler import (
    _COMMAND_REGISTRY,
    _dispatch_command,
    is_pre_ready_command,
)

if TYPE_CHECKING:
    from websockets.asyncio.server import ServerConnection

    from src.stt_server.state import ServerState

# ─── Test doubles ────────────────────────────────────────────────────────


@dataclass
class _FakeWebSocket:
    """Minimal stand-in for ``websockets.asyncio.server.ServerConnection``.

    Captures everything sent so tests can assert on the JSON payloads
    the dispatcher emitted in response to a command.
    """

    sent: list[str] = field(default_factory=list)

    async def send(self, payload: str) -> None:
        self.sent.append(payload)


@dataclass
class _MinimalState:
    """Just enough of ``ServerState`` for the unknown-command path.

    The unknown-command branch in ``_dispatch_command`` never touches
    ``state`` — it only writes to ``ws``. That makes the unknown-command
    property tractable without standing up the full state graph.
    """

    recorder: Any = None
    extended_logging: bool = False


def _run(coro: Any) -> None:  # noqa: ANN401 — hypothesis property
    """Drive an awaitable to completion synchronously."""
    asyncio.run(coro)


# ─── is_pre_ready_command ────────────────────────────────────────────────


@settings(max_examples=200, deadline=None)
@given(st.text(min_size=0, max_size=40))
def test_is_pre_ready_command_never_raises(name: str) -> None:
    """Any arbitrary string (or None) must yield a bool, never raise.

    The control loop calls this on every incoming message before
    dispatch; a raised exception here would crash the per-client task
    on the first malformed frame.
    """
    result = is_pre_ready_command(name)
    assert isinstance(result, bool)


def test_is_pre_ready_command_none_returns_false() -> None:
    """The ``None`` branch (no ``command`` key in payload) returns False
    so the pre-ready filter doesn't accidentally let garbage through."""
    assert is_pre_ready_command(None) is False


@settings(max_examples=100, deadline=None)
@given(st.text(alphabet=string.ascii_letters + "_-/", min_size=1, max_size=20))
def test_is_pre_ready_command_matches_registry(name: str) -> None:
    """Result MUST agree with the registry's ``pre_ready`` flag.

    Single source of truth: the decorator-registered spec. If the two
    drift apart, pre-ready commands could be silently dropped during
    boot — exactly the bug class the unified registry was introduced
    to prevent.
    """
    expected = _COMMAND_REGISTRY.get(name)
    if expected is None:
        assert is_pre_ready_command(name) is False
    else:
        assert is_pre_ready_command(name) is expected.pre_ready


def test_known_pre_ready_commands_advertise_pre_ready() -> None:
    """Sanity: at least one well-known pre-ready command is wired so
    the registry-driven property has real data to compare against."""
    assert is_pre_ready_command("list_models") is True
    assert is_pre_ready_command("list_input_devices") is True
    # The settings panel fires this on first paint; model load can take >10s
    # (CrisperWhisper on DirectML ≈ 13.6s). It MUST be pre-ready or the
    # renderer's 10s sendRequest times out before the recorder is up.
    assert is_pre_ready_command("list_models_with_state") is True


def test_known_post_ready_commands_are_not_pre_ready() -> None:
    """Commands that require an initialised recorder must NOT be
    pre-ready — otherwise the boot-time filter would let them through
    and they'd crash on ``state.recorder is None``."""
    assert is_pre_ready_command("call_method") is False
    assert is_pre_ready_command("set_parameter") is False


# ─── _dispatch_command unknown-command path ──────────────────────────────


@settings(max_examples=100, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.text(min_size=1, max_size=30))
def test_unknown_command_returns_error_response(name: str) -> None:
    """Any unknown command name must produce a JSON error response.

    Critical: the dispatcher must never silently drop a command —
    that would leave the renderer waiting forever for a response.
    The error path emits a structured ``{"status":"error", ...}``
    payload that the client treats as a rejection.
    """
    # Pre-filter: hypothesis may hand us a known command name; skip
    # those by reusing the registry as the oracle.
    if name in _COMMAND_REGISTRY:
        return
    ws = _FakeWebSocket()
    state = _MinimalState()
    payload = {"command": name}

    _run(_dispatch_command(cast("ServerConnection", ws), cast("ServerState", state), payload, name))

    assert len(ws.sent) == 1
    response = json.loads(ws.sent[0])
    assert response["status"] == "error"
    assert "message" in response
    assert name in response["message"]


def test_none_command_dispatches_to_unknown_branch() -> None:
    """A payload without a ``command`` key parses to ``command=None``;
    the dispatcher must treat this as unknown (not raise)."""
    ws = _FakeWebSocket()
    state = _MinimalState()
    _run(_dispatch_command(cast("ServerConnection", ws), cast("ServerState", state), {}, None))
    assert len(ws.sent) == 1
    response = json.loads(ws.sent[0])
    assert response["status"] == "error"


@settings(max_examples=50, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(
    st.text(min_size=0, max_size=30),
    st.dictionaries(
        st.text(min_size=0, max_size=10),
        st.one_of(st.integers(), st.text(min_size=0, max_size=20), st.booleans()),
        max_size=5,
    ),
)
def test_unknown_command_with_arbitrary_garbage_payload_does_not_raise(
    name: str,
    extra_keys: dict[str, Any],
) -> None:
    """Extra/garbage fields on an unknown-command payload are ignored.

    The dispatcher only reads ``command`` for routing; everything else
    is the handler's concern. A defensive caller sending stray fields
    must not crash the dispatch layer.
    """
    if name in _COMMAND_REGISTRY:
        return
    ws = _FakeWebSocket()
    state = _MinimalState()
    payload: dict[str, Any] = {**extra_keys, "command": name}
    _run(_dispatch_command(cast("ServerConnection", ws), cast("ServerState", state), payload, name))
    assert len(ws.sent) == 1
    assert json.loads(ws.sent[0])["status"] == "error"


# ─── _dispatch_command determinism ───────────────────────────────────────


@settings(max_examples=30, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.text(min_size=1, max_size=30))
def test_unknown_command_response_is_deterministic(name: str) -> None:
    """Same unknown command, same response payload — twice in a row.

    The control-handler doesn't carry per-request state for the
    error path, so consecutive identical commands must return identical
    error responses (modulo trivial environmental noise).
    """
    if name in _COMMAND_REGISTRY:
        return
    ws_a = _FakeWebSocket()
    ws_b = _FakeWebSocket()
    state = _MinimalState()
    payload = {"command": name}

    _run(_dispatch_command(cast("ServerConnection", ws_a), cast("ServerState", state), payload, name))
    _run(_dispatch_command(cast("ServerConnection", ws_b), cast("ServerState", state), payload, name))

    assert ws_a.sent == ws_b.sent


# ─── Registry shape invariants ───────────────────────────────────────────


def test_registry_has_no_empty_keys() -> None:
    """Every registered command must have a non-empty name — an empty
    string would shadow the ``None`` / missing-command path and cause
    silent dispatch ambiguity."""
    for name in _COMMAND_REGISTRY:
        assert name
        assert isinstance(name, str)


def test_registry_handlers_are_async_callables() -> None:
    """Every spec's handler must be callable — a stray decorator-without-
    function would register ``None`` as the handler and crash at dispatch
    time. Property checked here so the regression is caught at import."""
    for name, spec in _COMMAND_REGISTRY.items():
        assert callable(spec.handler), f"handler for {name!r} is not callable"


def test_pre_ready_set_is_non_empty() -> None:
    """At least one pre-ready command must exist — the Settings panel
    relies on ``list_models`` returning before the recorder is up."""
    pre_ready = {n for n, s in _COMMAND_REGISTRY.items() if s.pre_ready}
    assert pre_ready, "no pre-ready commands wired"
