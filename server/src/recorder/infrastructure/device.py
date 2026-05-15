"""Shared device-resolution utility for ML-based infrastructure adapters.

Decides whether a caller's ``"cuda"`` request can actually be honored by:

1. Checking that ``onnxruntime-gpu`` is installed (it registers CUDA in
   ``get_available_providers``).
2. Patching the Python DLL search path on Windows so the bundled NVIDIA
   pip wheels (``nvidia-cublas-cu12``, ``nvidia-cudnn-cu12``,
   ``nvidia-cuda-runtime-cu12``) are loadable from inside the venv —
   onnxruntime-gpu can't find ``cublasLt64_12.dll`` without this. Replaces
   the torch-bundled DLL trick that the Track B step 1 refactor removed.
3. Probing whether a CUDAExecutionProvider session can actually be
   created. ``get_available_providers`` only checks the registered list;
   it returns CUDA even when DLLs fail to load (the symptom of repeated
   "Error 126" spam users saw before this hardening landed).

Caches the probe result for the process lifetime — DLL discovery is
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
GPU_PROVIDERS: frozenset[str] = frozenset(
    {
        "CUDAExecutionProvider",
        "TensorrtExecutionProvider",
        "DmlExecutionProvider",
        "ROCMExecutionProvider",
    }
)

# Subdirectories within each ``nvidia-*-cu12`` wheel that hold the .dll files
# on Windows (``bin``) or .so files on Linux (``lib``). The wheel layout is
# ``site-packages/nvidia/<lib_name>/bin/`` per the upstream nvidia packaging.
# Cover the full set ORT pulls into its provider DLL chain — cuBLAS, cuDNN,
# cuFFT, cuRAND, cuSPARSE, cuSOLVER, cuda_runtime, and nvrtc. Missing any one
# of these still produces the "Error 126" spam.
_NVIDIA_PACKAGES = (
    "cublas",
    "cudnn",
    "cuda_runtime",
    "cuda_nvrtc",
    "cufft",
    "curand",
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


# Module-load side effect: inject NVIDIA DLLs the first time this module
# is imported. ``device.py`` is imported transitively by bootstrap.py
# BEFORE any code that touches ``onnxruntime`` (the imports in
# ``OnnxAsrTranscriber`` and ``SileroVAD`` are lazy / inside class init).
# Running the injection at module load is the cleanest way to guarantee
# the DLLs are in the process's module table before ORT's CUDA EP DLL
# resolves its implicit dependencies — which is what makes onnxruntime-gpu
# usable on a torch-free Windows install.
_inject_cuda_dlls()


def resolve_device(requested: str) -> str:
    """Return the actual device to use, falling back to CPU when GPU is unavailable.

    "cuda" is honored only when the CUDA execution provider is registered
    AND its DLL chain is actually loadable (so we don't spam the user
    with provider-bridge failure logs every model load). Non-cuda values
    pass through unchanged.
    """
    if requested != "cuda":
        return requested
    try:
        import onnxruntime as rt
    except ImportError:
        logger.warning("CUDA requested but onnxruntime is not installed — falling back to CPU.")
        return "cpu"
    available = set(rt.get_available_providers())
    if not (available & GPU_PROVIDERS):
        logger.warning(
            "CUDA requested but no GPU execution provider (CUDA / TensorRT / DirectML) is "
            "registered with onnxruntime — falling back to CPU. For GPU support install the "
            "``server[gpu]`` extras."
        )
        return "cpu"
    # CUDA is the only of our GPU providers that needs DLL-chain probing
    # (DirectML and TensorRT have different runtime requirements). Only
    # block on the probe if CUDA is the candidate.
    if "CUDAExecutionProvider" in available and not _probe_cuda_session():
        return "cpu"
    return "cuda"
