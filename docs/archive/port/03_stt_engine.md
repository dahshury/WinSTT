# 03 — STT Engine: unified `ort`-ONNX re-port of onnx-asr (deep spec)

> **Status:** SPEC + interface stubs. This is the **highest-risk subsystem** of the whole port.
> Nothing here is compiled. The Rust stub lives at `app/src-tauri/src/winstt/stt/mod.rs`.
> **Gate:** the de-risking spike in §11 MUST pass before any decode loop is written.

## 0. What we are porting and why it's hard

WinSTT's STT engine is **torch-free**: the Python server drives every one of its ~40 catalog
models through the **onnx-asr** fork (`E:/DL/Projects/onnx-asr/src/onnx_asr/`) on top of
**ONNX Runtime**. onnx-asr is NOT a thin wrapper — it hand-rolls per-family tokenizers, decode
loops (Whisper greedy + KV-cache, CTC greedy, RNN-T/TDT transducer, AED), preprocessors (mel /
fbank / LFR / CMVN), a HuggingFace snapshot resolver, and ~12 per-model numerical fixes that took
months of debugging (see WinSTT memory `project_*`). The Python `OnnxAsrTranscriber`
(`server/src/recorder/infrastructure/onnxasr_transcriber.py`) adds a second layer on top: fp16
decoder repair, sharded-external-data refetch, ORT session-option tuning, EP resolution, and
audio conditioning.

The locked port decision is **S2 — one `ort` runtime for every model**. That means we must
re-implement onnx-asr's model logic in Rust on raw `ort` 2.x, because:

- `transcribe-rs` (Handy's existing dep, `0.3.8` with `["whisper-cpp", "onnx"]`) only ships a
  SUBSET: `onnx::{canary, cohere, gigaam, moonshine, parakeet, sense_voice}` engines + a
  whisper.cpp path. It has **no** ONNX-Whisper / lite-whisper / Kaldi-Zipformer / Dolphin / T-One
  engine, **no** cross-attention word-timestamps, **no** fp16 Whisper decoder repair, **no**
  sharded `.onnx_data` refetch, and **no** initial-prompt decoder-bias. (Verified against
  `app/src-tauri/src/managers/transcription.rs` imports.) The lite-whisper decision (`KEEP — ONNX
  + ort only`) alone rules out the whisper.cpp path for that family.
- So: keep `transcribe-rs` for the families it covers IF we want a shortcut, but the spec below
  re-ports the FULL onnx-asr surface onto raw `ort` so all 40 models share ONE runtime and ONE set
  of fixes. Where transcribe-rs already has a verified engine (e.g. SenseVoice, Cohere, Parakeet),
  treat its source as a second reference but do not assume parity — Cohere fp16 KV-cache dtype and
  Parakeet leading-silence are WinSTT-specific.

### Crate versions (confirmed 2026-05, crates.io)
- **`ort = "2.0.0-rc.12"`** — safe Rust wrapper for ONNX Runtime 1.24, MSRV 1.88. Production-ready,
  not API-stable. Features: `cuda`, `directml`, `coreml`, `rocm`, `openvino`, `load-dynamic`.
  Exposes `Session`, `SessionBuilder`, `IoBinding`, `Value`/`Tensor`, `GraphOptimizationLevel`,
  `ExecutionProvider`. **This is what we build on.**
- **`hf-hub = "1.0.0-rc.1"`** — Rust client for the HF Hub; reuses the Python `huggingface_hub`
  cache layout (so a dev box that already pulled models via the Python server hits the same cache).
  Provides `Api`/`ApiRepo` + `snapshot`-style download. We extend it for the `.onnx_data` shard
  completeness check (§2.3).
- `ndarray` (for f32 tensor math in decode loops), `tokenizers` is **deliberately avoided** — onnx-asr
  hand-rolls every tokenizer with `serde_json`, and we mirror that (smaller dep tree, exact parity).
- `serde_json` (vocab.json / tokenizer.json / config.json parsing), `rubato` already in Handy
  (resampling, but the engine receives 16 kHz already), `thiserror` (error enum).

---

## 1. Layered architecture (Rust)

```
winstt/stt/
  mod.rs            ← Transcriber trait, EngineKind, FamilyPolicy, options/results, pure helpers (DONE-as-stub)
  resolver.rs       ← HF snapshot + per-quant glob + .onnx_data shard completeness + SHA (SPEC §2)
  ort_env.rs        ← ORT environment init, EP list build, SessionBuilder factory, fp16 workaround (SPEC §6,§9)
  tokenizer/        ← hand-rolled tokenizers (gpt2_byte, sentencepiece_byte_fallback, kaldi_tokens, sensevoice_tokens)
  preprocess/       ← mel (whisper-80/128), fbank-kaldi, lfr, cmvn, identity (SPEC §5)
  engines/
    whisper_hf.rs   ← EngineKind::WhisperHf  (encoder + merged decoder + IoBinding KV-cache + word-ts)
    whisper_ort.rs  ← EngineKind::WhisperOrt (whisper-base-ort single repo)
    moonshine.rs    ← EngineKind::Moonshine  (3-graph, all-ones mask fix)
    cohere.rs       ← EngineKind::CohereAsr  (merged decoder, fp16 KV-cache dtype)
    nemo.rs         ← NemoCtc / NemoRnnt / NemoTdt / NemoAed
    kaldi.rs        ← KaldiTransducer + IcefallZipformer (uppercase→lowercase)
    gigaam.rs       ← GigaamCtc / GigaamRnnt
    tone.rs         ← ToneCtc
    dolphin.rs      ← DolphinCtc (CMVN-in-metadata, lob_probs)
    sense_voice.rs  ← SenseVoiceCtc (fbank+lfr+cmvn, 4 control tokens)
  word_timestamps.rs← cross-attention DTW (alignment-heads table, median filter, DTW) (SPEC §8)
```

Dependencies point inward; only `engines/*` touch `ort` sessions. `mod.rs` is the public face the
`transcription_coordinator` calls. **No engine imports another engine** except by sharing the
decode-loop archetype via free functions (e.g. `engines::transducer::greedy_decode`).

### The trait (already stubbed in `mod.rs`)
`Transcriber { kind, model_name, is_ready, active_providers, supports_word_timestamps, transcribe, shutdown }`.
`transcribe(&mut self, audio: &[f32], opts: &TranscribeOptions) -> SttResult<Transcription>`.
Audio is mono 16 kHz f32 in `[-1,1]`, **already peak-normalized to 0.95 by the caller** (single
chokepoint, mirrors Python `_peak_normalize`; engines add NO conditioning —
memory `project_stt_premodel_conditioning_policy`).

---

## 2. The resolver (`resolver.rs`)

Port of `onnx_asr/resolver.py` + `model_base._get_model_files` + WinSTT's
`onnxasr_transcriber._refetch_hf_snapshot` + `model_cache._file_quantization`.

### 2.1 Repo-id / alias resolution
- A `model` is either a slashed HF repo id (`onnx-community/whisper-tiny`) used verbatim, or a bare
  alias (`nemo-parakeet-tdt-0.6b-v3`) mapped through the `model_repos` table
  (`resolver.py:19-70`) to a repo id. Port `model_repos` verbatim as a Rust `&[(&str, &str)]`
  table in `resolver.rs` (catalog slice `01_stt_catalog.md` is the source of truth for the FULL
  alias set; cross-check both).
- A local-dir override (`path=`) sets offline mode and skips HF entirely (custom models, §10).

### 2.2 Per-quant file globs (`_get_model_files`)
Each engine declares a logical-key → glob map, quant-suffixed. The suffix uses `?` as a SINGLE-CHAR
wildcard so it matches BOTH the `_` (onnx-community: `encoder_model_fp16.onnx`) and `.`
(Kaldi/sherpa: `encoder.int8.onnx`) separators. Port each `_get_model_files` exactly:

| EngineKind | logical keys → glob (quant `Q`, `suffix = "?"+Q` when Q set) |
|---|---|
| WhisperHf | `encoder`=`**/encoder_model{sfx}.onnx`, `decoder`=`**/decoder_model_merged{sfx}.onnx`, `vocab`=`vocab.json`, `added_tokens`=`added_tokens.json` |
| WhisperOrt | (whisper-base-ort layout — read `_ort.py`; encoder/decoder + `vocab.json`/`added_tokens.json`) |
| Moonshine | `encoder`=`**/encoder_model{sfx}.onnx`, `decoder`=`**/decoder_model{sfx}.onnx`, `decoder_with_past`=`**/decoder_with_past_model{sfx}.onnx`, `tokenizer`=`tokenizer.json`, `tokenizer_config`=`tokenizer_config.json` |
| CohereAsr | `encoder`=`**/encoder_model{sfx}.onnx`, `decoder`=`**/decoder_model_merged{sfx}.onnx`, `tokenizer`=`tokenizer.json`, `tokenizer_config`=`tokenizer_config.json` |
| NemoCtc | `model`=`model{sfx}.onnx`, `vocab`=`vocab.txt` |
| NemoRnnt/Tdt | `encoder`=`encoder-model{sfx}.onnx`, `decoder_joint`=`decoder_joint-model{sfx}.onnx`, `vocab`=`vocab.txt` |
| NemoAed | `encoder`=`encoder-model{sfx}.onnx`, `decoder`=`decoder-model{sfx}.onnx`, `vocab`=`vocab.txt` |
| KaldiTransducer | `encoder`=`*/encoder{sfx}.onnx`, `decoder`=`*/decoder{sfx}.onnx`, `joiner`=`*/joiner{sfx}.onnx`, `vocab`=`*/tokens.txt` |
| IcefallZipformer | `encoder`=`encoder-*{sfx}.onnx`, `decoder`=`decoder-*{sfx}.onnx`, `joiner`=`joiner-*{sfx}.onnx`, `vocab`=`tokens.txt` (root-level epoch-suffixed files) |
| DolphinCtc | `model`=`model{sfx}.onnx`, `vocab`=`tokens.txt` |
| SenseVoiceCtc | `model`=`model{sfx}.onnx`, `vocab`=`tokens.txt` |
| GigaamCtc/Rnnt | (read `models/gigaam.py` — NeMo-shaped; mel front-end differs) |
| ToneCtc | (read `models/tone.py`) |

`config.json` and `config.yaml` are always added to the download set; `.ort` files are an accepted
fallback for `.onnx` (`_resolve_model_files.find`). A glob that matches >1 file is an error
(`MoreThanOneModelFileFoundError`); 0 matches → `SttError::Resolve`.

### 2.3 `.onnx_data` shard completeness (CRITICAL — three bugs converge here)
Models >2 GB (whisper-large-v3, cohere fp16) export weights to external-data sidecars. THREE
fixes from `resolver.py:137-174` + WinSTT memory must ALL be ported:

1. **Download the sidecars.** For every `.onnx` in the file set, ALSO request
   `<stem>.onnx?data` (the `?` matches `.` or `_`, i.e. `.onnx.data` AND `.onnx_data`). Build the
   glob with **forward slashes** — HF `allow_patterns` are fnmatched against POSIX repo paths; a
   Windows backslash pattern silently skips the sidecar and ORT then dies with
   `External data path validation failed`. In Rust: build patterns from `&str` with `/`, never from
   `Path`.
2. **Shard form.** Sharded weights are `<stem>.onnx_data_1`, `.onnx_data_2`, … (or `.onnx.data_2`).
   The refetch glob must be `*.onnx?data_*` to catch them (memory
   `project_sharded_external_data_refetch`, `project_cohere_fp16_kvcache_dtype`).
3. **Completeness check BEFORE declaring cached.** A partial download leaves the `.onnx` graph
   present while a `.onnx_data_N` shard is missing → `local_files_only` "succeeds", ORT fails at
   session-create. Port `would_download_on_load`/`_refetch_hf_snapshot`: after resolving locally,
   stat every sidecar referenced by the `.onnx`'s external-data records; if any is missing, force a
   non-`local_files_only` snapshot refetch ONCE and retry (`onnxasr_transcriber.py:202-252`).
   - To enumerate referenced sidecars without a full protobuf parse: the picker-open path must NOT
     do `onnx.load(load_external_data=False)` on the FULL graph (it parses inline weights and starves
     the loop — memory `project_list_models_onnx_parse_loop_starvation`). Use a 64 MB size guard:
     external-data graphs are tiny, so only parse `.onnx` files under 64 MB for the data check.

### 2.4 Per-quant cache + effective-quantization
- Cache slug includes the quant tag so int8 and fp16 don't collide (`_slug_model_id`). hf-hub's
  cache keys by repo+revision; we add a quant dimension by checking the resolved file's suffix.
- `_file_quantization` reads the suffix off the resolved `.onnx` filename, handling BOTH separators
  AND the sharded form (a fp16 model whose weights are `model.onnx_data_1` is still fp16).
- **Effective-quantization bridge** (memory `project_effective_quantization_bridge`): the picker
  badge MUST check `cache_by_quantization[effective]`, where `effective` is what the resolver
  ACTUALLY loads after int8-preferred / fp16-auto resolution — NOT the raw requested quant. Expose
  `ResolvedModel.effective_quantization` (already in the stub) and report it to the frontend so
  "green/downloaded" never lies about an impending background download.

### 2.5 SHA / integrity
hf-hub verifies `etag`/blob sha on download. For the local completeness check we only need
existence + nonzero size (matching `_refetch_hf_snapshot`); a full sha re-verify per picker-open is
too slow (the same starvation trap). Record sha only when a download actually runs.

**Acceptance (resolver):** given `onnx-community/whisper-large-v3` it downloads
`encoder_model.onnx` + `encoder_model.onnx_data` (+ decoder pair) with forward-slash patterns; a
manually-deleted `.onnx_data` triggers exactly ONE refetch and the second load succeeds.

---

## 3. Engine dispatch (`build_engine`)

`build_engine(EngineConfig) -> Box<dyn Transcriber>` matches on `EngineKind`. The `EngineKind` is
chosen by the resolver from the catalog `family` + the model's `config.json` `model_type` (mirrors
`loader.create_asr_resolver`'s `model_types` dict). Dispatch table:

```
WhisperHf | (config model_type ∈ {whisper, lite-whisper, distil-whisper}) → engines::whisper_hf
WhisperOrt| (alias whisper-base / model_type whisper-ort)                 → engines::whisper_ort
Moonshine | (alias moonshine-* / model_type moonshine)                    → engines::moonshine
CohereAsr | (alias cohere-transcribe / model_type cohere_asr)             → engines::cohere
NemoCtc   | (nemo-*-ctc, gigaam-*-ctc share loop but different mel)        → engines::nemo (ctc)
NemoRnnt  | (nemo-*-rnnt)                                                  → engines::nemo (rnnt)
NemoTdt   | (nemo-parakeet-tdt-*)                                          → engines::nemo (tdt)
NemoAed   | (nemo-canary-*)                                               → engines::nemo (aed)
KaldiTransducer | (vosk / kaldi-rnnt)                                     → engines::kaldi
IcefallZipformer| (zipformer-en) — subtype of Kaldi, file-glob override   → engines::kaldi
GigaamCtc/Rnnt  | (gigaam-v2/v3-*)                                        → engines::gigaam
ToneCtc   | (t-tech/t-one)                                                → engines::tone
DolphinCtc| (dolphin-*-ctc)                                               → engines::dolphin
SenseVoiceCtc | (sense-voice-small)                                       → engines::sense_voice
```

---

## 4. Decode loops (the core compute)

### 4.1 Whisper encoder/decoder + IoBinding KV-cache (`whisper_hf.rs`)
Port `models/whisper/_hf.py` + `_base.py`. This is the centerpiece.

- **Encode once:** mel features `(1, n_mels, T)` → `encoder.run` → `last_hidden_state`. Use ORT
  **IoBinding**: bind `input_features` as an `OrtValue`, bind `last_hidden_state` to the device. In
  `ort` 2.x this is `Session::create_binding()` / `IoBinding::bind_input` / `bind_output_to_device`.
- **Static decoder prompt** (`_base.py:92-125`): `[<|startoftranscript|>, <lang>, <|transcribe|>,
  <|notimestamps|>]`. For timestamps drop `<|notimestamps|>`. For translate swap
  `<|transcribe|>`→`<|translate|>` (mutates the prompt array, multilingual only — §6.7).
- **Language autodetect** for multilingual when no `language` given: run a 3-token decode from
  `[<|sot|>]`, take position-1 argmax as the language token (`_base.py:277-279`). `.en` exports skip
  this (forced `"en"` — §6.3).
- **Greedy autoregressive loop** (`_hf.py:_decode`/`_decoding`):
  - First step: `use_cache_branch=false`, feed full prompt as `input_ids`, empty past KV
    (`_create_state` builds zero `(0, heads, 0, head_dim)` `past_key_values.*`).
  - Subsequent steps: `use_cache_branch=true`, feed only the LAST token (`tokens[:, -1:]`), bind
    each `past_key_values.N` input and each `present.N` output device-side; carry forward present→past.
  - The "keep prev value when next has 0 length" zip merge (`_hf.py:193-196`) handles the
    cross-attn KV that's static after step 1.
  - argmax next token; force EOS-sticky (once a row emits `<|endoftext|>` freeze it); stop when all
    rows EOS or `max_length=448`.
- **IoBinding rationale:** binding past/present KV device-side avoids host round-trips per step —
  THIS is the fast path; do NOT regress to host-side numpy copies (the Python code is explicitly
  IoBinding-bound and benchmarked; memory `project_kv_cache_export_dead_end` says we're already on
  the right shape — don't re-export to "modern" ORT KV shapes).
- **Decode text** (`_decode_text`, §6.4): GPT-2 byte decoder; skip `<|...|>` markers; strip ONE
  leading space.
- **Multi-token-per-call is BROKEN** on these exports (memory `project_onnx_whisper_cache_bug`):
  the merged decoder scrambles all-but-last predictions when `use_cache_branch=true` with K>1
  tokens. So the loop MUST feed exactly one token per cached step. Don't try spec-decode / K-tokens.

### 4.2 CTC greedy (`_AsrWithCtcDecoding`, used by NemoCtc, GigaamCtc, Dolphin, SenseVoice, ToneCtc)
Port `asr._AsrWithCtcDecoding._decoding`: argmax over vocab axis per frame; mask out blanks AND
consecutive duplicates (`np.diff(...prepend=blank) != 0`); the surviving ids are the transcript.
The pure collapse is already in `mod.rs::ctc_greedy_collapse` (tested). Logprobs via reduceat are
optional (only needed for the noise-break / quality path). Subsampling factor sets timestamp spacing.

### 4.3 RNN-T / TDT transducer beam=1 (`_AsrWithTransducerDecoding`, Kaldi + NemoRnnt/Tdt + GigaamRnnt)
Port `asr._AsrWithTransducerDecoding._decoding` (greedy, not beam — the published baseline is
beam=1). Per encoder frame `t`:
- run `_decode(prev_tokens, state, encoder_out[t])` → `(logits, step, new_state)`;
- argmax token; if not blank: commit token + timestamp, adopt new state, `emitted_tokens++`;
- advance `t` by `step` (TDT duration head, `>0`) OR by 1 when blank / `max_tokens_per_step` hit.
- **TDT** (`NemoConformerTdt._decode`): the joint output is `[vocab_logits | duration_logits]`;
  slice `[:vocab_size]` for the token and `argmax([vocab_size:])` for the duration `step`
  (`nemo.py:134-138`). RNN-T returns `step=-1` (always advance by 1).
- **Kaldi/Zipformer** (`kaldi.py`): stateless 2-token-context decoder cached by context tuple
  `(-1, blank, *prev)[-2:]`; encoder I/O is `x`/`x_lens`→`encoder_out`/`encoder_out_lens`; joiner
  takes `encoder_out`+`decoder_out`→`logit`. **CONTEXT_SIZE=2.**
- **NeMo state** is `(input_states_1, input_states_2)` zero-seeded from decoder_joint input shapes
  (`nemo.py:105-110`); `targets=[[last_or_blank]]`, `target_length=[1]`. Encoder output is
  transposed `(0,2,1)` for NeMo (`nemo.py:103`).

### 4.4 AED (Canary) pad/trim + decoder_mems loop (`NemoConformerAED`)
Port `nemo.py:141-266`. Static 10-token control prompt `[" ", <|startofcontext|>,
<|startoftranscript|>, <|emo:undefined|>, <|en|>, <|en|>, <|pnc|>, <|noitn|>, <|notimestamp|>,
<|nodiarize|>]`. `language` overrides slot 4; `target_language` (or `language`) overrides slot 5
(this IS the native translate path); `pnc` overrides slot 6. Decoder runs with `decoder_mems`
(grows: full input when `decoder_mems.shape[2]==0`, else last-token-only). Stop on all-EOS or
`max_sequence_length=1024`. Strip `<|...|>` tokens on decode.
- **AED audio conditioning** (WinSTT-specific, `onnx_decoder_patches`): Canary AND Cohere get a
  leading-silence trim THEN `maybe_pad_for_aed` (1.25 s trailing silence) — the AED encoder
  mis-handles very short clips. Parakeet RNN-T/TDT get a 250 ms leading-silence PREPEND
  (`maybe_prepend_silence_for_parakeet`, trained against silence-prefixed inputs). These are
  applied in the COORDINATOR before `transcribe`, gated by family — port them in the
  `transcription_coordinator` slice, not in the engine. Spec'd here so they aren't forgotten.
- **`<|startofcontext|>` is UNTRAINED** for Canary/Cohere (memory
  `project_canary_cohere_prompt_slot_untrained`): never inject prompt text there. Enforced by
  `EngineKind::supports_initial_prompt() == false`.

### 4.5 Moonshine 3-graph greedy (`moonshine.rs`)
Port `models/moonshine.py`. Raw-audio encoder (no mel — `identity` preprocessor). First step uses
`decoder_model.onnx` (seeds full KV); subsequent steps use `decoder_with_past_model.onnx` (emits
only decoder-self-attn present; encoder KV static). Prompt is just `[bos_id]`. Decode via
SentencePiece byte-fallback tokenizer. See §6.6 for the all-ones-mask fix.

### 4.6 Cohere merged-decoder greedy (`cohere.rs`)
Port `models/cohere_asr.py`. Conformer encoder (time-first mel `(B,T,128)`). Merged decoder with
NO `use_cache_branch` input — KV-branch is implicit in past-tensor shapes. Inputs per step:
`input_ids`, `attention_mask`, `position_ids`, `num_logits_to_keep=1`, `encoder_hidden_states`,
plus 32 `past_key_values.*` (8 layers × {dec.k,dec.v,enc.k,enc.v}). 10-token prompt (§4.4 shape but
Cohere variant). See §6.5 for the fp16 KV-cache dtype fix. SentencePiece byte-fallback decode.

---

## 5. Preprocessors (`preprocess/`)

| Name | Used by | Port from |
|---|---|---|
| `whisper{80\|128}` mel | Whisper, Cohere(128, time-first) | `preprocessors/numpy_preprocessor.WhisperPreprocessorNumpy` / `CohereAsrPreprocessorNumpy` |
| `nemo{features_size}` mel | NeMo, Gigaam | `NemoPreprocessorNumpy`, `GigaamPreprocessorNumpy` |
| `kaldi` 80-dim fbank | Kaldi/Vosk, Zipformer, Dolphin | `KaldiPreprocessorNumpy` |
| `identity` (passthrough) | Moonshine, SenseVoice | `IdentityPreprocessor` |
| SenseVoice fbank+LFR+CMVN | SenseVoice (inline) | `models/sense_voice.py:_compute_fbank/_apply_lfr/_apply_cmvn` |

The Cohere/Granite preprocessors have NO ONNX twin — they MUST run on the NumPy/Rust path
(`loader.py:339-352`). Port them as pure `ndarray` functions. SenseVoice's FBANK is a Kaldi-style
HTK triangular mel + Hamming window + pre-emphasis 0.97 + log-magnitude (`sense_voice.py:78-115`) —
a deterministic, hand-verifiable port (good spike candidate). Dolphin applies CMVN
`(fbank - mean) * invstd` from the ONNX `custom_metadata_map` AFTER the kaldi fbank (§6.9).

**Conditioning policy (locked):** the ONLY pre-model step is peak-normalize-to-0.95 in the caller.
NEVER add denoising / pre-emphasis (except SenseVoice's intrinsic fbank pre-emph) / dither / DC /
HPF — denoising raises WER 1–47% (memory `project_stt_premodel_conditioning_policy`).

---

## 6. The ~12 per-model fixes (each MUST be reproduced)

These are the hard-won correctness fixes. Skipping any one produces empty / garbled / crashing
output on the affected model. Each lists: trigger, root cause, the fix, and where it lives.

### 6.1 Whisper fp16 in-file decoder repair
- **Trigger:** loading an `onnx-community` Whisper `*_fp16` merged-decoder export. ORT 1.18+ (and
  1.24) rejects it at session-create.
- **Root cause:** the export declares subgraph outputs (`logits`, `present.*`) with outer-scope
  names + **fp32 dtype annotations on an fp16 graph**. ORT's graph validator throws.
- **Fix:** catch the load error (regex `_FP16_DECODER_LOAD_ERROR`,
  `onnxasr_transcriber.py:138-160`), surgically patch the `.onnx` file IN PLACE
  (`onnx_patch.patch_whisper_decoder` — rewrites the offending output dtype annotations from fp32→
  fp16 inside the subgraph), set a "patched" marker so a second failure isn't re-patched
  (`should_skip_patch`), retry the load ONCE. In Rust: parse the ONNX protobuf with `prost` +
  the `onnx` proto (or a minimal hand-written proto for just the GraphProto/NodeProto/ValueInfoProto
  we touch), edit the `ValueInfoProto.type.tensor_type.elem_type` for the named subgraph outputs,
  rewrite the file. **This is a real risk** — flagged in the spike (§11) because it needs a
  protobuf round-trip ORT will accept.
- **Lives:** `ort_env.rs::load_with_fp16_repair` + a `whisper_decoder_patch.rs`.

### 6.2 Whisper fp16 `ORT_ENABLE_EXTENDED` (not `ORT_ENABLE_ALL`)
- **Trigger:** any fp16 Whisper-family load.
- **Root cause:** ORT's `SimplifiedLayerNormFusion` mis-fuses the fp16 Whisper encoder at the
  `ORT_ENABLE_ALL` / `LAYOUT` optimization level → wrong output.
- **Fix:** lower `graph_optimization_level` to `ORT_ENABLE_EXTENDED` for fp16 AND whisper-family
  ONLY (`onnxasr_transcriber.py:_is_whisper_family`, substring `"whisper"`). Non-Whisper fp16 keeps
  `ORT_ENABLE_ALL` (5–10% fusion savings). In `ort` 2.x:
  `SessionBuilder::with_optimization_level(GraphOptimizationLevel::Level2 /* = EXTENDED */)`.
- **Lives:** `ort_env.rs::build_session_options` (carries `whisper_fp16_workaround` from
  `EngineConfig`).

### 6.3 Whisper `.en` If-subgraph / prompt-slot patch
- **Trigger:** English-only `.en` exports (tiny.en, base.en, …).
- **Root cause:** `.en` exports drop the language-detect prompt slot. Writing `<|en|>` (or any lang
  token) into prompt position 1 corrupts the prompt → empty/garbled output. They DO carry `<|en|>`
  for ID-compat, so a naive vocab-size check is fragile.
- **Fix:** detect multilingual via `"<|fr|>" in vocab` (`_base.py:110`); if NOT multilingual, force
  `language="en"`, NEVER touch prompt position 1, skip language-autodetect. (The "If-subgraph patch"
  in the inventory refers to the same family of `.en` merged-decoder quirks the in-cache patcher
  also covers; the prompt-slot guard is the behavioral half.)
- **Lives:** `whisper_hf.rs` (prompt builder reads `is_multilingual`).

### 6.4 Vocab completion `.get()` (CrisperWhisper KeyError)
- **Trigger:** Whisper exports with an INCOMPLETE `vocab.json` (e.g. CrisperWhisper ships
  46674/51866 ids — memory `project_whisper_incomplete_vocab_and_transcription_failed`).
- **Root cause:** `_vocab[id]` direct indexing `KeyError`s on the missing ids → transcription crash.
- **Fix:** decode with `vocab.get(id)` and skip `None` (`_base.py:147` uses `self._vocab.get`). In
  Rust: `vocab.get(&id)` returning `Option`, skip `None`. Also surface a `TranscriptionFailed`
  event upstream instead of the "no audio detected" lie when decode yields empty.
- **Lives:** `tokenizer/gpt2_byte.rs::decode_text`.

### 6.5 Cohere fp16 KV-cache dtype + sharded refetch
- **Trigger:** loading `cohere-transcribe` fp16/q4f16 on DML→auto-fp16.
- **Root cause (A):** the fp16 decoder declares `past_key_values` as **float16**, but a float32
  empty cache on the first step trips ORT's input-type check (`Unexpected input data type.
  Actual: (tensor(float)), expected: (tensor(float16))`). Logits also come back float16.
- **Fix (A):** read the REAL dtype off the decoder's first `past_key_values` input
  (`cohere_asr.py:_past_np_dtype = _ort_type_to_np_dtype(first_past.type)`); seed the empty KV with
  THAT dtype; promote fp16 logits → f32 before argmax. In Rust: inspect
  `session.inputs()[i].input_type` for the past tensors, allocate the empty `Value` as f16 or f32
  accordingly; cast logits to f32. (memory `project_cohere_fp16_kvcache_dtype`)
- **Root cause (B):** cohere fp16 weights are SHARDED external data (`.onnx_data_1`); a partial
  download wasn't detected (resolver said "cached") → load failed; the refetch glob missed shards.
- **Fix (B):** §2.3 shard-aware completeness + `*.onnx?data_*` refetch.
- **Lives:** `cohere.rs` (dtype) + `resolver.rs` (shards).

### 6.6 Moonshine all-ones attention-mask inputs
- **Trigger:** `transformers>=4.57` re-exports (moonshine-tiny-uk / -fr, Apr 2026) declare explicit
  `attention_mask` / `encoder_attention_mask` / `encoder_hidden_states` inputs the original 3-graph
  layout omitted. ORT rejects a run that doesn't feed EVERY declared input.
- **Root cause:** mask inputs added upstream; older exports (tiny/base + zh/ja/ko/ar/vi) don't
  declare them.
- **Fix:** detect each mask/hidden input by name at load; feed all-ones `int64` masks of the right
  shape ONLY when declared; feed nothing when absent (backward-compatible)
  (`moonshine.py:105-123`, `_encode`/`_first_decode_step`/`_past_decode_step`). The past-step
  decoder in re-exports also recomputes cross-attn from `encoder_hidden_states` every step — feed
  it when declared.
- **Lives:** `moonshine.rs` (name-detect inputs at construct).

### 6.7 Whisper translate via prompt mutation
- **Trigger:** `opts.translate` on a MULTILINGUAL Whisper model.
- **Fix:** swap `<|transcribe|>`→`<|translate|>` in BOTH static prompt arrays
  (`_transcribe_input`, `_transcribe_input_with_timestamps`). No-op on `.en` (raises in Python; we
  return `Unsupported` or fall back to transcribe). Canary uses native `target_language="en"`
  (§4.4) — NOT prompt mutation. Cohere/others: no translate.
- **Lives:** `whisper_hf.rs::patch_translate_prompt`, gated by `EngineKind::supports_translate`.

### 6.8 Zipformer uppercase→lowercase
- **Trigger:** `sherpa-onnx-zipformer-en` (and any icefall/Kaldi LibriSpeech BPE export) — ALL-CAPS
  vocab → ALL-CAPS transcripts, unusable for dictation.
- **Fix:** detect via `vocab_is_uppercase` (≳90% of cased tokens uppercase — ALREADY ported +
  tested in `mod.rs`); lowercase the decoded text (`asr._AsrWithDecoding._decode_tokens` →
  `text.lower()` when `_lowercase_decoded`). Sentence-casing is left to the caller. Never flips for
  mixed/lowercase vocabs (Whisper/NeMo/Vosk).
- **Lives:** `kaldi.rs` decode (uses `mod.rs::vocab_is_uppercase`).

### 6.9 Dolphin / SenseVoice CTC fbank + CMVN-in-metadata
- **Dolphin:** no `config.json`; per-mel-bin CMVN (`mean`/`invstd`, 80 floats each) rides in the
  ONNX `custom_metadata_map`. Apply `x = (fbank - mean) * invstd` AFTER the shared kaldi fbank,
  BEFORE the encoder. Blank is `<blank>` id 0 (not `<blk>`). The logprob output is misnamed
  `lob_probs` and resolved by rank (3-D output) not by name (`dolphin.py`).
- **SenseVoice:** own FBANK (HTK mel + Hamming + pre-emph 0.97 + log) → LFR stacking
  (`window_size`/`window_shift` from metadata, default 7/6, partial window right-padded with last
  frame) → CMVN (`neg_mean`/`inv_stddev` from metadata, `(x + neg_mean) * inv_stddev`). Full model
  has 4 inputs `(feat, x_length, language, text_norm)` and prepends 4 control tokens (lang/emotion/
  event/itn) stripped on decode; FunASR-Nano has 1 input + base64 `tokens.txt` + no CMVN. Auto-detect
  via `"Nano" in metadata.comment` (`sense_voice.py`). num_frames for the greedy decode is
  `features.rows + 4` (non-Nano) to cover the control prefix.
- **Lives:** `dolphin.rs`, `sense_voice.rs`, `preprocess/`.

### 6.10 int8-preferred resolution
- **Trigger:** `auto`/`""` quant on a non-CUDA backend for an int8-preferred family.
- **Fix:** resolve to `int8` when the family ∈ `{nemo, cohere, gigaam, kaldi, t-one, sense_voice,
  dolphin}` AND int8 is published (`bootstrap._resolve_quantization`; `_INT8_PREFERRED_FAMILIES`).
  ALREADY ported + tested in `mod.rs::resolve_quantization_auto`. The full resolver also: fp16-auto
  ≥500M on CUDA; reject sub-fp16 on CUDA (`_GPU_COMPATIBLE_QUANTIZATIONS = {"", "fp16"}`); warn +
  fall back to fp32 on an unpublished concrete quant. Port those branches into `resolver.rs`.

### 6.11 DML-incompatible → CPU
- **Trigger:** DML/ROCm/CoreML accelerator picked for a DML-incompatible family.
- **Root cause:** their ONNX encoders crash DirectML's `MLOperatorAuthorImpl` reshape kernel
  (`ERROR_FATAL_APP_EXIT`); Canary+DML+int8 is a documented hard crash
  (memory `project_canary_dml_int8_crash`).
- **Fix:** override the provider list to `[CPUExecutionProvider]` for
  `{nemo, cohere, gigaam, kaldi, t-one, sense_voice, dolphin}` (Whisper/Moonshine/custom keep GPU).
  ALREADY ported + tested in `mod.rs::override_dml_to_cpu_for_family`. Plus: wrap `transcribe` in a
  `catch_unwind` at the COORDINATOR (load-bearing `panic = "unwind"`) so any residual kernel crash
  degrades gracefully instead of killing the recorder thread (mirrors `_safe_transcribe`).

### 6.12 lite-whisper fp16-only
- **Trigger:** any `lite-whisper-*` model.
- **Root cause:** only `""` (fp32 default) and `fp16` work; int8/uint8/q4/q4f16/bnb4 are broken
  upstream (memory `project_lite_whisper_variants`). `-acc` = "accelerated" not "accurate".
- **Fix:** the catalog lists only `["", "fp16"]` for these; the resolver's "unpublished concrete
  quant → fall back to fp32" branch (§6.10) handles a stray request. fp16 lite-whisper hits the
  §6.1 decoder-repair + §6.2 ENABLE_EXTENDED paths (it IS whisper-family by substring). No separate
  code, but the catalog quant set and the whisper-family substring match MUST be right.

### (bonus) Silero VAD CPU-only
Not an STT-engine fix per se but a load-bearing invariant the engine slice must respect: the Silero
VAD used for WhisperX-style segmentation loads ALWAYS on `CPUExecutionProvider` — loading it on
CUDA with `do_copy_in_default_stream=1` deadlocks ORT session-create (the "Reconnecting forever"
bug). Lives in the VAD slice (`04_*`), cached process-wide.

---

## 7. Quantization & EP resolution (`resolver.rs` + `ort_env.rs`)

Port `bootstrap._resolve_quantization` (the auto path is in `mod.rs`; the full branches go in
`resolver.rs`) and `device.py` (`resolve_accelerator`, `providers_for_settings`,
`_override_dml_to_cpu_for_incompatible_family`):

- **Accelerator resolution** (`resolve_accelerator`): user setting (`auto`/`cuda`/`directml`/`cpu`/
  …) → concrete EP, walking the per-OS priority list for `auto` (win32:
  `openvino→directml→cuda→cpu`). For Windows the SHIPPED build is DirectML default (CUDA retired on
  Windows — see root CLAUDE.md). `ort` 2.x registers EPs via cargo features
  (`ort = { features = ["directml"] }`); `get_available_providers()`-equivalent is
  `ort::execution_providers` availability. CUDA's DLL-probe dance (`_inject_cuda_dlls`,
  `_probe_cuda_session`) is Windows-CUDA-only and reserved for the future Linux NVIDIA build — port
  it LAST / behind a feature flag.
- **CPU op-level fallback:** every GPU provider list appends `CPUExecutionProvider`
  (`[<gpu_ep>, CPU]`) so an unsupported op falls back per-op.
- **CUDA EP options:** `do_copy_in_default_stream=1` (−59…−77% latency, byte-identical) when the
  CUDA path is ever built.
- **Threads:** `pick_intra_op_threads` (CPU→min(cpu,8), GPU→2) — ALREADY in `mod.rs`, set on EVERY
  session via `SessionBuilder::with_intra_threads`.

---

## 8. Word timestamps (`word_timestamps.rs`)

Port `word_timestamps.py` (itself a port of openai-whisper `timing.py`). Only WhisperHf exports
with `cross_attentions.*` decoder outputs support it (`supports_word_timestamps` confirms at load).
Pipeline: collect per-step cross-attention from selected `alignment_heads` → stack
`(layers, heads, tokens, frames)` → crop encoder dim to `num_audio_frames/2` → softmax over time →
normalize over tokens → width-7 median filter → mean over heads → DTW on the negated matrix → group
tokens into words via the GPT-2 byte decoder (split on `Ġ`/space; CJK stops at unicode boundaries)
→ per-word start/end from path jump times / `TOKENS_PER_SECOND=50`.

The `_ALIGNMENT_HEADS` base85-gzip table and `_MODEL_SIZE_BY_DIMS` `(layers, heads)` map are copied
VERBATIM from openai-whisper — port the bytes as a Rust `&[(&str, &[u8])]` and gunzip+base85-decode
at lookup (or precompute the bool masks at build time). This whole feature is opt-in (lazy
`align_words` on first play — memory `project_word_highlight_playback`); it's allowed to be slower
(CPU, post-commit). Port AFTER the core decode loops are green.

---

## 9. ORT environment & session options (`ort_env.rs`)

- One process-wide `ort::init()` with the right EP features compiled in.
- `build_session_options(EngineConfig) -> SessionBuilder`:
  - optimization level: `ORT_ENABLE_ALL` normally, `ORT_ENABLE_EXTENDED` for whisper-fp16 (§6.2);
  - `with_intra_threads(pick_intra_op_threads(...))`;
  - provider list from §7 (already DML-overridden for incompatible families).
- `load_with_fp16_repair(EngineConfig)`: try create; on the missing-external-data error → §2.3
  refetch + retry; on the fp16-decoder error → §6.1 in-place patch + retry once; else propagate.
- IoBinding helpers shared by Whisper/Cohere/Moonshine (`create_binding`, device-typed output bind).

---

## 10. Custom user models

Discovered by the custom-models slice (scan `{dir}/{slug}/`). Validation contract (all required):
encoder ONNX (`encoder.onnx`|`encoder_model.onnx`), decoder ONNX
(`decoder_model.onnx`|`decoder_model_merged.onnx`), `tokenizer.json`, `config.json` with non-empty
`model_type`. The resolver loads via `path=local_dir` (offline, no HF). `model_type` from config
routes to the right `EngineKind` via the same dispatch table (§3) — most custom models are
Whisper/Distil-Whisper-shaped, so `WhisperHf`. `available_quantizations=[""]`, `param_count=0`
(skips hardware-fit warning).

---

## 11. MANDATORY de-risking spike (THE GATE)

**No decode-loop code ships until this spike is green.** It proves the three riskiest things at
once on real `ort` 2.x against real exports. Write it as a throwaway `examples/stt_spike.rs` (or a
`#[ignore]` integration test) that the user runs once Rust is installed.

**Spike acceptance criteria — reproduce correct transcripts for:**

1. **Whisper-fp16** (`onnx-community/whisper-tiny`, quant `fp16`): proves §6.1 in-file decoder
   repair (protobuf round-trip ORT accepts), §6.2 `ORT_ENABLE_EXTENDED`, and the IoBinding KV-cache
   greedy loop (§4.1). Transcript of a known JFK clip must match the Python server's output for the
   same model/quant (allow whitespace-only diffs).
2. **lite-whisper** (`onnx-community/lite-whisper-large-v3-turbo-ONNX`, quant `fp16`): proves the
   whisper-family path generalizes to the factorized-encoder variant via ONNX+ort only (no
   whisper.cpp), the LOCKED reason we keep lite-whisper. Same JFK-match bar.
3. **Cohere-fp16-sharded** (`onnx-community/cohere-transcribe-03-2026-ONNX`, quant `fp16`): proves
   §6.5 (fp16 KV-cache dtype read off the session + logits f32-promote) AND §2.3 (sharded
   `.onnx_data_1` completeness + `*.onnx?data_*` refetch). Delete a shard, confirm exactly one
   refetch, confirm a correct transcript.

**Spike must also smoke-test (load + one transcribe, transcript sanity, not byte-match):**
- one CTC model (`sense-voice-small` int8 — exercises fbank+LFR+CMVN + control-token strip),
- one transducer (`zipformer-en` — exercises stateless-2-context + uppercase→lowercase),
- and confirm `nemo`/`cohere` on a `directml`-feature `ort` build actually route to CPU (§6.11)
  rather than crashing.

**Spike output:** a short report (latency p50 for whisper-tiny-fp16 on DirectML vs the Python
target p50≈85 ms) + a go/no-go on the `ort` IoBinding + protobuf-patch approach. If the in-file
fp16 patch (§6.1) proves infeasible on `ort` 2.x (e.g. ORT still rejects the patched graph), the
fallback is to ship the fp32 default export for affected Whisper models and lose fp16 on those —
document that decision here before proceeding.

---

## 12. Open risks / decisions to record

- **fp16 decoder protobuf patch (§6.1)** is the single biggest unknown — needs a Rust ONNX-proto
  edit ORT accepts. Spike item 1 is the go/no-go.
- **IoBinding API surface in `ort 2.0.0-rc.12`** may differ from the Python `io_binding()` ergonomics;
  confirm `bind_output_to_device` / device-typed KV carry-forward exists. If not, the host-copy
  fallback is correct-but-slower (acceptable for a first green build, optimize after).
- **`transcribe-rs` reuse:** decide per-family whether to call transcribe-rs's existing
  `onnx::{cohere,canary,gigaam,moonshine,parakeet,sense_voice}` engines vs the from-scratch port.
  Pro: less code. Con: transcribe-rs lacks the WinSTT fixes (Cohere fp16 dtype, Parakeet silence,
  Moonshine all-ones mask, lite-whisper, word-ts, fp16 Whisper) — so Whisper/lite-whisper/Kaldi/
  Dolphin/T-One/word-ts are from-scratch REGARDLESS. Recommendation: from-scratch for ALL to keep
  one runtime + one fix-set, but the spike may justify reusing transcribe-rs for the 6 it covers if
  parity checks pass. Record the call after the spike.
- **`hf-hub 1.0.0-rc.1`** is a release-candidate; pin exactly and re-verify the snapshot/cache API
  at compile time.

---

## 13. Cross-references
- Catalog (all 40 models + aliases + quant sets): `PORT/01_stt_catalog.md`.
- Settings (device/accelerator/quantization keys): `PORT/02_settings.md` +
  `frontend/src/shared/config/settings-schema.ts`.
- VAD / Silero-CPU / realtime: `PORT/04_vad_endpoint_realtime.md`.
- Word-ts / diarization / loopback: `PORT/05_*`.
- lib.rs wiring (manager registration): `PORT/lib_wiring.md`.
- Inventory: `handy_winstt/examples/winstt-port-docs/inventory/03_stt_core.md`.
- WinSTT memory invariants: `C:/Users/MASTE/.claude/projects/E--DL-Projects-WinSTT/memory/project_*.md`
  (effective-quantization bridge, cohere fp16 KV-cache, sharded refetch, onnx whisper cache bug,
  canary/cohere untrained slot, lite-whisper variants, fp16 patch, int8 trap, DML int8 crash,
  context prompt poisons whisper, premodel conditioning policy).
