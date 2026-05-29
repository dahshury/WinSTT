"""Shared device-resolution utility for ML-based infrastructure adapters.

Decides which ONNX Runtime execution provider chain to use based on the
caller's intent (``"auto"`` / ``"cuda"`` / ``"directml"`` / ``"openvino"`` /
``"rocm"`` / ``"coreml"`` / ``"cpu"``) and the EPs actually registered with
the ORT install:

1. Checks the available providers list (``rt.get_available_providers()``)
   to know what the bundled ORT wheel ships — CPU-only / DirectML /
   ``onnxruntime-gpu`` (CUDA+TRT) / OpenVINO / ROCm.
2. For CUDA: patches the Python DLL search path on Windows so the
   bundled NVIDIA pip wheels (``nvidia-cublas-cu12``, ``nvidia-cudnn-cu12``,
   ``nvidia-cuda-runtime-cu12`` …) are loadable from inside the venv —
   ``onnxruntime-gpu`` can't find ``cublasLt64_12.dll`` without this.
3. For CUDA: probes whether a CUDAExecutionProvider session can actually
   be created. ``get_available_providers`` only checks the registered
   list; it returns CUDA even when DLLs fail to load (the symptom of
   repeated "Error 126" spam users saw before this hardening landed).
4. DirectML needs no DLL prep — ``onnxruntime-directml`` ships
   ``DirectML.dll`` inline and the Windows D3D12 stack is system-managed.
5. OpenVINO ships its own runtime DLLs inside the
   ``onnxruntime-openvino`` wheel. Default device target is ``AUTO`` so
   the runtime picks Intel ARC dGPU > Iris Xe iGPU > CPU per the host;
   advanced users can override via ``OPENVINO_DEVICE`` env var.
6. ``"auto"`` picks the priority order per-OS: Windows = OpenVINO >
   DirectML > CUDA > CPU; Linux = OpenVINO > CUDA > ROCm > CPU;
   macOS = CoreML > CPU. OpenVINO is at the head when present because
   it's the Intel-tuned path — on systems without Intel acceleration,
   the EP simply isn't registered and we fall through to the next entry.

Caches the CUDA probe result for the process lifetime — DLL discovery is
permanent, no point re-probing.
"""

from __future__ import annotations

import logging
import os
import sys
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)

# Canonical set of onnxruntime execution providers that count as "GPU" for
# device-selection purposes. Shared with other infrastructure adapters that
# need to inspect a session's active providers — keep this in ONE place so
# new ORT EPs (e.g. QnnExecutionProvider) don't have to be added in three
# files at once. The previous parallel set in ``onnxasr_transcriber.py``
# silently lagged behind this one (was missing ROCMExecutionProvider).
#
# ``TensorrtExecutionProvider`` is deliberately excluded: onnxruntime-gpu
# registers it whenever the build was compiled with TRT support, but we
# never bundle the TensorRT runtime (``nvinfer_10.dll``). Including it
# here makes ORT try TRT first on every session creation, log a noisy
# "EP Error … nvinfer_10.dll missing" / "Falling back to CUDA" pair, and
# only then continue with CUDA. Dropping it from the candidate set keeps
# the provider list TRT-free so users never see that spam.
GPU_PROVIDERS: frozenset[str] = frozenset(
    {
        "CUDAExecutionProvider",
        "DmlExecutionProvider",
        "ROCMExecutionProvider",
        "CoreMLExecutionProvider",
        "OpenVINOExecutionProvider",
    }
)

# Mapping from the user-facing accelerator name to its concrete ORT provider
# name. The user-facing names mirror the ``[directml]`` / ``[gpu]`` / ``cpu``
# extras in pyproject.toml so settings UI labels and install instructions
# line up. The ORT names are what ``rt.get_available_providers()`` returns.
_ACCELERATOR_PROVIDER: dict[str, str] = {
    "cuda": "CUDAExecutionProvider",
    "directml": "DmlExecutionProvider",
    "openvino": "OpenVINOExecutionProvider",
    "rocm": "ROCMExecutionProvider",
    "coreml": "CoreMLExecutionProvider",
    "cpu": "CPUExecutionProvider",
}

# Per-OS priority order used when the user picks ``accelerator="auto"``.
# - Windows: OpenVINO first when present (Intel ARC + recent iGPUs get a
#   real ~10-30 % uplift over DirectML's generic D3D12 path on Intel
#   silicon — Intel-published benchmarks). DirectML second because (a)
#   it's the default install per the pyproject ``[directml]`` extra,
#   (b) it works on AMD/Intel/NVIDIA, and (c) benchmarks (whisper-tiny
#   q4 on RTX 3080 Ti) show it matches CUDA's mean latency with 5-10x
#   lower stdev. CUDA is the fallback for the legacy ``[gpu]`` flavor
#   that ships NVIDIA wheels.
# - Linux: OpenVINO first (Intel datacenter); CUDA second (the standard
#   datacenter GPU EP); ROCm is the AMD fallback.
# - macOS: CoreML covers Apple Silicon NPU + AMD/Intel iGPUs natively.
#   (OpenVINO is unavailable on macOS upstream as of 1.18.)
#
# Entries whose EP isn't registered are skipped at resolution time, so a
# DirectML-only install behaves exactly as before — the OpenVINO entry
# just doesn't match and we fall through to ``directml``.
_AUTO_PRIORITY: dict[str, tuple[str, ...]] = {
    "win32": ("openvino", "directml", "cuda", "cpu"),
    "linux": ("openvino", "cuda", "rocm", "cpu"),
    "darwin": ("coreml", "cpu"),
}

# Sentinel: the user setting that means "no explicit preference". Used by
# :func:`resolve_accelerator` and :func:`providers_for_device` to honor the
# per-OS priority list instead of pinning a specific EP.
_ACCELERATOR_AUTO = "auto"

# Sentinel: the user setting that means "force CPU even if a GPU is present".
# Kept explicit so users can opt out of GPU acceleration regardless of EPs.
_ACCELERATOR_CPU = "cpu"


def _platform_priority() -> tuple[str, ...]:
    """Return the per-OS auto-priority list of accelerator names."""
    return _AUTO_PRIORITY.get(sys.platform, ("cpu",))


# Subdirectories within each ``nvidia-*-cu12`` wheel that hold the .dll files
# on Windows (``bin``) or .so files on Linux (``lib``). The wheel layout is
# ``site-packages/nvidia/<lib_name>/bin/`` per the upstream nvidia packaging.
# Cover the full set ORT pulls into its provider DLL chain — cuBLAS, cuDNN,
# cuFFT, cuRAND, cuSPARSE, cuSOLVER, cuda_runtime, nvrtc, and nvJitLink.
# Missing any one of these still produces the "Error 126" spam.
#
# Order matters for strategy 3 (preload pass): ``nvjitlink`` MUST come before
# ``cusparse``/``cusolver`` because their DLLs have an implicit dep on
# ``nvJitLink_120_0.dll``. Without preloading nvJitLink first, ``WinDLL`` on
# cusparse64_12.dll fails with "Error 126" even when its own bin dir is on the
# search path.
_NVIDIA_PACKAGES = (
    "cublas",
    "cudnn",
    "cuda_runtime",
    "cuda_nvrtc",
    "cufft",
    "curand",
    "nvjitlink",
    "cusparse",
    "cusolver",
)


def _inject_cuda_dlls() -> int:
    """Make bundled NVIDIA wheel DLLs available to onnxruntime-gpu.

    Three concurrent strategies because the Windows DLL resolver has
    subtly different rules for each load path that ORT triggers:

    1. ``os.add_dll_directory`` — covers explicit ``LoadLibrary`` calls
       and the modern ``LOAD_LIBRARY_SEARCH_USER_DIRS`` flag.
    2. ``os.environ["PATH"]`` prepend — covers legacy implicit DLL search
       (Windows walks PATH when resolving a dependency DLL whose parent
       wasn't loaded with ``LOAD_LIBRARY_SEARCH_*`` flags).
    3. ``ctypes.WinDLL`` preload of the leaf DLLs — puts them in the
       process's loaded-modules table BEFORE ORT loads
       ``onnxruntime_providers_cuda.dll``. When ORT's CUDA EP DLL is
       resolved by the loader and has implicit deps on ``cudnn64_9.dll``
       etc., Windows finds them already-loaded and skips the disk search
       entirely. This is the mechanism the old ``import torch`` hack
       relied on; we replicate it for the torch-free build.

    Returns the number of NVIDIA wheel directories successfully added.
    Idempotent.
    """
    if sys.platform != "win32":
        return 0
    try:
        import nvidia
    except ImportError:
        return 0
    # ``nvidia`` is a namespace package (no ``__file__``) — every
    # ``nvidia-*-cu12`` wheel installs a sub-package under the shared
    # ``nvidia/`` directory. Walk ``__path__`` (a list for namespace
    # packages) to find every canonical site-packages location.
    nvidia_roots = [Path(p) for p in nvidia.__path__]
    bin_dirs: list[Path] = []
    seen: set[Path] = set()
    for nvidia_root in nvidia_roots:
        for pkg in _NVIDIA_PACKAGES:
            bin_dir = nvidia_root / pkg / "bin"
            if bin_dir in seen or not bin_dir.is_dir():
                continue
            seen.add(bin_dir)
            bin_dirs.append(bin_dir)

    if not bin_dirs:
        return 0

    # Strategy 1: explicit DLL search dirs.
    for bin_dir in bin_dirs:
        try:
            os.add_dll_directory(str(bin_dir))
        except OSError as e:
            logger.debug("os.add_dll_directory(%s) raised: %s", bin_dir, e)

    # Strategy 2: prepend each bin to PATH (idempotent — we check first).
    path_segments = os.environ.get("PATH", "").split(os.pathsep)
    prepend: list[str] = []
    for bin_dir in bin_dirs:
        s = str(bin_dir)
        if s not in path_segments:
            prepend.append(s)
    if prepend:
        os.environ["PATH"] = os.pathsep.join([*prepend, *path_segments])

    # Strategy 3: preload critical DLLs into the process. The leaf DLLs
    # onnxruntime_providers_cuda.dll depends on must already be loaded
    # before ORT tries to dlopen them as implicit deps. ctypes.WinDLL with
    # an absolute path bypasses the search rules entirely.
    import ctypes

    for bin_dir in bin_dirs:
        for dll_path in bin_dir.glob("*.dll"):
            try:
                ctypes.WinDLL(str(dll_path))
            except OSError as e:
                logger.debug("preload %s raised: %s", dll_path.name, e)

    logger.info("Injected %d NVIDIA wheel DLL directories", len(bin_dirs))
    return len(bin_dirs)


_CUDA_DLLS_TO_PROBE = (
    "cublasLt64_12.dll",
    "cublas64_12.dll",
    "cudart64_12.dll",
    "cufft64_11.dll",
    "curand64_10.dll",
    "cusparse64_12.dll",
    "cusolver64_11.dll",
)


@lru_cache(maxsize=1)
def _probe_cuda_session() -> bool:
    """Verify the CUDA DLL chain is loadable from this process.

    Some installs register the CUDA provider name (so
    ``get_available_providers`` returns it) but fail to load the DLL chain
    at session-create time — producing dozens of "Error 126" log lines as
    every model load retries. We probe by trying ``ctypes.WinDLL`` on the
    DLLs ORT actually depends on; success here means a real ORT session
    with CUDA providers will load cleanly.

    Linux: skipped (return True if onnxruntime-gpu is installed) — there
    we rely on LD_LIBRARY_PATH being set correctly at the OS level.
    """
    _inject_cuda_dlls()
    if sys.platform != "win32":
        return True
    import ctypes

    for dll_name in _CUDA_DLLS_TO_PROBE:
        try:
            ctypes.WinDLL(dll_name)
        except OSError as e:
            logger.warning(
                "CUDAExecutionProvider unusable: %s could not be loaded (%s). "
                "Falling back to CPU. Install ``server[gpu]`` extras (bundles "
                "cuBLAS / cuDNN wheels) or ensure CUDA 12 + cuDNN 9 DLLs are "
                "on PATH.",
                dll_name,
                e,
            )
            return False
    return True


# NB: NVIDIA DLL injection is intentionally NOT done at module load — it
# would fire even on installs where the resolved accelerator is DirectML
# (dev venvs that happen to have ``[gpu]`` installed alongside
# ``[directml]``) and burn startup time + RSS preloading hundreds of MB of
# CUDA DLLs that ORT will never touch. Injection now happens lazily inside
# :func:`_probe_cuda_session`, which is the only path that can decide to
# create a CUDA EP session. The call chain
# ``resolve_accelerator → _probe_cuda_session → _inject_cuda_dlls`` keeps
# the original ordering invariant (DLLs in the process table BEFORE ORT's
# CUDA EP DLL resolves its implicit deps) without paying the cost on the
# DirectML / CPU / non-Windows paths.


def _available_providers() -> list[str]:
    """Return the EPs registered with the ORT install, or ``[]`` if ORT is missing."""
    try:
        import onnxruntime as rt
    except ImportError:
        return []
    return list(rt.get_available_providers())


def resolve_accelerator(requested: str) -> str:
    """Pick a concrete accelerator name from a user-facing setting.

    Inputs (case-insensitive, leading/trailing whitespace tolerated):

    * ``"auto"`` — walk :func:`_platform_priority` and pick the first
      candidate whose EP is registered (and, for CUDA, whose DLL chain
      probes clean). Falls back to ``"cpu"`` if nothing works.
    * ``"cuda"`` / ``"directml"`` / ``"rocm"`` / ``"coreml"`` — pin that
      specific EP. Falls back to ``"cpu"`` with a clear log line when the
      EP isn't registered or the DLL probe fails.
    * ``"cpu"`` — force CPU regardless of GPU availability.

    The return value is always one of the keys in :data:`_ACCELERATOR_PROVIDER`.
    Used by :func:`providers_for_device` to build the ORT provider list.
    """
    pref = (requested or _ACCELERATOR_AUTO).strip().lower()
    if pref == _ACCELERATOR_CPU:
        return _ACCELERATOR_CPU
    available = set(_available_providers())
    if not available and pref != _ACCELERATOR_AUTO:
        logger.warning(
            "Accelerator %r requested but onnxruntime is not installed — falling back to CPU.",
            pref,
        )
        return _ACCELERATOR_CPU

    candidates = _platform_priority() if pref == _ACCELERATOR_AUTO else (pref,)
    for cand in candidates:
        ep_name = _ACCELERATOR_PROVIDER.get(cand)
        if ep_name is None:
            # Unknown user-supplied accelerator name — log once and try CPU.
            logger.warning(
                "Unknown accelerator %r — known values: %s. Falling back to CPU.",
                cand,
                sorted(_ACCELERATOR_PROVIDER),
            )
            return _ACCELERATOR_CPU
        if cand == _ACCELERATOR_CPU:
            return _ACCELERATOR_CPU
        if ep_name not in available:
            if pref != _ACCELERATOR_AUTO:
                logger.warning(
                    "Accelerator %r requested but %s is not registered with onnxruntime "
                    "— falling back to CPU. Install the matching ``server[%s]`` extra.",
                    cand,
                    ep_name,
                    cand if cand != "cuda" else "gpu",
                )
                return _ACCELERATOR_CPU
            continue
        if cand == "cuda" and not _probe_cuda_session():
            # CUDA EP is registered but its DLL chain failed to load.
            # In auto-mode we keep walking the priority list (next entry
            # is typically CPU); for an explicit ``cuda`` request the
            # probe already logged a warning, so just return CPU.
            if pref == _ACCELERATOR_AUTO:
                continue
            return _ACCELERATOR_CPU
        return cand
    return _ACCELERATOR_CPU


def resolve_device(requested: str) -> str:
    """Return the actual device class ("cuda" / "cpu") for a legacy device string.

    Kept for backward compatibility with code paths that still think in
    terms of ``device == "cuda"``. Internally delegates to
    :func:`resolve_accelerator` and collapses every non-CPU accelerator to
    ``"cuda"`` so callers (e.g. the fp16/quantization selection in
    ``bootstrap._resolve_quantization``) treat DirectML and ROCm the same
    way they used to treat CUDA: "we have a GPU, pick the fp16 path".

    The legacy ``"auto"``/``"cuda"``/``"cpu"`` strings are accepted; anything
    not in that set (e.g. ``"directml"``) is forwarded to
    :func:`resolve_accelerator` first so it follows the same fallback rules.
    """
    legacy = (requested or "auto").strip().lower()
    if legacy == _ACCELERATOR_CPU:
        return _ACCELERATOR_CPU
    # Forward to the accelerator resolver and collapse to legacy buckets.
    resolved = resolve_accelerator(legacy)
    return _ACCELERATOR_CPU if resolved == _ACCELERATOR_CPU else "cuda"


# CUDA EP provider options. We *tried* sherpa-onnx's recommended
# ``cudnn_conv_algo_search="HEURISTIC"`` here (session.cc:310-316 — they pick
# it to avoid EXHAUSTIVE's multi-second first-run search) — but on a 30-min
# JFK benchmark with whisper-base + RTX 3080 Ti it produced a **4.5x
# steady-state regression** (42x→9.4x realtime). The heuristic algorithm
# pick was wrong for our encoder's conv shapes on Ampere. ORT's default
# (``EXHAUSTIVE``) is slower to warm up but materially faster in steady
# state for our workload, so we leave the search algorithm at the default.
# Other knobs left at default too: ``enable_cuda_graph`` requires zero
# Memcpy nodes in the graph (microsoft/onnxruntime#15490) which we can't
# guarantee without a custom fp16 conversion of the export.
#
# ``do_copy_in_default_stream`` is the one knob we DO touch. With the
# default (kept implicit), ORT issues host↔device Memcpys on auxiliary
# streams, which forces extra cudaStreamSynchronize calls before the
# next kernel can read the data. Routing copies through the same stream
# the kernels run on lets cudaMemcpyAsync overlap with the launch queue
# and skips the sync. Measured speedups on RTX 3080 Ti + intra=2,
# byte-identical transcripts across every (model, duration) cell:
#
#   whisper-tiny       6 s → -59 % (66 ms → 27 ms)
#   whisper-base.en    6 s → -66 % (106 ms → 36 ms)
#   moonshine-base    12 s → -77 % (73 ms → 17 ms)
#   canary-180m        6 s → -76 % (64 ms → 16 ms)
#
# See ``server/scripts/bench_matrix.py`` for the full matrix.
_CUDA_EP_OPTIONS: dict[str, str] = {
    "do_copy_in_default_stream": "1",
}


# OpenVINO EP provider options. ``device_type`` decides which Intel
# accelerator the runtime targets:
#   * ``AUTO``  — OpenVINO's auto-device plugin picks the best available
#                 backend (GPU dGPU > GPU iGPU > CPU). Recommended default.
#   * ``GPU``   — Force any Intel GPU (Iris Xe, Arc).
#   * ``GPU.0`` — Force a specific device by ID (useful for multi-GPU rigs).
#   * ``CPU``   — Force the Intel-vectorized CPU path (mostly diagnostic).
#
# Override at runtime via the ``OPENVINO_DEVICE`` env var; defaults to AUTO
# so a fresh install Just Works on Intel silicon. We pass ``cache_dir``
# so the EP can serialize compiled blobs across runs (~5-15s saved on
# subsequent boots after the first model load) — kept under the user's
# data dir so portable installs stay portable.
_OPENVINO_EP_OPTIONS: dict[str, str] = {
    "device_type": os.environ.get("OPENVINO_DEVICE", "AUTO").strip() or "AUTO",
}


# Provider-list entry as accepted by onnxruntime.InferenceSession: either a
# bare EP name or a (name, options_dict) tuple. onnx-asr forwards either form
# straight through, so callers don't need to know the difference.
ProviderEntry = str | tuple[str, dict[str, str]]


def providers_for_accelerator(accelerator: str) -> list[ProviderEntry] | None:
    """Translate a user-facing ``accelerator`` setting into a pinned ORT provider list.

    Mirrors :func:`providers_for_device` but takes the modern accelerator
    setting (``"auto"`` / ``"cuda"`` / ``"directml"`` / ``"rocm"`` /
    ``"coreml"`` / ``"cpu"``). New call sites should prefer this entry
    point — :func:`providers_for_device` stays for compatibility with the
    legacy ``device`` config field, which only knows CPU vs GPU.

    Returns ``["CPUExecutionProvider"]`` for ``"cpu"`` (forced or fallback).
    For a GPU accelerator, returns ``[<gpu_ep>, "CPUExecutionProvider"]``
    so ORT can fall back to CPU at op-level if a kernel isn't supported on
    the GPU EP. ``None`` is never returned — callers can always rely on
    a concrete list. The CUDA entry carries :data:`_CUDA_EP_OPTIONS` so
    every model load uses the same tuned settings.
    """
    chosen = resolve_accelerator(accelerator)
    if chosen == _ACCELERATOR_CPU:
        return ["CPUExecutionProvider"]
    ep_name = _ACCELERATOR_PROVIDER.get(chosen)
    if ep_name is None or ep_name not in _available_providers():
        # Defensive — resolve_accelerator already enforces this, but if a
        # caller hands us a freshly-monkeypatched provider list mid-test
        # we'd rather degrade gracefully than crash the session creation.
        return ["CPUExecutionProvider"]
    entry = _provider_entry_with_options(chosen, ep_name)
    return [entry, "CPUExecutionProvider"]


def _provider_entry_with_options(accelerator: str, ep_name: str) -> ProviderEntry:
    """Pick the right (provider, options) tuple for an EP that supports tuning.

    Centralised so :func:`providers_for_accelerator` and
    :func:`providers_for_device` apply identical knobs. Plain string entries
    (no options) are returned when an EP has no provider-specific options
    to set — onnxruntime accepts both forms in the providers list.
    """
    if accelerator == "cuda" and _CUDA_EP_OPTIONS:
        return (ep_name, dict(_CUDA_EP_OPTIONS))
    if accelerator == "openvino" and _OPENVINO_EP_OPTIONS:
        return (ep_name, dict(_OPENVINO_EP_OPTIONS))
    return ep_name


def providers_for_settings(device: str, accelerator: str) -> list[ProviderEntry] | None:
    """Pick the ORT provider list from the combined ``(device, accelerator)`` config.

    The two fields layer like so:

    * ``device == "cpu"`` — pinned CPU, ignore ``accelerator``.
    * ``accelerator != "auto"`` — explicit EP pin (``"directml"``, ``"cuda"``,
      ``"rocm"``, ``"coreml"``, ``"cpu"``); honoured if the EP is registered
      with the bundled ORT, else CPU fallback with a log line.
    * Otherwise (``device == "auto" | "cuda"`` with ``accelerator == "auto"``)
      — :func:`resolve_accelerator` walks the per-OS priority list (Windows:
      DirectML > CUDA > CPU) and picks the first viable EP.

    Existing callers that only know the ``device`` field can keep using
    :func:`providers_for_device`; new code should prefer this entry point
    so it picks up the user's accelerator preference automatically.
    """
    dev = (device or "auto").strip().lower()
    acc = (accelerator or _ACCELERATOR_AUTO).strip().lower()
    if dev == _ACCELERATOR_CPU:
        return ["CPUExecutionProvider"]
    if acc != _ACCELERATOR_AUTO:
        return providers_for_accelerator(acc)
    return providers_for_device(dev)


def providers_for_device(device: str) -> list[ProviderEntry] | None:
    """Translate a user-facing ``device`` string into a pinned ORT provider list.

    ``"cuda"`` requests are honoured only when a GPU-class provider is
    actually registered with onnxruntime (and, for CUDA, its DLL chain
    loads cleanly per :func:`_probe_cuda_session`) — otherwise we fall
    back to CPU instead of silently letting onnx-asr pick whatever ORT
    has available. ``None`` means "let the caller's library decide" (we
    use that for unknown values so callers can stay backwards-compatible).

    The GPU priority list is derived from ``onnxruntime.get_available_providers()``
    filtered against the shared :data:`GPU_PROVIDERS` set, so new ORT
    execution providers (DirectML / ROCm / future EPs) are honoured
    automatically without editing this function. ``TensorrtExecutionProvider``
    is intentionally excluded via :data:`GPU_PROVIDERS` — see the comment
    there for why.

    On CUDA the returned entries carry tuned provider options
    (:data:`_CUDA_EP_OPTIONS`) so every model load uses the same settings.

    Lives in ``device.py`` (not bootstrap) so non-bootstrap call sites
    (e.g. :class:`SileroVAD`) can request the same list without violating
    the application/infrastructure import contract.
    """
    resolved = resolve_device(device)
    if resolved == "cpu":
        return ["CPUExecutionProvider"]
    if resolved != "cuda":
        return None
    available = _available_providers()
    if not available:
        return ["CPUExecutionProvider"]
    gpu_providers = [p for p in available if p in GPU_PROVIDERS]
    if not gpu_providers:
        return ["CPUExecutionProvider"]
    entries: list[ProviderEntry] = []
    for p in gpu_providers:
        if p == "CUDAExecutionProvider" and _CUDA_EP_OPTIONS:
            entries.append((p, dict(_CUDA_EP_OPTIONS)))
        elif p == "OpenVINOExecutionProvider" and _OPENVINO_EP_OPTIONS:
            entries.append((p, dict(_OPENVINO_EP_OPTIONS)))
        else:
            entries.append(p)
    entries.append("CPUExecutionProvider")
    return entries
