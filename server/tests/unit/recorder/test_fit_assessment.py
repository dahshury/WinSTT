"""Unit tests for fit_assessment — dictation + Ollama verdicts."""

from __future__ import annotations

import pytest

from src.recorder.domain.model_registry import ModelCatalog
from src.recorder.infrastructure.fit_assessment import (
    _BYTES_PER_PARAM_BY_QUANT,
    _DICTATION_OVERHEAD_BYTES,
    _OLLAMA_OVERHEAD_BYTES,
    _OLLAMA_SIZE_HEADROOM_FACTOR,
    _RAM_USABLE_FRACTION,
    WARNING_THRESHOLD,
    FitReason,
    FitSeverity,
    FitTarget,
    assess_dictation_fit,
    assess_ollama_fit,
    dictation_fit_dict,
    estimate_runtime_bytes,
    ollama_fit_dict,
    predicted_target,
)
from src.recorder.infrastructure.live_resources import LiveGpuInfo, LiveResources

GB = 1024**3


def _live(
    *,
    ram_total: int = 32 * GB,
    ram_available: int | None = None,
    gpus: tuple[LiveGpuInfo, ...] = (),
    cpu_logical: int = 8,
    cpu_physical: int = 4,
    cpu_pct: float = 5.0,
) -> LiveResources:
    return LiveResources(
        ram_total_bytes=ram_total,
        ram_available_bytes=ram_available if ram_available is not None else ram_total // 2,
        cpu_count_logical=cpu_logical,
        cpu_count_physical=cpu_physical,
        cpu_percent=cpu_pct,
        gpus=gpus,
    )


def _gpu(*, total: int = 24 * GB, free: int | None = None) -> LiveGpuInfo:
    return LiveGpuInfo(
        name="NVIDIA Test GPU",
        total_vram_bytes=total,
        used_vram_bytes=0 if free is None else total - free,
        free_vram_bytes=total if free is None else free,
        utilization_percent=0,
    )


@pytest.fixture()
def catalog() -> ModelCatalog:
    return ModelCatalog()


# ─── estimate_runtime_bytes ─────────────────────────────────────────────


class TestEstimateRuntimeBytes:
    def test_zero_when_param_count_missing(self, catalog: ModelCatalog) -> None:
        """A model with param_count=0 yields 0 (unknown footprint)."""
        from src.recorder.domain.model_registry import ModelInfo, TranscriberBackend

        unknown = ModelInfo(
            id="unknown",
            display_name="Unknown",
            backend=TranscriberBackend.ONNX_ASR,
            family="whisper",
        )
        assert estimate_runtime_bytes(unknown) == 0

    def test_fp32_default(self, catalog: ModelCatalog) -> None:
        tiny = catalog.get("tiny")
        assert tiny is not None
        # 37.8M params x 4 = ~151 MB + 500 MB overhead
        bytes_ = estimate_runtime_bytes(tiny, "")
        assert bytes_ == int(tiny.param_count * 4.0) + _DICTATION_OVERHEAD_BYTES

    def test_fp16_halves_weight_cost(self, catalog: ModelCatalog) -> None:
        tiny = catalog.get("tiny")
        assert tiny is not None
        fp32 = estimate_runtime_bytes(tiny, "")
        fp16 = estimate_runtime_bytes(tiny, "fp16")
        # fp16 weights are half; overhead is the same constant
        assert fp16 < fp32
        assert fp16 == int(tiny.param_count * 2.0) + _DICTATION_OVERHEAD_BYTES

    def test_unknown_quant_defaults_to_fp32(self, catalog: ModelCatalog) -> None:
        tiny = catalog.get("tiny")
        assert tiny is not None
        unknown_quant = estimate_runtime_bytes(tiny, "made-up-quant")
        assert unknown_quant == int(tiny.param_count * 4.0) + _DICTATION_OVERHEAD_BYTES


# ─── predicted_target ───────────────────────────────────────────────────


class TestPredictedTarget:
    def test_neither_when_no_resources(self) -> None:
        empty = _live(ram_total=0, ram_available=0)
        assert predicted_target("", requested_device=None, live=empty) == FitTarget.NEITHER

    def test_cpu_when_user_picks_cpu(self) -> None:
        live = _live(gpus=(_gpu(),))
        assert predicted_target("", requested_device="cpu", live=live) == FitTarget.CPU

    def test_cpu_when_no_gpu(self) -> None:
        live = _live()
        assert predicted_target("", requested_device=None, live=live) == FitTarget.CPU

    def test_cpu_when_quant_not_cuda_compatible(self) -> None:
        live = _live(gpus=(_gpu(),))
        # int8 falls back to CPU even on a GPU host
        assert predicted_target("int8", requested_device=None, live=live) == FitTarget.CPU
        assert predicted_target("q4", requested_device=None, live=live) == FitTarget.CPU

    def test_gpu_when_compatible(self) -> None:
        live = _live(gpus=(_gpu(),))
        assert predicted_target("", requested_device=None, live=live) == FitTarget.GPU
        assert predicted_target("fp16", requested_device=None, live=live) == FitTarget.GPU


# ─── assess_dictation_fit ───────────────────────────────────────────────


class TestAssessDictationFit:
    def test_unknown_model_critical(self) -> None:
        live = _live()
        a = assess_dictation_fit("not-a-real-model", live=live)
        assert a.severity == FitSeverity.CRITICAL
        assert a.target == FitTarget.NEITHER
        assert FitReason.UNKNOWN_FOOTPRINT in a.reasons

    def test_fits_comfortably_on_gpu(self, catalog: ModelCatalog) -> None:
        live = _live(gpus=(_gpu(total=24 * GB, free=24 * GB),))
        a = assess_dictation_fit("tiny", catalog=catalog, live=live)
        assert a.target == FitTarget.GPU
        assert a.severity == FitSeverity.OK
        assert FitReason.OK in a.reasons

    def test_warning_when_tight_on_gpu(self, catalog: ModelCatalog) -> None:
        # Pick a model whose footprint sits in the WARNING band on a tight GPU
        large = catalog.get("large-v3")
        assert large is not None
        required = estimate_runtime_bytes(large, "")
        # Available is just above required but below the WARNING threshold
        available = int(required / WARNING_THRESHOLD) - 1
        live = _live(gpus=(_gpu(total=available, free=available),))
        a = assess_dictation_fit("large-v3", catalog=catalog, live=live)
        assert a.target == FitTarget.GPU
        assert a.severity == FitSeverity.WARNING
        assert FitReason.TIGHT_VRAM in a.reasons

    def test_critical_when_exceeds_vram(self, catalog: ModelCatalog) -> None:
        large = catalog.get("large-v3")
        assert large is not None
        # Tiny GPU
        live = _live(gpus=(_gpu(total=1 * GB, free=1 * GB),))
        a = assess_dictation_fit("large-v3", catalog=catalog, live=live)
        assert a.severity == FitSeverity.CRITICAL
        assert FitReason.EXCEEDS_VRAM in a.reasons

    def test_critical_when_exceeds_ram_on_cpu(self, catalog: ModelCatalog) -> None:
        large = catalog.get("large-v3")
        assert large is not None
        # No GPU, only 2 GB RAM
        live = _live(ram_total=2 * GB, ram_available=2 * GB)
        a = assess_dictation_fit("large-v3", catalog=catalog, live=live)
        assert a.target == FitTarget.CPU
        assert a.severity == FitSeverity.CRITICAL
        assert FitReason.EXCEEDS_RAM in a.reasons

    def test_no_gpu_available_reason_when_no_gpu(self, catalog: ModelCatalog) -> None:
        live = _live(ram_total=64 * GB, ram_available=64 * GB)  # plenty of RAM
        a = assess_dictation_fit("tiny", catalog=catalog, live=live, requested_device=None)
        assert a.target == FitTarget.CPU
        # User didn't ask for CPU explicitly; we should note we're falling back
        assert FitReason.NO_GPU_AVAILABLE in a.reasons

    def test_requires_cpu_quant_reason_on_gpu_host(self, catalog: ModelCatalog) -> None:
        live = _live(gpus=(_gpu(total=24 * GB, free=24 * GB),))
        a = assess_dictation_fit("tiny", catalog=catalog, candidate_quant="int8", live=live)
        assert a.target == FitTarget.CPU  # Quant routes us to CPU
        assert FitReason.REQUIRES_CPU_QUANT in a.reasons

    def test_subtracts_loaded_other_on_cpu(self, catalog: ModelCatalog) -> None:
        small = catalog.get("small")
        assert small is not None
        # Budget = min(available, total*0.7). Set up so subtracting another
        # loaded model pushes us from OK → WARNING.
        small_bytes = estimate_runtime_bytes(small, "")
        ram = 8 * GB
        # We want available_after = small_bytes / 0.8 - 1 (just above warning line)
        # so before subtracting "other_loaded", budget is exactly
        # small_bytes/0.8 - 1 + other_loaded.
        # Let other_loaded = small_bytes // 2.
        other_loaded_estimate = estimate_runtime_bytes(catalog.get("base"), "")  # type: ignore[arg-type]
        target_budget = int(small_bytes / WARNING_THRESHOLD) - 1
        ram_avail_needed = target_budget + other_loaded_estimate
        # Use a system with enough total RAM; live_available is what matters
        live = _live(ram_total=ram * 2, ram_available=ram_avail_needed)
        a = assess_dictation_fit(
            "small",
            catalog=catalog,
            live=live,
            loaded_realtime="base",
            loaded_realtime_quant="",
        )
        assert a.target == FitTarget.CPU
        assert FitReason.STT_ALREADY_USES_RAM in a.reasons

    def test_excludes_outgoing_main_when_swapping(self, catalog: ModelCatalog) -> None:
        """When replacing the same main slot, don't double-count it."""
        live = _live(ram_total=4 * GB, ram_available=4 * GB)
        # Replacing main "tiny" with "tiny" — exclude_id matches loaded_main
        a = assess_dictation_fit(
            "tiny",
            catalog=catalog,
            live=live,
            loaded_main="tiny",
            loaded_main_quant="",
        )
        # No STT_ALREADY_USES_RAM since the "other loaded" is excluded
        assert FitReason.STT_ALREADY_USES_RAM not in a.reasons

    def test_unknown_footprint_returns_ok(self, catalog: ModelCatalog) -> None:
        """A model with no param count gets a benign OK + UNKNOWN_FOOTPRINT."""
        from src.recorder.domain.model_registry import ModelInfo, TranscriberBackend

        unknown = ModelInfo(
            id="ufp",
            display_name="UFP",
            backend=TranscriberBackend.ONNX_ASR,
            family="whisper",
        )

        class Stub:
            def get(self, _id: str) -> ModelInfo:
                return unknown

        a = assess_dictation_fit(
            "ufp",
            catalog=Stub(),  # type: ignore[arg-type]
            live=_live(),
        )
        assert a.severity == FitSeverity.OK
        assert FitReason.UNKNOWN_FOOTPRINT in a.reasons

    def test_falls_back_to_total_vram_when_free_unknown(self, catalog: ModelCatalog) -> None:
        """If free_vram is 0 (probe gave no live data) but total is reported,
        the assessment uses total as the budget."""
        live = _live(
            gpus=(
                LiveGpuInfo(
                    name="X",
                    total_vram_bytes=24 * GB,
                    used_vram_bytes=0,
                    free_vram_bytes=0,  # missing live signal
                    utilization_percent=-1,
                ),
            )
        )
        # tiny is tiny — would obviously fit on 24 GB but free_vram=0
        a = assess_dictation_fit("tiny", catalog=catalog, live=live)
        # available falls back to total (24 GB), so OK
        assert a.target == FitTarget.GPU


# ─── assess_ollama_fit ──────────────────────────────────────────────────


class TestAssessOllamaFit:
    def test_zero_size_returns_ok(self) -> None:
        a = assess_ollama_fit(0, live=_live())
        assert a.severity == FitSeverity.OK
        assert FitReason.UNKNOWN_FOOTPRINT in a.reasons

    def test_fits_on_gpu(self) -> None:
        live = _live(gpus=(_gpu(total=24 * GB, free=24 * GB),))
        # 1 GB GGUF → required = 1.2 GB + 1 GB = 2.2 GB
        a = assess_ollama_fit(1 * GB, live=live)
        assert a.target == FitTarget.GPU
        assert a.severity == FitSeverity.OK

    def test_critical_when_exceeds_vram(self) -> None:
        live = _live(gpus=(_gpu(total=4 * GB, free=4 * GB),))
        # 8 GB GGUF → required = ~10.6 GB > 4 GB
        a = assess_ollama_fit(8 * GB, live=live)
        assert a.severity == FitSeverity.CRITICAL
        assert FitReason.EXCEEDS_VRAM in a.reasons

    def test_no_gpu_falls_back_to_cpu(self) -> None:
        # No GPU, plenty of RAM
        live = _live(ram_total=64 * GB, ram_available=64 * GB)
        a = assess_ollama_fit(2 * GB, live=live)
        assert a.target == FitTarget.CPU
        assert a.severity == FitSeverity.OK

    def test_subtracts_loaded_dictation_from_cpu_budget(self, catalog: ModelCatalog) -> None:
        # No GPU, plenty of RAM, but a large dictation model is loaded
        live = _live(ram_total=16 * GB, ram_available=16 * GB)
        a = assess_ollama_fit(
            5 * GB,
            catalog=catalog,
            loaded_main="large-v3",
            loaded_main_quant="",
            live=live,
        )
        # large-v3 is 1.55B params x 4 bytes = ~6.2 GB + overhead
        # 16 GB x 0.7 = 11.2 GB budget; minus loaded ≈ 4.5 GB
        # Required (5 GB → 1.2*5+1 = 7 GB) likely exceeds available
        assert FitReason.STT_ALREADY_USES_RAM in a.reasons
        assert a.severity in (FitSeverity.WARNING, FitSeverity.CRITICAL)

    def test_warning_band_on_gpu(self) -> None:
        # Construct a GPU where required just exceeds WARNING_THRESHOLD * available
        size_bytes = 4 * GB
        required = int(size_bytes * _OLLAMA_SIZE_HEADROOM_FACTOR) + _OLLAMA_OVERHEAD_BYTES
        available = int(required / WARNING_THRESHOLD) - 10  # just barely warning band
        live = _live(gpus=(_gpu(total=available, free=available),))
        a = assess_ollama_fit(size_bytes, live=live)
        assert a.severity == FitSeverity.WARNING
        assert FitReason.TIGHT_VRAM in a.reasons

    def test_stt_uses_gpu_reason(self) -> None:
        catalog = ModelCatalog()
        live = _live(gpus=(_gpu(total=24 * GB, free=20 * GB),))
        a = assess_ollama_fit(
            1 * GB,
            catalog=catalog,
            loaded_main="tiny",
            live=live,
        )
        assert FitReason.STT_ALREADY_USES_GPU in a.reasons


# ─── Serialisation ──────────────────────────────────────────────────────


class TestSerialisation:
    def test_dictation_fit_dict_shape(self) -> None:
        live = _live()
        a = assess_dictation_fit("tiny", live=live)
        wire = dictation_fit_dict(a)
        assert wire["severity"] in {"ok", "warning", "critical"}
        assert wire["target"] in {"gpu", "cpu", "neither"}
        assert isinstance(wire["required_bytes"], int)
        assert isinstance(wire["available_bytes"], int)
        assert isinstance(wire["reasons"], list)
        for r in wire["reasons"]:
            assert isinstance(r, str)

    def test_ollama_fit_dict_shape(self) -> None:
        live = _live()
        a = assess_ollama_fit(1 * GB, live=live)
        wire = ollama_fit_dict(a)
        assert "severity" in wire
        assert "target" in wire
        assert "reasons" in wire


# ─── Constants sanity ────────────────────────────────────────────────────


class TestConstants:
    """Guard against accidental tuning regressions."""

    def test_warning_threshold_below_one(self) -> None:
        assert 0.0 < WARNING_THRESHOLD < 1.0

    def test_ram_usable_fraction_below_one(self) -> None:
        assert 0.0 < _RAM_USABLE_FRACTION < 1.0

    def test_bytes_per_param_table_covers_known_quants(self) -> None:
        for quant in ["", "fp16", "int8", "q4", "bnb4"]:
            assert quant in _BYTES_PER_PARAM_BY_QUANT
