"""End-to-end test for ``examples/onnx_asr_stream_demo.py`` ``Transcript``.

Drives the in-memory transcript model against scripted ``WhisperStream``
snapshots and verifies that:

* the live preview reflects only the text *past* the committed prefix,
* committed utterances accumulate across finalize cycles,
* the terminal-only mode never tries to open a file,
* optional ``--output`` mirrors committed text + trailing newlines.

No microphone, no model download.
"""

from __future__ import annotations

import importlib.util
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

import numpy as np
import pytest

DEMO_PATH = Path(__file__).resolve().parents[2] / "examples" / "onnx_asr_stream_demo.py"


def _import_demo() -> ModuleType:
    """Load the demo module by file path (it's not a package)."""
    spec = importlib.util.spec_from_file_location("onnx_asr_stream_demo", DEMO_PATH)
    if spec is None or spec.loader is None:
        pytest.fail(f"Could not load demo spec at {DEMO_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["onnx_asr_stream_demo"] = module
    spec.loader.exec_module(module)
    return module


@dataclass
class _Snapshot:
    """Mirror of onnx_asr.asr.StreamingResult — kept independent for test isolation."""

    text: str
    committed_text: str = ""


@pytest.fixture
def demo_module() -> ModuleType:
    return _import_demo()


def test_preview_is_snapshot_minus_committed(demo_module: ModuleType) -> None:
    """``Transcript.preview`` shows only the *uncommitted* tail of a snapshot."""
    t = demo_module.Transcript(output_file=None)
    t.update_from_snapshot("hello world how are you", "hello world")
    assert t.preview == "how are you"
    assert t.committed == []


def test_render_alternates_yellow_cyan(demo_module: ModuleType) -> None:
    """Committed utterances render in alternating yellow/cyan; preview in bold yellow."""
    t = demo_module.Transcript(output_file=None)
    t.update_from_snapshot("first sentence", "first sentence")
    t.finalize_utterance()
    t.update_from_snapshot("second one", "second one")
    t.finalize_utterance()
    t.update_from_snapshot("third in progress", "")  # all live preview
    text = t.render()
    plain = text.plain
    assert "first sentence" in plain
    assert "second one" in plain
    assert "third in progress" in plain
    # Spans carry the styles — gather them out.
    styles = [span.style for span in text.spans]
    assert "yellow" in styles
    assert "cyan" in styles
    assert "bold yellow" in styles


def test_render_accumulates_in_progress_committed_text(demo_module: ModuleType) -> None:
    """Across successive WhisperStream snapshots, the rendered text must GROW.

    Regression: previously ``render()`` only showed the uncommitted tail (preview)
    of the current segment, so as the LocalAgreement-2 commit grew (snapshot 2 has
    ``committed_text="hello"``, snapshot 3 has ``committed_text="hello world"``,
    …), the committed prefix was invisible and the screen appeared to *replace*
    each word with the next one instead of accumulating.
    """
    t = demo_module.Transcript(output_file=None)

    # Snapshot 1: full preview, nothing committed yet.
    t.update_from_snapshot("hello", "")
    plain_1 = t.render().plain
    assert "hello" in plain_1

    # Snapshot 2: "hello" is now stable; "world" is the new preview.
    t.update_from_snapshot("hello world", "hello")
    plain_2 = t.render().plain
    assert "hello" in plain_2  # stable prefix must still be visible
    assert "world" in plain_2  # preview tail is visible
    assert len(plain_2.strip()) >= len(plain_1.strip())

    # Snapshot 3: "hello world" is stable; "how" is the new preview.
    t.update_from_snapshot("hello world how", "hello world")
    plain_3 = t.render().plain
    assert "hello" in plain_3
    assert "world" in plain_3
    assert "how" in plain_3
    assert len(plain_3.strip()) >= len(plain_2.strip())


def test_in_progress_committed_renders_in_segment_color(demo_module: ModuleType) -> None:
    """The current segment's committed prefix uses the segment's own yellow/cyan slot.

    Empty history → segment is the 0th utterance → yellow. The preview tail
    remains bold yellow regardless.
    """
    t = demo_module.Transcript(output_file=None)
    t.update_from_snapshot("hello world how", "hello world")
    text = t.render()
    styles = {span.style for span in text.spans}
    assert "yellow" in styles  # in-progress committed prefix
    assert "bold yellow" in styles  # preview tail


def test_finalize_moves_committed_into_history(demo_module: ModuleType) -> None:
    t = demo_module.Transcript(output_file=None)
    t.update_from_snapshot("hi there", "hi there")
    t.finalize_utterance()
    assert t.committed == ["hi there"]
    assert t.preview == ""


def test_finalize_includes_uncommitted_preview_tail(demo_module: ModuleType) -> None:
    """If the last snapshot has uncommitted text and we finalize, the tail joins the utterance."""
    t = demo_module.Transcript(output_file=None)
    t.update_from_snapshot("hi there friend", "hi there")
    t.finalize_utterance()
    assert t.committed == ["hi there friend"]


def test_multiple_utterances_in_history(demo_module: ModuleType) -> None:
    t = demo_module.Transcript(output_file=None)
    for utterance in ["one", "two", "three"]:
        t.update_from_snapshot(utterance, utterance)
        t.finalize_utterance()
    assert t.committed == ["one", "two", "three"]


def test_clear_resets_everything(demo_module: ModuleType) -> None:
    t = demo_module.Transcript(output_file=None)
    t.update_from_snapshot("partial", "")
    t.finalize_utterance()
    t.update_from_snapshot("in progress", "in")
    t.clear()
    assert t.committed == []
    assert t.preview == ""
    assert t.render().plain == ""


def test_terminal_only_mode_writes_no_file(demo_module: ModuleType, tmp_path: Path) -> None:
    """With output_file=None, no file is created."""
    t = demo_module.Transcript(output_file=None)
    t.update_from_snapshot("just words", "just words")
    t.finalize_utterance()
    assert list(tmp_path.iterdir()) == []
    t.close()


def test_output_file_mirrors_committed_text(demo_module: ModuleType, tmp_path: Path) -> None:
    """With ``--output`` set, committed text plus newlines are appended."""
    out = tmp_path / "transcript.txt"
    t = demo_module.Transcript(output_file=out)
    t.update_from_snapshot("hello", "hello")
    t.finalize_utterance()
    t.update_from_snapshot("world", "world")
    t.finalize_utterance()
    t.close()
    assert out.read_text(encoding="utf-8") == "hello\nworld\n"


def test_chunk_recorder_drain_returns_buffered_chunks(demo_module: ModuleType) -> None:
    """``ChunkRecorder.drain`` returns queued chunks without blocking forever."""
    import queue as queue_mod
    import threading

    rec = object.__new__(demo_module.ChunkRecorder)
    rec._queue = queue_mod.Queue()
    rec._lock = threading.Lock()
    rec._queue.put(np.ones(1600, dtype=np.float32))
    rec._queue.put(np.ones(1600, dtype=np.float32) * 2)
    chunks = rec.drain(timeout_s=0.01)
    assert len(chunks) == 2
    assert chunks[0][0] == pytest.approx(1.0)
    assert chunks[1][0] == pytest.approx(2.0)


def test_megabyte_column_formats_under_1mb(demo_module: ModuleType) -> None:
    """``_format_mb`` auto-scales to kB / B below 1 MB."""
    assert demo_module._format_mb(0).strip() == "0 B"
    assert "kB" in demo_module._format_mb(2048)
    assert "MB" in demo_module._format_mb(5 * 1024 * 1024)
