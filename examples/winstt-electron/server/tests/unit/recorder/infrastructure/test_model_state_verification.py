"""The picker's cache verdict must match what an actual swap downloads — for
EVERY family, not just the int8-preferred ones.

The fast ``*.onnx`` glob heuristic only sees weight files; it can't tell that a
load also needs ``vocab.txt`` / ``tokens.txt`` / ``config.json`` / a second
decoder graph / a ``.onnx_data`` sidecar. If any of those is missing the badge
would paint "Downloaded" and the swap would silently fetch the rest. These
tests lock in the authoritative cross-check: any heuristic ``cached`` is
verified against the loader's own resolver and demoted to ``partial`` when a
load would still download.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src.recorder.domain.model_registry import ModelCatalog
from src.recorder.infrastructure import model_cache, model_state
from src.recorder.infrastructure.model_cache import (
    ModelCacheState,
    _file_quantization,
    _onnx_external_data_missing,
    onnx_asr_would_download,
    would_download_on_load,
)


def _model(model_id: str) -> object:
    model = ModelCatalog().get(model_id)
    assert model is not None, f"catalog must still ship {model_id}"
    return model


class TestVerifyQuantCache:
    def test_not_cached_is_returned_untouched_without_a_resolver_call(self, monkeypatch: pytest.MonkeyPatch) -> None:
        called = False

        def _boom(*_args: object, **_kwargs: object) -> bool | None:
            nonlocal called
            called = True
            return True

        monkeypatch.setattr(model_state, "would_download_on_load", _boom)
        state = ModelCacheState(state="not_cached")
        result = model_state._verify_quant_cache(_model("nemo-canary-1b-flash"), "int8", state)  # type: ignore[arg-type]
        assert result is state
        assert called is False, "not_cached must skip the authoritative check"

    def test_cached_is_demoted_to_partial_when_a_load_would_download(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(model_state, "would_download_on_load", lambda *a, **k: True)
        state = ModelCacheState(state="cached", downloaded_bytes=500, total_bytes=500)
        result = model_state._verify_quant_cache(_model("nemo-canary-1b-flash"), "int8", state)  # type: ignore[arg-type]
        assert result.state == "partial"
        assert result.downloaded_bytes == 500
        assert result.total_bytes > result.downloaded_bytes  # progress < 100%

    def test_cached_stays_cached_when_the_loader_confirms_all_files_present(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(model_state, "would_download_on_load", lambda *a, **k: False)
        state = ModelCacheState(state="cached", downloaded_bytes=500, total_bytes=500)
        result = model_state._verify_quant_cache(_model("nemo-canary-1b-flash"), "int8", state)  # type: ignore[arg-type]
        assert result is state

    def test_cached_stays_cached_when_verdict_is_undeterminable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(model_state, "would_download_on_load", lambda *a, **k: None)
        state = ModelCacheState(state="cached", downloaded_bytes=1, total_bytes=1)
        result = model_state._verify_quant_cache(_model("nemo-canary-1b-flash"), "int8", state)  # type: ignore[arg-type]
        assert result is state

    def test_partial_is_upgraded_to_cached_when_the_loader_confirms_all_files(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A repo-wide orphan ``.incomplete`` marker (an abandoned download of a
        # DIFFERENT precision) makes the heuristic report THIS precision partial
        # even though all its files are present. The resolver checks this
        # precision's files only — when it confirms a load downloads nothing the
        # false ``partial`` is cleared back to ``cached`` at 100%.
        monkeypatch.setattr(model_state, "would_download_on_load", lambda *a, **k: False)
        state = ModelCacheState(state="partial", downloaded_bytes=4_000_000, total_bytes=4_000_500)
        result = model_state._verify_quant_cache(_model("cohere-transcribe"), "fp16", state)  # type: ignore[arg-type]
        assert result.state == "cached"
        assert result.downloaded_bytes == 4_000_000
        assert result.total_bytes == result.downloaded_bytes  # 100% — no leftover marker bytes

    def test_partial_stays_partial_when_a_load_would_still_download(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # A GENUINELY incomplete (or actively-downloading) precision still has a
        # missing file → the resolver returns True → it must remain partial.
        monkeypatch.setattr(model_state, "would_download_on_load", lambda *a, **k: True)
        state = ModelCacheState(state="partial", downloaded_bytes=10, total_bytes=20)
        result = model_state._verify_quant_cache(_model("cohere-transcribe"), "fp16", state)  # type: ignore[arg-type]
        assert result is state

    def test_partial_stays_partial_when_verdict_is_undeterminable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(model_state, "would_download_on_load", lambda *a, **k: None)
        state = ModelCacheState(state="partial", downloaded_bytes=10, total_bytes=20)
        result = model_state._verify_quant_cache(_model("cohere-transcribe"), "fp16", state)  # type: ignore[arg-type]
        assert result is state


class TestWouldDownloadOnLoad:
    def test_custom_local_bundle_never_downloads(self) -> None:
        assert would_download_on_load("slug", local_path="C:/models/x", quantization="int8") is False

    def test_missing_model_name_is_undeterminable(self) -> None:
        assert would_download_on_load(None, local_path=None, quantization="") is None

    def test_every_family_uses_the_onnx_asr_resolver(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # SenseVoice included — it now has its own onnx-asr model class, so the
        # single resolver check covers it (no bespoke branch).
        monkeypatch.setattr(model_cache, "onnx_asr_would_download", lambda name, quant: True)
        assert would_download_on_load("istupakov/canary-1b-flash-onnx", local_path=None, quantization="q4") is True
        assert would_download_on_load("sense-voice-small", local_path=None, quantization="int8") is True


class TestOnnxAsrResolverProbe:
    def test_unpublished_quant_is_flagged_as_would_download(self) -> None:
        # canary publishes only ["", "int8"]; q4 weights never exist on disk, so
        # the offline resolver must report a load would fetch them.
        assert onnx_asr_would_download("istupakov/canary-1b-flash-onnx", "q4") is True

    def test_missing_onnx_asr_is_undeterminable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import builtins

        real_import = builtins.__import__

        def _no_onnx_asr(name: str, *args: object, **kwargs: object) -> object:
            if name == "onnx_asr.loader" or name.startswith("onnx_asr"):
                raise ImportError(name)
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", _no_onnx_asr)
        assert onnx_asr_would_download("istupakov/canary-1b-flash-onnx", "int8") is None


class TestFileQuantization:
    """Sharded external-data sidecars (``…onnx_data_<n>``) must be attributed to
    the SAME quant bucket as their graph — onnx-community splits >2 GB fp16
    weights across numbered shards, and mis-reading the second shard as the
    default precision silently split the fp16 file set in two (the per-quant
    "downloaded?" badge then went green on an incomplete download).
    """

    @pytest.mark.parametrize(
        ("filename", "expected"),
        [
            ("encoder_model_fp16.onnx", "fp16"),
            ("encoder_model_fp16.onnx_data", "fp16"),
            ("encoder_model_fp16.onnx_data_1", "fp16"),  # the regression: was ""
            ("encoder_model.onnx_data_3", ""),
            ("decoder_model_merged_q4f16.onnx_data", "q4f16"),
            ("encoder.int8.onnx.data", "int8"),  # istupakov "." separator
            ("encoder.int8.onnx.data_2", "int8"),
            ("model.onnx", ""),
        ],
    )
    def test_shard_index_does_not_break_quant_attribution(self, filename: str, expected: str) -> None:
        assert _file_quantization(Path(filename)) == expected


class TestOnnxExternalDataMissing:
    """A small ``.onnx`` graph can resolve while its multi-GB ``.onnx_data``
    sidecar is still missing — onnx-asr's resolver never names the sidecar, so
    only an explicit external-data check keeps the badge honest.
    """

    @staticmethod
    def _write_graph_with_external_data(directory: Path, location: str) -> Path:
        import onnx
        from onnx import TensorProto, helper

        weight = TensorProto()
        weight.name = "w"
        weight.data_type = TensorProto.FLOAT
        weight.dims.extend([4])
        weight.data_location = TensorProto.EXTERNAL
        loc = weight.external_data.add()
        loc.key, loc.value = "location", location
        length = weight.external_data.add()
        length.key, length.value = "length", "16"
        graph = helper.make_graph([], "g", [], [], initializer=[weight])
        model = helper.make_model(graph)
        path = directory / "encoder_model_fp16.onnx"
        onnx.save(model, str(path))
        return path

    def test_missing_sidecar_reports_would_download(self, tmp_path: Path) -> None:
        graph = self._write_graph_with_external_data(tmp_path, "encoder_model_fp16.onnx_data")
        # sidecar deliberately NOT created
        assert _onnx_external_data_missing(graph) is True

    def test_present_sidecar_is_complete(self, tmp_path: Path) -> None:
        graph = self._write_graph_with_external_data(tmp_path, "encoder_model_fp16.onnx_data")
        (tmp_path / "encoder_model_fp16.onnx_data").write_bytes(b"\x00" * 16)
        assert _onnx_external_data_missing(graph) is False

    def test_graph_without_external_data_is_complete(self, tmp_path: Path) -> None:
        import onnx
        from onnx import helper

        graph = helper.make_graph([], "g", [], [])
        path = tmp_path / "tiny.onnx"
        onnx.save(helper.make_model(graph), str(path))
        assert _onnx_external_data_missing(path) is False

    def test_unparseable_path_does_not_override_resolver(self, tmp_path: Path) -> None:
        bogus = tmp_path / "not_a_model.onnx"
        bogus.write_bytes(b"not an onnx graph")
        assert _onnx_external_data_missing(bogus) is False

    def test_oversized_graph_is_skipped_without_parsing(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """A graph larger than the size ceiling is treated as inline-weight and
        returns ``False`` without ``onnx.load`` — even when a sidecar it would
        reference is missing. This is the guard that stopped ``list_models_with_
        state`` parsing multi-GB inline graphs and starving the WS event loop.
        """
        graph = self._write_graph_with_external_data(tmp_path, "encoder_model_fp16.onnx_data")
        # sidecar deliberately missing — without the guard this is ``True``.
        monkeypatch.setattr(model_cache, "_EXTERNAL_DATA_GRAPH_MAX_BYTES", 1)

        def _fail_load(*_args: object, **_kwargs: object) -> object:
            raise AssertionError("onnx.load must not run for an oversized graph")

        import onnx

        monkeypatch.setattr(onnx, "load", _fail_load)
        assert _onnx_external_data_missing(graph) is False
