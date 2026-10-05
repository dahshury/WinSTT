#!/usr/bin/env python3
"""Audio8-ASR-Infinite -> ONNX: weight reader, torch reference, graph builder, streaming session.

One module so the export, the parity harness and the (Rust-mirroring) streaming session share a
single definition of the graph contract.

GRAPH CONTRACT
--------------
audio_encoder.onnx  (mel + causal conv embedder + 32-layer sliding-window tower + projector)
  in : audio        f32 [B, S]          B raw 16 kHz windows of equal length S (one per text token
                                         group, the reference `streaming_audio_embeds_by_definition`
                                         window incl. its 52.5 ms look-back / 2.5 ms look-ahead)
       frame_len    i64 [1]             encoder frames per text token (4 = 80 ms gear)
       cos, sin     f32 [T, 64]         RoPE factors of the T = B*K new encoder frames (host f64)
       attn_bias    f32 [T, C + T]      additive mask: past ring slots then the new frames
       past_key_i   f32 [1, 32, C, 64]  ring of ROTATED keys (any slot order; C = 749 fixed)
       past_value_i f32 [1, 32, C, 64]
  out: audio_embeds f32 [1, T/frame_len, 2048]
       key_i, value_i f32 [1, 32, T, 64]  rotated keys / values of the new frames

decoder.onnx  (Qwen2.5-3B text backbone with Voxtral delay modulation + tied LM head + VAD heads)
  in : inputs_embeds f32 [1, n, 2048]   token embedding (host table) + audio embedding
       ada_scale     f32 [36, 2048]      per-layer (1 + ada_rms_norm(t_cond)) -- constant per session
       cos, sin      f32 [n, 128]
       attn_bias     f32 [n, L + n]
       past_key_i    f32 [1, 2, L, 128]  rotated keys (L = 375 fixed capacity, masked when empty)
       past_value_i  f32 [1, 2, L, 128]
  out: logits        f32 [1, 151936]     last position only
       vad_logits    f32 [1, 4, 8]       semantic-VAD heads (horizons 0.5/1/2/3 s), last position
       key_i, value_i f32 [1, 2, n, 128]

Keys are stored ALREADY ROTATED with host-computed (f64, reduced mod 2*pi) angles, so no cache ever
needs re-rotation except the decoder's rolling-window trim (suffix re-based by -trim positions).
"""
from __future__ import annotations

import json
import math
import os
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

# ----------------------------------------------------------------------------------------------
# constants (from config.json of Edge0/Audio8-ASR-Infinite)
# ----------------------------------------------------------------------------------------------
SR = 16000
N_FFT = 400
HOP = 160
N_MELS = 128
LOG_MEL_FLOOR = 1.5 - 8.0
BOS, EOS, PAD = 151644, 151645, 151643
STREAM_PAD, STREAM_WORD, LANG_ZH, LANG_EN = 151665, 151666, 151667, 151668
VOCAB = 151936
LOOK_BACK = 840  # 52.5 ms
LOOK_AHEAD = 40  # 2.5 ms
RIGHT_PAD_TEXT_TOKENS = 10
LEFT_PAD_BY_FL = {4: 18, 6: 12, 8: 9}
DELAYS_BY_FL = {4: {240: 3, 320: 4, 480: 6, 560: 7}, 6: {240: 2, 480: 4}, 8: {320: 2, 480: 3}}
SUPPORTED_FL = (4, 6, 8)
MAX_FL = 8
VAD_HORIZONS = (0.5, 1.0, 2.0, 3.0)
# vLLM / MLX rolling 30 s window
ROLL_CONTEXT = 375
ROLL_TRIM = 38
ROLL_STABLE = 16


@dataclass
class Dims:
    a_hidden: int = 1280
    a_layers: int = 32
    a_heads: int = 32
    a_head_dim: int = 64
    a_inter: int = 5120
    a_eps: float = 1e-5
    a_theta: float = 1e6
    a_window: int = 750
    t_hidden: int = 2048
    t_layers: int = 36
    t_heads: int = 16
    t_kv: int = 2
    t_head_dim: int = 128
    t_inter: int = 11008
    t_eps: float = 1e-6
    t_theta: float = 1e6
    vocab: int = VOCAB
    n_mels: int = N_MELS
    vad_heads: int = 4
    vad_classes: int = 8

    @property
    def projection(self) -> int:
        return MAX_FL * self.a_hidden

    @property
    def enc_cache(self) -> int:
        return self.a_window - 1

    @classmethod
    def from_config(cls, cfg: dict) -> "Dims":
        a, t = cfg["audio_config"], cfg["text_config"]
        return cls(
            a_hidden=a["hidden_size"], a_layers=a["num_hidden_layers"], a_heads=a["num_attention_heads"],
            a_head_dim=a.get("head_dim") or a["hidden_size"] // a["num_attention_heads"],
            a_inter=a["intermediate_size"], a_eps=a["rms_norm_eps"],
            a_theta=a["rope_parameters"]["rope_theta"], a_window=a["sliding_window"],
            t_hidden=t["hidden_size"], t_layers=t["num_hidden_layers"], t_heads=t["num_attention_heads"],
            t_kv=t["num_key_value_heads"], t_head_dim=t.get("head_dim") or t["hidden_size"] // t["num_attention_heads"],
            t_inter=t["intermediate_size"], t_eps=t["rms_norm_eps"], t_theta=t["rope_parameters"]["rope_theta"],
            vocab=t["vocab_size"], n_mels=a["num_mel_bins"],
            vad_heads=len(cfg.get("semantic_vad_horizons_seconds") or VAD_HORIZONS),
            vad_classes=cfg.get("semantic_vad_num_classes", 8),
        )


# ----------------------------------------------------------------------------------------------
# weights: zero-copy safetensors memmap (bf16 upcast on access)
# ----------------------------------------------------------------------------------------------
_ST_DT = {"BF16": (np.uint16, "bf16"), "F32": (np.float32, None), "F16": (np.float16, None)}


class SafeTensors:
    """name -> float32 ndarray, reading lazily from memmapped safetensors files."""

    def __init__(self, paths: list[str | Path]):
        self.index: dict[str, tuple[np.memmap, str, list[int], int, int]] = {}
        for p in paths:
            with open(p, "rb") as f:
                (hlen,) = struct.unpack("<Q", f.read(8))
                header = json.loads(f.read(hlen))
            mm = np.memmap(p, dtype=np.uint8, mode="r")
            base = 8 + hlen
            for name, meta in header.items():
                if name == "__metadata__":
                    continue
                s, e = meta["data_offsets"]
                self.index[name] = (mm, meta["dtype"], meta["shape"], base + s, base + e)

    def __contains__(self, name: str) -> bool:
        return name in self.index

    def raw(self, name: str) -> tuple[np.ndarray, str]:
        mm, dt, shape, s, e = self.index[name]
        np_dt, tag = _ST_DT[dt]
        return mm[s:e].view(np_dt).reshape(shape), (tag or dt)

    def __getitem__(self, name: str) -> np.ndarray:
        arr, tag = self.raw(name)
        if tag == "bf16":
            return (arr.astype(np.uint32) << 16).view(np.float32)
        return np.asarray(arr, dtype=np.float32)

    def keys(self):
        return self.index.keys()


class DictWeights(dict):
    """Same interface for in-memory weights (tiny-config tests)."""

    def raw(self, name):
        return self[name], "F32"


def load_weights(ckpt: Path):
    files = sorted(Path(ckpt).glob("model*.safetensors"))
    vad = Path(ckpt) / "semantic_vad_heads.safetensors"
    st = SafeTensors(files + ([vad] if vad.exists() else []))
    return st


# ----------------------------------------------------------------------------------------------
# frontend constants
# ----------------------------------------------------------------------------------------------
def mel_filters() -> np.ndarray:
    """[201, 128] slaney mel bank (VoxtralRealtimeFeatureExtractor)."""
    from transformers.audio_utils import mel_filter_bank

    return mel_filter_bank(
        num_frequency_bins=1 + N_FFT // 2, num_mel_filters=N_MELS, min_frequency=0.0,
        max_frequency=8000.0, sampling_rate=SR, norm="slaney", mel_scale="slaney",
    ).astype(np.float32)


def dft_basis() -> np.ndarray:
    """[2*201, 1, 400] periodic-Hann-windowed real/imag DFT rows as Conv1d kernels."""
    n = np.arange(N_FFT, dtype=np.float64)
    win = 0.5 - 0.5 * np.cos(2 * np.pi * n / N_FFT)  # torch.hann_window(periodic=True)
    k = np.arange(N_FFT // 2 + 1, dtype=np.float64)[:, None]
    ang = 2 * np.pi * k * n[None, :] / N_FFT
    re = np.cos(ang) * win
    im = -np.sin(ang) * win
    return np.concatenate([re, im], 0)[:, None, :].astype(np.float32)


def rope_inv_freq(head_dim: int, theta: float) -> np.ndarray:
    return 1.0 / (theta ** (np.arange(0, head_dim, 2, dtype=np.float64) / head_dim))


def rope_cos_sin(positions, head_dim: int, theta: float) -> tuple[np.ndarray, np.ndarray]:
    """f64 angles reduced mod 2*pi -> f32 [n, head_dim] (rotate_half layout)."""
    pos = np.asarray(positions, dtype=np.float64)[:, None]
    ang = np.mod(pos * rope_inv_freq(head_dim, theta)[None, :], 2 * np.pi)
    ang = np.concatenate([ang, ang], -1)
    return np.cos(ang).astype(np.float32), np.sin(ang).astype(np.float32)


def modulation(W, dims: Dims, delay_tokens: int, frame_len: int) -> np.ndarray:
    """[t_layers, t_hidden] = 1 + ada_rms_norm(t_cond) per layer (constant per session)."""
    import torch

    h = dims.t_hidden
    inv = torch.exp(-math.log(10000.0) * torch.arange(h // 2).float() / (h // 2))
    phase = float(delay_tokens) * inv
    t = torch.cat([phase.cos(), phase.sin()])
    t = t + torch.from_numpy(W["frame_len_embedding.weight"][SUPPORTED_FL.index(frame_len)].copy())
    out = []
    for i in range(dims.t_layers):
        p = f"language_model.model.layers.{i}.ada_rms_norm."
        w1 = torch.from_numpy(W[p + "linear1.weight"].copy())
        w2 = torch.from_numpy(W[p + "linear2.weight"].copy())
        out.append(1.0 + (torch.nn.functional.gelu(t @ w1.T) @ w2.T))
    return torch.stack(out).numpy().astype(np.float32)


def embed_rows(W, ids) -> np.ndarray:
    """Exact bf16 -> f32 token embedding rows."""
    arr, tag = W.raw("language_model.model.embed_tokens.weight")
    rows = np.asarray(arr[np.asarray(ids)])
    if tag == "bf16":
        return (rows.astype(np.uint32) << 16).view(np.float32)
    return rows.astype(np.float32)


# ----------------------------------------------------------------------------------------------
# torch functional reference (same contract as the ONNX graphs, fp32 math)
# ----------------------------------------------------------------------------------------------
class TorchRef:
    def __init__(self, W, dims: Dims):
        import torch

        self.torch = torch
        self.W = W
        self.d = dims
        self._mel = torch.from_numpy(mel_filters())
        self._cache: dict[str, "torch.Tensor"] = {}

    def w(self, name):
        t = self._cache.get(name)
        if t is None:
            t = self.torch.from_numpy(np.ascontiguousarray(self.W[name]))
        return t

    def keep(self, names):
        for n in names:
            self._cache[n] = self.torch.from_numpy(np.ascontiguousarray(self.W[n]))

    @staticmethod
    def rms(x, w, eps):
        return x * (x.pow(2).mean(-1, keepdim=True) + eps).rsqrt() * w

    @staticmethod
    def rot(x, cos, sin):
        import torch

        h = x.shape[-1] // 2
        return x * cos + torch.cat([-x[..., h:], x[..., :h]], -1) * sin

    def lin(self, x, name, bias=True):
        y = x @ self.w(name + ".weight").T
        if bias and (name + ".bias") in self.W:
            y = y + self.w(name + ".bias")
        return y

    def mel(self, audio):
        torch = self.torch
        st = torch.stft(audio, N_FFT, HOP, window=torch.hann_window(N_FFT), return_complex=True, center=True)
        mag = st[..., :-1].abs() ** 2
        m = self._mel.T @ mag
        lg = torch.clamp(m, min=1e-10).log10()
        lg = torch.maximum(lg, torch.tensor(LOG_MEL_FLOOR))
        return (lg + 4.0) / 4.0

    def attend(self, q, k_new, v_new, past_k, past_v, bias, groups):
        """q [1,H,T,D]; k/v [1,KV,*,D]; bias [T, C+T]."""
        torch = self.torch
        k = torch.cat([past_k, k_new], 2)
        v = torch.cat([past_v, v_new], 2)
        if groups > 1:
            k = k.repeat_interleave(groups, 1)
            v = v.repeat_interleave(groups, 1)
        s = (q @ k.transpose(-1, -2)) * (q.shape[-1] ** -0.5) + bias
        return torch.softmax(s, -1) @ v

    def encoder(self, audio, frame_len, cos, sin, attn_bias, past_k, past_v):
        torch, d = self.torch, self.d
        F = torch.nn.functional
        audio = torch.as_tensor(audio)
        B = audio.shape[0]
        T = cos.shape[0]
        K = T // B
        x = self.mel(audio)  # [B,128,F]
        x = F.gelu(F.conv1d(F.pad(x, (2, 0)), self.w("audio_tower.embedder.conv1.weight"), self.w("audio_tower.embedder.conv1.bias")))
        x = F.gelu(F.conv1d(F.pad(x, (1, 0)), self.w("audio_tower.embedder.conv2.weight"), self.w("audio_tower.embedder.conv2.bias"), stride=2))
        x = x.transpose(1, 2)[:, -K:, :].reshape(1, T, d.a_hidden)
        cos, sin = torch.as_tensor(cos), torch.as_tensor(sin)
        bias = torch.as_tensor(attn_bias)
        new_k, new_v = [], []
        for i in range(d.a_layers):
            p = f"audio_tower.layers.{i}."
            h = self.rms(x, self.w(p + "self_attn_layer_norm.weight"), d.a_eps)
            q = self.lin(h, p + "self_attn.q_proj").view(1, T, d.a_heads, d.a_head_dim).transpose(1, 2)
            k = self.lin(h, p + "self_attn.k_proj").view(1, T, d.a_heads, d.a_head_dim).transpose(1, 2)
            v = self.lin(h, p + "self_attn.v_proj").view(1, T, d.a_heads, d.a_head_dim).transpose(1, 2)
            q, k = self.rot(q, cos, sin), self.rot(k, cos, sin)
            new_k.append(k)
            new_v.append(v)
            o = self.attend(q, k, v, torch.as_tensor(past_k[i]), torch.as_tensor(past_v[i]), bias, 1)
            o = o.transpose(1, 2).reshape(1, T, -1)
            x = x + self.lin(o, p + "self_attn.o_proj")
            h = self.rms(x, self.w(p + "final_layer_norm.weight"), d.a_eps)
            g = self.lin(h, p + "mlp.gate_proj")
            u = self.lin(h, p + "mlp.up_proj")
            x = x + self.lin(F.silu(g) * u, p + "mlp.down_proj")
        x = self.rms(x, self.w("audio_tower.norm.weight"), d.a_eps)
        g = x.reshape(T // frame_len, frame_len * d.a_hidden)
        g = F.pad(g, (0, d.projection - frame_len * d.a_hidden))
        e = self.lin(F.gelu(self.lin(g, "multi_modal_projector.linear_1")), "multi_modal_projector.linear_2")
        return e[None], new_k, new_v

    def decoder(self, embeds, ada, cos, sin, attn_bias, past_k, past_v, all_logits=False):
        torch, d = self.torch, self.d
        F = torch.nn.functional
        x = torch.as_tensor(embeds)
        n = x.shape[1]
        ada = torch.as_tensor(ada)
        cos, sin = torch.as_tensor(cos), torch.as_tensor(sin)
        bias = torch.as_tensor(attn_bias)
        new_k, new_v = [], []
        for i in range(d.t_layers):
            p = f"language_model.model.layers.{i}."
            h = self.rms(x, self.w(p + "input_layernorm.weight"), d.t_eps)
            q = self.lin(h, p + "self_attn.q_proj").view(1, n, d.t_heads, d.t_head_dim).transpose(1, 2)
            k = self.lin(h, p + "self_attn.k_proj").view(1, n, d.t_kv, d.t_head_dim).transpose(1, 2)
            v = self.lin(h, p + "self_attn.v_proj").view(1, n, d.t_kv, d.t_head_dim).transpose(1, 2)
            q, k = self.rot(q, cos, sin), self.rot(k, cos, sin)
            new_k.append(k)
            new_v.append(v)
            o = self.attend(q, k, v, torch.as_tensor(past_k[i]), torch.as_tensor(past_v[i]), bias, d.t_heads // d.t_kv)
            o = o.transpose(1, 2).reshape(1, n, -1)
            x = x + self.lin(o, p + "self_attn.o_proj")
            h = self.rms(x, self.w(p + "post_attention_layernorm.weight"), d.t_eps) * ada[i]
            g = self.lin(h, p + "mlp.gate_proj")
            u = self.lin(h, p + "mlp.up_proj")
            x = x + self.lin(F.silu(g) * u, p + "mlp.down_proj")
        x = self.rms(x, self.w("language_model.model.norm.weight"), d.t_eps)
        last = x if all_logits else x[:, -1:]
        logits = last @ self.w("language_model.model.embed_tokens.weight").T
        vad = torch.stack([self.lin(last, f"semantic_vad_heads.{j}") for j in range(d.vad_heads)], -2)
        if not all_logits:
            logits, vad = logits[:, 0], vad[:, 0]
        return logits, vad, new_k, new_v


# ----------------------------------------------------------------------------------------------
# streaming session (mirrors the Rust engine)
# ----------------------------------------------------------------------------------------------
NEG = np.float32(-1e9)  # finite "-inf" keeps fully-masked padding rows NaN-free


@dataclass
class StepLog:
    tokens: list = field(default_factory=list)
    logits: list = field(default_factory=list)
    vad: list = field(default_factory=list)


class Session:
    """HF-reference streaming definition (prefill = left_pad + delay + 1) + rolling 30 s window.

    backend.encoder(audio[B,S], frame_len, cos, sin, bias, past_k, past_v) -> (embeds, new_k, new_v)
    backend.decoder(embeds, ada, cos, sin, bias, past_k, past_v) -> (logits, vad, new_k, new_v)
    (numpy in / numpy-or-torch out).
    """

    def __init__(self, backend, W, dims: Dims, *, delay_tokens=6, frame_len=4, language=LANG_EN,
                 rolling=True, ada=None, enc_batch=1, keep_logits=False):
        self.b, self.W, self.d = backend, W, dims
        self.fl = frame_len
        self.P = 320 * frame_len
        self.left = LEFT_PAD_BY_FL[frame_len]
        self.delay = delay_tokens
        self.prefill = self.left + delay_tokens + 1
        self.lang = language
        self.rolling = rolling
        self.enc_batch = enc_batch
        self.keep_logits = keep_logits
        self.ada = modulation(W, dims, delay_tokens, frame_len) if ada is None else ada
        C, L = dims.enc_cache, ROLL_CONTEXT
        self.C = C
        self.ek = [np.zeros((1, dims.a_heads, C, dims.a_head_dim), np.float32) for _ in range(dims.a_layers)]
        self.ev = [np.zeros_like(self.ek[0]) for _ in range(dims.a_layers)]
        self.epos = np.full(C, -1, np.int64)
        self.enc_frames = 0
        self.L = L if rolling else 4096
        self.dk = [np.zeros((1, dims.t_kv, self.L, dims.t_head_dim), np.float32) for _ in range(dims.t_layers)]
        self.dv = [np.zeros_like(self.dk[0]) for _ in range(dims.t_layers)]
        self.dlen = 0
        self.trims = 0
        self.log = StepLog()

    # -- encoder ---------------------------------------------------------------------------
    def window_bounds(self, k: int) -> tuple[int, int]:
        if k == 0:
            return 0, self.prefill * self.P + LOOK_AHEAD
        return (self.prefill + k - 1) * self.P - LOOK_BACK, (self.prefill + k) * self.P + LOOK_AHEAD

    def encode(self, windows: list[np.ndarray], tokens_per_window: int) -> np.ndarray:
        d = self.d
        B = len(windows)
        K = tokens_per_window * self.fl
        T = B * K
        pos = np.arange(self.enc_frames, self.enc_frames + T, dtype=np.int64)
        cos, sin = rope_cos_sin(pos, d.a_head_dim, d.a_theta)
        bias = np.full((T, self.C + T), NEG, np.float32)
        for t in range(T):
            q = pos[t]
            valid = (self.epos >= 0) & (self.epos > q - d.a_window)
            bias[t, : self.C][valid] = 0.0
            j = np.arange(T)
            ok = (j <= t) & (pos[j] > q - d.a_window)
            bias[t, self.C:][ok] = 0.0
        audio = np.stack(windows).astype(np.float32)
        emb, nk, nv = self.b.encoder(audio, self.fl, cos, sin, bias, self.ek, self.ev)
        nk = [np.asarray(x) for x in nk]
        nv = [np.asarray(x) for x in nv]
        start = max(0, T - self.C)
        for t in range(start, T):
            slot = int(pos[t] % self.C)
            for i in range(d.a_layers):
                self.ek[i][:, :, slot] = nk[i][:, :, t]
                self.ev[i][:, :, slot] = nv[i][:, :, t]
            self.epos[slot] = pos[t]
        self.enc_frames += T
        return np.asarray(emb)[0]

    # -- decoder ---------------------------------------------------------------------------
    def maybe_trim(self, incoming: int):
        if not self.rolling:
            return
        d = self.d
        while self.dlen + incoming > ROLL_CONTEXT:
            s, r = ROLL_STABLE, ROLL_TRIM
            cos, sin = rope_cos_sin([-r], d.t_head_dim, d.t_theta)
            for i in range(d.t_layers):
                suf_k = self.dk[i][:, :, s + r: self.dlen].copy()
                h = d.t_head_dim // 2
                rot = np.concatenate([-suf_k[..., h:], suf_k[..., :h]], -1)
                suf_k = suf_k * cos[0] + rot * sin[0]
                self.dk[i][:, :, s: self.dlen - r] = suf_k
                self.dv[i][:, :, s: self.dlen - r] = self.dv[i][:, :, s + r: self.dlen]
                self.dk[i][:, :, self.dlen - r: self.dlen] = 0
                self.dv[i][:, :, self.dlen - r: self.dlen] = 0
            self.dlen -= r
            self.trims += 1

    def decode(self, embeds: np.ndarray, all_logits=False):
        d = self.d
        n = embeds.shape[0]
        self.maybe_trim(n)
        assert self.dlen + n <= self.L
        pos = np.arange(self.dlen, self.dlen + n)
        cos, sin = rope_cos_sin(pos, d.t_head_dim, d.t_theta)
        bias = np.full((n, self.L + n), NEG, np.float32)
        bias[:, : self.dlen] = 0.0
        bias[:, self.L:] = np.where(np.tril(np.ones((n, n), bool)), 0.0, NEG)
        if all_logits:
            logits, vad, nk, nv = self.b.decoder(embeds[None], self.ada, cos, sin, bias, self.dk, self.dv, all_logits=True)
        else:
            logits, vad, nk, nv = self.b.decoder(embeds[None], self.ada, cos, sin, bias, self.dk, self.dv)
        for i in range(d.t_layers):
            self.dk[i][:, :, self.dlen: self.dlen + n] = np.asarray(nk[i])
            self.dv[i][:, :, self.dlen: self.dlen + n] = np.asarray(nv[i])
        self.dlen += n
        return np.asarray(logits), np.asarray(vad)

    # -- full utterance ----------------------------------------------------------------------
    def stream_of(self, wav: np.ndarray) -> np.ndarray:
        right = (self.delay + 1 + RIGHT_PAD_TEXT_TOKENS) * self.P
        return np.concatenate([np.zeros(self.left * self.P, np.float32), wav.astype(np.float32),
                               np.zeros(right, np.float32)])

    def n_windows(self, stream_len: int) -> int:
        k = 0
        while self.window_bounds(k)[1] <= stream_len:
            k += 1
        return k

    def run(self, wav: np.ndarray, forced: list[int] | None = None, max_steps: int | None = None,
            on_step: Callable | None = None) -> list[int]:
        """Greedy streaming decode (or teacher-forced when `forced` is given: logits are recorded,
        the forced tokens are fed back, decoder calls are chunked up to the next trim boundary)."""
        stream = self.stream_of(wav)
        nwin = self.n_windows(len(stream))
        if max_steps:
            nwin = min(nwin, max_steps)
        prompt = [BOS, self.lang] + [STREAM_PAD] * (self.prefill - 2)
        # window 0
        s, e = self.window_bounds(0)
        a0 = self.encode([stream[s:e]], self.prefill)
        emb = embed_rows(self.W, prompt) + a0
        logits, vad = self.decode(emb)
        out = []
        self._emit(logits, vad, forced, out)
        k = 1
        pending_audio: list[np.ndarray] = []
        while k < nwin:
            # encoder in batches of windows (audio-only dependency)
            if not pending_audio:
                kk = list(range(k, min(nwin, k + self.enc_batch)))
                wins = [stream[self.window_bounds(j)[0]: self.window_bounds(j)[1]] for j in kk]
                pending_audio = list(self.encode(wins, 1))
            if forced is None:
                emb = embed_rows(self.W, [out[-1]]) + pending_audio.pop(0)[None]
                logits, vad = self.decode(emb)
                self._emit(logits, vad, None, out)
                k += 1
            else:
                room = (ROLL_CONTEXT - self.dlen) if self.rolling else 10**9
                if room <= 0:
                    self.maybe_trim(1)
                    room = ROLL_CONTEXT - self.dlen
                m = min(len(pending_audio), room, nwin - k)
                toks = [forced[k - 1 + j] for j in range(m)]
                emb = embed_rows(self.W, toks) + np.stack(pending_audio[:m])
                del pending_audio[:m]
                logits, vad = self.decode(emb, all_logits=True)
                for j in range(m):
                    self._emit(logits[0, j][None], vad[0, j][None], forced, out)
                k += m
            if on_step:
                on_step(k, nwin, out)
        return out

    def _emit(self, logits, vad, forced, out):
        lg = np.asarray(logits, dtype=np.float32).reshape(-1).copy()
        lg[EOS] = -np.inf
        tok = int(lg.argmax())
        self.log.tokens.append(tok)
        if self.keep_logits:
            self.log.logits.append(np.asarray(logits, dtype=np.float32).reshape(-1))
        self.log.vad.append(np.asarray(vad, dtype=np.float32).reshape(-1))
        out.append(forced[len(out)] if forced is not None else tok)


def visible_text(tokenizer, ids) -> str:
    keep = []
    for t in ids:
        if t == EOS:
            break
        if t in (STREAM_PAD, STREAM_WORD, BOS, PAD, LANG_ZH, LANG_EN):
            continue
        keep.append(t)
    return tokenizer.decode(keep)


def eot_probability(vad_row: np.ndarray, horizon_index: int = 2) -> float:
    z = vad_row.reshape(-1, 8)[horizon_index].astype(np.float64)
    z = np.exp(z - z.max())
    return float(z[0] / z.sum())
