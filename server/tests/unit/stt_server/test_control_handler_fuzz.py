"""Fuzz tests for the WebSocket control-handler dispatch.

Pushes much harder than ``test_control_handler_property.py``: large inputs,
random binary, recursive dicts, lone surrogates, CRLF injection, and a
~1MB payload. Goal: verify that ``_dispatch_command`` and
``is_pre_ready_command`` never crash, never hang, never silently drop —
under any input we can throw at them.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

from hypothesis import HealthCheck, example, given, settings
from hypothesis import strategies as st

from src.stt_server.control_handler import (
    _COMMAND_REGISTRY,
    _dispatch_command,
    is_pre_ready_command,
)


@dataclass
class _FakeWebSocket:
    sent: list[str] = field(default_factory=list)

    async def send(self, payload: str) -> None:
        self.sent.append(payload)


@dataclass
class _MinimalState:
    recorder: Any = None
    extended_logging: bool = False


def _run(coro: Any) -> None:  # noqa: ANN401
    asyncio.run(coro)


# ─── is_pre_ready_command totality fuzz ──────────────────────────────────


@settings(max_examples=300, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.text(min_size=0, max_size=10000))
def test_pre_ready_check_total_over_text(name: str) -> None:
    """Long text never crashes the pre-ready filter."""
    result = is_pre_ready_command(name)
    assert isinstance(result, bool)


@settings(max_examples=200, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.text(alphabet=st.characters(blacklist_categories=()), min_size=0, max_size=200))
def test_pre_ready_check_total_over_all_codepoints(name: str) -> None:
    """All-codepoint text (including surrogates, controls) never crashes."""
    result = is_pre_ready_command(name)
    assert isinstance(result, bool)


@example("\x00")
@example("\r\n\r\nGET / HTTP/1.0\r\n\r\n")
@example("a" * 1_000_000)
@example("\ud83d")  # lone surrogate (incomplete emoji)
@example("‮‭")  # bidi-override + isolate
@settings(max_examples=20, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.text(min_size=0, max_size=100))
def test_pre_ready_check_adversarial_seeds(name: str) -> None:
    """Adversarial named seeds plus a hypothesis sample."""
    result = is_pre_ready_command(name)
    assert isinstance(result, bool)


# ─── _dispatch_command totality fuzz ─────────────────────────────────────


def _dispatch_safely(command: Any, payload: Any) -> tuple[bool, list[str]]:  # noqa: ANN401
    """Drive _dispatch_command; return (raised, sent_messages)."""
    ws = _FakeWebSocket()
    state = _MinimalState()
    try:
        _run(_dispatch_command(ws, state, payload, command))  # type: ignore[arg-type]
        return False, ws.sent
    except Exception:
        return True, ws.sent


@settings(max_examples=300, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.text(min_size=0, max_size=200))
def test_dispatch_random_command_name(name: str) -> None:
    """Arbitrary command-name strings never raise an uncaught exception."""
    # If hypothesis lands on a real command name with no payload, the
    # registered handler may legitimately reject the payload — but it
    # must still not raise. Skip names that ARE registered because their
    # handlers have richer signature contracts tested elsewhere.
    if name in _COMMAND_REGISTRY:
        return
    raised, sent = _dispatch_safely(name, {"command": name})
    assert raised is False
    # Unknown path must produce exactly one error response.
    assert len(sent) == 1
    response = json.loads(sent[0])
    assert response["status"] == "error"


@settings(max_examples=200, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(
    st.recursive(
        st.none() | st.booleans() | st.integers() | st.text(max_size=50),
        lambda children: st.lists(children, max_size=5) | st.dictionaries(st.text(max_size=10), children, max_size=5),
        max_leaves=20,
    )
)
def test_dispatch_random_payload(payload: Any) -> None:  # noqa: ANN401
    """Random recursive payload with bogus command name never raises."""
    name = "definitely_not_a_real_command_name_xyzzy"
    raised, _ = _dispatch_safely(name, {"command": name, "data": payload})
    assert raised is False


@example("\x00\x01\x02")
@example("\r\n\r\nGET / HTTP/1.0\r\n\r\n")
@example("x" * 100_000)  # 100KB
@example("\ud83d")  # lone high surrogate
@example("‮")  # right-to-left override
@settings(max_examples=30, deadline=None, suppress_health_check=[HealthCheck.too_slow, HealthCheck.large_base_example])
@given(st.text(min_size=0, max_size=100))
def test_dispatch_adversarial_command(name: str) -> None:
    """Adversarial command-name seeds — null bytes, CRLF, surrogates."""
    if name in _COMMAND_REGISTRY:
        return
    raised, sent = _dispatch_safely(name, {"command": name})
    assert raised is False
    assert len(sent) == 1


@settings(max_examples=50, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.dictionaries(st.text(max_size=20), st.one_of(st.none(), st.text(max_size=50), st.integers()), max_size=10))
def test_dispatch_arbitrary_dict_payload_unknown_command(payload: dict[str, Any]) -> None:
    """Arbitrary dict payload with unknown command yields error response."""
    name = "completely_unknown_command_for_fuzz"
    raised, sent = _dispatch_safely(name, {"command": name, **payload})
    assert raised is False
    assert len(sent) == 1
    response = json.loads(sent[0])
    assert response["status"] == "error"


# ─── Determinism ────────────────────────────────────────────────────────


@settings(max_examples=100, deadline=None)
@given(st.text(min_size=1, max_size=30))
def test_pre_ready_check_deterministic(name: str) -> None:
    """Same input must produce same output regardless of repetition."""
    a = is_pre_ready_command(name)
    b = is_pre_ready_command(name)
    c = is_pre_ready_command(name)
    assert a == b == c
