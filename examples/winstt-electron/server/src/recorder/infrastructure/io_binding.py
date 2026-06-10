"""IO-binding adapter for ORT InferenceSession (Tier 2 optimization).

ONNX Runtime's ``InferenceSession.run`` allocates fresh input/output
``OrtValue`` tensors on every call. On RTX-4090-class GPUs that overhead
is measurable (~5-10 % per inference), and on CPU it's a non-trivial
allocator-pressure source on hot paths. ``run_with_iobinding`` lets
callers pre-allocate the tensors once and bind them by name across
runs, eliminating the per-call allocation.

This module ships the wrapper but **does not** wire it into the
onnx-asr hot path. Reason: onnx-asr fully owns session creation +
inference orchestration internally; intercepting its ``session.run``
calls requires patching the upstream library. Until that lands in our
``onnx-asr`` fork,
the adapter is a documented foundation for future work — the
``OnnxAsrTranscriber`` continues to use ``session.run()`` indirectly
via onnx-asr.

Architectural notes:

* **Provider-agnostic.** The adapter accepts any ORT
  ``InferenceSession`` and walks its ``get_inputs()`` / ``get_outputs()``
  to discover names and shapes. Provider is inferred from
  ``session.get_providers()`` so DirectML / CUDA / OpenVINO all work
  without explicit branches.

* **Static-shape only.** Variable-length audio (Whisper's encoder
  takes a 30 s mel spectrogram of fixed shape, but the decoder's
  ``input_ids`` grows by one token per autoregressive step) breaks
  static binding. The adapter exposes :meth:`shape_compatible` so
  callers can fall back to ``session.run()`` per-call when shapes
  drift — this is the safe path for the decoder, where the win is
  smaller anyway (the heavy compute is in the encoder).

* **No buffer reuse across sessions.** Each adapter owns its own
  preallocated tensors; sharing buffers between concurrent sessions
  would need synchronization we don't provide. One adapter per
  session, single-threaded use.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from numpy.typing import NDArray


logger = logging.getLogger(__name__)


class IoBindingAdapter:
    """Wrap an ORT ``InferenceSession`` to use ``run_with_iobinding``.

    Pre-allocates ``OrtValue`` tensors for every input/output named by
    the session metadata. On :meth:`run`, the caller supplies numpy
    arrays matching the input names; the adapter copies them into the
    pre-allocated input buffers and executes ``run_with_iobinding``,
    returning the output buffers as numpy arrays.

    The adapter targets steady-state inference on a fixed-shape model;
    if the caller's input shapes differ from the shapes seen at
    construction time, :meth:`run` raises ``ShapeError`` (so the caller
    knows to fall back to plain ``session.run``).
    """

    class ShapeError(ValueError):
        """Raised when the caller's input shape doesn't match the bound shape."""

    def __init__(
        self,
        session: Any,  # noqa: ANN401 — onnxruntime.InferenceSession
        sample_inputs: dict[str, NDArray[Any]],
    ) -> None:
        """Create binding tensors sized to ``sample_inputs``.

        Args:
            session: An already-created ``rt.InferenceSession``.
            sample_inputs: One representative input batch keyed by
                model input name. Used to seed the input tensor shapes
                and allocate the matching device buffers.
        """
        self._session = session
        self._device_name, self._device_id = self._resolve_device(session)
        self._input_meta = {meta.name: meta for meta in session.get_inputs()}
        self._output_meta = {meta.name: meta for meta in session.get_outputs()}
        self._bound_shapes: dict[str, tuple[int, ...]] = {}
        self._input_values: dict[str, Any] = {}
        self._output_values: dict[str, Any] = {}
        self._io_binding = session.io_binding()
        self._prime(sample_inputs)

    @staticmethod
    def _resolve_device(session: Any) -> tuple[str, int]:  # noqa: ANN401
        """Return the ``(device_name, device_id)`` tuple for ORT OrtValue allocations.

        ORT's OrtValue takes a device name string ("cpu" / "cuda" /
        "dml" / "openvino") and a device id (always 0 unless the host
        has multiple GPUs and the user pinned a specific one). We
        infer the device from the session's first provider; non-GPU
        providers always fall back to CPU buffers (ORT performs the
        cross-device copy automatically when binding).
        """
        providers = list(session.get_providers())
        if not providers:
            return "cpu", 0
        first = providers[0]
        if first == "CUDAExecutionProvider":
            return "cuda", 0
        if first == "DmlExecutionProvider":
            return "dml", 0
        if first == "OpenVINOExecutionProvider":
            # OpenVINO EP doesn't expose its own OrtValue device; use CPU
            # buffers and let the EP own the device copy. Same pattern as
            # the CoreML EP.
            return "cpu", 0
        return "cpu", 0

    def _prime(self, sample_inputs: dict[str, NDArray[Any]]) -> None:
        """Allocate input/output OrtValue tensors sized to ``sample_inputs``."""
        import numpy as np
        import onnxruntime as rt

        for name, arr in sample_inputs.items():
            if name not in self._input_meta:
                msg = f"Unknown input name {name!r} for session"
                raise ValueError(msg)
            ortval = rt.OrtValue.ortvalue_from_numpy(
                np.asarray(arr),
                self._device_name,
                self._device_id,
            )
            self._input_values[name] = ortval
            self._bound_shapes[name] = tuple(arr.shape)
            self._io_binding.bind_ortvalue_input(name, ortval)

        # Outputs are bound by name only — ORT allocates the buffer
        # on the configured device the first time the session runs
        # (the lazy-alloc path is fine for our use case; pre-alloc
        # requires knowing the output shape ahead of time which the
        # encoder/decoder don't always tell us via static metadata).
        for name in self._output_meta:
            self._io_binding.bind_output(name, self._device_name, self._device_id)

    def shape_compatible(self, inputs: dict[str, NDArray[Any]]) -> bool:
        """True iff every input's shape matches the bound shape.

        Callers should branch on this: ``True`` → use :meth:`run`;
        ``False`` → fall back to plain ``session.run`` (variable-length
        decode steps, beam-search rebinds, etc.).
        """
        for name, arr in inputs.items():
            bound = self._bound_shapes.get(name)
            if bound is None:
                return False
            if tuple(arr.shape) != bound:
                return False
        return True

    def run(self, inputs: dict[str, NDArray[Any]]) -> dict[str, NDArray[Any]]:
        """Copy ``inputs`` into the bound tensors and execute the session.

        Returns the bound outputs as numpy arrays keyed by output name.
        Raises :class:`ShapeError` if any input shape doesn't match the
        bound shape — callers should catch this and fall back to
        ``session.run`` rather than trying to re-prime mid-stream.
        """
        for name, arr in inputs.items():
            bound = self._bound_shapes.get(name)
            if bound is None:
                msg = f"Unknown input {name!r} (not bound)"
                raise self.ShapeError(msg)
            if tuple(arr.shape) != bound:
                msg = f"Shape mismatch for input {name!r}: expected {bound}, got {tuple(arr.shape)}"
                raise self.ShapeError(msg)
            # update_inplace lets us reuse the same OrtValue (no realloc).
            # Falls through to a fresh OrtValue if the EP doesn't
            # support in-place numpy updates (older ORT, CPU EP only).
            ortval = self._input_values[name]
            updater = getattr(ortval, "update_inplace", None)
            if callable(updater):
                updater(arr)
            else:  # pragma: no cover — older ORT fallback
                import numpy as np
                import onnxruntime as rt

                fresh = rt.OrtValue.ortvalue_from_numpy(np.asarray(arr), self._device_name, self._device_id)
                self._input_values[name] = fresh
                self._io_binding.bind_ortvalue_input(name, fresh)

        self._session.run_with_iobinding(self._io_binding)
        return {name: ortval.numpy() for name, ortval in self._gather_outputs().items()}

    def _gather_outputs(self) -> dict[str, Any]:
        """Return the bound output OrtValues keyed by name.

        ``io_binding.get_outputs()`` returns a list in the same order
        as ``session.get_outputs()`` — we zip them back to a name-keyed
        dict so the caller doesn't have to track index↔name.
        """
        ordered_names = [meta.name for meta in self._session.get_outputs()]
        return dict(zip(ordered_names, self._io_binding.get_outputs(), strict=False))

    @property
    def device(self) -> tuple[str, int]:
        """The ``(device_name, device_id)`` the input/output tensors live on."""
        return (self._device_name, self._device_id)

    @property
    def bound_shapes(self) -> dict[str, tuple[int, ...]]:
        """Snapshot of the bound input shapes — useful for tests and diagnostics."""
        return dict(self._bound_shapes)
