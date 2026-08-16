#!/usr/bin/env python3
"""Make a fused Cohere-Transcribe ONNX export run correctly on the DirectML EP.

WHY
---
The stock `onnx-community/cohere-transcribe-*-ONNX` decoder bakes its attention into two
`com.microsoft` contrib ops that the ONNX Runtime **DirectML** EP mishandles (empirically isolated
with `examples/cohere_dml_spike.rs`):

  * cross-attention `MultiHeadAttention` (8 nodes, `*/encoder_attn/*`) — the DML kernel CRASHES
    (`E_INVALIDARG` at `/model/layers.0/encoder_attn/MultiHeadAttention`) on the 3-D-query / 4-D-KV
    cross-attention form.
  * self-attention `GroupQueryAttention` (8 nodes, `*/attn/*`) — DML silently MIS-COMPUTES it
    (garbled transcript, no error).

The encoder's self-attention `MultiHeadAttention` was measured DML-SAFE, so it is left untouched.

This tool rewrites ONLY those two decoder op families into plain ONNX primitives
(Reshape / Transpose / MatMul / Mul / Add / Softmax / Concat) that DirectML runs correctly. The
result is numerically identical to the fused graph (verified bit-exact on CPU) and, once its decoder
contains no MHA/GQA nodes, WinSTT's loader (`cohere_export_dml_safe`) auto-routes it to DirectML.

GQA specifics handled here: `num_heads == kv_num_heads` (no KV-head grouping), `do_rotary=0` (no
in-op rotary), KV-cache = concat(past, new) feeding the `present.*` graph outputs, and — critically —
the causal mask, which GQA applies INTERNALLY. The exported `attention_bias` input (in[10]) is only
the PADDING mask, so this tool builds the causal mask explicitly (shared across all layers) and adds
both to the attention scores.

USAGE
-----
    python cohere_decompose_attention.py --src <hf_snapshot_dir> --out <output_dir> [--check]

`--src` is a directory containing `onnx/decoder_model_merged*.onnx` (+ external data) and the encoder
+ tokenizer sidecars (an HF snapshot dir). `--check` runs a CPU parity assertion against the source
decoder. Then upload `<output_dir>` as a repo and point the catalog `onnx_model_name` at it.
"""
from __future__ import annotations

import argparse
import glob
import os
import shutil

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

H = 1024  # decoder hidden size (num_heads * head_dim = 8 * 128)
NEG_F32 = -3.4028234663852886e38
NEG_F16 = -65504.0  # float16 finite minimum (matches the fp16 graph's clamped padding bias)

# Activation float dtype of the decoder being rewritten. Set per-file in decompose_decoder so the
# scale / mask / bias constants match the graph's compute type (fp32 for the default / int8 / q4
# exports; fp16 for the fp16 / q4f16 exports, whose Mul/Add would else raise a type-mismatch).
_ACT_NP = np.float32
_NEG = NEG_F32


def _scf(name, val):
    return numpy_helper.from_array(np.array(val, dtype=_ACT_NP), name=name)


def _sci(name, val):
    return numpy_helper.from_array(np.array(val, dtype=np.int64), name=name)


def _attr(node, name, default=None):
    for a in node.attribute:
        if a.name == name:
            return helper.get_attribute_value(a)
    return default


def flatten_cross_attn_ifs(g) -> int:
    """Remove the two cross-attn `If` nodes, making cross-KV recompute UNCONDITIONAL (branchless).

    Control-flow ops have no DirectML kernel — ORT always runs `If` on the CPU EP, so each `If`
    boundary forces GPU→CPU→GPU transfers of all 16 cross-KV tensors (~20 MB) EVERY decode step.
    That partition churn is why the fused-then-decomposed graph ran ~2× slower on DML than the
    hand-exported (branchless) Arabic graph, which recomputes cross-KV from `encoder_hidden_states`
    every step and still beats CPU 2.7×. This pass reproduces that proven branchless layout:

      * `/model/if_cross_attn_kv_cache`: hoist its then-branch (the k/v_proj MatMul→Add→Reshape→
        Transpose chains — all weights already live in the PARENT graph) into the main graph, renaming
        each branch output (`cross_attn.i.encoder.k`) to the If's output name
        (`cross_attn.i.encoder.key`) so downstream cross-attention is untouched.
      * `/model/if_cross_attn_public_cache`: replace with per-layer `Identity(cross_attn.i.encoder.*)
        → present.i.encoder.*` (echo the freshly computed full-length KV, exactly like the Arabic
        export — the engine re-stores it each step).
      * The `is_first_step` condition chain and the now-unused `past_key_values.*.encoder.*` inputs
        become dead; dead nodes are pruned (inputs stay declared — the engine still binds them).

    Returns the number of `If` nodes removed (0 = already branchless; a no-op on such exports).
    """
    ifs = {n.name: n for n in g.node if n.op_type == "If"}
    kv_if = ifs.get("/model/if_cross_attn_kv_cache")
    pub_if = ifs.get("/model/if_cross_attn_public_cache")
    if kv_if is None and pub_if is None:
        return 0

    new_nodes = []
    removed = 0
    for n in g.node:
        if kv_if is not None and n.name == kv_if.name:
            then_g = next(helper.get_attribute_value(a) for a in n.attribute if a.name == "then_branch")
            # Branch-output name (`cross_attn.i.encoder.k`) → If-output name (`cross_attn.i.encoder.key`),
            # positional per the If spec.
            out_map = {so.name: n.output[idx] for idx, so in enumerate(then_g.output)}
            if then_g.initializer:
                g.initializer.extend(then_g.initializer)
            for sn in then_g.node:
                for i, o in enumerate(sn.output):
                    if o in out_map:
                        sn.output[i] = out_map[o]
                new_nodes.append(sn)
            removed += 1
        elif pub_if is not None and n.name == pub_if.name:
            # present.i.encoder.* = the freshly computed cross_attn.i.encoder.* (then-branch semantics,
            # now valid on EVERY step because the recompute above is unconditional).
            for out in n.output:
                src = out.replace("present.", "cross_attn.")
                new_nodes.append(helper.make_node("Identity", [src], [out], name=f"ds/echo/{out}"))
            removed += 1
        else:
            new_nodes.append(n)

    # Prune the now-dead `is_first_step` condition chain (and anything else no longer reaching an
    # output) with a reverse liveness sweep. Graph INPUTS stay declared even when unused.
    needed = {o.name for o in g.output}
    live = []
    for n in reversed(new_nodes):
        if any(o in needed for o in n.output):
            live.append(n)
            needed.update(i for i in n.input if i)
    live.reverse()
    del g.node[:]
    g.node.extend(live)
    return removed


def decompose_decoder(src_decoder: str, dst_decoder: str) -> tuple[int, int]:
    """Rewrite the decoder graph in place at `dst_decoder`. Returns (n_cross_mha, n_gqa).

    The weights are NEVER re-serialized: the graph is loaded with `load_external_data=False`, edited
    proto-only (no pass here reads tensor bytes), and saved with the original initializers still
    pointing into the UNTOUCHED copied `.onnx_data` sidecar. This sidesteps a real onnx-python
    (≤1.21) external-data writer bug: a plain load(load_external_data=True) + save(
    save_as_external_data=True) round-trip of the q4f16 decoder loses ONE byte at a 4-bit tensor
    boundary, shifting every later tensor by a byte — garbage weights, flat logits. It also avoids
    rewriting multi-GB sidecars. The handful of small NEW initializers (mask/scale/shape constants)
    embed inline in the .onnx proto."""
    global _ACT_NP, _NEG
    m = onnx.load(src_decoder, load_external_data=False)
    g = m.graph

    n_ifs = flatten_cross_attn_ifs(g)
    if n_ifs:
        print(f"  flattened {n_ifs} cross-attn If node(s) → branchless cross-KV recompute")

    # Detect the activation float dtype from an attention node's query input, so the constants we
    # emit (scale / mask / bias) match the graph's compute type. Only fp16 / q4f16 exports run fp16
    # activations; the default / int8 / q4 exports dequantize to fp32.
    vinfo = {vi.name: vi for vi in list(g.value_info) + list(g.input) + list(g.output)}
    attn0 = next((n for n in g.node if n.op_type in ("MultiHeadAttention", "GroupQueryAttention")), None)
    is_fp16 = False
    if attn0 is not None and attn0.input[0] in vinfo:
        is_fp16 = vinfo[attn0.input[0]].type.tensor_type.elem_type == TensorProto.FLOAT16
    _ACT_NP = np.float16 if is_fp16 else np.float32
    _NEG = NEG_F16 if is_fp16 else NEG_F32

    inits: list = [
        _scf("ds/neg_inf", _NEG), _scf("ds/zero_f", 0.0),
        _sci("ds/c0", 0), _sci("ds/c1", 1), _sci("ds/c2", 2),
        _sci("ds/ax0", [0]), _sci("ds/ax1", [1]), _sci("ds/ax01", [0, 1]),
    ]

    gqa_nodes = [n for n in g.node if n.op_type == "GroupQueryAttention"]
    if not gqa_nodes:
        # Already-decomposed export (e.g. the Arabic hand-export: plain SDPA, no contrib attention,
        # no Ifs) — nothing to decompose. Save through unchanged so the hoist pass can still run.
        onnx.save(m, dst_decoder)
        return 0, 0
    any_pastk = gqa_nodes[0].input[3]  # past_key_values.0.decoder.key (B, kvh, past, hd)

    # Shared causal mask (1,1,S,T): key j is masked for query i when j > past_len + i.
    shared = [
        helper.make_node("Shape", ["input_ids"], ["ds/sh_in"]),
        helper.make_node("Gather", ["ds/sh_in", "ds/c1"], ["ds/S"], axis=0),
        helper.make_node("Shape", [any_pastk], ["ds/sh_pk"]),
        helper.make_node("Gather", ["ds/sh_pk", "ds/c2"], ["ds/P"], axis=0),
        helper.make_node("Add", ["ds/P", "ds/S"], ["ds/T"]),
        helper.make_node("Range", ["ds/c0", "ds/T", "ds/c1"], ["ds/jr"]),
        helper.make_node("Range", ["ds/c0", "ds/S", "ds/c1"], ["ds/ir"]),
        helper.make_node("Add", ["ds/ir", "ds/P"], ["ds/iabs"]),
        helper.make_node("Unsqueeze", ["ds/jr", "ds/ax0"], ["ds/jr2"]),
        helper.make_node("Unsqueeze", ["ds/iabs", "ds/ax1"], ["ds/iabs2"]),
        helper.make_node("Greater", ["ds/jr2", "ds/iabs2"], ["ds/future"]),
        helper.make_node("Where", ["ds/future", "ds/neg_inf", "ds/zero_f"], ["ds/causal2d"]),
        helper.make_node("Unsqueeze", ["ds/causal2d", "ds/ax01"], ["ds/causal4d"]),
    ]

    new_nodes = list(shared)
    # The generated tensor/initializer names must NOT embed the contrib op-type strings
    # ("MultiHeadAttention" / "GroupQueryAttention") — WinSTT's DML-safety check
    # (`cohere_export_dml_safe`) byte-scans the graph for those op_type strings, and a name derived
    # from the original node (e.g. `.../encoder_attn/MultiHeadAttention/output_0`) would be a false
    # positive. So every replacement uses an op-type-free `ds/mha_i` / `ds/gqa_i` prefix, and the
    # attention OUTPUT tensor is renamed (its downstream consumers patched below).
    rename: dict[str, str] = {}
    n_mha = n_gqa = 0
    for n in g.node:
        if n.op_type == "MultiHeadAttention" and "encoder_attn" in n.name:
            q, k, v = n.input[0], n.input[1], n.input[2]
            pfx = f"ds/mha_{n_mha}"
            nh = _attr(n, "num_heads")
            hd = H // nh
            scale = _attr(n, "scale", 1.0 / np.sqrt(hd))
            out = f"{pfx}/out"
            rename[n.output[0]] = out
            inits += [_sci(f"{pfx}/shq", [0, 0, nh, hd]), _sci(f"{pfx}/sho", [0, 0, H]), _scf(f"{pfx}/scl", float(scale))]
            qr, qh, kt, s0, ss, pr, ct, cx = (f"{pfx}/{x}" for x in "qr qh kt s0 ss pr ct cx".split())
            new_nodes += [
                helper.make_node("Reshape", [q, f"{pfx}/shq"], [qr]),
                helper.make_node("Transpose", [qr], [qh], perm=[0, 2, 1, 3]),
                helper.make_node("Transpose", [k], [kt], perm=[0, 1, 3, 2]),
                helper.make_node("MatMul", [qh, kt], [s0]),
                helper.make_node("Mul", [s0, f"{pfx}/scl"], [ss]),
                helper.make_node("Softmax", [ss], [pr], axis=-1),
                helper.make_node("MatMul", [pr, v], [ct]),
                helper.make_node("Transpose", [ct], [cx], perm=[0, 2, 1, 3]),
                helper.make_node("Reshape", [cx, f"{pfx}/sho"], [out]),
            ]
            n_mha += 1
        elif n.op_type == "GroupQueryAttention":
            q, k, v, pk, pv = n.input[:5]
            pad_bias = n.input[10]  # exported PADDING bias only (0 / -inf per key)
            pfx = f"ds/gqa_{n_gqa}"
            nh = _attr(n, "num_heads")
            hd = H // nh
            scale = _attr(n, "scale", 1.0 / np.sqrt(hd))
            out = f"{pfx}/out"
            rename[n.output[0]] = out
            pres_k, pres_v = n.output[1], n.output[2]  # graph outputs — names kept (no op-type substr)
            inits += [_sci(f"{pfx}/shh", [0, 0, nh, hd]), _sci(f"{pfx}/sho", [0, 0, H]), _scf(f"{pfx}/scl", float(scale))]
            names = "qr qh kr kh vr vh kt s0 ss sb1 sb2 pr ct cx".split()
            qr, qh, kr, kh, vr, vh, kt, s0, ss, sb1, sb2, pr, ct, cx = (f"{pfx}/{x}" for x in names)
            new_nodes += [
                helper.make_node("Reshape", [q, f"{pfx}/shh"], [qr]),
                helper.make_node("Transpose", [qr], [qh], perm=[0, 2, 1, 3]),
                helper.make_node("Reshape", [k, f"{pfx}/shh"], [kr]),
                helper.make_node("Transpose", [kr], [kh], perm=[0, 2, 1, 3]),
                helper.make_node("Reshape", [v, f"{pfx}/shh"], [vr]),
                helper.make_node("Transpose", [vr], [vh], perm=[0, 2, 1, 3]),
                helper.make_node("Concat", [pk, kh], [pres_k], axis=2),  # present.*.key
                helper.make_node("Concat", [pv, vh], [pres_v], axis=2),  # present.*.value
                helper.make_node("Transpose", [pres_k], [kt], perm=[0, 1, 3, 2]),
                helper.make_node("MatMul", [qh, kt], [s0]),
                helper.make_node("Mul", [s0, f"{pfx}/scl"], [ss]),
                helper.make_node("Add", [ss, "ds/causal4d"], [sb1]),
                helper.make_node("Add", [sb1, pad_bias], [sb2]),
                helper.make_node("Softmax", [sb2], [pr], axis=-1),
                helper.make_node("MatMul", [pr, pres_v], [ct]),
                helper.make_node("Transpose", [ct], [cx], perm=[0, 2, 1, 3]),
                helper.make_node("Reshape", [cx, f"{pfx}/sho"], [out]),
            ]
            n_gqa += 1
        else:
            new_nodes.append(n)

    # Patch consumers of the renamed attention outputs (e.g. each layer's `o_proj` MatMul).
    for n in new_nodes:
        for i, inp in enumerate(n.input):
            if inp in rename:
                n.input[i] = rename[inp]

    del g.node[:]
    g.node.extend(new_nodes)
    g.initializer.extend(inits)

    # Prune stale `value_info` shape hints left behind for the removed contrib-attention outputs
    # (e.g. `.../GroupQueryAttention/output_0`). They no longer name any tensor, but their strings
    # would survive in the proto and trip WinSTT's op-type byte-scan (`cohere_export_dml_safe`),
    # keeping a now-DML-safe export needlessly on CPU. ORT re-infers shapes, so dropping them is safe.
    keep_vi = [
        vi for vi in g.value_info
        if "MultiHeadAttention" not in vi.name and "GroupQueryAttention" not in vi.name
    ]
    del g.value_info[:]
    g.value_info.extend(keep_vi)

    # Proto-only save: existing initializers keep their external_data pointers into the verbatim-
    # copied sidecar; the new small constants ride inline. Do NOT use save_as_external_data here
    # (see the writer-bug note in the docstring). Check AFTER saving, by PATH, so the checker
    # resolves the sidecar against the model's directory instead of the CWD.
    onnx.save(m, dst_decoder)
    onnx.checker.check_model(dst_decoder, full_check=False)
    return n_mha, n_gqa


def _read_init_bytes(init, base_dir: str) -> bytes:
    """Raw bytes of an initializer, reading external data MANUALLY (offset/length from the proto) —
    onnx's own loaders carry guards (hardlink checks, whole-model loads) we don't want here."""
    if init.data_location == TensorProto.EXTERNAL:
        kv = {e.key: e.value for e in init.external_data}
        with open(os.path.join(base_dir, kv["location"]), "rb") as f:
            f.seek(int(kv.get("offset", 0)))
            return f.read(int(kv["length"]))
    return init.raw_data


def hoist_cross_kv(dec, enc_path: str, dec_dir: str) -> int:
    """LOOP-INVARIANT CODE MOTION: move the cross-attention K/V computation OUT of the per-token
    decoder and INTO the (once-per-utterance) encoder graph.

    The branchless decoder recomputes all 16 cross-KV projections from `encoder_hidden_states` on
    EVERY decoded token (~tens of GFLOP/token for long audio) and re-materializes them as
    `present.*.encoder.*` outputs each step - ~100x the decoder's actual per-token compute. This
    pass, generically for both the multilingual (flattened then-branch) and Arabic (inline torch
    SDPA) layouts:

      * FREE closure: Constant nodes, the batch-dim idiom `Gather(Shape(<any graph input>), 0)`
        (batch is the same for every graph input, so it can be re-rooted on the encoder
        `last_hidden_state`), and shape-arithmetic ops over free inputs. Free nodes are COPIED into
        the encoder (originals stay for remaining decoder consumers; ORT prunes dead ones).
      * ENC closure: nodes whose inputs are all free/enc-derived with at least one enc-derived -
        these are MOVED to the encoder.
      * Boundary tensors (enc-derived values the decoder still consumes) become decoder INPUTS:
        canonical `cross_attn.{i}.encoder.{key,value}` names when they fed a `present.*.encoder.*`
        output, deterministic `cross_attn.hoisted.{n}` otherwise (e.g. the pre-transposed key). The
        engine binds every `cross_attn.*` decoder input from the same-named encoder output.
      * `present.*.encoder.*` outputs (and echo Identities) are dropped; `past_key_values.*.encoder.*`
        inputs stay DECLARED (some exports reference them in a keep-alive sum) and are bound empty.
      * Everything grafted into the encoder is prefix-renamed (`ds/hx/...`) - torch exports reuse
        default node/tensor names (`/Shape`, `/Transpose_5`) across encoder and decoder graphs.

    Returns the number of moved (enc-closure) nodes (0 = no cross-KV recompute found; no-op)."""
    g = dec.graph
    graph_inputs = {i.name for i in g.input}
    inits = {i.name for i in g.initializer}

    # Canonical name mapping from the present.*.encoder.* outputs.
    producers = {o: n for n in g.node for o in n.output}
    canon = {}
    echo_ids = set()
    for o in g.output:
        if o.name.startswith("present.") and ".encoder." in o.name:
            target = o.name.replace("present.", "cross_attn.", 1)
            prod = producers[o.name]
            if prod.op_type == "Identity":
                canon[prod.input[0]] = target
                echo_ids.add(id(prod))
            else:
                canon[o.name] = target
    if not canon:
        return 0

    # ---- FREE closure ----------------------------------------------------------------------
    SHAPE_ARITH = {"Unsqueeze", "Squeeze", "Concat", "Cast", "Slice", "Gather",
                   "Add", "Sub", "Mul", "Div", "Where", "Equal", "Range"}
    free_nodes = []
    free_ids = set()
    free = set()            # tensor names computable without per-token inputs
    shape_of_input = set()  # outputs of Shape(<graph input>) - usable ONLY via dim-0 Gather

    def const_scalar(node):
        for a in node.attribute:
            if a.name == "value":
                arr = numpy_helper.to_array(helper.get_attribute_value(a))
                if arr.size == 1:
                    return int(arr.reshape(-1)[0])
        return None

    for n in g.node:
        if n.op_type == "Constant" and not n.input:
            free_nodes.append(n)
            free_ids.add(id(n))
            free.update(n.output)
        elif n.op_type == "Shape" and n.input[0] in graph_inputs:
            free_nodes.append(n)
            free_ids.add(id(n))
            shape_of_input.update(n.output)
        elif (n.op_type == "Gather" and n.input[0] in shape_of_input
              and n.input[1] in free and id(producers.get(n.input[1])) in free_ids
              and const_scalar(producers[n.input[1]]) == 0):
            # batch-dim extraction: identical for every graph input -> re-rootable on the encoder.
            free_nodes.append(n)
            free_ids.add(id(n))
            free.update(n.output)
        elif (n.op_type in SHAPE_ARITH and n.input
              and all((i in free or i in inits) for i in n.input if i)):
            free_nodes.append(n)
            free_ids.add(id(n))
            free.update(n.output)

    # ---- ENC closure (the nodes to MOVE) ----------------------------------------------------
    # DO NOT hoist the cross-attn KEY transpose (perm swapping the last two axes, (…,S,hd)→(…,hd,S)):
    # keeping it in the decoder makes EVERY cross boundary tensor uniformly (1, nh, S, hd), so the
    # `bucket_cross_kv` pass can pad them all along one axis. The transpose is a negligible per-token
    # copy. Without this, the pre-transposed key becomes a (1, nh, hd, S) boundary and bucketing
    # would have to special-case its axis.
    def is_key_transpose(n):
        return n.op_type == "Transpose" and list(_attr(n, "perm") or []) == [0, 1, 3, 2]

    enc_derived = {"encoder_hidden_states"}
    moved = []
    moved_ids = set()
    for n in g.node:
        if id(n) in echo_ids or is_key_transpose(n):
            continue
        ins = [i for i in n.input if i]
        if (ins and id(n) not in free_ids
                and all(i in enc_derived or i in free or i in inits for i in ins)
                and any(i in enc_derived for i in ins)):
            moved.append(n)
            moved_ids.add(id(n))
            enc_derived.update(n.output)

    # ---- Boundary + canonical names ----------------------------------------------------------
    remaining = [n for n in g.node if id(n) not in moved_ids and id(n) not in echo_ids]
    used = {i for n in remaining for i in n.input if i}
    boundary = sorted(t for t in enc_derived - {"encoder_hidden_states"} if t in used)
    auto = 0
    for t in boundary:
        if t not in canon:
            canon[t] = f"cross_attn.hoisted.{auto}"
            auto += 1
    retarget = {t: canon[t] for t in boundary}

    # ---- Decoder edits -----------------------------------------------------------------------
    for n in remaining:
        for k, i in enumerate(n.input):
            if i in retarget:
                n.input[k] = retarget[i]
    del g.node[:]
    g.node.extend(remaining)
    keep_out = [o for o in g.output if not (o.name.startswith("present.") and ".encoder." in o.name)]
    del g.output[:]
    g.output.extend(keep_out)
    past0 = next(i for i in g.input if i.name.startswith("past_key_values.") and ".decoder." in i.name)
    elem = past0.type.tensor_type.elem_type
    for t in sorted({retarget[t] for t in boundary}):
        # Rank-4 with fully-dynamic dims: canonical KV are (B,nh,S,hd) but auto-hoisted tensors
        # (e.g. the pre-transposed key, (B,nh,hd,S)) differ - concrete dims resolve at bind time.
        g.input.append(helper.make_tensor_value_info(
            t, elem, [f"{t}_d0", f"{t}_d1", f"{t}_d2", f"{t}_d3"]))
    # Layout marker consumed by WinSTT's engine (byte-scanned before session build): the DirectML
    # HYBRID policy (encoder on DML, decoder on CPU) is only safe when the decoder does NOT
    # recompute cross-KV per token, i.e. exactly when this hoist ran.
    if not any(e.key == "winstt_hoisted_cross_kv" for e in dec.metadata_props):
        entry = dec.metadata_props.add()
        entry.key = "winstt_hoisted_cross_kv"
        entry.value = "1"
    gone = set(canon) | set(canon.values()) | {o for n in moved for o in n.output}
    keep_vi = [vi for vi in g.value_info if vi.name not in gone]
    del g.value_info[:]
    g.value_info.extend(keep_vi)

    # ---- Encoder graft -----------------------------------------------------------------------
    # Only the free nodes the moved set actually consumes (transitively) get copied.
    moved_needs = {i for n in moved for i in n.input if i}
    live_free = []
    for n in reversed(free_nodes):
        if any(o in moved_needs for o in n.output):
            live_free.append(n)
            moved_needs.update(i for i in n.input if i)
    live_free.reverse()

    enc = onnx.load(enc_path, load_external_data=False)
    eg = enc.graph
    needed = {i for n in moved + live_free for i in n.input if i in inits}
    clash = needed & {i.name for i in eg.initializer}
    if clash:
        raise SystemExit(f"hoist: initializer name collision grafting into encoder: {sorted(clash)[:4]}")
    init_map = {i.name: i for i in g.initializer}
    for name in sorted(needed):
        src_t = init_map[name]
        t = TensorProto()
        t.CopyFrom(src_t)
        if src_t.data_location == TensorProto.EXTERNAL:
            raw = _read_init_bytes(src_t, dec_dir)
            del t.external_data[:]
            t.data_location = TensorProto.DEFAULT
            t.raw_data = raw
        eg.initializer.append(t)

    # Prefix-rename every grafted internal tensor/node (torch default names collide across graphs);
    # boundary outputs get their canonical names; enc-states / Shape-of-input re-root on
    # last_hidden_state (batch dim is shared by construction).
    grafted = []
    rename = {}
    for n in live_free + moved:
        for o in n.output:
            rename[o] = canon.get(o, f"ds/hx/{o}")
    for n in live_free + moved:
        c = onnx.NodeProto()
        c.CopyFrom(n)
        c.name = f"ds/hx/{c.name}" if c.name else ""
        for k, i in enumerate(c.input):
            if i == "encoder_hidden_states" or (c.op_type == "Shape" and i in graph_inputs):
                c.input[k] = "last_hidden_state"
            elif i in rename:
                c.input[k] = rename[i]
        for k, o in enumerate(c.output):
            c.output[k] = rename[o]
        grafted.append(c)
    enc_names = ({i.name for i in eg.initializer} | {o for n in eg.node for o in n.output}
                 | {i.name for i in eg.input})
    dup = {o for n in grafted for o in n.output} & enc_names
    if dup:
        raise SystemExit(f"hoist: tensor name collision in encoder graph: {sorted(dup)[:4]}")
    eg.node.extend(grafted)
    for t in sorted({retarget[t] for t in boundary}):
        eg.output.append(helper.make_tensor_value_info(
            t, elem, [f"{t}_d0", f"{t}_d1", f"{t}_d2", f"{t}_d3"]))
    onnx.save(enc, enc_path)
    onnx.checker.check_model(enc_path, full_check=False)

    # Standalone PROBE graph (last_hidden_state -> all hoisted cross outputs) for the parity
    # harness: runs the exact grafted computation without loading the full encoder weights. Written
    # next to the decoder; the caller deletes it after checks.
    probe_inits = [i for i in eg.initializer if i.name in needed]
    enc_elem = next(i for i in g.input if i.name == "encoder_hidden_states").type.tensor_type.elem_type
    probe_nodes = []
    for n in grafted:
        c = onnx.NodeProto()
        c.CopyFrom(n)
        probe_nodes.append(c)
    probe_graph = helper.make_graph(
        probe_nodes, "cross_kv_probe",
        [helper.make_tensor_value_info("last_hidden_state", enc_elem, ["batch_size", "seq", None])],
        [helper.make_tensor_value_info(retarget[t], elem, None) for t in sorted(set(boundary))],
        initializer=probe_inits,
    )
    probe = helper.make_model(probe_graph, opset_imports=list(dec.opset_import))
    probe.ir_version = dec.ir_version
    onnx.save(probe, enc_path + ".crosskv_probe.onnx")
    return len(moved)


STATIC_MAX_KV = 1024  # decoder max_position_embeddings == engine max_decode_length


def staticize_kv(dec, max_len: int = STATIC_MAX_KV) -> int:
    """STATIC-SHAPE decode: make every per-step decoder shape CONSTANT so the DirectML EP compiles
    its fused graph ONCE instead of re-fusing per autoregressive step (~34 ms/token measured).

      * every self-attn KV `Concat(past, new, axis=2)` (growing shapes) becomes a masked write over a
        fixed max-length buffer:  present = past * kv_keep_mask + kv_write_mat @ new
        with host-fed masks (kv_keep_mask (1,1,MAX,1): 0 at the slots being written;
        kv_write_mat (1,1,MAX,S_q): one-hot scatter matrix). Attention then runs over the full
        MAX-length buffer; unwritten slots are zero (the engine seeds ZEROED buffers) and masked to
        -inf by `attn_bias`, so softmax gives them exactly 0 weight.
      * the in-graph causal + padding mask chains (built from Shape(past)/attention_mask — both
        dynamic AND partition-splitting) are replaced by ONE host-fed additive `attn_bias` input
        (1,1,S_q,MAX): the engine knows step and length exactly. Detection: an Add chain feeding a
        self-attention Softmax where one operand's subgraph contains no MatMul (mask math never
        does; the scores side always does).
      * decoder proto metadata gains `winstt_static_kv=<MAX>` (engine switches decode strategy and
        may place the decoder back on DirectML).

    Runs AFTER hoist_cross_kv (cross-attn is per-utterance-static already; only self-attn KV grows).
    Returns the number of Concats replaced (0 = layout not recognized; graph left untouched)."""
    g = dec.graph

    # ---- 1. masked-write KV update ------------------------------------------------------------
    producers = {o: n for n in g.node for o in n.output}

    def subtree_has_matmul(t, depth=0, seen=None):
        seen = seen if seen is not None else set()
        if t in seen or depth > 40 or t not in producers:
            return False
        seen.add(t)
        n = producers[t]
        if n.op_type in ("MatMul", "MatMulNBits", "Gemm"):
            return True
        return any(subtree_has_matmul(i, depth + 1, seen) for i in n.input if i)

    out_nodes = []
    replaced = 0
    for n in g.node:
        if (n.op_type == "Concat" and len(n.input) == 2 and _attr(n, "axis") == 2
                and n.input[0].startswith("past_key_values.")
                and any(o.startswith("present.") for o in n.output)):
            past_in, new_in = n.input[0], n.input[1]
            out = n.output[0]
            p = f"ds/skv/{replaced}"
            out_nodes += [
                helper.make_node("Mul", [past_in, "kv_keep_mask"], [f"{p}/kept"]),
                helper.make_node("MatMul", ["kv_write_mat", new_in], [f"{p}/wnew"]),
                helper.make_node("Add", [f"{p}/kept", f"{p}/wnew"], [out]),
            ]
            replaced += 1
        else:
            out_nodes.append(n)
    if not replaced:
        return 0

    # ---- 2. replace the self-attn mask chain with the attn_bias input --------------------------
    # Walk down from each self-attn Softmax through the Add chain feeding it; the operand whose
    # subgraph has no MatMul is the mask math. Rewire to a single Add(scores, attn_bias).
    for i, n in enumerate(out_nodes):
        if n.op_type != "Softmax":
            continue
        sm_in = n.input[0]
        chain = []
        is_cross = False
        t = sm_in
        while t in producers and producers[t].op_type == "Add":
            chain.append(producers[t])
            add = producers[t]
            sides = [(k, x) for k, x in enumerate(add.input)]
            mask_side = [x for _, x in sides if not subtree_has_matmul(x)]
            score_side = [x for _, x in sides if subtree_has_matmul(x)]
            if len(mask_side) == 1 and len(score_side) == 1:
                # A CROSS-attention Softmax masked by `bucket_cross_kv` (Add(scaled_scores,
                # cross_bias)) must be left alone — only SELF-attention mask chains become attn_bias.
                if mask_side[0] == "cross_bias":
                    is_cross = True
                    break
                t = score_side[0]
            else:
                chain = []
                break
        if chain and not is_cross:  # t is now the raw scores tensor
            new_add = helper.make_node("Add", [t, "attn_bias"], [sm_in], name=f"ds/skv/bias/{i}")
            # drop the old Add chain nodes; splice the new Add right before the Softmax
            drop = {id(c) for c in chain}
            out_nodes = [x for x in out_nodes if id(x) not in drop]
            out_nodes.insert(out_nodes.index(n), new_add)
            producers = {o: nn for nn in out_nodes for o in nn.output}

    # ---- 3. liveness prune (kills the dead causal/pad/Shape chains) ---------------------------
    needed = {o.name for o in g.output}
    live = []
    for n in reversed(out_nodes):
        if any(o in needed for o in n.output):
            live.append(n)
            needed.update(i for i in n.input if i)
    live.reverse()
    del g.node[:]
    g.node.extend(live)

    # ---- 4. new inputs + metadata ---------------------------------------------------------------
    past0 = next(i for i in g.input if i.name.startswith("past_key_values.") and ".decoder." in i.name)
    elem = past0.type.tensor_type.elem_type
    g.input.append(helper.make_tensor_value_info("kv_keep_mask", elem, [1, 1, max_len, 1]))
    g.input.append(helper.make_tensor_value_info("kv_write_mat", elem, [1, 1, max_len, 1]))
    g.input.append(helper.make_tensor_value_info("attn_bias", elem, [1, 1, 1, max_len]))

    # LITERAL static dims on every per-step I/O: the DirectML EP only FUSES a graph whose shapes are
    # known at session build (dynamic dim_params -> op-by-op execution, ~65us/op dispatch = the
    # 34-60 ms/token overhead measured). sequence_length pins to 1 -> the ENGINE FEEDS THE PROMPT
    # ONE TOKEN AT A TIME. The dead `encoder_hidden_states` input pins to (1,1,H); the unused
    # `past.*.encoder.*` pin to 0-length. Only the `cross_attn.*` inputs stay dynamic (encoder
    # length varies per utterance) - a small unfused island. All internal value_info is dropped so
    # stale dynamic shape hints can't fight the new declarations.
    nh_ = past0.type.tensor_type.shape.dim[1].dim_value
    hd_ = past0.type.tensor_type.shape.dim[3].dim_value
    for vi in g.input:
        n = vi.name
        if n in ("input_ids", "position_ids"):
            vi.type.tensor_type.ClearField("shape")
            vi.type.tensor_type.shape.dim.add().dim_value = 1
            vi.type.tensor_type.shape.dim.add().dim_value = 1
        elif n == "attention_mask":
            vi.type.tensor_type.ClearField("shape")
            vi.type.tensor_type.shape.dim.add().dim_value = 1
            vi.type.tensor_type.shape.dim.add().dim_value = max_len
        elif n == "encoder_hidden_states":
            hidden = vi.type.tensor_type.shape.dim[2].dim_value
            vi.type.tensor_type.ClearField("shape")
            for d in (1, 1, hidden):
                vi.type.tensor_type.shape.dim.add().dim_value = d
        elif n.startswith("past_key_values."):
            seq = 0 if ".encoder." in n else max_len
            vi.type.tensor_type.ClearField("shape")
            for d in (1, nh_, seq, hd_):
                vi.type.tensor_type.shape.dim.add().dim_value = d
    for vo in g.output:
        n = vo.name
        if n == "logits":
            vocab = vo.type.tensor_type.shape.dim[2].dim_value
            vo.type.tensor_type.ClearField("shape")
            for d in (1, 1, vocab):
                vo.type.tensor_type.shape.dim.add().dim_value = d
        elif n.startswith("present."):
            vo.type.tensor_type.ClearField("shape")
            for d in (1, nh_, max_len, hd_):
                vo.type.tensor_type.shape.dim.add().dim_value = d
    del g.value_info[:]
    if not any(e.key == "winstt_static_kv" for e in dec.metadata_props):
        entry = dec.metadata_props.add()
        entry.key = "winstt_static_kv"
        entry.value = str(max_len)
    return replaced


CROSS_MAX = 1024  # fixed cross-attention key length (covers ~80 s post-8x-subsampling; model's own
# audio limit is 35 s and the app VADs to <=10 s, so real S_enc is far smaller).


def inject_cross_bias_adds(g) -> int:
    """Insert `Add(scores, cross_bias)` before every CROSS-attention Softmax; returns the count.

    Discriminator: a SELF-attention Softmax is always fed by the `Add` that applies its causal/pad
    mask (explicit causal mask pre-staticize, `attn_bias` after); a CROSS Softmax has no mask, so it
    is fed directly by the scaled scores — `Mul(scores, scale)` in the onnx-community decomposition,
    or the raw score `MatMul` in the Arabic torch export (scale folded into Q/K). So "NOT `Add`-fed"
    robustly identifies cross Softmaxes across both layouts, before OR after `staticize_kv`.

    The caller declares the `cross_bias` graph input (pinned `(1,1,1,cross_max)` for the bucketed
    layout, dynamic `(1,1,1,enc_seq)` for bias-only) — the score tensor's last axis is the key
    length in every layout, so the bias broadcasts correctly either way."""
    producers = {o: n for n in g.node for o in n.output}
    masked = 0
    new_nodes = []
    for n in g.node:
        feeder = producers.get(n.input[0]) if n.op_type == "Softmax" else None
        if feeder is not None and feeder.op_type != "Add":
            biased = f"ds/cross/{masked}/biased"
            new_nodes.append(helper.make_node("Add", [n.input[0], "cross_bias"], [biased]))
            n.input[0] = biased
            masked += 1
        new_nodes.append(n)
    if masked:
        del g.node[:]
        g.node.extend(new_nodes)
    return masked


def bucket_cross_kv(dec, enc_path: str, cross_max: int = CROSS_MAX) -> int:
    """Fuse the cross-attention on DirectML by giving it a FIXED key length.

    After `staticize_kv` the self-attention is fixed-shape (fused), but cross-attention still attends
    over the dynamic encoder length `S_enc` -> DML can't fuse it, and its per-token cost grows with
    audio length (measured: 66 s clip 5 ms/tok, 245 s clip 42 ms/tok). This pads the cross K/V to
    `cross_max` and masks the padding, making the whole decoder fixed-shape.

      * DECODER: pin every `cross_attn.*` input to (1, nh, cross_max, hd); before each cross-attn
        Softmax (the `Mul`-fed ones; self-attn Softmaxes are `Add`-fed after staticize) insert
        `Add(scaled_scores, cross_bias)`; add one decoder input `cross_bias` (1, 1, 1, cross_max).
      * ENCODER: `Pad` each cross output from S_enc to cross_max along seq (axis 2, zeros), and emit a
        `cross_bias` output = 0 for the first S_enc keys, -inf beyond. The engine binds it like any
        other encoder->decoder passthrough, so the decode loop is unchanged.

    Requires the static layout (needs `attn_bias` to distinguish self vs cross Softmaxes). Returns the
    number of cross Softmaxes masked (0 = not applicable). Runs on a HOISTED decoder BEFORE
    `staticize_kv` (cross Softmaxes are `Mul`-fed; self are `Add`-fed — no `attn_bias` needed yet), so
    the SAME cross-bias-consuming decoder can then be saved as the dynamic-self variant OR staticized
    for the fixed-self variant, both served by ONE padded encoder."""
    g = dec.graph
    if not any(i.name.startswith("cross_attn.") for i in g.input):
        return 0
    # Cross-bucketing assumes every cross-K/V boundary is uniformly (1, nh, S, hd) (seq at axis 2) so
    # ONE pad axis + ONE `cross_bias` shape covers them. The onnx-community layout satisfies this; the
    # Arabic torch export uses a (B, S, nh, hd) head layout with a `[0,2,3,1]` key transpose, so the
    # hoisted boundaries have heterogeneous seq axes and pinning them all to (1,nh,cross_max,hd) is
    # wrong. Detect that (any cross input NOT the canonical `.encoder.key/value` 4-D form → a
    # transposed/auto-hoisted tensor) and SKIP — the caller falls back to static-self only (cross
    # stays dynamic; still ~4 ms/tok for the app's ≤10 s VAD segments, only long single clips regress).
    cross_ins = [i.name for i in g.input if i.name.startswith("cross_attn.")]
    # Non-uniform layout → BIAS-ONLY: the cross K/V can't be pinned to one bucket, but the
    # `cross_bias` Add can still be injected (the score tensor's last axis is the key length in
    # EVERY layout, so a (1,1,1,S_enc) bias broadcasts correctly). The decoder then declares a
    # DYNAMIC `cross_bias` input the ENGINE computes per utterance from the real (pre-pad) audio
    # length — without it the maskless cross-attention attends trailing pad/silence zeros and
    # phrase-loops (re-emits one sentence until the token budget), and the engine must withhold
    # the DirectML encoder pad bucket entirely (paying the per-utterance re-fuse tax).
    bias_only = any(".encoder.key" not in n and ".encoder.value" not in n for n in cross_ins)
    if bias_only:
        print("  cross-bucket: non-uniform cross layout — injecting BIAS-ONLY dynamic cross_bias")
    past0 = next(i for i in g.input if i.name.startswith("past_key_values.") and ".decoder." in i.name)
    elem = past0.type.tensor_type.elem_type
    nh = past0.type.tensor_type.shape.dim[1].dim_value
    hd = past0.type.tensor_type.shape.dim[3].dim_value

    masked = inject_cross_bias_adds(g)
    if not masked:
        return 0

    if bias_only:
        # Dynamic-length bias input; no pinning, no encoder padding — the engine builds the bias
        # host-side (0 over real-speech keys, -inf over pad) and binds it every decode step.
        g.input.append(helper.make_tensor_value_info("cross_bias", elem, [1, 1, 1, "enc_seq"]))
        del g.value_info[:]
        if not any(e.key == "winstt_cross_bias" for e in dec.metadata_props):
            e = dec.metadata_props.add()
            e.key, e.value = "winstt_cross_bias", "dynamic"
        return masked

    # pin cross inputs to the fixed bucket; add cross_bias input
    for vi in g.input:
        if vi.name.startswith("cross_attn."):
            vi.type.tensor_type.ClearField("shape")
            for d in (1, nh, cross_max, hd):
                vi.type.tensor_type.shape.dim.add().dim_value = d
    g.input.append(helper.make_tensor_value_info("cross_bias", elem, [1, 1, 1, cross_max]))
    del g.value_info[:]
    if not any(e.key == "winstt_cross_bucket" for e in dec.metadata_props):
        e = dec.metadata_props.add()
        e.key, e.value = "winstt_cross_bucket", str(cross_max)

    # ---- encoder: pad cross outputs + emit cross_bias -----------------------------------------
    enc = onnx.load(enc_path, load_external_data=False)
    eg = enc.graph
    neg = NEG_F16 if elem == TensorProto.FLOAT16 else NEG_F32
    consumers = {}
    for n in eg.node:
        for i in n.input:
            consumers.setdefault(i, []).append(n)
    cross_outs = [o.name for o in eg.output if o.name.startswith("cross_attn.")]
    # S_enc from a cross output's seq dim (axis 2). Build once.
    inits = [
        numpy_helper.from_array(np.array([0, 0, 0, 0, 0, 0, 0, 0], dtype=np.int64), name="ds/cb/pads0"),
        numpy_helper.from_array(np.array([2], dtype=np.int64), name="ds/cb/ax2"),
        numpy_helper.from_array(np.array(0, dtype=np.int64), name="ds/cb/i0"),
        numpy_helper.from_array(np.array(1, dtype=np.int64), name="ds/cb/i1"),
        numpy_helper.from_array(np.array(cross_max, dtype=np.int64), name="ds/cb/cmax"),
        numpy_helper.from_array(np.array(neg, dtype=(np.float16 if elem == TensorProto.FLOAT16 else np.float32)), name="ds/cb/neg"),
        numpy_helper.from_array(np.array(0.0, dtype=(np.float16 if elem == TensorProto.FLOAT16 else np.float32)), name="ds/cb/zero"),
        numpy_helper.from_array(np.array([1, 1, 1, cross_max], dtype=np.int64), name="ds/cb/bshape"),
    ]
    eg.initializer.extend(inits)
    # S_enc = last_hidden_state seq length (axis 1) — same as every cross output's seq (axis 2), but
    # available BEFORE the Pad nodes below rename the cross outputs (avoids a topo cycle).
    eg.initializer.extend([
        numpy_helper.from_array(np.array([1], dtype=np.int64), name="ds/cb/ax1"),
        numpy_helper.from_array(np.array([0], dtype=np.int64), name="ds/cb/ax0z"),
        numpy_helper.from_array(np.array([0, 0, 0, 0, 0, 0], dtype=np.int64), name="ds/cb/pads6"),
        numpy_helper.from_array(np.array([0], dtype=np.int64), name="ds/cb/pads1"),
    ])
    eg.node.extend([
        helper.make_node("Shape", ["last_hidden_state"], ["ds/cb/shp"]),
        # scalar index (ds/cb/i1 == 1) → Gather returns a SCALAR (S_enc), no Squeeze needed.
        helper.make_node("Gather", ["ds/cb/shp", "ds/cb/i1"], ["ds/cb/senc"], axis=0),
        helper.make_node("Sub", ["ds/cb/cmax", "ds/cb/senc"], ["ds/cb/padend"]),
        helper.make_node("Unsqueeze", ["ds/cb/padend", "ds/cb/ax0z"], ["ds/cb/padend1"]),
        helper.make_node("Concat", ["ds/cb/pads6", "ds/cb/padend1", "ds/cb/pads1"], ["ds/cb/pads"], axis=0),
    ])
    # pad each cross output in place (rename original -> _raw, Pad -> original name)
    for name in cross_outs:
        prod = next(n for n in eg.node if name in n.output)
        raw = f"ds/cb/{name}/raw"
        for k, o in enumerate(prod.output):
            if o == name:
                prod.output[k] = raw
        eg.node.append(helper.make_node("Pad", [raw, "ds/cb/pads", "ds/cb/zero"], [name], mode="constant"))
    # cross_bias = where(arange(cross_max) < S_enc, 0, neg) -> (1,1,1,cross_max)
    eg.node.extend([
        helper.make_node("Range", ["ds/cb/i0", "ds/cb/cmax", "ds/cb/i1"], ["ds/cb/ar"]),   # (cross_max,)
        helper.make_node("Less", ["ds/cb/ar", "ds/cb/senc"], ["ds/cb/keep"]),
        helper.make_node("Where", ["ds/cb/keep", "ds/cb/zero", "ds/cb/neg"], ["ds/cb/bias1"]),
        helper.make_node("Reshape", ["ds/cb/bias1", "ds/cb/bshape"], ["cross_bias"]),
    ])
    eg.output.append(helper.make_tensor_value_info("cross_bias", elem, [1, 1, 1, cross_max]))
    del eg.value_info[:]
    onnx.save(enc, enc_path)
    onnx.checker.check_model(enc_path, full_check=False)
    return masked


def parity_check(orig_decoder: str, new_decoder: str, probe_path: str | None = None) -> None:
    """Autoregressive equivalence: prompt step (past=0) + two decode steps whose past KV is each
    graph's own present.* from the previous step. Handles BOTH decoder layouts:
      * legacy branchless (recomputes cross-KV internally from encoder_hidden_states);
      * hoisted (consumes `cross_attn.*` graph inputs) — those inputs are fed the ORIGINAL graph's
        prompt-step `present.*.encoder.*` values, which are exactly what the hoisted encoder now
        computes (same nodes, same weights)."""
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    s0 = ort.InferenceSession(orig_decoder, so, providers=["CPUExecutionProvider"])
    s1 = ort.InferenceSession(new_decoder, so, providers=["CPUExecutionProvider"])
    # fp16 graphs carry ~3 significant digits; decomposed-vs-fused logits differ by fp16 rounding.
    is_fp16 = any("float16" in i.type for i in s1.get_inputs())
    tol = 0.1 if is_fp16 else 1e-2

    rng = np.random.RandomState(0)
    enc_len, nh, hd = 6, 8, 128
    dt0 = {i.name: (np.float16 if "float16" in i.type else np.float32) for i in s0.get_inputs()}
    dt1 = {i.name: (np.float16 if "float16" in i.type else np.float32) for i in s1.get_inputs()}
    enc = (rng.randn(1, enc_len, 1024) * 0.1).astype(dt0["encoder_hidden_states"])

    def step(sess, dts, ids, past, past_dec_len, past_enc_len, extra=None):
        names = {i.name for i in sess.get_inputs()}
        static = "kv_keep_mask" in names
        seq = len(ids)
        total = past_dec_len + seq
        feeds = {
            "input_ids": np.array([ids], dtype=np.int64),
            "attention_mask": np.ones((1, total), dtype=np.int64),
            "position_ids": np.arange(past_dec_len, total, dtype=np.int64)[None, :],
            "num_logits_to_keep": np.array(1, dtype=np.int64),  # 1 = engine behavior; 0 means keep-none on the Arabic export
            "encoder_hidden_states": enc.astype(dts.get("encoder_hidden_states", np.float32)),
        }
        if static:
            kmax = next(i for i in sess.get_inputs() if i.name == "kv_keep_mask").shape[2]
            mdt = dts["kv_keep_mask"]
            feeds["attention_mask"] = np.ones((1, kmax), dtype=np.int64)
            feeds["encoder_hidden_states"] = np.zeros((1, 1, enc.shape[2]),
                                                      dtype=dts.get("encoder_hidden_states", np.float32))
            neg = np.float32(-3.4028234663852886e38) if mdt == np.float32 else np.float16(-65504.0)
            keep = np.ones((1, 1, kmax, 1), dtype=mdt)
            keep[0, 0, past_dec_len:total, 0] = 0
            w = np.zeros((1, 1, kmax, seq), dtype=mdt)
            for i in range(seq):
                w[0, 0, past_dec_len + i, i] = 1
            bias = np.full((1, 1, seq, kmax), neg, dtype=mdt)
            for i in range(seq):
                bias[0, 0, i, : past_dec_len + i + 1] = 0
            feeds["kv_keep_mask"], feeds["kv_write_mat"], feeds["attn_bias"] = keep, w, bias
        for name in names:
            if name.startswith("past_key_values."):
                if name in past:
                    feeds[name] = past[name]
                elif static and ".decoder." in name:
                    kmax = next(i for i in sess.get_inputs() if i.name == "kv_keep_mask").shape[2]
                    feeds[name] = np.zeros((1, nh, kmax, hd), dtype=dts[name])
                else:
                    length = past_enc_len if ".encoder." in name else past_dec_len
                    if static and ".encoder." in name:
                        length = 0  # static graphs pin the unused encoder pasts to 0-length
                    feeds[name] = np.zeros((1, nh, length, hd), dtype=dts[name])
        cross_bucket = "cross_bias" in names
        if extra:
            for k, v in extra.items():
                if k in names:
                    if cross_bucket and k.startswith("cross_attn."):
                        cm = next(i for i in sess.get_inputs() if i.name == k).shape[2]
                        # BIAS-ONLY graphs keep dynamic (unpinned) cross inputs — no padding there.
                        if isinstance(cm, int):
                            senc = v.shape[2]
                            pad = np.zeros((v.shape[0], v.shape[1], cm - senc, v.shape[3]), dtype=v.dtype)
                            v = np.concatenate([v, pad], axis=2)
                    feeds[k] = v.astype(dts[k])
        if cross_bucket:
            cm = next(i for i in sess.get_inputs() if i.name == "cross_bias").shape[3]
            if not isinstance(cm, int):  # bias-only: dynamic length = the encoder key length
                cm = enc.shape[1]
            senc = enc.shape[1]
            mdt = dts["cross_bias"]
            neg = np.float32(-3.4028234663852886e38) if mdt == np.float32 else np.float16(-65504.0)
            cb = np.full((1, 1, 1, cm), neg, dtype=mdt)
            cb[0, 0, 0, :senc] = 0
            feeds["cross_bias"] = cb
        feeds = {k: v for k, v in feeds.items() if k in names}
        out_names = [o.name for o in sess.get_outputs()]
        return dict(zip(out_names, sess.run(None, feeds)))

    def carry(prev, past):
        for name, v in prev.items():
            if name.startswith("present.") and v.shape[2] != 0:
                past[name.replace("present.", "past_key_values.")] = v
        return past

    def logit_diff(r0, r1):
        return float(np.abs(r0["logits"].astype(np.float32) - r1["logits"].astype(np.float32)).max())

    def run_prompt(sess, dts, prompt, extra):
        # Static sessions pin sequence_length=1: feed the prompt token-by-token (causally identical).
        if "kv_keep_mask" not in {i.name for i in sess.get_inputs()}:
            return step(sess, dts, prompt, {}, 0, 0, extra=extra), {}
        past = {}
        r = None
        for j, tok in enumerate(prompt):
            r = step(sess, dts, [tok], past, j, enc_len, extra=extra)
            past = carry(r, past)
        return r, past

    print("CPU parity (fused vs rewritten decoder, autoregressive):")
    prompt = [7, 42, 13, 99]
    r0 = step(s0, dt0, prompt, {}, 0, 0)
    # Hoisted layout: cross_attn.* inputs come from the PROBE graph (the exact grafted encoder-tail
    # computation) when available, else from the original graph's computed present.*.encoder.
    if probe_path and os.path.exists(probe_path):
        pr = ort.InferenceSession(probe_path, so, providers=["CPUExecutionProvider"])
        pdt = np.float16 if "float16" in pr.get_inputs()[0].type else np.float32
        pouts = [o.name for o in pr.get_outputs()]
        cross = dict(zip(pouts, pr.run(None, {"last_hidden_state": enc.astype(pdt)})))
    else:
        cross = {name.replace("present.", "cross_attn.", 1): v
                 for name, v in r0.items() if name.startswith("present.") and ".encoder." in name}
    r1, past1_pre = run_prompt(s1, dt1, prompt, cross)
    past0 = carry(r0, {})
    past1 = past1_pre if past1_pre else carry(r1, {})
    d = logit_diff(r0, r1)
    print(f"  prompt(seq=4): max|diff|={d:.6g}  {'PASS' if d < tol else 'FAIL'}")
    assert d < tol, "parity FAILED (prompt step)"
    dec_len, tok = len(prompt), 55
    for stepno in range(2):
        r0 = step(s0, dt0, [tok], past0, dec_len, enc_len)
        r1 = step(s1, dt1, [tok], past1, dec_len, enc_len, extra=cross)
        past0, past1 = carry(r0, past0), carry(r1, past1)
        d = logit_diff(r0, r1)
        print(f"  decode step {stepno + 1} (past={dec_len}): max|diff|={d:.6g}  {'PASS' if d < tol else 'FAIL'}")
        assert d < tol, "parity FAILED (decode step)"
        dec_len += 1
        tok = int(r0["logits"][0, -1].argmax())
    print("  parity OK")


def encoder_chain_check(orig_enc: str, new_enc: str) -> None:
    """The grafted encoder must (a) leave last_hidden_state IDENTICAL and (b) emit cross_attn.*
    outputs. Runs both encoders on a short random mel clip. Heavy (loads full encoder weights) —
    used behind --check-encoder for selected precisions."""
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    e0 = ort.InferenceSession(orig_enc, so, providers=["CPUExecutionProvider"])
    e1 = ort.InferenceSession(new_enc, so, providers=["CPUExecutionProvider"])
    rng = np.random.RandomState(1)
    dt = np.float16 if "float16" in e0.get_inputs()[0].type else np.float32
    mel = (rng.randn(1, 64, 128) * 0.5).astype(dt)
    h0 = e0.run(["last_hidden_state"], {"input_features": mel})[0]
    outs = [o.name for o in e1.get_outputs()]
    res = dict(zip(outs, e1.run(None, {"input_features": mel})))
    d = float(np.abs(h0.astype(np.float32) - res["last_hidden_state"].astype(np.float32)).max())
    n_cross = sum(1 for o in outs if o.startswith("cross_attn."))
    print(f"  encoder: last_hidden_state max|diff|={d:.6g}  cross outputs={n_cross}")
    assert d == 0.0, "encoder last_hidden_state changed!"
    assert n_cross == 16, f"expected 16 cross outputs, got {n_cross}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, help="HF snapshot dir (contains onnx/ + sidecars)")
    ap.add_argument("--out", required=True, help="output model dir")
    ap.add_argument("--check", action="store_true", help="run CPU parity assertion")
    ap.add_argument("--check-encoder", action="store_true",
                    help="also run the (heavy, loads full weights) encoder-graft assertion")
    args = ap.parse_args()

    src_onnx = os.path.join(args.src, "onnx")
    out_onnx = os.path.join(args.out, "onnx")
    os.makedirs(out_onnx, exist_ok=True)

    # Copy the whole export (break HF-cache hardlinks so onnx can load external data), then rewrite
    # the decoder in place. Encoder + tokenizer + configs are copied verbatim.
    for f in os.listdir(src_onnx):
        shutil.copy2(os.path.join(src_onnx, f), os.path.join(out_onnx, f))
    for f in os.listdir(args.src):
        fp = os.path.join(args.src, f)
        if os.path.isfile(fp):
            shutil.copy2(fp, os.path.join(args.out, f))

    dec = glob.glob(os.path.join(out_onnx, "decoder_model_merged*.onnx"))
    dec = [d for d in dec if not d.endswith("_data")]
    if not dec:
        raise SystemExit(f"no decoder_model_merged*.onnx in {out_onnx}")
    for dst in dec:
        n_mha, n_gqa = decompose_decoder(dst, dst)
        # Pair with the matching-precision encoder and hoist the loop-invariant cross-KV into it.
        sfx = os.path.basename(dst)[len("decoder_model_merged"):-len(".onnx")]
        enc_path = os.path.join(out_onnx, f"encoder_model{sfx}.onnx")
        moved = n_static = n_cross = 0
        dyn_dst = f"{dst[:-len('.onnx')]}_dyn.onnx"
        if os.path.exists(enc_path):
            dm = onnx.load(dst, load_external_data=False)
            # ONE encoder + TWO decoders (both fed by the padded encoder, sharing the decoder sidecar):
            #   hoist  → move loop-invariant cross-KV into the encoder;
            #   bucket → fix the cross length + `cross_bias` (encoder padded ONCE here);
            #   save the DYNAMIC-self decoder (`*_dyn.onnx`, growing self-KV — fastest on the CPU EP);
            #   staticize → fix the self-KV too, save the STATIC decoder (default name — fastest on DML).
            moved = hoist_cross_kv(dm, enc_path, out_onnx)
            n_cross = bucket_cross_kv(dm, enc_path) if moved else 0
            if moved:
                onnx.save(dm, dyn_dst)  # dynamic-self decoder (CPU fallback)
                onnx.checker.check_model(dyn_dst, full_check=False)
            n_static = staticize_kv(dm) if moved else 0
            if moved:
                onnx.save(dm, dst)  # static decoder (DML default)
                onnx.checker.check_model(dst, full_check=False)
        src = os.path.join(src_onnx, os.path.basename(dst))
        probe = enc_path + ".crosskv_probe.onnx"
        # RESILIENCE: verify the STATIC decoder against the source; if it fails (e.g. the Arabic int8
        # export's DynamicQuantizeLinear interacts badly with the fixed-KV masked write), DROP the
        # static graph for this quant and ship the dynamic decoder as the default — the engine then
        # sees no `winstt_static_kv` marker and runs the hybrid (enc-DML / dec-CPU) path. fp32/q4 keep
        # full static; only the affected quant degrades to the (still ~2.7×) hybrid.
        static_ok = True
        if moved and n_static:
            try:
                parity_check(src, dst, probe_path=probe)
            except AssertionError as e:
                static_ok = False
                print(f"  ⚠ static parity FAILED ({e}) — shipping dynamic decoder as default for {sfx or 'fp32'}")
                shutil.copy2(dyn_dst, dst)
                if os.path.exists(dyn_dst):
                    os.remove(dyn_dst)
        if moved and args.check:
            parity_check(src, dyn_dst if static_ok else dst, probe_path=probe)
        print(f"{os.path.basename(dst)}: cross-MHA={n_mha} GQA={n_gqa} hoisted={moved} static-kv={n_static if static_ok else 0} cross-bucket={n_cross}{' (+_dyn)' if static_ok else ' (dynamic-only)'}")
        if os.path.exists(probe):
            os.remove(probe)
        if args.check_encoder and moved:
            encoder_chain_check(os.path.join(src_onnx, f"encoder_model{sfx}.onnx"), enc_path)
    print("done →", args.out)


if __name__ == "__main__":
    main()
