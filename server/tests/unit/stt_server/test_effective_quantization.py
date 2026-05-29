"""The model-state payload must advertise the precision the server WILL load.

Regression for the canary-1b-flash bug: the picker showed a model as
"downloaded" (its default export was on disk) but a swap silently
re-downloaded the int8 weights, because the server auto-resolves the
int8-preferred families (NeMo / Cohere / GigaAM / …) to ``int8`` on
non-CUDA accelerators while the renderer was checking the raw ``""``
setting. The fix surfaces an ``effective_quantization`` per model so the
renderer can check the file set that actually loads.
"""

from __future__ import annotations

from src.recorder.domain.model_registry import ModelCatalog
from src.recorder.infrastructure.model_state import model_state_dict
from src.stt_server.control_handler import _build_models_with_state_payload, _effective_quant_for


def _canary_flash() -> object:
    catalog = ModelCatalog()
    model = catalog.get("nemo-canary-1b-flash")
    assert model is not None, "catalog must still ship nemo-canary-1b-flash"
    return model


class TestEffectiveQuantForModelState:
    def test_model_state_dict_surfaces_effective_quantization(self) -> None:
        model = _canary_flash()
        state = model_state_dict(model, effective_quantization="int8")  # type: ignore[arg-type]
        assert state["effective_quantization"] == "int8"

    def test_model_state_dict_defaults_effective_quantization_to_empty(self) -> None:
        model = _canary_flash()
        state = model_state_dict(model)  # type: ignore[arg-type]
        assert state["effective_quantization"] == ""

    def test_nemo_family_auto_resolves_to_int8_on_non_cuda(self) -> None:
        # auto/default ("") on a DirectML / CPU host must report int8 — the
        # precision the loader actually fetches for the NeMo family.
        model = _canary_flash()
        assert _effective_quant_for(model, onnx_quantization="", device="cpu", accelerator="directml") == "int8"

    def test_whisper_family_stays_default_on_auto(self) -> None:
        # Whisper publishes a working fp32 export across every EP, so auto on a
        # small model stays on the default precision ("") — the picker must not
        # claim a different effective precision for it.
        catalog = ModelCatalog()
        whisper = catalog.get("base")
        assert whisper is not None and whisper.family == "whisper"
        assert _effective_quant_for(whisper, onnx_quantization="", device="cpu", accelerator="cpu") == ""

    def test_concrete_pick_passes_through(self) -> None:
        model = _canary_flash()
        assert _effective_quant_for(model, onnx_quantization="int8", device="cpu", accelerator="cpu") == "int8"

    def test_payload_states_carry_effective_quantization_for_every_model(self) -> None:
        payload = _build_models_with_state_payload(device="cpu", accelerator="directml", onnx_quantization="")
        states = {s["id"]: s for s in payload["states"]}
        assert states, "payload must enumerate catalog models"
        for state in states.values():
            assert "effective_quantization" in state
        # The NeMo flash variant specifically must resolve to int8 here.
        assert states["nemo-canary-1b-flash"]["effective_quantization"] == "int8"
