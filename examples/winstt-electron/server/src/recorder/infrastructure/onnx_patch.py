"""Repair malformed onnx-community Whisper fp16 decoder exports.

The ``onnx-community/whisper-tiny.en/decoder_model_merged_fp16.onnx`` file
(and likely siblings — same Optimum export chain) has two coexisting
metadata bugs that make it unloadable on ORT 1.18+:

1. **Subgraph output names collide with outer scope.** Both ``If``
   subgraphs (the ``use_cache_branch`` switch) declare their outputs with
   the parent graph's final output names — ``logits``,
   ``present.0.decoder.key``, etc. Those names exist in outer scope (as
   the post-``If`` ``Cast`` outputs). ORT interprets this as "subgraph
   output is an outer-scope value being returned directly" and rejects
   the model: ``graph.cc:1491 InitializeStateFromModelFileGraphProto``.
   The actual computation inside each subgraph produces
   ``graph_output_cast_<i>``, positionally aligned with the parent
   ``If``'s outputs.

2. **Subgraph output dtypes annotated as fp32, not fp16.** Every weight
   initializer, every internal node value_info, and the parent ``If``'s
   declared outputs are all fp16. Only the subgraph-output annotations
   are fp32 — a stray remnant of the pre-fp16 export.

The fix is the same one Optimum would have applied if its fp16 pass had
propagated correctly: rename each subgraph output to match what's
produced inside the subgraph (``graph_output_cast_<i>``, taken from the
parent ``If``'s outputs by position), then copy the parent ``If``'s
``TypeProto`` into the subgraph output's type so the dtype matches.

The encoder fp16 file has a separate defect (an ORT
``SimplifiedLayerNormFusion`` bug triggered by inserted
``PrecisionFreeCast`` nodes); it can't be fixed graph-side, but lowering
the session optimization level to ``ORT_ENABLE_EXTENDED`` sidesteps it.
That part is handled at the call site in
:class:`~src.recorder.infrastructure.onnxasr_transcriber.OnnxAsrTranscriber`.

Verified end-to-end on a 203 s English clip: patched fp16 transcription
matches the fp32 reference byte-for-byte (max abs diff 0.009 on logits,
100 % argmax agreement on both no-cache and cached branches).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from onnx import GraphProto, NodeProto, TypeProto

logger = logging.getLogger(__name__)

#: Sidecar marker so we don't reopen + rewrite a multi-MB ONNX file on
#: every load. Bump the version suffix if the patch logic changes.
_PATCH_MARKER_NAME = ".winstt_patched_v1"


def _fix_if_subgraph(
    if_node: NodeProto,
    parent_output_types: dict[str, TypeProto],
    subgraph: GraphProto,
) -> int:
    """Repair one ``If`` branch.

    For each subgraph output:

    * If the declared name isn't produced inside the subgraph but the
      parent ``If``'s corresponding positional output name *is*, rewrite
      the subgraph output name to point at the locally-produced value.
    * If the parent ``If`` declared a dtype for that position and it
      differs from the subgraph output's annotation, copy the parent's
      ``TypeProto`` over. Resolves the fp32-annotation-in-fp16-model bug.

    Returns the number of edits applied (0 = no-op, model already valid).
    """
    if len(subgraph.output) != len(if_node.output):
        return 0
    inner_produced = {o for n in subgraph.node for o in n.output if o}
    sg_inputs = {i.name for i in subgraph.input}
    edits = 0

    for i, out in enumerate(subgraph.output):
        intended_name = if_node.output[i]
        intended_type = parent_output_types.get(intended_name)

        if (
            out.name != intended_name
            and out.name not in inner_produced
            and out.name not in sg_inputs
            and intended_name in inner_produced
        ):
            out.name = intended_name
            edits += 1

        if intended_type is not None and intended_type.HasField("tensor_type"):
            want_elem = intended_type.tensor_type.elem_type
            have_elem = out.type.tensor_type.elem_type if out.type.HasField("tensor_type") else 0
            if want_elem and want_elem != have_elem:
                out.type.CopyFrom(intended_type)
                edits += 1

    return edits


def _walk(graph: GraphProto, parent_output_types: dict[str, TypeProto], counter: list[int]) -> None:
    """Recursive graph walk that propagates the visible-type lookup into nested subgraphs."""
    from onnx import AttributeProto

    type_lookup = dict(parent_output_types)
    for vi in graph.value_info:
        type_lookup[vi.name] = vi.type
    for vi in graph.output:
        type_lookup[vi.name] = vi.type
    for vi in graph.input:
        type_lookup[vi.name] = vi.type

    for node in graph.node:
        if node.op_type == "If":
            for attr in node.attribute:
                if attr.type == AttributeProto.GRAPH:
                    counter[0] += _fix_if_subgraph(node, type_lookup, attr.g)
                    _walk(attr.g, type_lookup, counter)
                elif attr.type == AttributeProto.GRAPHS:
                    for sg in attr.graphs:
                        counter[0] += _fix_if_subgraph(node, type_lookup, sg)
                        _walk(sg, type_lookup, counter)
        else:
            for attr in node.attribute:
                if attr.type == AttributeProto.GRAPH:
                    _walk(attr.g, type_lookup, counter)
                elif attr.type == AttributeProto.GRAPHS:
                    for sg in attr.graphs:
                        _walk(sg, type_lookup, counter)


def patch_whisper_decoder(model_path: Path) -> int:
    """Patch a Whisper merged-decoder ONNX file in place.

    Idempotent — if the file has no offending subgraphs (already patched,
    or a different export entirely), nothing is written and ``0`` is
    returned. On first patch, drops a sidecar marker file alongside so
    subsequent loads skip the (multi-MB) read + parse + rewrite. The
    marker is checked by :func:`should_skip_patch` so callers can avoid
    even importing :mod:`onnx` on the fast path.
    """
    import onnx

    marker = model_path.parent / f"{model_path.name}{_PATCH_MARKER_NAME}"
    if marker.is_file():
        return 0

    model = onnx.load(str(model_path), load_external_data=False)
    counter = [0]
    _walk(model.graph, {}, counter)

    if counter[0]:
        onnx.save(model, str(model_path))
        logger.info("Patched %d subgraph metadata fixes in %s", counter[0], model_path)
    # Drop the marker even when the file needed no edits (a clean upstream
    # re-export should be respected next load without re-parsing the graph).
    marker.touch()
    return counter[0]


def should_skip_patch(model_path: Path) -> bool:
    """True iff a sidecar marker shows this file was already inspected."""
    return (model_path.parent / f"{model_path.name}{_PATCH_MARKER_NAME}").is_file()
