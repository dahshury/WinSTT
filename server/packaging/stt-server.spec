# PyInstaller spec for the WinSTT STT server.
#
# Single spec, two flavors. The build flavor is determined by which extra
# was installed in the venv (``uv sync --extra cpu`` vs ``--extra gpu``).
# We sniff the venv at spec-evaluation time:
#
#   - ``nvidia`` namespace package present → GPU build → bundle every
#     ``nvidia/*/bin/*.dll`` so onnxruntime-gpu's CUDA EP works offline.
#     Total artifact ~2 GB.
#   - ``nvidia`` absent → CPU build → only onnxruntime CPU DLLs.
#     Total artifact ~150–200 MB.
#
# Build command (from server/):
#   uv run pyinstaller build/stt-server.spec --clean --noconfirm --distpath dist
#
# Output: dist/stt-server/  (onedir layout — Electron spawns the exe in-place
# via ``process.resourcesPath/stt-server/stt-server.exe``; onefile would
# extract to %TEMP% on every start which is unacceptable for a 2 GB GPU
# bundle).

# ruff: noqa  — PyInstaller specs run under its own interpreter context
# pylint: disable=undefined-variable  — Analysis/EXE/COLLECT are spec globals

import importlib.util
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
    upx=False,
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
    upx=False,
    upx_exclude=[],
    name="stt-server",  # → dist/stt-server/
)
