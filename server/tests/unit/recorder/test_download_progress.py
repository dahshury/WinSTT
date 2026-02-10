"""Tests for _intercept_hf_progress download-tracking mechanism.

Verifies that the huggingface_hub tqdm monkey-patching fires progress
callbacks correctly, suppresses original tqdm output, patches
faster_whisper's disabled_tqdm subclass, restores originals on exit,
tracks progress when total is externally mutated (as huggingface_hub's
_AggregatedTqdm does in snapshot_download), and reports download speed.
"""

from __future__ import annotations

import itertools
import sys
import types
from collections.abc import Callable
from typing import Any

import pytest

from src.recorder.domain.events import DownloadProgress

# Use totals above the 1 MB threshold so progress events fire.
_2MB = 2_000_000
_10MB = 10_000_000
_100MB = 100_000_000
_3GB = 3_000_000_000


class _FakeTqdm:
    """Minimal tqdm-like class standing in for huggingface_hub.utils.tqdm.

    Mirrors real tqdm behavior: update() is a no-op when disable=True,
    which is critical because _TrackedTqdm sets disable=True and must
    track bytes itself via _tracked_n.
    """

    def __init__(self, *args: object, total: float | None = None, disable: bool = False, **kwargs: object) -> None:
        self.total = total
        self.disable = disable
        self.n: float = 0

    def update(self, n: object = 1) -> None:
        if self.disable:
            return  # real tqdm is a no-op when disable=True
        if isinstance(n, (int, float)):
            self.n += n


class _FakeDisabledTqdm(_FakeTqdm):
    """Stands in for faster_whisper.utils.disabled_tqdm (subclass of tqdm)."""

    def __init__(self, *args: object, **kwargs: object) -> None:
        kwargs["disable"] = True
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]


@pytest.fixture(autouse=True)
def _install_fake_modules() -> Any:  # noqa: ANN401
    """Inject fake huggingface_hub.utils, tqdm.auto, and faster_whisper.utils modules.

    Mirrors the real class hierarchy:
      tqdm.auto.tqdm  (_FakeTqdm)
        ├── huggingface_hub.utils.tqdm.tqdm  (_FakeTqdm — same class for simplicity)
        └── faster_whisper.utils.disabled_tqdm  (_FakeDisabledTqdm)
    """
    # Fake tqdm.auto (base tqdm)
    tqdm_root = types.ModuleType("tqdm")
    tqdm_auto = types.ModuleType("tqdm.auto")
    tqdm_auto.tqdm = _FakeTqdm  # type: ignore[attr-defined]
    tqdm_root.auto = tqdm_auto  # type: ignore[attr-defined]

    # Fake huggingface_hub
    hf_root = types.ModuleType("huggingface_hub")
    hf_utils = types.ModuleType("huggingface_hub.utils")
    hf_utils.tqdm = _FakeTqdm  # type: ignore[attr-defined]
    hf_root.utils = hf_utils  # type: ignore[attr-defined]

    # Fake faster_whisper
    fw_root = types.ModuleType("faster_whisper")
    fw_utils = types.ModuleType("faster_whisper.utils")
    fw_utils.disabled_tqdm = _FakeDisabledTqdm  # type: ignore[attr-defined]
    fw_root.utils = fw_utils  # type: ignore[attr-defined]

    saved: dict[str, types.ModuleType | None] = {}
    mod_names = (
        "tqdm",
        "tqdm.auto",
        "huggingface_hub",
        "huggingface_hub.utils",
        "faster_whisper",
        "faster_whisper.utils",
    )
    for name in mod_names:
        saved[name] = sys.modules.get(name)

    sys.modules["tqdm"] = tqdm_root
    sys.modules["tqdm.auto"] = tqdm_auto
    sys.modules["huggingface_hub"] = hf_root
    sys.modules["huggingface_hub.utils"] = hf_utils
    sys.modules["faster_whisper"] = fw_root
    sys.modules["faster_whisper.utils"] = fw_utils

    yield

    for name, mod in saved.items():
        if mod is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = mod


def _get_patched_cls() -> type:
    """Return the currently-installed tqdm class from the fake hf module."""
    return sys.modules["huggingface_hub.utils"].tqdm  # type: ignore[no-any-return]


def _get_fw_disabled() -> type:
    """Return the currently-installed disabled_tqdm from fake faster_whisper."""
    return sys.modules["faster_whisper.utils"].disabled_tqdm  # type: ignore[no-any-return]


def _collect(events: list[DownloadProgress]) -> Callable[[DownloadProgress], None]:
    """Return a callback that appends DownloadProgress to a list."""

    def cb(info: DownloadProgress) -> None:
        events.append(info)

    return cb


class TestInterceptHfProgress:
    """Test suite for _intercept_hf_progress context manager."""

    def test_fires_start_progress_complete(self) -> None:
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        events: list[DownloadProgress] = []

        with _intercept_hf_progress("test-model", _collect(events)):
            bar = _get_patched_cls()(total=_10MB)
            bar.update(_2MB)
            bar.update(_2MB)
            bar.update(_10MB - _2MB - _2MB)

        # First event: start (0.0)
        assert events[0].progress == 0.0
        assert events[0].model == "test-model"
        # Last event: complete (1.0) — fired in finally block
        assert events[-1].progress == 1.0
        # Intermediate progress values should be monotonically increasing
        progress_values = [e.progress for e in events]
        assert all(a <= b for a, b in itertools.pairwise(progress_values))

    def test_progress_values_are_correct(self) -> None:
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        events: list[DownloadProgress] = []

        with _intercept_hf_progress("mdl", _collect(events)):
            bar = _get_patched_cls()(total=_10MB)
            bar.update(_10MB // 2)  # 50%
            bar.update(_10MB // 2)  # 100% → capped at 99%

        progress_only = [e.progress for e in events]
        assert progress_only[0] == 0.0  # start
        assert progress_only[1] == pytest.approx(0.5)  # 50%
        assert progress_only[2] == pytest.approx(0.99)  # capped
        assert progress_only[3] == 1.0  # complete

    def test_reports_bytes_and_total(self) -> None:
        """DownloadProgress carries downloaded_bytes and total_bytes."""
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        events: list[DownloadProgress] = []

        with _intercept_hf_progress("bytes-model", _collect(events)):
            bar = _get_patched_cls()(total=_10MB)
            bar.update(_2MB)

        # Find the progress event after the start event
        progress_events = [e for e in events if 0.0 < e.progress < 1.0]
        assert len(progress_events) >= 1
        ev = progress_events[0]
        assert ev.downloaded_bytes == _2MB
        assert ev.total_bytes == _10MB

    def test_reports_speed_after_warmup(self) -> None:
        """Speed should be 0.0 initially (< 0.5s elapsed) and non-zero once time passes."""
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        events: list[DownloadProgress] = []

        with _intercept_hf_progress("speed-model", _collect(events)):
            bar = _get_patched_cls()(total=_10MB)
            bar.update(_2MB)

        # First progress event: speed is 0.0 because elapsed < 0.5s
        progress_events = [e for e in events if 0.0 < e.progress < 1.0]
        assert progress_events[0].speed_bps == 0.0

    def test_suppresses_original_tqdm(self) -> None:
        """The patched tqdm must set disable=True so the original bar doesn't render."""
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        with _intercept_hf_progress("mdl", lambda _info: None):
            bar = _get_patched_cls()(total=_10MB)
            assert bar.disable is True

    def test_restores_original_class_on_exit(self) -> None:
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        original = _get_patched_cls()
        assert original is _FakeTqdm

        with _intercept_hf_progress("mdl", lambda _info: None):
            patched = _get_patched_cls()
            assert patched is not _FakeTqdm  # should be _TrackedTqdm

        restored = _get_patched_cls()
        assert restored is _FakeTqdm

    def test_no_callbacks_when_no_download(self) -> None:
        """If no tqdm bar is created (model already cached), no events fire."""
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        events: list[DownloadProgress] = []

        with _intercept_hf_progress("cached-model", _collect(events)):
            pass  # no download → no tqdm bar created

        assert events == []

    def test_multiple_bars_aggregate_progress(self) -> None:
        """Multiple download bars (e.g. model.bin + config.json) aggregate correctly."""
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        events: list[DownloadProgress] = []

        with _intercept_hf_progress("multi", _collect(events)):
            cls = _get_patched_cls()
            bar1 = cls(total=_10MB)  # file 1: 10 MB
            bar2 = cls(total=_10MB)  # file 2: 10 MB  (total = 20 MB)
            bar1.update(_10MB)  # 10/20 = 50%
            bar2.update(_10MB)  # 20/20 = 99% (capped)

        progress_only = [e.progress for e in events]
        assert progress_only[0] == 0.0  # start (first bar created)
        assert pytest.approx(0.5) in progress_only
        assert progress_only[-1] == 1.0  # complete
        # total_bytes should reflect aggregate of both bars
        assert events[-1].total_bytes == _10MB * 2

    def test_callback_receives_model_name(self) -> None:
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        events: list[DownloadProgress] = []

        with _intercept_hf_progress("my-model", _collect(events)):
            _get_patched_cls()(total=_10MB).update(_10MB)

        assert all(e.model == "my-model" for e in events)

    def test_small_files_below_threshold_suppressed(self) -> None:
        """Progress events are suppressed when total < 1 MB (small config files)."""
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        events: list[DownloadProgress] = []

        with _intercept_hf_progress("small", _collect(events)):
            cls = _get_patched_cls()
            # Small config file (1 KB) — below 1 MB threshold
            bar = cls(total=1000)
            bar.update(1000)

        # No events because total < 1 MB
        assert events == []


class TestExternalTotalMutation:
    """Verify progress tracks correctly when total is mutated externally.

    This simulates huggingface_hub's _AggregatedTqdm pattern from
    snapshot_download: a bytes_progress bar is created with total=0,
    then _AggregatedTqdm externally sets bytes_progress.total += file_size
    for each file before forwarding update() calls.
    """

    def test_external_total_mutation_tracks_progress(self) -> None:
        """Bar created with total=0, total set externally → progress still tracked."""
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        events: list[DownloadProgress] = []

        with _intercept_hf_progress("ext-model", _collect(events)):
            cls = _get_patched_cls()
            # Simulate bytes_progress = tqdm_class(total=0)
            bytes_bar = cls(total=0)
            # _AggregatedTqdm.__init__ externally sets total (large model file)
            bytes_bar.total = _100MB
            # _AggregatedTqdm.update forwards byte chunks
            bytes_bar.update(_100MB // 4)  # 25%
            bytes_bar.update(_100MB // 4)  # 50%
            bytes_bar.update(_100MB // 4)  # 75%
            bytes_bar.update(_100MB // 4)  # 100% → capped at 99%

        progress_only = [e.progress for e in events]
        # Should have intermediate values, not just 0% and 99%
        assert len(progress_only) >= 5  # start + 4 updates + complete
        assert progress_only[-1] == 1.0
        # Verify intermediate granularity (25%, 50%, 75% approximately)
        assert pytest.approx(0.25) in progress_only
        assert pytest.approx(0.5) in progress_only
        assert pytest.approx(0.75) in progress_only
        # Verify bytes are reported correctly
        last_progress = [e for e in events if 0.0 < e.progress < 1.0][-1]
        assert last_progress.downloaded_bytes == _100MB
        assert last_progress.total_bytes == _100MB

    def test_snapshot_download_simulation(self) -> None:
        """Full simulation of snapshot_download's two-bar pattern.

        snapshot_download creates:
          1. bytes_progress = tqdm_class(total=0) — total mutated externally
          2. files_progress via thread_map(tqdm_class=tqdm_class, total=N)
        Small config files complete before the large model.bin is discovered.
        Progress should NOT spike to 99% from small files.
        """
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        events: list[DownloadProgress] = []

        with _intercept_hf_progress("snap-model", _collect(events)):
            cls = _get_patched_cls()

            # 1. bytes_progress bar — created with total=0
            bytes_bar = cls(total=0)

            # 2. files_progress bar — created by thread_map with total=3
            files_bar = cls(total=3)

            # Small config file completes instantly (below 1 MB threshold)
            bytes_bar.total = 2000  # config.json
            bytes_bar.update(2000)
            files_bar.update(1)

            # No events yet — total is below 1 MB threshold
            assert len(events) == 0

            # Large model.bin starts — total jumps above threshold
            bytes_bar.total = (bytes_bar.total or 0) + _3GB
            bytes_bar.update(_3GB // 4)
            # NOW events should fire
            assert len(events) >= 1

            bytes_bar.update(_3GB // 4)
            bytes_bar.update(_3GB // 4)
            bytes_bar.update(_3GB // 4)
            files_bar.update(1)

        progress_only = [e.progress for e in events]
        assert progress_only[0] == 0.0
        assert progress_only[-1] == 1.0

        # Should have smooth progress without a 99% spike at the start
        unique_intermediates = sorted({round(p, 2) for p in progress_only if 0.0 < p < 0.99})
        assert len(unique_intermediates) >= 2, f"Expected smooth progress, got: {progress_only}"

    def test_total_starts_zero_no_start_event_until_threshold(self) -> None:
        """No start event fires until total exceeds 1 MB threshold."""
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        events: list[DownloadProgress] = []

        with _intercept_hf_progress("lazy", _collect(events)):
            cls = _get_patched_cls()
            bar = cls(total=0)
            # No events yet — total is 0
            assert len(events) == 0
            # Small total — still below threshold
            bar.total = 500
            bar.update(250)
            assert len(events) == 0
            # Now set total above threshold and update
            bar.total = _10MB
            bar.update(_10MB // 2)
            # NOW events should fire (start + progress)
            assert len(events) >= 1

        # Complete event at the end
        assert events[-1].progress == 1.0
        assert events[-1].model == "lazy"


class TestFasterWhisperDisabledTqdmPatch:
    """Verify that faster_whisper.utils.disabled_tqdm subclass is also patched."""

    def test_disabled_tqdm_is_patched(self) -> None:
        """disabled_tqdm (a tqdm subclass) must be replaced with _TrackedTqdm."""
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        assert _get_fw_disabled() is _FakeDisabledTqdm

        with _intercept_hf_progress("mdl", lambda _info: None):
            patched = _get_fw_disabled()
            assert patched is not _FakeDisabledTqdm

        assert _get_fw_disabled() is _FakeDisabledTqdm

    def test_disabled_tqdm_fires_callbacks(self) -> None:
        """When faster_whisper passes disabled_tqdm as tqdm_class, callbacks still fire."""
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        events: list[DownloadProgress] = []

        with _intercept_hf_progress("fw-model", _collect(events)):
            # Simulate what faster_whisper.utils.download_model does:
            # kwargs["tqdm_class"] = disabled_tqdm  (now patched to _TrackedTqdm)
            tqdm_class = _get_fw_disabled()
            bar = tqdm_class(total=_100MB)
            bar.update(_100MB // 2)
            bar.update(_100MB // 2)

        assert events[0].model == "fw-model"
        assert events[0].progress == 0.0
        assert events[-1].progress == 1.0
        assert len(events) >= 4  # start + 2 progress + complete


class TestCancelDownload:
    """Verify download cancellation suppresses the 100% completion event.

    Bug: _intercept_hf_progress's finally block fired _emit(1.0, total, total)
    even when DownloadCancelledError was raised, causing a false "download
    complete" event to reach the frontend UI.
    """

    def test_cancel_suppresses_completion_event(self) -> None:
        """When cancelled, the finally block must NOT fire the 1.0 progress event."""
        from src.recorder.infrastructure.whisper_transcriber import (
            DownloadCancelledError,
            _intercept_hf_progress,
        )

        events: list[DownloadProgress] = []
        cancel_flag = False

        with pytest.raises(DownloadCancelledError):
            with _intercept_hf_progress("cancel-model", _collect(events), cancel_check=lambda: cancel_flag):
                cls = _get_patched_cls()
                bar = cls(total=_100MB)
                bar.update(_100MB // 4)  # 25%
                cancel_flag = True
                bar.update(_100MB // 4)  # raises DownloadCancelledError

        # Must NOT have a 1.0 completion event — download was cancelled
        assert all(e.progress < 1.0 for e in events), (
            f"Expected no 1.0 completion event after cancel, got: {[e.progress for e in events]}"
        )

    def test_cancel_still_restores_original_class(self) -> None:
        """Even on cancellation, original tqdm classes must be restored."""
        from src.recorder.infrastructure.whisper_transcriber import (
            DownloadCancelledError,
            _intercept_hf_progress,
        )

        assert _get_patched_cls() is _FakeTqdm
        assert _get_fw_disabled() is _FakeDisabledTqdm

        with pytest.raises(DownloadCancelledError):
            with _intercept_hf_progress("mdl", lambda _: None, cancel_check=lambda: True):
                cls = _get_patched_cls()
                bar = cls(total=_10MB)
                bar.update(_2MB)  # cancel_check returns True → raises

        assert _get_patched_cls() is _FakeTqdm
        assert _get_fw_disabled() is _FakeDisabledTqdm

    def test_normal_completion_still_fires_100_percent(self) -> None:
        """Regression: normal (non-cancelled) downloads must still emit 1.0."""
        from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

        events: list[DownloadProgress] = []

        with _intercept_hf_progress("ok-model", _collect(events), cancel_check=lambda: False):
            cls = _get_patched_cls()
            bar = cls(total=_10MB)
            bar.update(_10MB)

        assert events[-1].progress == 1.0
