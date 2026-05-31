"""Performance profile: dual (main + realtime) Whisper on GPU + Ollama transition.

OFF by default. Each test in this module skips unless ``WINSTT_PROFILE=1``.
Run with coverage disabled (this is a profile, not a coverage test):

    set WINSTT_PROFILE=1
    uv run pytest --no-cov -s -v tests/integration/recorder/test_concurrent_profile.py

What it exercises (real models, real GPU, optionally real Ollama):
    * Main + realtime ``onnx-asr`` Whisper-base loaded simultaneously on CUDA.
    * Process RSS, CPU%, GPU memory + util sampled at every stage.
    * Event-bus timeline so transition phases get accurate wall-clock numbers.
    * Long-sentence stress (≥3 min audio) to flush out hangs.
    * Rapid successive recordings → leak / regression check.
    * Ollama ``/api/chat`` round-trip ("transform transition phase") when
      Ollama is reachable at localhost:11434.
    * Edge cases: silence input, abort mid-record.

Each test writes a JSON profile under ``tests/.profile_runs/<test>.json``
and prints a structured one-liner per stage to stdout so anomalies are
visible during the run, not only after.
"""

from __future__ import annotations

import gc
import json
import os
import shutil
import subprocess
import threading
import time
from collections.abc import Iterator
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pytest

# Module-level gate: every test skips unless the user opted in. Coverage
# stays unaffected when the env var is missing — pytest skips the whole
# file before any imports of infrastructure run.
pytestmark = pytest.mark.skipif(
    os.environ.get("WINSTT_PROFILE") != "1",
    reason="set WINSTT_PROFILE=1 to run the GPU/Ollama profile suite",
)

# Imports below the gate so a default ``make`` run never pays the cost
# of loading psutil / soundfile / torch-via-onnx-asr just to skip.
import contextlib  # noqa: E402
import itertools  # noqa: E402

import psutil  # noqa: E402
import soundfile as sf  # noqa: E402

from src.recorder import AudioToTextRecorder  # noqa: E402
from src.recorder.domain.events import (  # noqa: E402
    RealtimeTranscriptionUpdate,
    RecordingStarted,
    RecordingStopped,
    TranscriptionCompleted,
    TranscriptionStarted,
)

# ── Paths ──────────────────────────────────────────────────────────────────

_REPO_ROOT = Path(__file__).resolve().parents[4]
_JFK_PATH = _REPO_ROOT / "examples" / "faster-whisper" / "tests" / "data" / "jfk.flac"
_LONG_PATH = _REPO_ROOT / "examples" / "faster-whisper" / "tests" / "data" / "physicsworks.wav"
_RESULTS_DIR = Path(__file__).resolve().parents[2] / ".profile_runs"

# ── Configuration knobs ────────────────────────────────────────────────────

_MAIN_MODEL = os.environ.get("WINSTT_PROFILE_MAIN_MODEL", "tiny")
_REALTIME_MODEL = os.environ.get("WINSTT_PROFILE_RT_MODEL", "tiny")
_OLLAMA_ENDPOINT = os.environ.get("WINSTT_PROFILE_OLLAMA", "http://127.0.0.1:11434")
# Background sampler cadence — 50ms is short enough to see GPU spikes from a
# single transcribe call but cheap enough to leave headroom on the timing.
_SAMPLE_INTERVAL_S = 0.05
# Anomaly thresholds. The dictation-end latency budget is the main signal:
# anything above this on a 10s utterance with main + realtime warm means
# something is wrong (or the model is too big for this hardware).
_MAX_RECORDING_END_TO_TRANSCRIPTION_COMPLETE_S = 2.5
_MAX_REALTIME_TICK_GAP_S = 1.2  # busy realtime should not stall this long
_MAX_RSS_GROWTH_MB_PER_RECORDING = 80.0
_MAX_VRAM_GROWTH_MB_PER_RECORDING = 80.0


# ── Audio helpers ──────────────────────────────────────────────────────────


def _load_audio_int16_mono_16k(path: Path) -> bytes:
    """Read a WAV/FLAC file and return raw 16 kHz mono int16 PCM bytes.

    Whisper's mel front-end runs at 16 kHz; the pipeline's audio buffer is
    16-bit signed little-endian. Resample + downmix at load time so the
    profile reflects steady-state pipeline cost, not decoder overhead.
    """
    data, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if data.ndim == 2:
        data = data.mean(axis=1)
    if sr != 16_000:
        from scipy.signal import resample

        new_len = round(len(data) * 16_000 / sr)
        data = resample(data, new_len).astype(np.float32, copy=False)
    clipped = np.clip(data, -1.0, 1.0)
    return (clipped * 32767.0).astype(np.int16).tobytes()


def _silence_bytes(seconds: float) -> bytes:
    n = round(16_000 * seconds)
    return (np.zeros(n, dtype=np.int16)).tobytes()


def _feed_pcm_bytes_chunked(recorder: AudioToTextRecorder, pcm: bytes, chunk_ms: int = 32) -> float:
    """Feed PCM through the recorder at real-time pace.

    Real-time pacing matters here: feeding instantly defeats VAD-based
    silence detection and skews realtime-worker tick timings. Returns
    the wall-clock seconds it took to feed.
    """
    bytes_per_ms = 2 * 16  # 16-bit, 16 kHz → 32 bytes/ms
    chunk_size = bytes_per_ms * chunk_ms
    t0 = time.perf_counter()
    next_deadline = t0
    for offset in range(0, len(pcm), chunk_size):
        recorder.feed_audio(pcm[offset : offset + chunk_size])
        next_deadline += chunk_ms / 1000.0
        sleep_for = next_deadline - time.perf_counter()
        if sleep_for > 0:
            time.sleep(sleep_for)
    return time.perf_counter() - t0


# ── Sampling primitives ────────────────────────────────────────────────────


@dataclass
class Sample:
    t: float
    rss_mb: float
    cpu_pct: float
    vram_used_mb: float | None
    vram_total_mb: float | None
    gpu_util_pct: float | None


@dataclass
class StageMarker:
    name: str
    t: float


@dataclass
class EventEntry:
    t: float
    kind: str
    extra: dict[str, Any] = field(default_factory=dict)


class _NvidiaSmi:
    """Thin wrapper over ``nvidia-smi`` for one-shot GPU snapshots.

    ``pynvml`` would be lower-overhead but isn't a dependency of the
    server venv. ``nvidia-smi`` adds ~30-40 ms per call on Windows, which
    is why the sampler thread runs at 20 Hz (default) rather than 50+.
    Falls back to ``None`` on every field when the binary is missing.
    """

    def __init__(self) -> None:
        self._path = shutil.which("nvidia-smi")

    @property
    def available(self) -> bool:
        return self._path is not None

    def sample(self) -> tuple[float | None, float | None, float | None]:
        if self._path is None:
            return None, None, None
        try:
            out = (
                subprocess.check_output(
                    [
                        self._path,
                        "--query-gpu=memory.used,memory.total,utilization.gpu",
                        "--format=csv,noheader,nounits",
                    ],
                    stderr=subprocess.DEVNULL,
                    timeout=2.0,
                )
                .decode()
                .strip()
            )
        except (subprocess.SubprocessError, OSError):
            return None, None, None
        line = out.splitlines()[0] if out else ""
        parts = [p.strip() for p in line.split(",") if p.strip()]
        if len(parts) < 3:
            return None, None, None
        try:
            return float(parts[0]), float(parts[1]), float(parts[2])
        except ValueError:
            return None, None, None


class Profiler:
    """Background sampler + stage marker + event-bus timeline collector.

    Sampling runs on a daemon thread so the test body stays single-threaded.
    Stage markers are inserted from the test body via :meth:`mark` whenever
    the test enters a new phase ("warmup", "feed", "wait_transcribe", …).
    """

    def __init__(self, name: str, interval_s: float = _SAMPLE_INTERVAL_S) -> None:
        self._name = name
        self._interval = interval_s
        self._proc = psutil.Process()
        self._proc.cpu_percent(interval=None)  # prime the counter
        self._gpu = _NvidiaSmi()
        self._samples: list[Sample] = []
        self._markers: list[StageMarker] = []
        self._events: list[EventEntry] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True, name=f"profiler-{name}")
        self._t0 = 0.0

    def start(self) -> None:
        self._t0 = time.perf_counter()
        self._thread.start()
        self.mark("profile-start")

    def mark(self, name: str) -> None:
        self._markers.append(StageMarker(name=name, t=time.perf_counter() - self._t0))

    def record_event(self, kind: str, **extra: Any) -> None:  # noqa: ANN401 — event payload is heterogeneous (int / str / bytes len)
        self._events.append(EventEntry(t=time.perf_counter() - self._t0, kind=kind, extra=extra))

    def stop(self) -> None:
        self.mark("profile-stop")
        self._stop.set()
        self._thread.join(timeout=2.0)

    def _loop(self) -> None:
        while not self._stop.is_set():
            now = time.perf_counter() - self._t0
            rss_mb = self._proc.memory_info().rss / (1024 * 1024)
            cpu_pct = self._proc.cpu_percent(interval=None)
            vram_used, vram_total, gpu_util = self._gpu.sample()
            self._samples.append(
                Sample(
                    t=now,
                    rss_mb=rss_mb,
                    cpu_pct=cpu_pct,
                    vram_used_mb=vram_used,
                    vram_total_mb=vram_total,
                    gpu_util_pct=gpu_util,
                )
            )
            self._stop.wait(self._interval)

    @staticmethod
    def _peak(values: list[float]) -> float:
        return max(values) if values else 0.0

    @staticmethod
    def _mean(values: list[float]) -> float:
        return sum(values) / len(values) if values else 0.0

    def summary(self) -> dict[str, Any]:
        rss = [s.rss_mb for s in self._samples]
        cpu = [s.cpu_pct for s in self._samples]
        vram = [s.vram_used_mb for s in self._samples if s.vram_used_mb is not None]
        gpu_util = [s.gpu_util_pct for s in self._samples if s.gpu_util_pct is not None]
        return {
            "name": self._name,
            "duration_s": self._samples[-1].t if self._samples else 0.0,
            "samples": len(self._samples),
            "rss_mb": {"min": min(rss, default=0), "max": max(rss, default=0), "mean": self._mean(rss)},
            "cpu_pct": {"max": self._peak(cpu), "mean": self._mean(cpu)},
            "vram_used_mb": {
                "min": min(vram, default=0),
                "max": max(vram, default=0),
                "mean": self._mean(vram),
            },
            "gpu_util_pct": {"max": self._peak(gpu_util), "mean": self._mean(gpu_util)},
            "markers": [asdict(m) for m in self._markers],
            "events": [asdict(e) for e in self._events],
            "gpu_available": self._gpu.available,
        }

    def write_json(self) -> Path:
        _RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        path = _RESULTS_DIR / f"{self._name}.json"
        path.write_text(json.dumps(self.summary(), indent=2))
        return path

    def event_first(self, kind: str) -> float | None:
        for e in self._events:
            if e.kind == kind:
                return e.t
        return None

    def event_last(self, kind: str) -> float | None:
        for e in reversed(self._events):
            if e.kind == kind:
                return e.t
        return None

    def event_times(self, kind: str) -> list[float]:
        return [e.t for e in self._events if e.kind == kind]


# ── Recorder fixture ───────────────────────────────────────────────────────


@dataclass
class RecorderHandle:
    recorder: AudioToTextRecorder
    transcribe_completed: list[TranscriptionCompleted]
    realtime_updates: list[RealtimeTranscriptionUpdate]
    profiler: Profiler | None = None
    _text_thread: threading.Thread | None = None
    _stop_text_worker: threading.Event = field(default_factory=threading.Event)

    def start_text_worker(self) -> None:
        """Loop ``recorder.text()`` on a daemon thread.

        ``text()`` is a *blocking* call that internally drives listen → wait
        → transcribe → publish. Each iteration corresponds to exactly one
        dictation. We mirror the real ``stt_server`` loop in
        ``server.py:154-157`` so the profile measures the real flow.
        """

        def _loop() -> None:
            while not self._stop_text_worker.is_set():
                try:
                    self.recorder.text()
                except Exception:
                    # text() raises on shutdown / abort racing with the
                    # next loop iteration. Treat as benign and keep going
                    # so a single bad cycle doesn't kill the worker.
                    if self._stop_text_worker.is_set():
                        return
                    time.sleep(0.05)

        self._text_thread = threading.Thread(target=_loop, daemon=True, name="profile-text-worker")
        self._text_thread.start()

    def stop_text_worker(self) -> None:
        self._stop_text_worker.set()
        # An idle text() is blocked in wait_audio(); abort wakes it up
        # by pushing a sentinel on the transcription queue.
        with contextlib.suppress(Exception):
            self.recorder.abort()
        if self._text_thread is not None:
            self._text_thread.join(timeout=3.0)

    def subscribe_to_profiler(self, profiler: Profiler) -> None:
        self.profiler = profiler

        bus = self.recorder._event_bus

        def _on_rec_started(_e: RecordingStarted) -> None:
            profiler.record_event("recording_started")

        def _on_rec_stopped(_e: RecordingStopped) -> None:
            profiler.record_event("recording_stopped")

        def _on_trans_started(e: TranscriptionStarted) -> None:
            profiler.record_event("transcription_started", audio_bytes=len(e.audio))

        def _on_trans_completed(e: TranscriptionCompleted) -> None:
            profiler.record_event("transcription_completed", text_len=len(e.text))

        def _on_rt(e: RealtimeTranscriptionUpdate) -> None:
            profiler.record_event("realtime_update", text_len=len(e.text))

        bus.subscribe(RecordingStarted, _on_rec_started)
        bus.subscribe(RecordingStopped, _on_rec_stopped)
        bus.subscribe(TranscriptionStarted, _on_trans_started)
        bus.subscribe(TranscriptionCompleted, _on_trans_completed)
        bus.subscribe(RealtimeTranscriptionUpdate, _on_rt)


def _build_recorder() -> RecorderHandle:
    """Construct the dual-model recorder on CUDA and warm both transcribers.

    Uses ``use_microphone=False`` so the facade wires a ``FileAudioSource``
    instead of opening a real input stream — the test feeds audio bytes
    directly via :meth:`feed_audio`.
    """
    completed: list[TranscriptionCompleted] = []
    realtime: list[RealtimeTranscriptionUpdate] = []

    recorder = AudioToTextRecorder(
        model=_MAIN_MODEL,
        realtime_model_type=_REALTIME_MODEL,
        device="cuda",
        use_microphone=False,
        enable_realtime_transcription=True,
        # Drive realtime as hard as the worker allows — we want to surface
        # any jitter in the loop, not hide it behind a long pause.
        realtime_processing_pause=0.1,
        init_realtime_after_seconds=0.1,
        # Keep VAD endpointing snappy: we drive start/stop explicitly so
        # the silence threshold is mostly informational, but a tight value
        # makes silence-input edge cases finish quickly.
        post_speech_silence_duration=0.3,
        spinner=False,
        on_realtime_transcription_update=lambda _t: None,
    )
    # Touch service to force model load + warmup (which runs a dummy
    # inference on each loaded transcriber).
    recorder.warmup()
    # ``text()`` is the only path that actually runs the main transcriber.
    # The real stt_server runs it in a forever loop on a worker thread —
    # we mirror that exactly so the profile reflects real-world execution.
    # listen() (called inside text()) bootstraps the pipeline worker +
    # realtime worker; nothing transcribes without this thread alive.
    handle = RecorderHandle(recorder=recorder, transcribe_completed=completed, realtime_updates=realtime)
    handle.start_text_worker()
    # PTT-mode: disable VAD-driven silence-end so the test fully controls
    # when recording stops. Without this, JFK's quiet opening (~0.5 s of
    # near-silence before "and so my fellow Americans") trips silence-end
    # within ~0.3 s and the recorder transcribes the silence prefix only.
    recorder.silence_endpoint_enabled = False

    bus = recorder._event_bus
    bus.subscribe(TranscriptionCompleted, completed.append)
    bus.subscribe(RealtimeTranscriptionUpdate, realtime.append)
    return handle


@pytest.fixture(scope="module")
def recorder_handle() -> Iterator[RecorderHandle]:
    """Module-scoped so the model load cost (~10 s on cold cache) amortizes
    across every test in this file. Tests must leave the recorder in a
    clean (INACTIVE) state — ``_recover_to_idle`` enforces this.
    """
    if not _JFK_PATH.exists():
        pytest.skip(f"required audio sample missing: {_JFK_PATH}")
    handle = _build_recorder()
    try:
        yield handle
    finally:
        handle.stop_text_worker()
        handle.recorder.shutdown()
        gc.collect()


def _recover_to_idle(handle: RecorderHandle) -> None:
    """Force the recorder back to a clean idle state between tests.

    Tests that ``abort()`` mid-record, or that hit an unexpected pipeline
    state, would otherwise leak that state into the next test in the same
    module.
    """
    with contextlib.suppress(Exception):
        handle.recorder.abort()
    handle.transcribe_completed.clear()
    handle.realtime_updates.clear()


# ── Profiler context helper ────────────────────────────────────────────────


def _profile(handle: RecorderHandle, name: str) -> Profiler:
    """Spin up a profiler subscribed to the recorder's event bus.

    Returned profiler is already started; caller must call :meth:`stop`
    and :meth:`write_json` before assertions inspect the summary.
    """
    p = Profiler(name=name)
    handle.subscribe_to_profiler(p)
    p.start()
    return p


def _run_dictation_cycle(
    handle: RecorderHandle,
    pcm: bytes,
    *,
    profiler: Profiler,
    feed_chunk_ms: int = 32,
    transcribe_timeout_s: float = 90.0,
) -> dict[str, Any]:
    """One press-to-talk cycle: start → feed → stop → wait for transcription.

    The ``text()`` worker thread is already running (see
    :meth:`RecorderHandle.start_text_worker`). It is blocked inside
    ``wait_audio()``. We force RECORDING with ``recorder.start()``, feed
    audio at real-time pace, then ``recorder.stop()`` flips the pipeline
    state machine to TRANSCRIBING and queues a signal that wakes up
    ``wait_audio``. ``text()`` then runs the main transcribe synchronously
    and publishes ``TranscriptionCompleted`` — which the test waits on.

    Returns timing fields used for assertions:
        * stop_to_transcribe_start_s   — release → TranscriptionStarted
        * stop_to_transcribe_complete_s — release → TranscriptionCompleted
        * wall_release_to_complete_s   — wall clock from stop() to event
    """
    profiler.mark("cycle-start")
    handle.transcribe_completed.clear()
    handle.realtime_updates.clear()

    t_start = time.perf_counter()
    profiler.mark("recorder-start")
    handle.recorder.start()
    profiler.mark("feed-begin")
    _feed_pcm_bytes_chunked(handle.recorder, pcm, chunk_ms=feed_chunk_ms)
    profiler.mark("feed-end")
    t_release = time.perf_counter()
    handle.recorder.stop()
    profiler.mark("recorder-stop")

    deadline = time.perf_counter() + transcribe_timeout_s
    while not handle.transcribe_completed and time.perf_counter() < deadline:
        time.sleep(0.01)
    profiler.mark("transcribe-observed")
    if not handle.transcribe_completed:
        raise AssertionError(f"transcription did not complete within {transcribe_timeout_s}s")

    total = time.perf_counter() - t_start
    # ``event_last`` (not ``first``) — the profiler is shared across the
    # session and the same event types fire on every cycle.
    rec_start_t = profiler.event_last("recording_started")
    rec_stop_t = profiler.event_last("recording_stopped")
    trans_start_t = profiler.event_last("transcription_started")
    trans_done_t = profiler.event_last("transcription_completed")

    # Snapshot the last text BEFORE the caller's ``finally`` clause runs
    # ``_recover_to_idle`` (which clears ``transcribe_completed``).
    last_text = handle.transcribe_completed[-1].text if handle.transcribe_completed else ""

    return {
        "total_s": total,
        "wall_release_to_complete_s": time.perf_counter() - t_release,
        "rec_start_at": rec_start_t or 0.0,
        "rec_stop_at": rec_stop_t or 0.0,
        "trans_start_at": trans_start_t or 0.0,
        "trans_complete_at": trans_done_t or 0.0,
        "stop_to_transcribe_start_s": (trans_start_t or 0.0) - (rec_stop_t or 0.0),
        "stop_to_transcribe_complete_s": (trans_done_t or 0.0) - (rec_stop_t or 0.0),
        "text": last_text,  # captured before recover_to_idle wipes the list
    }


# ── Tests ──────────────────────────────────────────────────────────────────


def test_dual_model_init_profile(recorder_handle: RecorderHandle, capsys: pytest.CaptureFixture[str]) -> None:
    """Cold-start: capture VRAM and RSS deltas with both models loaded.

    The fixture has already loaded the models — this test only writes the
    "as warmed" snapshot. It exists to capture absolute resource usage as
    the baseline subsequent tests measure deltas against.
    """
    p = _profile(recorder_handle, "init")
    # Hold for a few sampler ticks so we capture a clean steady-state band.
    time.sleep(0.5)
    p.stop()
    summary = p.summary()
    path = p.write_json()
    print(
        f"[profile-init] vram_max={summary['vram_used_mb']['max']:.0f}MB "
        f"rss_max={summary['rss_mb']['max']:.0f}MB -> {path}"
    )
    capsys.disabled()


def test_short_recording_dual_model(recorder_handle: RecorderHandle) -> None:
    """JFK ~11 s clip end-to-end. Most important latency: stop → complete."""
    if not _JFK_PATH.exists():
        pytest.skip(f"missing sample: {_JFK_PATH}")
    pcm = _load_audio_int16_mono_16k(_JFK_PATH)

    p = _profile(recorder_handle, "short_dual_model")
    try:
        timings = _run_dictation_cycle(recorder_handle, pcm, profiler=p)
    finally:
        p.stop()
        path = p.write_json()
        _recover_to_idle(recorder_handle)

    print(
        f"[short] release->complete={timings['stop_to_transcribe_complete_s'] * 1000:.0f}ms "
        f"release->start={timings['stop_to_transcribe_start_s'] * 1000:.0f}ms "
        f"vram_max={p.summary()['vram_used_mb']['max']:.0f}MB -> {path}"
    )

    assert timings["text"], "no TranscriptionCompleted fired"
    text = str(timings["text"]).lower()
    # JFK clip is "And so my fellow Americans, ask not what your country can
    # do for you - ask what you can do for your country." With ``tiny`` we
    # accept partial recognition — assert the word "country" appears.
    assert "country" in text, f"main transcription unexpected: {text!r}"

    assert timings["stop_to_transcribe_complete_s"] <= _MAX_RECORDING_END_TO_TRANSCRIPTION_COMPLETE_S, (
        f"dictation-end latency too high: "
        f"{timings['stop_to_transcribe_complete_s'] * 1000:.0f}ms "
        f"(budget {_MAX_RECORDING_END_TO_TRANSCRIPTION_COMPLETE_S * 1000:.0f}ms)"
    )


def test_long_sentence_no_hang(recorder_handle: RecorderHandle) -> None:
    """Long-sentence stress: ≥3 min audio fed in real time, must complete.

    This reproduces the user-reported hang: dictating a long sentence used
    to leave the recorder in TRANSCRIBING with the realtime worker spinning
    on the growing buffer. We bound the entire cycle to 6 minutes so the
    suite still fails (rather than hangs CI) if regressions return.
    """
    if not _LONG_PATH.exists():
        pytest.skip(f"missing long sample: {_LONG_PATH}")
    pcm = _load_audio_int16_mono_16k(_LONG_PATH)
    audio_seconds = len(pcm) / (2 * 16_000)
    # 3x audio duration is a generous transcription budget on whisper-base/GPU
    # (we usually see 0.1-0.3x realtime). It catches a true hang without
    # being flaky on slower hardware.
    deadline_s = audio_seconds * 3 + 30

    p = _profile(recorder_handle, "long_no_hang")
    try:
        timings = _run_dictation_cycle(
            recorder_handle,
            pcm,
            profiler=p,
            feed_chunk_ms=32,
            transcribe_timeout_s=deadline_s,
        )
    finally:
        p.stop()
        path = p.write_json()
        _recover_to_idle(recorder_handle)

    summary = p.summary()
    rt_events = p.event_times("realtime_update")
    gaps = [b - a for a, b in itertools.pairwise(rt_events)]
    max_gap = max(gaps) if gaps else 0.0

    print(
        f"[long] audio={audio_seconds:.0f}s rt_ticks={len(rt_events)} "
        f"max_rt_gap={max_gap * 1000:.0f}ms vram_max={summary['vram_used_mb']['max']:.0f}MB "
        f"release->complete={timings['stop_to_transcribe_complete_s'] * 1000:.0f}ms -> {path}"
    )

    assert timings["text"], "long-sentence transcription did not fire"
    # No tick gap larger than the threshold: a >1.2s gap during recording
    # signals the realtime worker stalled (the hang symptom).
    assert max_gap <= _MAX_REALTIME_TICK_GAP_S, (
        f"realtime tick stalled: max_gap={max_gap * 1000:.0f}ms (budget {_MAX_REALTIME_TICK_GAP_S * 1000:.0f}ms)"
    )


def test_rapid_successive_recordings_no_leak(recorder_handle: RecorderHandle) -> None:
    """5 short dictations back-to-back. Asserts RSS / VRAM don't keep growing."""
    if not _JFK_PATH.exists():
        pytest.skip(f"missing sample: {_JFK_PATH}")
    pcm = _load_audio_int16_mono_16k(_JFK_PATH)

    p = _profile(recorder_handle, "rapid_succession")
    per_cycle: list[dict[str, float]] = []
    rss_marks: list[float] = []
    vram_marks: list[float] = []
    try:
        proc = psutil.Process()
        gpu = _NvidiaSmi()
        for i in range(5):
            p.mark(f"cycle-{i}-pre")
            t = _run_dictation_cycle(recorder_handle, pcm, profiler=p, transcribe_timeout_s=30.0)
            per_cycle.append(t)
            rss_marks.append(proc.memory_info().rss / (1024 * 1024))
            vram_marks.append(gpu.sample()[0] or 0.0)
            # Tiny gap so the realtime worker's accumulator resets cleanly.
            time.sleep(0.1)
    finally:
        p.stop()
        path = p.write_json()
        _recover_to_idle(recorder_handle)

    rss_growth = rss_marks[-1] - rss_marks[0] if len(rss_marks) >= 2 else 0.0
    vram_growth = vram_marks[-1] - vram_marks[0] if len(vram_marks) >= 2 else 0.0
    avg_release_to_complete = sum(c["stop_to_transcribe_complete_s"] for c in per_cycle) / len(per_cycle)

    print(
        f"[rapid] cycles=5 avg_release->complete={avg_release_to_complete * 1000:.0f}ms "
        f"rss_growth={rss_growth:+.0f}MB vram_growth={vram_growth:+.0f}MB -> {path}"
    )

    assert rss_growth <= _MAX_RSS_GROWTH_MB_PER_RECORDING * 5, (
        f"process RSS leaked across 5 dictations (+{rss_growth:.0f}MB)"
    )
    assert vram_growth <= _MAX_VRAM_GROWTH_MB_PER_RECORDING * 5, (
        f"VRAM leaked across 5 dictations (+{vram_growth:.0f}MB)"
    )
    # Steady-state latency should not deteriorate cycle over cycle.
    first = per_cycle[0]["stop_to_transcribe_complete_s"]
    last = per_cycle[-1]["stop_to_transcribe_complete_s"]
    assert last <= first * 2 + 0.3, (
        f"latency regressed across cycles: first={first * 1000:.0f}ms last={last * 1000:.0f}ms"
    )


def test_realtime_tick_jitter(recorder_handle: RecorderHandle) -> None:
    """While recording, RealtimeTranscriptionUpdate cadence should stay
    bounded — large gaps reveal contention with the main transcriber.
    """
    if not _JFK_PATH.exists():
        pytest.skip(f"missing sample: {_JFK_PATH}")
    pcm = _load_audio_int16_mono_16k(_JFK_PATH)
    # Two JFK samples back-to-back = ~22 s recording → enough room for the
    # realtime accumulator to commit at least once (20 s threshold).
    pcm_extended = pcm + pcm

    p = _profile(recorder_handle, "realtime_jitter")
    try:
        _run_dictation_cycle(recorder_handle, pcm_extended, profiler=p, transcribe_timeout_s=60.0)
    finally:
        p.stop()
        path = p.write_json()
        _recover_to_idle(recorder_handle)

    rt = p.event_times("realtime_update")
    gaps = [b - a for a, b in itertools.pairwise(rt)]
    if gaps:
        max_gap = max(gaps)
        mean_gap = sum(gaps) / len(gaps)
    else:
        max_gap = 0.0
        mean_gap = 0.0
    print(f"[rt-jitter] ticks={len(rt)} mean_gap={mean_gap * 1000:.0f}ms max_gap={max_gap * 1000:.0f}ms -> {path}")
    if rt:
        # Allow one outlier gap to be the commit-tick (which transcribes
        # the buffered audio inside the same loop iteration), but cap it.
        assert max_gap <= _MAX_REALTIME_TICK_GAP_S * 1.5, f"realtime tick gap too large: {max_gap * 1000:.0f}ms"


def test_edge_case_silence_input(recorder_handle: RecorderHandle) -> None:
    """Feed pure silence: pipeline should produce empty text without hang."""
    pcm = _silence_bytes(2.0)
    p = _profile(recorder_handle, "silence_input")
    timings: dict[str, Any] = {}
    try:
        timings = _run_dictation_cycle(recorder_handle, pcm, profiler=p, transcribe_timeout_s=10.0)
    finally:
        p.stop()
        p.write_json()
        _recover_to_idle(recorder_handle)

    # Whisper occasionally hallucinates on pure zero-energy audio (the
    # famous "Thanks for watching!" failure mode). We accept any output as
    # long as the pipeline finishes — the hang is the regression we guard
    # against, not the hallucination.
    print(f"[silence] text={str(timings.get('text', '')).strip()!r}")


def test_edge_case_abort_mid_recording(recorder_handle: RecorderHandle) -> None:
    """Abort during recording: state must return to INACTIVE cleanly."""
    if not _JFK_PATH.exists():
        pytest.skip(f"missing sample: {_JFK_PATH}")
    pcm = _load_audio_int16_mono_16k(_JFK_PATH)

    p = _profile(recorder_handle, "abort_mid_recording")
    handle = recorder_handle
    handle.transcribe_completed.clear()
    p.mark("recorder-start")
    handle.recorder.start()
    # Feed half the audio, then abort.
    half = pcm[: len(pcm) // 2]
    p.mark("feed-begin")
    _feed_pcm_bytes_chunked(handle.recorder, half, chunk_ms=32)
    p.mark("abort")
    handle.recorder.abort()
    # Give the pipeline a moment to flush.
    time.sleep(0.3)
    p.stop()
    p.write_json()

    # After abort, the recorder is back to INACTIVE; starting a fresh
    # cycle must succeed without errors.
    _recover_to_idle(handle)
    p2 = _profile(handle, "abort_recover")
    timings: dict[str, Any] = {}
    try:
        timings = _run_dictation_cycle(handle, pcm, profiler=p2, transcribe_timeout_s=30.0)
    finally:
        p2.stop()
        p2.write_json()
        _recover_to_idle(handle)
    assert timings.get("text"), "post-abort transcription cycle did not produce text"


# ── Ollama transition phase ────────────────────────────────────────────────


def _ollama_reachable(endpoint: str) -> bool:
    try:
        import urllib.error
        import urllib.request

        req = urllib.request.Request(
            f"{endpoint.rstrip('/')}/api/tags",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError, TimeoutError):
        return False


def _ollama_list_models(endpoint: str) -> list[str]:
    import urllib.request

    try:
        with urllib.request.urlopen(f"{endpoint.rstrip('/')}/api/tags", timeout=3.0) as resp:
            data = json.loads(resp.read())
    except (OSError, json.JSONDecodeError):
        return []
    return [m["name"] for m in data.get("models", []) if "name" in m]


def _ollama_pick_small_model(endpoint: str) -> str | None:
    models = _ollama_list_models(endpoint)
    if not models:
        return None
    # Prefer the smallest model the user has — typically picked for cleanup
    # by users who care about latency. ``gemma3:4b`` is the small model on
    # the dev box this was authored against; otherwise we just pick the
    # first listed.
    for preferred in ("gemma3:4b", "llama3.2:3b", "qwen2.5:3b"):
        if preferred in models:
            return preferred
    return models[0]


def _ollama_chat_once(
    endpoint: str,
    model: str,
    system_prompt: str,
    user_text: str,
    *,
    keep_alive: str = "30m",
    timeout: float = 180.0,
) -> tuple[float, str]:
    """Single non-streaming /api/chat call. Returns (wall_seconds, output_text)."""
    import urllib.request

    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_text},
            ],
            "stream": False,
            "keep_alive": keep_alive,
            "options": {"temperature": 0.3, "top_p": 0.9, "num_predict": max(len(user_text) * 2, 100)},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{endpoint.rstrip('/')}/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read())
    elapsed = time.perf_counter() - t0
    text = payload.get("message", {}).get("content", "")
    return elapsed, text


def test_ollama_transform_transition_latency(recorder_handle: RecorderHandle) -> None:
    """Measure the "transition phase" the user is feeling.

    Pinpoints whether the 1-1.5 s lag is Ollama's per-call cost or some
    latency in the surrounding pipeline. Runs three calls back-to-back:

        cold  — first call after model unload (keep_alive=0)
        warm1 — keep_alive=30m, model already loaded
        warm2 — same conditions; sanity check that warm latency is stable
    """
    if not _ollama_reachable(_OLLAMA_ENDPOINT):
        pytest.skip(f"Ollama not reachable at {_OLLAMA_ENDPOINT}")
    model = _ollama_pick_small_model(_OLLAMA_ENDPOINT)
    if model is None:
        pytest.skip("Ollama has no models installed")

    system_prompt = (
        "You are a professional editor. Clean up the user's dictated text — "
        "fix punctuation, capitalization, and obvious speech artifacts. "
        "Return ONLY the cleaned text, no commentary."
    )
    sample_text = (
        "and so my fellow americans ask not what your country can do for you ask what you can do for your country"
    )

    # Force a cold path by asking Ollama to unload first.
    cold_s, cold_out = _ollama_chat_once(_OLLAMA_ENDPOINT, model, system_prompt, sample_text, keep_alive="0s")
    warm_s1, warm_out1 = _ollama_chat_once(_OLLAMA_ENDPOINT, model, system_prompt, sample_text)
    warm_s2, warm_out2 = _ollama_chat_once(_OLLAMA_ENDPOINT, model, system_prompt, sample_text)

    _RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (_RESULTS_DIR / "ollama_transition.json").write_text(
        json.dumps(
            {
                "endpoint": _OLLAMA_ENDPOINT,
                "model": model,
                "cold_s": cold_s,
                "cold_chars": len(cold_out),
                "warm_s1": warm_s1,
                "warm_chars1": len(warm_out1),
                "warm_s2": warm_s2,
                "warm_chars2": len(warm_out2),
                "sample_text_chars": len(sample_text),
            },
            indent=2,
        )
    )

    print(
        f"[ollama] model={model} cold={cold_s * 1000:.0f}ms warm1={warm_s1 * 1000:.0f}ms warm2={warm_s2 * 1000:.0f}ms"
    )

    # Diagnostic only — no hard assertion. The point is to surface the
    # numbers so we know where the 1-1.5 s "transition" comes from. A hard
    # ceiling here would be flaky across hardware.


# Allow direct invocation: ``python tests/integration/recorder/test_concurrent_profile.py``
# runs a single all-in-one sweep without pytest's coverage machinery.
if __name__ == "__main__":  # pragma: no cover
    os.environ.setdefault("WINSTT_PROFILE", "1")
    pytest.main([__file__, "-s", "-v", "--no-cov"])
