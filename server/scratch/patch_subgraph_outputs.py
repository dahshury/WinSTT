"""Repair malformed onnx-community/whisper-*.en fp16 decoder exports.

Two coexisting metadata bugs in Optimum's fp16 fork of
``decoder_model_merged.onnx`` (e.g. whisper-tiny.en):

1. **Wrong output names** — each ``If`` subgraph declares its outputs
   as the parent graph's final output names (``logits``,
   ``present.0.decoder.key`` …). Those names also exist in outer scope
   (as post-``If`` ``Cast`` outputs), so ORT 1.18+ rejects the model
   with "subgraph output is an outer scope value being returned
   directly". The actual computation inside the subgraph produces
   ``graph_output_cast_<i>`` — positionally aligned with the parent
   ``If`` node's outputs. Fix: ``sg.output[i].name = if.output[i]``.

2. **Wrong output dtypes** — those subgraph outputs are declared
   ``float`` (fp32) but the model is fp16: every weight initializer is
   fp16, every internal node value_info is fp16, the parent ``If``
   declares each positional output as fp16. The subgraph-output
   annotation is the only fp32 remnant of the original pre-fp16
   export. Fix: copy the parent ``If``'s ``TypeProto`` for output ``i``
   into ``sg.output[i].type``.

Idempotent: re-running on a fixed file is a no-op.
"""

from __future__ import annotations

import sys
from pathlib import Path

import onnx
from onnx import AttributeProto, GraphProto, NodeProto, TypeProto


def _fix_if_subgraph(
    if_node: NodeProto,
    parent_output_types: dict[str, TypeProto],
    subgraph: GraphProto,
) -> int:
    if len(subgraph.output) != len(if_node.output):
        return 0
    inner_produced = {o for n in subgraph.node for o in n.output if o}
    sg_inputs = {i.name for i in subgraph.input}
    fixes = 0

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
            fixes += 1

        if intended_type is not None and intended_type.HasField("tensor_type"):
            want_elem = intended_type.tensor_type.elem_type
            have_elem = out.type.tensor_type.elem_type if out.type.HasField("tensor_type") else 0
            if want_elem and want_elem != have_elem:
                out.type.CopyFrom(intended_type)
                fixes += 1

    return fixes


def _walk(graph: GraphProto, parent_output_types: dict[str, TypeProto], counter: list[int]) -> None:
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


def patch_model(model_path: Path) -> int:
    model = onnx.load(str(model_path), load_external_data=False)
    counter = [0]
    _walk(model.graph, {}, counter)
    if counter[0]:
        onnx.save(model, str(model_path))
    return counter[0]


if __name__ == "__main__":
    p = Path(sys.argv[1])
    n = patch_model(p)
    print(f"applied {n} metadata fixes in {p}")
