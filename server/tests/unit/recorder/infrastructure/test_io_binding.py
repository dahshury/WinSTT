"""Wrapper-level tests for :mod:`src.recorder.infrastructure.io_binding`.

The IO-binding adapter is provider-agnostic — these tests construct it
against a real ORT ``InferenceSession`` built from a trivial in-memory
model so we exercise the full path without depending on onnx-asr / HF
downloads / GPU hardware. The model is an Identity op (``y = x``)
which keeps the test small and deterministic.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
import pytest

if TYPE_CHECKING:
    from numpy.typing import NDArray

from src.recorder.infrastructure.io_binding import IoBindingAdapter


def _build_identity_session() -> object:
    """Construct an ORT InferenceSession over a trivial Identity model.

    The model has one fp32 input named ``x`` of shape ``(1, 4)`` and one
    fp32 output named ``y`` of the same shape. Built in-memory via the
    ``onnx`` helper API so no external file is required.
    """
    import onnx
    import onnxruntime as rt
    from onnx import TensorProto, helper

    input_tensor = helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 4])
    output_tensor = helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, 4])
    node = helper.make_node("Identity", inputs=["x"], outputs=["y"])
    graph = helper.make_graph([node], "identity", [input_tensor], [output_tensor])
    # IR v7 is widely compatible; opset 13 is far below the floor ORT
    # 1.24 supports. Keep the version pin so the test isn't fragile to
    # future onnx default-version bumps.
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], ir_version=7)
    onnx.checker.check_model(model)
    return rt.InferenceSession(model.SerializeToString(), providers=["CPUExecutionProvider"])


def test_io_binding_adapter_runs_identity_round_trip() -> None:
    """End-to-end: bind → run → recover the same array.

    The Identity op makes the output a bit-exact copy of the input, so
    we can assert array equality without floating-point tolerance.
    """
    session = _build_identity_session()
    sample: NDArray[np.float32] = np.arange(4, dtype=np.float32).reshape(1, 4)

    adapter = IoBindingAdapter(session, sample_inputs={"x": sample})
    out = adapter.run({"x": sample})

    assert "y" in out
    np.testing.assert_array_equal(out["y"], sample)


def test_io_binding_adapter_records_bound_shapes() -> None:
    session = _build_identity_session()
    sample = np.zeros((1, 4), dtype=np.float32)
    adapter = IoBindingAdapter(session, sample_inputs={"x": sample})
    # bound_shapes mirrors the constructor input — exposed for
    # diagnostics + the shape_compatible() fast path.
    assert adapter.bound_shapes == {"x": (1, 4)}


def test_io_binding_adapter_shape_compatible_accepts_matching_shape() -> None:
    session = _build_identity_session()
    sample = np.zeros((1, 4), dtype=np.float32)
    adapter = IoBindingAdapter(session, sample_inputs={"x": sample})

    matching = np.ones((1, 4), dtype=np.float32)
    assert adapter.shape_compatible({"x": matching}) is True


def test_io_binding_adapter_shape_compatible_rejects_different_shape() -> None:
    """Variable-length inputs (e.g. growing decoder ``input_ids``) must
    flunk the check so the caller falls back to plain ``session.run``."""
    session = _build_identity_session()
    sample = np.zeros((1, 4), dtype=np.float32)
    adapter = IoBindingAdapter(session, sample_inputs={"x": sample})

    different = np.zeros((1, 8), dtype=np.float32)
    assert adapter.shape_compatible({"x": different}) is False


def test_io_binding_adapter_run_raises_on_shape_mismatch() -> None:
    """``run`` is the strict path — it MUST raise on shape drift so
    callers don't silently get garbage output."""
    session = _build_identity_session()
    sample = np.zeros((1, 4), dtype=np.float32)
    adapter = IoBindingAdapter(session, sample_inputs={"x": sample})

    different = np.zeros((1, 8), dtype=np.float32)
    with pytest.raises(IoBindingAdapter.ShapeError):
        adapter.run({"x": different})


def test_io_binding_adapter_run_raises_on_unknown_input() -> None:
    session = _build_identity_session()
    sample = np.zeros((1, 4), dtype=np.float32)
    adapter = IoBindingAdapter(session, sample_inputs={"x": sample})

    with pytest.raises(IoBindingAdapter.ShapeError):
        adapter.run({"x_typo": sample})


def test_io_binding_adapter_rejects_unknown_input_at_construction() -> None:
    """Constructor must surface unknown inputs immediately so a typo
    doesn't survive until the first ``run`` call."""
    session = _build_identity_session()
    bogus = np.zeros((1, 4), dtype=np.float32)
    with pytest.raises(ValueError, match="Unknown input"):
        IoBindingAdapter(session, sample_inputs={"not_x": bogus})


def test_io_binding_adapter_device_is_cpu_for_cpu_session() -> None:
    """CPU session → CPU buffers. Other EPs (CUDA / DML) are exercised
    in integration tests where the hardware is actually present."""
    session = _build_identity_session()
    sample = np.zeros((1, 4), dtype=np.float32)
    adapter = IoBindingAdapter(session, sample_inputs={"x": sample})
    assert adapter.device == ("cpu", 0)


def test_io_binding_adapter_run_is_repeatable() -> None:
    """The whole point: same buffers, multiple calls. No realloc."""
    session = _build_identity_session()
    sample = np.zeros((1, 4), dtype=np.float32)
    adapter = IoBindingAdapter(session, sample_inputs={"x": sample})

    # Run several different inputs with the same shape — each call
    # must return its own data, proving update_inplace works.
    for i in range(3):
        new_input: NDArray[np.float32] = np.full((1, 4), float(i), dtype=np.float32)
        out = adapter.run({"x": new_input})
        np.testing.assert_array_equal(out["y"], new_input)
