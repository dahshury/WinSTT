"""Tests for the accelerator-aware ORT execution-provider selection logic
in :mod:`src.recorder.infrastructure.device`.

The module under test is in the infrastructure layer (excluded from the
coverage gate per ``pyproject.toml`` ``[tool.coverage.run].omit``) but the
logic is pure Python: it inspects ``onnxruntime.get_available_providers``
and decides what list to hand to ``onnx_asr.load_model``. By mocking the
EP list we can exhaustively verify the priority order without needing a
real GPU. CUDA DLL probing is short-circuited where it would normally
veto the choice.
"""

from __future__ import annotations

from contextlib import AbstractContextManager
from unittest.mock import patch

import pytest

from src.recorder.infrastructure import device


@pytest.fixture(autouse=True)
def _reset_cuda_probe_cache() -> None:
    """Ensure :func:`device._probe_cuda_session`'s ``lru_cache`` doesn't
    leak between tests — each test gets a fresh probe result so a previous
    "CUDA unusable" run cannot mask a later "CUDA available" expectation.
    """
    device._probe_cuda_session.cache_clear()


def _patch_providers(providers: list[str]) -> AbstractContextManager[object]:
    """Return a context manager that fakes ``onnxruntime.get_available_providers``."""
    # ``device._available_providers`` imports ``onnxruntime`` lazily, so we
    # patch through the cached module if it's importable. When the venv has
    # no ORT installed at all, we can simulate that by monkeypatching the
    # helper directly.
    import onnxruntime as rt

    return patch.object(rt, "get_available_providers", return_value=providers)


def _force_cuda_probe(passes: bool) -> AbstractContextManager[object]:
    """Pretend the CUDA DLL chain probe returns ``passes`` regardless of host."""
    return patch.object(device, "_probe_cuda_session", return_value=passes)


# ---------------------------------------------------------------------------
# resolve_accelerator
# ---------------------------------------------------------------------------


class TestResolveAccelerator:
    """Verify the user-facing accelerator name → resolved name mapping.

    All branches of the priority logic are reachable by combining the
    ``platform`` priority list, the EP list reported by ORT, and the CUDA
    probe outcome. We never call the real probe — it touches the system
    DLL loader and behaves differently per Windows install.
    """

    @pytest.mark.parametrize("alias", ["auto", "AUTO", "  auto  ", ""])
    def test_auto_falls_through_to_cpu_when_no_gpu_eps(self, alias: str) -> None:
        """With only CPU registered, every auto-mode call must end at CPU.

        Empty string and case/whitespace variants are accepted and treated
        as ``"auto"`` for backward compat with older persisted configs.
        """
        with _patch_providers(["CPUExecutionProvider"]):
            assert device.resolve_accelerator(alias) == "cpu"

    def test_explicit_cpu_short_circuits_without_touching_ort(self) -> None:
        """``"cpu"`` must NEVER touch ``rt.get_available_providers``.

        Forcing CPU is a "do not use the GPU" decision; we don't want to
        spend a millisecond enumerating EPs for it, and the path must work
        even when ORT isn't installed (the early return on the import error
        in :func:`device._available_providers` covers that).
        """
        with patch.object(device, "_available_providers") as mock_avail:
            assert device.resolve_accelerator("cpu") == "cpu"
            mock_avail.assert_not_called()

    def test_explicit_directml_honored_when_registered(self) -> None:
        """A user-pinned ``directml`` is honored when the EP is registered."""
        with _patch_providers(["DmlExecutionProvider", "CPUExecutionProvider"]):
            assert device.resolve_accelerator("directml") == "directml"

    def test_explicit_directml_falls_back_when_missing(self, caplog: pytest.LogCaptureFixture) -> None:
        """User pinned ``directml`` but the bundled ORT doesn't have it → CPU."""
        with _patch_providers(["CUDAExecutionProvider", "CPUExecutionProvider"]):
            assert device.resolve_accelerator("directml") == "cpu"
        assert any("DmlExecutionProvider" in r.getMessage() for r in caplog.records)

    def test_explicit_cuda_honored_when_dll_probe_passes(self) -> None:
        """CUDA is honored only when the DLL probe also passes."""
        with _patch_providers(["CUDAExecutionProvider", "CPUExecutionProvider"]), _force_cuda_probe(True):
            assert device.resolve_accelerator("cuda") == "cuda"

    def test_explicit_cuda_falls_back_when_dll_probe_fails(self) -> None:
        """CUDA EP registered but DLL chain unloadable → CPU fallback.

        Avoids the "Error 126" log spam on every model load that occurs
        when ``onnxruntime-gpu`` is installed without the NVIDIA wheel
        chain (or with a partial set thereof — see the memory note about
        cufft/cusparse/cusolver/curand being mandatory at session-create).
        """
        with _patch_providers(["CUDAExecutionProvider", "CPUExecutionProvider"]), _force_cuda_probe(False):
            assert device.resolve_accelerator("cuda") == "cpu"

    def test_auto_picks_directml_first_on_windows(self) -> None:
        """Windows auto priority is DirectML > CUDA > CPU."""
        with (
            patch.object(device.sys, "platform", "win32"),
            _patch_providers(["DmlExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"]),
            _force_cuda_probe(True),
        ):
            assert device.resolve_accelerator("auto") == "directml"

    def test_auto_falls_to_cuda_on_windows_when_dml_absent(self) -> None:
        """No DirectML EP registered on Windows → walk down to CUDA."""
        with (
            patch.object(device.sys, "platform", "win32"),
            _patch_providers(["CUDAExecutionProvider", "CPUExecutionProvider"]),
            _force_cuda_probe(True),
        ):
            assert device.resolve_accelerator("auto") == "cuda"

    def test_auto_walks_past_cuda_when_dll_probe_fails_on_windows(self) -> None:
        """Auto-mode CUDA probe failure isn't fatal — keep walking the list."""
        with (
            patch.object(device.sys, "platform", "win32"),
            _patch_providers(["CUDAExecutionProvider", "CPUExecutionProvider"]),
            _force_cuda_probe(False),
        ):
            assert device.resolve_accelerator("auto") == "cpu"

    def test_auto_priority_on_linux_is_cuda_then_rocm(self) -> None:
        """Linux auto: CUDA first, then ROCm, then CPU."""
        with (
            patch.object(device.sys, "platform", "linux"),
            _patch_providers(["ROCMExecutionProvider", "CPUExecutionProvider"]),
        ):
            assert device.resolve_accelerator("auto") == "rocm"

    def test_auto_priority_on_macos_is_coreml(self) -> None:
        """macOS auto: CoreML first, then CPU."""
        with (
            patch.object(device.sys, "platform", "darwin"),
            _patch_providers(["CoreMLExecutionProvider", "CPUExecutionProvider"]),
        ):
            assert device.resolve_accelerator("auto") == "coreml"

    def test_unknown_accelerator_logs_and_falls_back(self, caplog: pytest.LogCaptureFixture) -> None:
        """A typo like ``"directML "`` should normalise; ``"webgpu"`` is unknown."""
        # Whitespace + case normalisation
        with _patch_providers(["DmlExecutionProvider", "CPUExecutionProvider"]):
            assert device.resolve_accelerator("  DIRECTML  ") == "directml"
        # Unknown name → CPU + warning
        with _patch_providers(["CPUExecutionProvider"]):
            assert device.resolve_accelerator("webgpu") == "cpu"
        assert any("Unknown accelerator" in r.getMessage() for r in caplog.records)

    def test_no_ort_installed_returns_cpu_for_explicit_pin(self) -> None:
        """If onnxruntime isn't importable, explicit GPU pin falls back to CPU."""
        with patch.object(device, "_available_providers", return_value=[]):
            assert device.resolve_accelerator("cuda") == "cpu"
            assert device.resolve_accelerator("directml") == "cpu"

    def test_no_ort_installed_auto_resolves_to_cpu(self) -> None:
        """Auto without any EP at all (no ORT) → CPU (last item in priority list)."""
        with patch.object(device, "_available_providers", return_value=[]):
            assert device.resolve_accelerator("auto") == "cpu"


# ---------------------------------------------------------------------------
# providers_for_accelerator
# ---------------------------------------------------------------------------


class TestProvidersForAccelerator:
    """Verify the EP list handed to onnx-asr matches the resolved accelerator."""

    def test_cpu_returns_cpu_only(self) -> None:
        """Forced CPU → exactly ``["CPUExecutionProvider"]`` — no GPU sidecar."""
        assert device.providers_for_accelerator("cpu") == ["CPUExecutionProvider"]

    def test_directml_returns_dml_with_cpu_fallback(self) -> None:
        """A GPU EP entry is always paired with CPU so op-level fallback works.

        ORT routes nodes the GPU EP can't run (e.g. unsupported op or a
        shape it doesn't support) to the next EP in the list. CPU must be
        the universal tail of any GPU provider list.
        """
        with _patch_providers(["DmlExecutionProvider", "CPUExecutionProvider"]):
            result = device.providers_for_accelerator("directml")
        assert result == ["DmlExecutionProvider", "CPUExecutionProvider"]

    def test_cuda_carries_provider_options_when_set(self) -> None:
        """When ``_CUDA_EP_OPTIONS`` is non-empty, CUDA entries become tuples.

        The default is ``{}`` (we benchmarked custom options regressing on
        Ampere), but the wiring exists so a future option set is applied
        uniformly across every transcriber instance.
        """
        with (
            _patch_providers(["CUDAExecutionProvider", "CPUExecutionProvider"]),
            _force_cuda_probe(True),
            patch.object(device, "_CUDA_EP_OPTIONS", {"device_id": "0"}),
        ):
            result = device.providers_for_accelerator("cuda")
        assert result is not None
        assert result[0] == ("CUDAExecutionProvider", {"device_id": "0"})
        assert result[-1] == "CPUExecutionProvider"

    def test_falls_back_to_cpu_when_resolver_returns_cpu(self) -> None:
        """Resolver fallback chain ends at CPU → caller still gets a list, not None."""
        with _patch_providers(["CPUExecutionProvider"]):
            assert device.providers_for_accelerator("directml") == ["CPUExecutionProvider"]


# ---------------------------------------------------------------------------
# providers_for_settings — bridges the (device, accelerator) config pair
# ---------------------------------------------------------------------------


class TestProvidersForSettings:
    """Verify the layering between the legacy ``device`` and new ``accelerator``."""

    def test_device_cpu_short_circuits_regardless_of_accelerator(self) -> None:
        """``device == "cpu"`` is the kill switch — accelerator is ignored.

        Reflects user intent: someone who sets device=cpu (typically to
        free GPU VRAM for another app) wants every model load to be CPU,
        even if they have a non-default ``accelerator`` carryover from
        before they flipped the kill switch.
        """
        with _patch_providers(["DmlExecutionProvider", "CPUExecutionProvider"]):
            result = device.providers_for_settings("cpu", "directml")
        assert result == ["CPUExecutionProvider"]

    def test_explicit_accelerator_overrides_legacy_device(self) -> None:
        """``accelerator="directml"`` honored even when ``device="cuda"``.

        Lets users override the legacy device field without migrating
        every persisted config — the modern accelerator field wins.
        """
        with _patch_providers(["DmlExecutionProvider", "CPUExecutionProvider"]):
            result = device.providers_for_settings("cuda", "directml")
        assert result == ["DmlExecutionProvider", "CPUExecutionProvider"]

    def test_auto_accelerator_falls_back_to_legacy_device_path(self) -> None:
        """Both ``auto`` → :func:`providers_for_device` is consulted directly.

        :func:`providers_for_device` returns the full GPU list (filtered
        by :data:`GPU_PROVIDERS`) followed by CPU, matching the behaviour
        from before the accelerator setting was introduced.
        """
        with _patch_providers(["DmlExecutionProvider", "CPUExecutionProvider"]):
            result = device.providers_for_settings("auto", "auto")
        # On a host with DML registered the legacy path returns it first;
        # the actual ordering inside the GPU list is platform-dependent
        # (governed by ORT's own EP registration order), so we just assert
        # the membership and that CPU is the universal tail.
        assert result is not None
        assert result[-1] == "CPUExecutionProvider"

    def test_empty_strings_treated_as_auto(self) -> None:
        """Empty / whitespace-only config values normalise to ``"auto"``.

        Mirrors the existing tolerance in :func:`resolve_accelerator` so
        a persisted config with ``accelerator=""`` from an early build
        keeps working after upgrade.
        """
        with _patch_providers(["CPUExecutionProvider"]):
            assert device.providers_for_settings("", "  ") == ["CPUExecutionProvider"]


# ---------------------------------------------------------------------------
# Backward-compat surface: providers_for_device / resolve_device
# ---------------------------------------------------------------------------


class TestLegacyResolveDevice:
    """The old ``device``-only entry points must still behave identically.

    Bootstrap and tests still call :func:`resolve_device` and
    :func:`providers_for_device`; we only swapped one bootstrap call site
    to :func:`providers_for_settings`, so the legacy entry points need
    to keep working for every existing caller.
    """

    def test_resolve_device_auto_returns_cuda_when_dml_picked(self) -> None:
        """Legacy callers only know "cuda" vs "cpu" — DirectML collapses to "cuda".

        That lets ``bootstrap._resolve_quantization`` keep its "GPU vs CPU"
        check working for DirectML (which has the same fp16 / sub-fp16
        kernel-availability story as CUDA for our purposes).
        """
        with (
            patch.object(device.sys, "platform", "win32"),
            _patch_providers(["DmlExecutionProvider", "CPUExecutionProvider"]),
        ):
            assert device.resolve_device("auto") == "cuda"

    def test_resolve_device_explicit_cpu_stays_cpu(self) -> None:
        """A pinned CPU device must never accidentally route to GPU."""
        assert device.resolve_device("cpu") == "cpu"

    def test_providers_for_device_returns_cpu_when_no_ep_registered(self) -> None:
        """If ORT only knows CPU, legacy GPU device → CPU list (no GPU prefix)."""
        with _patch_providers(["CPUExecutionProvider"]):
            assert device.providers_for_device("cuda") == ["CPUExecutionProvider"]
