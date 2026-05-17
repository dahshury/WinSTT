"""Tests for the in-cache Whisper fp16 decoder repair.

Lives under ``tests/integration/`` because it touches the ``onnx`` package
and writes files — pure-domain unit tests don't touch I/O. Coverage of
this module is exempted (it lives under ``recorder/infrastructure/``)
but the tests run end-to-end so we don't regress the repair logic.
"""

from __future__ import annotations

from pathlib import Path

import pytest

onnx = pytest.importorskip("onnx")
from onnx import TensorProto, helper  # noqa: E402 — gated by importorskip above

from src.recorder.infrastructure.onnx_patch import (  # noqa: E402 — onnx-dependent module
    patch_whisper_decoder,
    should_skip_patch,
)


def _build_broken_decoder(tmp_path: Path) -> Path:
    """Synthesize a minimal Whisper-style merged decoder with both upstream bugs.

    Outer graph: ``If(bool) → [graph_output_cast_0] → Cast → logits``.
    Both subgraph branches compute a real internal value
    (``graph_output_cast_0``) but DECLARE their subgraph output as
    ``logits`` with elem_type ``float`` (fp32) — the two metadata bugs
    that bite onnx-community/whisper-tiny.en/decoder_model_merged_fp16.onnx.
    The parent If's value_info marks the output as ``float16``.
    """

    # Subgraph constant: an fp16 zero tensor surfaced as graph_output_cast_0.
    def _branch(value: float) -> onnx.GraphProto:
        const = helper.make_tensor("c0", TensorProto.FLOAT16, [1], [value])
        const_node = helper.make_node("Constant", inputs=[], outputs=["graph_output_cast_0"], value=const)
        # BUG: declare subgraph output as 'logits' (outer-scope name) with fp32 dtype.
        bad_output = helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1])
        return helper.make_graph([const_node], "branch", inputs=[], outputs=[bad_output])

    cond_input = helper.make_tensor_value_info("cond", TensorProto.BOOL, [1])
    if_node = helper.make_node(
        "If",
        inputs=["cond"],
        outputs=["graph_output_cast_0"],
        then_branch=_branch(1.0),
        else_branch=_branch(0.0),
    )
    cast = helper.make_node("Cast", inputs=["graph_output_cast_0"], outputs=["logits"], to=TensorProto.FLOAT)
    final_output = helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1])
    # Annotate the intermediate so the patch sees fp16 as the parent If's expected dtype.
    if_out_vi = helper.make_tensor_value_info("graph_output_cast_0", TensorProto.FLOAT16, [1])
    graph = helper.make_graph(
        [if_node, cast],
        "decoder_model_merged_fp16",
        inputs=[cond_input],
        outputs=[final_output],
        value_info=[if_out_vi],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 14)])

    path = tmp_path / "decoder_model_merged_fp16.onnx"
    onnx.save(model, str(path))
    return path


class TestPatchWhisperDecoder:
    def test_fixes_subgraph_output_names_and_dtypes(self, tmp_path: Path) -> None:
        path = _build_broken_decoder(tmp_path)

        edits = patch_whisper_decoder(path)

        # 2 edits per branch (name + dtype) x 2 branches = 4 metadata fixes.
        assert edits == 4

        # Reload and confirm the structural fixes landed.
        fixed = onnx.load(str(path))
        if_node = next(n for n in fixed.graph.node if n.op_type == "If")
        for attr in if_node.attribute:
            if attr.type == onnx.AttributeProto.GRAPH:
                sg = attr.g
                assert [o.name for o in sg.output] == ["graph_output_cast_0"]
                assert sg.output[0].type.tensor_type.elem_type == TensorProto.FLOAT16

    def test_drops_sidecar_marker(self, tmp_path: Path) -> None:
        path = _build_broken_decoder(tmp_path)
        assert not should_skip_patch(path)
        patch_whisper_decoder(path)
        assert should_skip_patch(path)

    def test_is_idempotent(self, tmp_path: Path) -> None:
        """Second call must be a no-op even if the marker is removed (idempotency
        of the structural fix itself, not just the marker shortcut)."""
        path = _build_broken_decoder(tmp_path)
        patch_whisper_decoder(path)
        marker = path.parent / f"{path.name}.winstt_patched_v1"
        marker.unlink()
        assert patch_whisper_decoder(path) == 0  # structural fix already in place

    def test_marker_short_circuits_reload(self, tmp_path: Path) -> None:
        """When the marker exists, the patch path returns 0 without parsing the file."""
        path = _build_broken_decoder(tmp_path)
        (path.parent / f"{path.name}.winstt_patched_v1").touch()

        # Corrupt the file — the function must not even try to parse it.
        path.write_bytes(b"not actually onnx")

        assert patch_whisper_decoder(path) == 0
