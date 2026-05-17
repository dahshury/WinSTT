"""Smoke tests for ``stt_server.observability``.

Only covers the logging side (file creation + idempotent reconfigure). The
Sentry init path is intentionally not exercised here — it requires either a
live DSN or extensive mocking, both of which add more noise than signal for
an entry-point wiring module.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import Iterator
from pathlib import Path
from typing import TYPE_CHECKING, cast

import pytest

from src.stt_server.observability import (
    _scrub,
    _scrub_breadcrumb,
    configure_observability,
)

if TYPE_CHECKING:
    from sentry_sdk._types import Breadcrumb, Event


@pytest.fixture(autouse=True)
def _reset_root_logger() -> Iterator[None]:
    """Snapshot + restore root logger handlers between tests."""
    root = logging.getLogger()
    saved_handlers = list(root.handlers)
    saved_level = root.level
    yield
    for h in list(root.handlers):
        root.removeHandler(h)
        with contextlib.suppress(Exception):
            h.close()
    for h in saved_handlers:
        root.addHandler(h)
    root.setLevel(saved_level)


def test_configure_observability_creates_log_file(tmp_path: Path) -> None:
    log_dir = tmp_path / "logs"
    configure_observability(log_dir=log_dir, debug=False, release=None)

    log_path = log_dir / "stt-server.log"
    assert log_path.parent.exists(), "log directory was not created"

    logger = logging.getLogger("winstt.test.smoke")
    logger.info("hello from the smoke test")

    # Flush all handlers so the file write lands on disk before we read it.
    for h in logging.getLogger().handlers:
        h.flush()

    assert log_path.exists(), "log file was not created"
    contents = log_path.read_text(encoding="utf-8")
    assert "hello from the smoke test" in contents
    assert "winstt.test.smoke" in contents


def test_configure_observability_is_idempotent(tmp_path: Path) -> None:
    log_dir = tmp_path / "logs"
    configure_observability(log_dir=log_dir, debug=False, release=None)
    handlers_after_first = list(logging.getLogger().handlers)
    configure_observability(log_dir=log_dir, debug=True, release=None)
    handlers_after_second = list(logging.getLogger().handlers)
    assert len(handlers_after_first) == len(handlers_after_second), (
        "duplicate handlers were attached on the second call"
    )


def test_configure_observability_without_log_dir(tmp_path: Path) -> None:
    # Should not raise, should not create a file, should still install stream handler.
    configure_observability(log_dir=None, debug=False, release=None)
    root = logging.getLogger()
    assert any(getattr(h, "_winstt_observability_handler", None) == "stream" for h in root.handlers)
    assert not any(getattr(h, "_winstt_observability_handler", None) == "file" for h in root.handlers)


def test_scrub_strips_transcript_and_server_name() -> None:
    raw_event: dict[str, object] = {
        "server_name": "user-laptop",
        "user": {"ip_address": "10.0.0.1", "id": "abc"},
        "extra": {
            "transcript": "the quick brown fox jumps over the lazy dog repeatedly",
            "safe_key": "ok",
        },
        "breadcrumbs": {
            "values": [
                {"data": {"audio_chunk": b"\x00\x01\x02", "harmless": 1}},
            ],
        },
    }
    out = _scrub(cast("Event", raw_event), {})
    assert out is not None
    out_dict = cast("dict[str, object]", out)
    assert "server_name" not in out_dict
    user_dict = cast("dict[str, object]", out_dict["user"])
    assert "ip_address" not in user_dict
    extra_dict = cast("dict[str, object]", out_dict["extra"])
    assert extra_dict["transcript"] == "[scrubbed]"
    assert extra_dict["safe_key"] == "ok"
    crumb_values = cast("list[dict[str, object]]", cast("dict[str, object]", out_dict["breadcrumbs"])["values"])
    crumb_data = cast("dict[str, object]", crumb_values[0]["data"])
    assert crumb_data["audio_chunk"] == "[scrubbed]"
    assert crumb_data["harmless"] == 1


def test_scrub_breadcrumb_drops_transcript_field() -> None:
    raw_crumb: dict[str, object] = {
        "category": "log",
        "data": {"text": "a long transcript-like sentence that should be scrubbed away"},
    }
    out = _scrub_breadcrumb(cast("Breadcrumb", raw_crumb), {})
    assert out is not None
    out_dict = cast("dict[str, object]", out)
    data_dict = cast("dict[str, object]", out_dict["data"])
    assert data_dict["text"] == "[scrubbed]"
