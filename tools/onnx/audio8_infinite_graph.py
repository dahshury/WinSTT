#!/usr/bin/env python3
"""Hand-built ONNX graphs for Audio8-ASR-Infinite (see audio8_infinite_ref.py for the IO contract).

The graphs are emitted node-by-node straight from the (memmapped, bf16) safetensors, one weight at
a time, with every initializer streamed into the external-data file as it is produced. Nothing ever
holds the whole fp32 model in RAM, which is what makes a 4 B-parameter export possible on a box
with single-digit free GB -- `torch.onnx.export` would need the full fp32 module plus its trace.

Precisions (`--precision`):
  fp32  MatMul fp32 weights (parity reference; ~16 GB, not shipped)
  fp16  whole graph fp16 (RMSNorm / softmax / mel in fp32), KV caches fp16, I/O otherwise fp32
  int8  weight-only MatMulNBits (8-bit, asymmetric, block 32, accuracy_level 4), fp32 activations
  int8dq  (comparison only, not shipped) per-channel int8 weights + DynamicQuantizeLinear /
        MatMulInteger, the quantize_dynamic pattern: ONE activation scale per tensor, so the
        result depends on how many frames share a call and Qwen2.5's activation outliers flatten
        the other channels -- measurably worse transcripts than either NBits tier
  int4  weight-only MatMulNBits (4-bit, asymmetric, block 32, accuracy_level 4), fp32 activations
"""
from __future__ import annotations

import math
import os
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper

import audio8_infinite_ref as a8i

OPSET = 17
F32, F16 = TensorProto.FLOAT, TensorProto.FLOAT16
NP = {F32: np.float32, F16: np.float16}


class Graph:
    def __init__(self, path: Path, act: int):
        self.path = Path(path)
        self.data_name = self.path.name + ".data"
        self.data = open(self.path.with_name(self.data_name), "wb")
        self.off = 0
        self.act = act
        self.nodes, self.inits, self.inputs, self.outputs = [], [], [], []
        self.n = 0
        self._consts: dict = {}

    # ---- plumbing ----------------------------------------------------------------------------
    def uid(self, p="t"):
        self.n += 1
        return f"{p}_{self.n}"

    def init(self, name: str, arr: np.ndarray, *, onnx_type=None) -> str:
        arr = np.ascontiguousarray(arr)
        if arr.nbytes < 4096:
            t = onnx.numpy_helper.from_array(arr, name)
            self.inits.append(t)
            return name
        pad = (-self.off) % 4096
        if pad:
            self.data.write(b"\0" * pad)
            self.off += pad
        buf = arr.tobytes()
        self.data.write(buf)
        t = TensorProto()
        t.name = name
        t.data_type = onnx_type if onnx_type is not None else helper.np_dtype_to_tensor_dtype(arr.dtype)
        t.dims.extend(arr.shape)
        t.data_location = TensorProto.EXTERNAL
        for k, v in (("location", self.data_name), ("offset", str(self.off)), ("length", str(len(buf)))):
            e = t.external_data.add()
            e.key, e.value = k, v
        self.off += len(buf)
        self.inits.append(t)
        return name

    def const(self, value, dtype=np.int64) -> str:
        arr = np.asarray(value, dtype=dtype)
        key = (arr.dtype.str, arr.shape, arr.tobytes())
        if key not in self._consts:
            self._consts[key] = self.init(self.uid("c"), arr)
        return self._consts[key]

    def fconst(self, value) -> str:
        return self.const(value, NP[self.act])

    def op(self, op_type, inputs, n_out=1, domain=None, **attrs):
        outs = [self.uid(op_type.lower()) for _ in range(n_out)]
        kw = {"domain": domain} if domain else {}
        self.nodes.append(helper.make_node(op_type, list(inputs), outs, name=self.uid("n_" + op_type), **kw, **attrs))
        return outs[0] if n_out == 1 else outs

    def inp(self, name, dtype, shape):
        self.inputs.append(helper.make_tensor_value_info(name, dtype, shape))
        return name

    def out(self, src, name, dtype, shape):
        self.nodes.append(helper.make_node("Identity", [src], [name], name=self.uid("n_out")))
        self.outputs.append(helper.make_tensor_value_info(name, dtype, shape))

    def finish(self, meta: dict):
        self.data.close()
        g = helper.make_graph(self.nodes, self.path.stem, self.inputs, self.outputs, self.inits)
        opsets = [helper.make_opsetid("", OPSET), helper.make_opsetid("com.microsoft", 1)]
        m = helper.make_model(g, opset_imports=opsets, producer_name="winstt-audio8-infinite-export")
        m.ir_version = 8
        for k, v in meta.items():
            e = m.metadata_props.add()
            e.key, e.value = k, str(v)
        onnx.save(m, str(self.path))

    # ---- math helpers --------------------------------------------------------------------------
    def cast(self, x, to):
        return self.op("Cast", [x], to=to)

    def rms(self, x, w: np.ndarray, eps: float, name: str):
        """x / sqrt(mean(x^2) + eps) * w, computed in fp32 (SimplifiedLayerNorm fusion pattern)."""
        xf = self.cast(x, F32) if self.act != F32 else x
        sq = self.op("Pow", [xf, self.const(2.0, np.float32)])
        mean = self.op("ReduceMean", [sq], axes=[-1], keepdims=1)
        den = self.op("Sqrt", [self.op("Add", [mean, self.const(eps, np.float32)])])
        y = self.op("Div", [xf, den])
        y = self.op("Mul", [y, self.init(name, w.astype(np.float32))])
        return self.cast(y, self.act) if self.act != F32 else y

    def gelu(self, x):
        xf = x
        e = self.op("Erf", [self.op("Div", [xf, self.fconst(math.sqrt(2.0))])])
        return self.op("Mul", [self.op("Mul", [xf, self.op("Add", [e, self.fconst(1.0)])]), self.fconst(0.5)])

    def silu(self, x):
        return self.op("Mul", [x, self.op("Sigmoid", [x])])

    def rope(self, x, cos, sin):
        a, b = self.op("Split", [x], n_out=2, axis=-1)
        rot = self.op("Concat", [self.op("Neg", [b]), a], axis=-1)
        return self.op("Add", [self.op("Mul", [x, cos]), self.op("Mul", [rot, sin])])

    def shape_dim(self, x, i):
        return self.op("Gather", [self.op("Shape", [x]), self.const([i])], axis=0)


class Linear:
    """Emits y = x @ W.T (+ b) in the requested precision."""

    def __init__(self, g: Graph, precision: str, block: int = 32, accuracy_level: int = 4):
        self.g, self.prec, self.block, self.acc = g, precision, block, accuracy_level
        self.count = 0

    def __call__(self, x, W: np.ndarray, b: np.ndarray | None, name: str, quantize: bool = True):
        g = self.g
        N, K = W.shape
        prec = self.prec if quantize else ("fp16" if self.prec == "fp16" else "fp32")
        self.count += 1
        if prec in ("fp32", "fp16"):
            dt = np.float16 if prec == "fp16" else np.float32
            y = g.op("MatMul", [x, g.init(name + ".weight_t", W.T.astype(dt))])
        elif prec == "int8dq":
            # Legacy quantize_dynamic pattern (per-tensor dynamic activations) — comparison only: its
            # activation scale depends on how many frames share a call, and it loses accuracy.
            Wt = W.T.astype(np.float32)  # [K, N]
            scale = np.maximum(np.abs(Wt).max(0), 1e-12) / 127.0
            q = np.clip(np.rint(Wt / scale), -127, 127).astype(np.int8)
            xq, xs, xz = g.op("DynamicQuantizeLinear", [x], n_out=3)
            mm = g.op("MatMulInteger", [xq, g.init(name + ".weight_q8", q), xz,
                                        g.init(name + ".weight_zp8", np.zeros(N, np.int8))])
            s = g.op("Mul", [xs, g.init(name + ".weight_scale", scale.astype(np.float32))])
            y = g.op("Mul", [g.op("Cast", [mm], to=F32), s])
        elif prec == "int4":
            from onnxruntime.capi._pybind_state import quantize_matmul_4bits

            Wt = np.ascontiguousarray(W.T.astype(np.float32))  # [K, N]
            kb = (K + self.block - 1) // self.block
            assert K % self.block == 0, (name, K)
            packed = np.zeros((N, kb, self.block // 2), np.uint8)
            scales = np.zeros((N, kb), np.float32)
            zp = np.zeros((N, (kb + 1) // 2), np.uint8)
            quantize_matmul_4bits(packed, Wt, scales, zp, self.block, N, K, False)
            y = g.op("MatMulNBits", [x, g.init(name + ".weight_q4", packed), g.init(name + ".weight_scales", scales),
                                     g.init(name + ".weight_zp4", zp)], domain="com.microsoft",
                     K=K, N=N, bits=4, block_size=self.block, accuracy_level=self.acc)
        elif prec == "int8":
            # Weight-only 8-bit, block-wise (MatMulNBits bits=8). With accuracy_level 4 the CPU kernel
            # quantizes the ACTIVATIONS per row-block too, so — unlike DynamicQuantizeLinear's single
            # per-tensor scale — the result does not depend on how many frames share a call and
            # Qwen2.5's activation outliers do not flatten every other channel.
            from onnxruntime.capi._pybind_state import quantize_matmul_8bits

            Wt = np.ascontiguousarray(W.T.astype(np.float32))  # [K, N]
            kb = (K + self.block - 1) // self.block
            assert K % self.block == 0, (name, K)
            packed = np.zeros((N, kb, self.block), np.uint8)
            scales = np.zeros((N, kb), np.float32)
            zp = np.zeros((N, kb), np.uint8)
            quantize_matmul_8bits(packed, Wt, scales, zp, self.block, N, K, False)
            y = g.op("MatMulNBits", [x, g.init(name + ".weight_q8", packed), g.init(name + ".weight_scales", scales),
                                     g.init(name + ".weight_zp8", zp)], domain="com.microsoft",
                     K=K, N=N, bits=8, block_size=self.block, accuracy_level=self.acc)
        else:
            raise ValueError(prec)
        if b is not None:
            y = g.op("Add", [y, g.init(name + ".bias", b.astype(NP[g.act]))])
        return y


def attention(g: Graph, q, k_new, v_new, past_k, past_v, bias_f32, *, kv_heads: int, head_dim: int, groups: int):
    """Split-score attention: never concatenates the (large) past cache with the new keys.

    q [1,H,T,D]; k_new/v_new [1,KV,T,D]; past_k/past_v [1,KV,C,D]; bias [T, C+T] (fp32).
    Returns [1,KV,G*T,D] (== [1,H,T,D] after a reshape when G > 1).
    """
    q = g.op("Mul", [q, g.fconst(head_dim ** -0.5)])
    # [1,H,T,D] -> [1,KV,G*T,D]   (heads h*G..h*G+G-1 share kv head h, like repeat_kv)
    qg = g.op("Reshape", [q, g.const([1, kv_heads, -1, head_dim])]) if groups > 1 else q
    sp = g.op("MatMul", [qg, g.op("Transpose", [past_k], perm=[0, 1, 3, 2])])
    sn = g.op("MatMul", [qg, g.op("Transpose", [k_new], perm=[0, 1, 3, 2])])
    s = g.op("Concat", [sp, sn], axis=-1)
    if g.act != F32:
        s = g.cast(s, F32)
    if groups > 1:
        # [1,KV,G*T,S] -> [1,KV,G,T,S] so the [T,S] bias broadcasts
        s5 = g.op("Reshape", [s, g.op("Concat", [g.const([1, kv_heads, groups]), g.op("Shape", [bias_f32])], axis=0)])
        p = g.op("Softmax", [g.op("Add", [s5, bias_f32])], axis=-1)
        p = g.op("Reshape", [p, g.op("Shape", [s])])
    else:
        p = g.op("Softmax", [g.op("Add", [s, bias_f32])], axis=-1)
    if g.act != F32:
        p = g.cast(p, g.act)
    C = g.shape_dim(past_k, 2)
    pp = g.op("Slice", [p, g.const([0]), C, g.const([-1])])
    pn = g.op("Slice", [p, C, g.const([1 << 40]), g.const([-1])])
    return g.op("Add", [g.op("MatMul", [pp, past_v]), g.op("MatMul", [pn, v_new])])


def heads(g: Graph, x, n_heads: int, head_dim: int):
    """[1,T,H*D] -> [1,H,T,D]"""
    r = g.op("Reshape", [x, g.const([1, -1, n_heads, head_dim])])
    return g.op("Transpose", [r], perm=[0, 2, 1, 3])


def merge(g: Graph, x, width: int):
    """[1,H,T,D] -> [1,T,H*D]"""
    t = g.op("Transpose", [x], perm=[0, 2, 1, 3])
    return g.op("Reshape", [t, g.const([1, -1, width])])


# ================================================================================================
def build_encoder(W, dims: a8i.Dims, precision: str, path: Path, block: int = 32):
    act = F16 if precision == "fp16" else F32
    kv = act
    g = Graph(path, act)
    lin = Linear(g, precision, block)
    d = dims
    audio = g.inp("audio", F32, ["batch", "samples"])
    frame_len = g.inp("frame_len", TensorProto.INT64, [1])
    cos = g.inp("cos", F32, ["frames", d.a_head_dim])
    sin = g.inp("sin", F32, ["frames", d.a_head_dim])
    bias = g.inp("attn_bias", F32, ["frames", "past_plus_frames"])
    past = []
    for i in range(d.a_layers):
        pk = g.inp(f"past_key_{i}", kv, [1, d.a_heads, "past", d.a_head_dim])
        pv = g.inp(f"past_value_{i}", kv, [1, d.a_heads, "past", d.a_head_dim])
        past.append((pk, pv))
    if act != F32:
        cos_a, sin_a = g.cast(cos, act), g.cast(sin, act)
    else:
        cos_a, sin_a = cos, sin

    # ---- log-mel (fp32): reflect pad, DFT-as-conv, power, mel, log10 floor ----
    a3 = g.op("Unsqueeze", [audio, g.const([1])])  # [B,1,S]
    padded = g.op("Pad", [a3, g.const([0, 0, N_FFT_HALF, 0, 0, N_FFT_HALF])], mode="reflect")
    spec = g.op("Conv", [padded, g.init("frontend.dft_basis", a8i.dft_basis())], strides=[a8i.HOP])  # [B,402,F]
    F_ = g.shape_dim(spec, 2)
    spec = g.op("Slice", [spec, g.const([0]), g.op("Sub", [F_, g.const([1])]), g.const([2])])
    sq = g.op("Mul", [spec, spec])
    re, im = g.op("Split", [sq], n_out=2, axis=1)
    power = g.op("Add", [re, im])  # [B,201,F-1]
    mel = g.op("MatMul", [g.init("frontend.mel_filters_t", a8i.mel_filters().T.copy()), power])  # [B,128,F-1]
    lg = g.op("Div", [g.op("Log", [g.op("Max", [mel, g.const(1e-10, np.float32)])]), g.const(math.log(10.0), np.float32)])
    lg = g.op("Max", [lg, g.const(a8i.LOG_MEL_FLOOR, np.float32)])
    feats = g.op("Div", [g.op("Add", [lg, g.const(4.0, np.float32)]), g.const(4.0, np.float32)])
    if act != F32:
        feats = g.cast(feats, act)
    dt = NP[act]
    c1 = g.op("Conv", [feats, g.init("embedder.conv1.weight", W["audio_tower.embedder.conv1.weight"].astype(dt)),
                       g.init("embedder.conv1.bias", W["audio_tower.embedder.conv1.bias"].astype(dt))], pads=[2, 0])
    c1 = g.gelu(c1)
    c2 = g.op("Conv", [c1, g.init("embedder.conv2.weight", W["audio_tower.embedder.conv2.weight"].astype(dt)),
                       g.init("embedder.conv2.bias", W["audio_tower.embedder.conv2.bias"].astype(dt))],
              pads=[1, 0], strides=[2])
    c2 = g.gelu(c2)  # [B,1280,Fc]
    x = g.op("Transpose", [c2], perm=[0, 2, 1])  # [B,Fc,1280]
    B = g.shape_dim(audio, 0)
    T = g.shape_dim(cos, 0)
    Kw = g.op("Div", [T, B])
    x = g.op("Slice", [x, g.op("Neg", [Kw]), g.const([1 << 40]), g.const([1])])
    x = g.op("Reshape", [x, g.const([1, -1, d.a_hidden])])  # [1,T,1280]

    width = d.a_heads * d.a_head_dim
    for i in range(d.a_layers):
        p = f"audio_tower.layers.{i}."
        h = g.rms(x, W[p + "self_attn_layer_norm.weight"], d.a_eps, f"enc.{i}.ln1")
        q = heads(g, lin(h, W[p + "self_attn.q_proj.weight"], W[p + "self_attn.q_proj.bias"], f"enc.{i}.q"), d.a_heads, d.a_head_dim)
        k = heads(g, lin(h, W[p + "self_attn.k_proj.weight"], None, f"enc.{i}.k"), d.a_heads, d.a_head_dim)
        v = heads(g, lin(h, W[p + "self_attn.v_proj.weight"], W[p + "self_attn.v_proj.bias"], f"enc.{i}.v"), d.a_heads, d.a_head_dim)
        q, k = g.rope(q, cos_a, sin_a), g.rope(k, cos_a, sin_a)
        g.out(k, f"key_{i}", kv, [1, d.a_heads, "frames", d.a_head_dim])
        g.out(v, f"value_{i}", kv, [1, d.a_heads, "frames", d.a_head_dim])
        o = attention(g, q, k, v, past[i][0], past[i][1], bias, kv_heads=d.a_heads, head_dim=d.a_head_dim, groups=1)
        o = merge(g, o, width)
        x = g.op("Add", [x, lin(o, W[p + "self_attn.o_proj.weight"], W[p + "self_attn.o_proj.bias"], f"enc.{i}.o")])
        h = g.rms(x, W[p + "final_layer_norm.weight"], d.a_eps, f"enc.{i}.ln2")
        gt = lin(h, W[p + "mlp.gate_proj.weight"], None, f"enc.{i}.gate")
        up = lin(h, W[p + "mlp.up_proj.weight"], None, f"enc.{i}.up")
        x = g.op("Add", [x, lin(g.op("Mul", [g.silu(gt), up]), W[p + "mlp.down_proj.weight"], W[p + "mlp.down_proj.bias"], f"enc.{i}.down")])
    x = g.rms(x, W["audio_tower.norm.weight"], d.a_eps, "enc.norm")
    # group frame_len frames per token, zero-pad to max_frame_len slots, project
    grp = g.op("Reshape", [x, g.op("Concat", [g.const([-1]), g.op("Mul", [frame_len, g.const([d.a_hidden])])], axis=0)])
    padw = g.op("Sub", [g.const([d.projection]), g.op("Mul", [frame_len, g.const([d.a_hidden])])])
    grp = g.op("Pad", [grp, g.op("Concat", [g.const([0, 0, 0]), padw], axis=0)])
    e = lin(grp, W["multi_modal_projector.linear_1.weight"], None, "proj.1")
    e = lin(g.gelu(e), W["multi_modal_projector.linear_2.weight"], None, "proj.2")
    e = g.op("Unsqueeze", [e, g.const([0])])
    if act != F32:
        e = g.cast(e, F32)
    g.out(e, "audio_embeds", F32, [1, "tokens", d.t_hidden])
    g.finish({"winstt_audio8_infinite": "audio_encoder", "precision": precision,
              "sliding_window": d.a_window, "rope_theta": d.a_theta, "head_dim": d.a_head_dim})
    return lin.count


N_FFT_HALF = a8i.N_FFT // 2


def build_decoder(W, dims: a8i.Dims, precision: str, path: Path, block: int = 32, layers=None, head=True):
    """layers=(start, end) builds a shard (for fp32 parity on low-RAM boxes): a shard that does not
    start at 0 takes `hidden` instead of `inputs_embeds`; one without `head` outputs `hidden`."""
    act = F16 if precision == "fp16" else F32
    kv = act
    g = Graph(path, act)
    lin = Linear(g, precision, block)
    d = dims
    l0, l1 = layers or (0, d.t_layers)
    x_in = g.inp("inputs_embeds" if l0 == 0 else "hidden", F32, [1, "n", d.t_hidden])
    ada = g.inp("ada_scale", F32, [d.t_layers, d.t_hidden])
    cos = g.inp("cos", F32, ["n", d.t_head_dim])
    sin = g.inp("sin", F32, ["n", d.t_head_dim])
    bias = g.inp("attn_bias", F32, ["n", "past_plus_n"])
    past = {}
    for i in range(l0, l1):
        past[i] = (g.inp(f"past_key_{i}", kv, [1, d.t_kv, "past", d.t_head_dim]),
                   g.inp(f"past_value_{i}", kv, [1, d.t_kv, "past", d.t_head_dim]))
    x = g.cast(x_in, act) if act != F32 else x_in
    cos_a, sin_a = (g.cast(cos, act), g.cast(sin, act)) if act != F32 else (cos, sin)
    ada_a = g.cast(ada, act) if act != F32 else ada
    groups = d.t_heads // d.t_kv
    width = d.t_heads * d.t_head_dim
    for i in range(l0, l1):
        p = f"language_model.model.layers.{i}."
        h = g.rms(x, W[p + "input_layernorm.weight"], d.t_eps, f"dec.{i}.ln1")
        q = heads(g, lin(h, W[p + "self_attn.q_proj.weight"], W[p + "self_attn.q_proj.bias"], f"dec.{i}.q"), d.t_heads, d.t_head_dim)
        k = heads(g, lin(h, W[p + "self_attn.k_proj.weight"], W[p + "self_attn.k_proj.bias"], f"dec.{i}.k"), d.t_kv, d.t_head_dim)
        v = heads(g, lin(h, W[p + "self_attn.v_proj.weight"], W[p + "self_attn.v_proj.bias"], f"dec.{i}.v"), d.t_kv, d.t_head_dim)
        q, k = g.rope(q, cos_a, sin_a), g.rope(k, cos_a, sin_a)
        g.out(k, f"key_{i}", kv, [1, d.t_kv, "n", d.t_head_dim])
        g.out(v, f"value_{i}", kv, [1, d.t_kv, "n", d.t_head_dim])
        o = attention(g, q, k, v, past[i][0], past[i][1], bias, kv_heads=d.t_kv, head_dim=d.t_head_dim, groups=groups)
        if groups > 1:
            o = g.op("Reshape", [o, g.const([1, d.t_heads, -1, d.t_head_dim])])
        o = merge(g, o, width)
        x = g.op("Add", [x, lin(o, W[p + "self_attn.o_proj.weight"], None, f"dec.{i}.o")])
        h = g.rms(x, W[p + "post_attention_layernorm.weight"], d.t_eps, f"dec.{i}.ln2")
        row = g.op("Gather", [ada_a, g.const(i)], axis=0)  # [2048]
        h = g.op("Mul", [h, row])
        gt = lin(h, W[p + "mlp.gate_proj.weight"], None, f"dec.{i}.gate")
        up = lin(h, W[p + "mlp.up_proj.weight"], None, f"dec.{i}.up")
        x = g.op("Add", [x, lin(g.op("Mul", [g.silu(gt), up]), W[p + "mlp.down_proj.weight"], None, f"dec.{i}.down")])
    if head:
        x = g.rms(x, W["language_model.model.norm.weight"], d.t_eps, "dec.norm")
        n = g.shape_dim(x, 1)
        last = g.op("Slice", [x, g.op("Sub", [n, g.const([1])]), n, g.const([1])])  # [1,1,2048]
        last = g.op("Reshape", [last, g.const([1, d.t_hidden])])
        emb = W["language_model.model.embed_tokens.weight"]
        logits = lin(last, emb, None, "lm_head")
        if act != F32:
            logits = g.cast(logits, F32)
        g.out(logits, "logits", F32, [1, d.vocab])
        vw = np.concatenate([W[f"semantic_vad_heads.{j}.weight"] for j in range(d.vad_heads)], 0)
        vb = np.concatenate([W[f"semantic_vad_heads.{j}.bias"] for j in range(d.vad_heads)], 0)
        lastf = g.cast(last, F32) if act != F32 else last
        gv = g.op("Add", [g.op("MatMul", [lastf, g.init("vad.weight_t", vw.T.astype(np.float32))]),
                          g.init("vad.bias", vb.astype(np.float32))])
        g.out(g.op("Reshape", [gv, g.const([1, d.vad_heads, d.vad_classes])]), "vad_logits", F32,
              [1, d.vad_heads, d.vad_classes])
    else:
        xo = g.cast(x, F32) if act != F32 else x
        g.out(xo, "hidden", F32, [1, "n", d.t_hidden])
    g.finish({"winstt_audio8_infinite": "decoder", "precision": precision, "layers": f"{l0}:{l1}",
              "rope_theta": d.t_theta, "head_dim": d.t_head_dim})
    return lin.count


# ------------------------------------------------------------------------------------------------
class OrtBackend:
    """Session backend over the exported graphs (numpy in/out)."""

    def __init__(self, enc_path, dec_paths, providers=("CPUExecutionProvider",), threads=None, opt_dir=None):
        import onnxruntime as ort

        so = ort.SessionOptions()
        if threads:
            so.intra_op_num_threads = threads
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.enc = ort.InferenceSession(str(enc_path), so, providers=list(providers)) if enc_path else None
        self.decs = [ort.InferenceSession(str(p), so, providers=list(providers)) for p in (dec_paths or [])]
        self.kv_dtype = {}
        for s in ([self.enc] if self.enc else []) + self.decs:
            for i in s.get_inputs():
                if i.name.startswith("past_key_"):
                    self.kv_dtype[id(s)] = np.float16 if "float16" in i.type else np.float32
                    break

    def encoder(self, audio, frame_len, cos, sin, bias, past_k, past_v):
        dt = self.kv_dtype[id(self.enc)]
        feed = {"audio": audio, "frame_len": np.array([frame_len], np.int64), "cos": cos, "sin": sin, "attn_bias": bias}
        L = len(past_k)
        for i in range(L):
            feed[f"past_key_{i}"] = past_k[i].astype(dt, copy=False)
            feed[f"past_value_{i}"] = past_v[i].astype(dt, copy=False)
        names = ["audio_embeds"] + [f"key_{i}" for i in range(L)] + [f"value_{i}" for i in range(L)]
        outs = self.enc.run(names, feed)
        return outs[0], [o.astype(np.float32) for o in outs[1:1 + L]], [o.astype(np.float32) for o in outs[1 + L:]]

    def decoder(self, embeds, ada, cos, sin, bias, past_k, past_v, all_logits=False):
        assert not all_logits, "ORT decoder returns last-position logits only"
        x = embeds.astype(np.float32)
        nk, nv = [], []
        logits = vad = None
        for s in self.decs:
            dt = self.kv_dtype[id(s)]
            names_in = {i.name for i in s.get_inputs()}
            feed = {("inputs_embeds" if "inputs_embeds" in names_in else "hidden"): x, "ada_scale": ada,
                    "cos": cos, "sin": sin, "attn_bias": bias}
            layers = sorted(int(n.split("_")[-1]) for n in names_in if n.startswith("past_key_"))
            for i in layers:
                feed[f"past_key_{i}"] = past_k[i].astype(dt, copy=False)
                feed[f"past_value_{i}"] = past_v[i].astype(dt, copy=False)
            out_names = [o.name for o in s.get_outputs()]
            res = dict(zip(out_names, s.run(out_names, feed)))
            for i in layers:
                nk.append(res[f"key_{i}"].astype(np.float32))
                nv.append(res[f"value_{i}"].astype(np.float32))
            if "hidden" in res:
                x = res["hidden"]
            else:
                logits, vad = res["logits"], res["vad_logits"]
        return logits, vad, nk, nv
