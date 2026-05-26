# PyInstaller spec for the WinSTT STT server.
#
# Single spec, three flavors. The build flavor is determined by which
# extra was installed in the venv (``uv sync --extra cpu`` /
# ``--extra directml`` / ``--extra gpu``). We sniff the venv at
# spec-evaluation time:
#
#   - ``nvidia`` namespace package present → CUDA build → bundle every
#     ``nvidia/*/bin/*.dll`` so onnxruntime-gpu's CUDA EP works offline.
#     Total artifact ~2 GB.
#   - DirectML build (``onnxruntime-directml`` installed, no ``nvidia``):
#     ``collect_all("onnxruntime")`` already pulls in DirectML.dll from
#     the wheel's ``onnxruntime/capi/`` directory — no special handling
#     needed. Total artifact ~200 MB.
#   - CPU build (``onnxruntime`` installed, no ``nvidia``): only the CPU
#     onnxruntime DLLs. Total artifact ~150 MB.
#
# Build command (from server/):
#   uv run pyinstaller build/stt-server.spec --clean --noconfirm --distpath dist
#
# Output: dist/stt-server/  (onedir layout — Electron spawns the exe in-place
# via ``process.resourcesPath/stt-server/stt-server.exe``; onefile would
# extract to %TEMP% on every start which is unacceptable for a 2 GB CUDA
# bundle).

# ruff: noqa  — PyInstaller specs run under its own interpreter context
# pylint: disable=undefined-variable  — Analysis/EXE/COLLECT are spec globals

import importlib.util
import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files


def _detect_gpu_build() -> bool:
    """True when the ``nvidia`` namespace package is importable in this venv."""
    return importlib.util.find_spec("nvidia") is not None


def _collect_nvidia_dlls() -> list[tuple[str, str]]:
    """Walk every ``nvidia-*-cu12`` wheel's ``bin/`` dir and pick its DLLs.

    Returned tuples are ``(src_path, dst_relative_path)`` as PyInstaller's
    ``binaries`` list expects. The destination keeps the wheel's directory
    layout (``nvidia/cublas/bin/cublasLt64_12.dll`` etc.) so
    ``_inject_cuda_dlls()`` finds them at runtime through ``nvidia.__path__``.
    """
    import nvidia  # noqa: PLC0415

    binaries: list[tuple[str, str]] = []
    for root in nvidia.__path__:
        root_path = Path(root)
        for bin_dir in root_path.glob("*/bin"):
            if not bin_dir.is_dir():
                continue
            sub_pkg = bin_dir.parent.name
            for dll in bin_dir.glob("*.dll"):
                rel = f"nvidia/{sub_pkg}/bin"
                binaries.append((str(dll), rel))
    return binaries


IS_GPU_BUILD = _detect_gpu_build()

# ── UPX configuration ──────────────────────────────────────────────────
# UPX compresses PE binaries in-place; on the Python C-extension layer
# (numpy.libs, scipy.libs, pydantic_core, etc.) it typically shaves
# 30–60 % off DLL size for a one-time decompress cost at first load. The
# decompressed bytes live in RAM, so cold startup memory rises by a few
# tens of MB — acceptable for a desktop app.
#
# ⚠️ Caveats and exclusions:
#   1. NVIDIA's CUDA DLLs (cublas*, cudnn*, curand*, cusolver*, cusparse*,
#      cufft*, nvrtc*, nvJitLink*) are giant, already heavily-compressed
#      math kernels. UPX gains are near zero AND can corrupt the cuDNN
#      runtime loader, which sniffs PE headers on import. Skip them all.
#   2. ``onnxruntime_providers_cuda.dll`` is a Microsoft-signed binary —
#      UPX would invalidate the signature and trigger SmartScreen.
#   3. Some Windows Defender heuristics flag UPX-packed PEs as suspicious;
#      this is the main reason desktop apps shipping to end users tend to
#      avoid it. If the AV false-positive rate becomes a problem, flip
#      ``ENABLE_UPX`` below to ``False`` to disable globally.
#
# Set ``WINSTT_NO_UPX=1`` in the build environment to bypass UPX entirely
# without editing this file (useful for reproducing the legacy bundle size
# or for signed-binary releases that need bit-stability).
ENABLE_UPX = os.environ.get("WINSTT_NO_UPX", "").strip() not in {"1", "true", "yes"}

UPX_EXCLUDES: list[str] = [
    # CUDA EP shim — Microsoft-signed and large.
    "onnxruntime_providers_cuda.dll",
    "onnxruntime_providers_tensorrt.dll",
    # cuDNN — runtime sniffs the PE header on import; UPX breaks this.
    "cudnn*.dll",
    # cuBLAS — already compressed math kernels.
    "cublas*.dll",
    "cublasLt*.dll",
    # Other NVIDIA libs (kept here as defence-in-depth even though the
    # ``[gpu]`` extra no longer pulls them; transitive resolves can still
    # surface them).
    "curand*.dll",
    "cufft*.dll",
    "cusparse*.dll",
    "cusolver*.dll",
    "cusolverMg*.dll",
    "nvrtc*.dll",
    "nvJitLink*.dll",
    # OpenSSL — Python embeds it for ssl/hashlib and some downloads. UPX
    # has historically caused load failures on it under Windows 11.
    "libcrypto-3-x64.dll",
    "libssl-3-x64.dll",
    # Python runtime itself + UCRT — touching these is asking for trouble.
    "python*.dll",
    "ucrtbase.dll",
    "vcruntime*.dll",
    "VCOMP*.DLL",
]

# ── Discover dependencies via hooks ────────────────────────────────────
# ``collect_all`` for runtime libs that load resources via __path__ /
# importlib at runtime — onnx-asr ships a Silero VAD .onnx next to its
# code; onnxruntime ships its own provider DLLs; huggingface_hub has a
# data file ``constants.py`` resolves dynamically.
onnxasr_datas, onnxasr_binaries, onnxasr_hidden = collect_all("onnx_asr")
ort_datas, ort_binaries, ort_hidden = collect_all("onnxruntime")
hf_datas, hf_binaries, hf_hidden = collect_all("huggingface_hub")

binaries: list[tuple[str, str]] = []
binaries.extend(onnxasr_binaries)
binaries.extend(ort_binaries)
binaries.extend(hf_binaries)
if IS_GPU_BUILD:
    binaries.extend(_collect_nvidia_dlls())

datas: list[tuple[str, str]] = []
datas.extend(onnxasr_datas)
datas.extend(ort_datas)
datas.extend(hf_datas)
# Pydantic ships compiled validation core via a data file in some envs;
# collect_data_files picks it up where ``collect_all`` misses.
datas.extend(collect_data_files("pydantic"))
# Ship the ASR model catalog JSON next to its loader. ``model_registry.py``
# resolves it via ``Path(__file__).parent / "catalog.json"``, so the
# destination directory mirrors the source layout exactly.
SERVER_ROOT_SPEC = Path(SPECPATH).resolve().parent
_CATALOG_SRC = SERVER_ROOT_SPEC / "src" / "recorder" / "domain" / "catalog.json"
if _CATALOG_SRC.is_file():
    datas.append((str(_CATALOG_SRC), "src/recorder/domain"))

# Ship the pre-downloaded offline base model (whisper-tiny q4) as a
# verbatim HF cache tree. ``seed_models.py`` (run by build.ps1) vendors
# it into ``packaging/seed-cache/`` and
# ``src/recorder/infrastructure/seed_cache.py`` copies it into the user's
# real HF cache on first run so STT works with zero network. Absent in a
# bare checkout — bundle only when a build seeded it.
_SEED_SRC = SERVER_ROOT_SPEC / "packaging" / "seed-cache"
if _SEED_SRC.is_dir():
    datas.append((str(_SEED_SRC), "seed-cache"))

hiddenimports: list[str] = []
hiddenimports.extend(onnxasr_hidden)
hiddenimports.extend(ort_hidden)
hiddenimports.extend(hf_hidden)
# onnx-asr loads model implementations dynamically — name them so PyInstaller
# doesn't tree-shake them. Mirrors the catalog in ``model_registry.py``.
hiddenimports.extend(
    [
        "onnx_asr.models.whisper",
        "onnx_asr.models.silero",
        "onnx_asr.models.nemo",
        "onnx_asr.models.gigaam",
        "onnx_asr.models.kaldi",
        "onnx_asr.models.tone",
    ]
)

# ── Analysis / build ───────────────────────────────────────────────────
SPEC_DIR = Path(SPECPATH).resolve()
SERVER_ROOT = SPEC_DIR.parent

a = Analysis(
    [str(SERVER_ROOT / "src" / "stt_server" / "server.py")],
    pathex=[str(SERVER_ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    # Local hooks/ shadow the stdhooks-contrib bundled hooks with the same
    # name. Currently used to patch hook-webrtcvad (PyPI dist name is
    # ``webrtcvad-wheels``, not ``webrtcvad``).
    hookspath=[str(SPEC_DIR / "hooks")],
    hooksconfig={},
    runtime_hooks=[],
    # Excludes — keep the bundle lean. None of these are needed at runtime.
    excludes=[
        "matplotlib",
        "PIL",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "tkinter",
        "IPython",
        "jupyter",
        "notebook",
        # If somebody installs the [sentence-classifier] extra, we still
        # don't want torch+transformers in the standalone exe — that's a
        # 2 GB+ surprise. The DistilBERT path is lazy-import + fail-soft
        # in the code, so excluding here is safe.
        "torch",
        "transformers",
        # TTS (kokoro) is delivered on demand as a downloadable support
        # pack — never frozen into the exe. Excluding these guarantees a
        # TTS-free exe even if a dev venv has the [tts] extra installed.
        # The synthesizer imports them lazily inside _ensure_loaded()
        # after the pack is on sys.path, so excluding here is safe.
        "kokoro_onnx",
        "espeakng_loader",
        "phonemizer",
        "phonemizer_fork",
        "segments",
        "csvw",
    ],
    noarchive=False,
    optimize=2,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="stt-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=ENABLE_UPX,
    upx_exclude=UPX_EXCLUDES,
    console=True,  # keep console so user can see startup logs / progress
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=ENABLE_UPX,
    upx_exclude=UPX_EXCLUDES,
    name="stt-server",  # → dist/stt-server/
)
