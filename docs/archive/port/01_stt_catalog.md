# 01 — STT Model Catalog (Rust port)

**Output:** `app/src-tauri/src/winstt/catalog.rs`
**Status:** DRAFT PORT — deterministic data + pure resolution logic. Real code + `#[cfg(test)]`
unit tests (it is a data table and string-state arithmetic, not ML, so it is fully written, not
spec-only).

**Grounded in (read these to verify):**
- `server/src/recorder/domain/catalog.json` — the canonical 42-model catalog (single source of truth).
- `server/src/recorder/domain/model_registry.py` — `ModelCatalog`, `ModelInfo`,
  `_GPU_COMPATIBLE_QUANTIZATIONS`, `_DML_INCOMPATIBLE_FAMILIES`, `gpu_filter_quantizations`,
  `to_dicts` (picker filtering).
- `server/src/recorder/bootstrap.py` — `_resolve_quantization`, `_FP16_AUTO_PARAM_THRESHOLD` (500M),
  `_INT8_PREFERRED_FAMILIES`, `_override_dml_to_cpu_for_incompatible_family`.
- `server/src/stt_server/control_handler.py` — `_effective_quant_for` (the picker-badge ↔ loader bridge).
- onnx-asr fork resolver: `E:/DL/Projects/onnx-asr/src/onnx_asr/` (the single source of truth for which
  *files* a repo/alias maps to).
- Memory: `project_onnx_asr_single_source_of_truth`, `project_effective_quantization_bridge`,
  `project_stt_models_added_dolphin_moonshinev2_icefall`, `project_canary_cohere_prompt_slot_untrained`,
  `project_context_prompt_poisons_whisper`, `project_lite_whisper_variants`,
  `project_onnx_whisper_fp16_patch`, `project_canary_dml_int8_crash`.

---

## 1. What the catalog is

WinSTT's catalog is a flat JSON array (`catalog.json`) of **42 shipped STT models**, loaded into
`ModelInfo` dataclasses by `model_registry.py`. There is **no `backend` field** — every model coerces
to `ONNX_ASR` (the lone legacy `FASTER_WHISPER` alias also routes to ONNX). The catalog is the input
to two consumers that MUST agree:

1. **The picker** (`ModelCatalog.to_dicts`) — what the UI offers, with CUDA quant-filtering applied.
2. **The loader** (`bootstrap.build_transcriber` → `_resolve_quantization` + provider override) — what
   the ort engine actually fetches + which execution provider it runs on.

The Rust port models the **slice the engine + picker policy need**: `id`, `family`, `onnx_model_name`
(HF repo or onnx-asr alias), `available_quantizations`, `param_count`, `supports_realtime`. Editorial-only
fields (`wer`, `rtfx`, `size_bytes_by_quantization`, full `languages` lists, `description`) are
**intentionally excluded** here — they belong to the picker-payload slice, not the engine table. (They
can be loaded from a generated JSON in a later slice if the renderer needs them; keeping this file an
*engine* table keeps it small and correctness-focused.)

### 1.1 Counts by family (asserted in `per_family_counts_match_catalog_json`)

| Family enum | catalog slug | count | engine class (onnx-asr) | notes |
|---|---|---|---|---|
| `Whisper` | `whisper` | **15** | `WhisperHf` | tiny/base/small/medium(.en) + large-v3 + large-v3-turbo + breeze-asr-25 + crisper-whisper + 3× lite-whisper |
| `Moonshine` | `moonshine` | **10** | `Moonshine` | tiny/base (en) + per-lang fine-tunes (ko/ar/vi/zh/ja + uk/fr) |
| `Nemo` | `nemo` | **8** | `NemoConformerCtc` / `NemoConformerRnnt` / `NemoConformerTdt` / `NemoConformerAED` (Canary) | parakeet ×3, canary ×3 (1b-v2, 180m-flash, 1b-flash), fastconformer-ru ×2 |
| `Kaldi` | `kaldi` | **3** | `KaldiTransducer` / `IcefallZipformer` | vosk-ru, vosk-small-ru, zipformer-en |
| `GigaAm` | `gigaam` | **2** | `GigaAMv2Ctc` / `GigaAMv2Rnnt`-style | gigaam-v3 ctc + rnnt (ru) |
| `Cohere` | `cohere` | **1** | `CohereAsr` | cohere-transcribe (2B, #1 leaderboard) |
| `SenseVoice` | `sense_voice` | **1** | `SenseVoiceCtc` | sense-voice-small (special FBANK+LFR+CMVN pipeline) |
| `TOne` | `t-one` | **1** | T-One CTC | t-tech/t-one (ru) |
| `Dolphin` | `dolphin` | **1** | `DolphinCtc` | dolphin-base-ctc (ar/zh/hi East-Asian) |

**Total: 42.** Every shipped row has `supports_realtime = true` today (asserted by
`all_shipped_models_support_realtime` — a canary if upstream ever changes).

Plus the runtime sentinel `Family::Custom` (`CUSTOM_MODEL_FAMILY = "custom"`): user-dropped models under
`{custom_models_dir}/{slug}/`, registered as `custom-{slug}`, `available_quantizations = [""]`,
`param_count = 0`, loaded by local path (no HF round-trip). It never appears in `STT_CATALOG`.

### 1.2 `onnx_model_name`: HF repo vs onnx-asr alias

Two forms appear and the onnx-asr resolver handles both (it is the **single source of truth** for file
resolution — there are no bypasses; see memory `project_onnx_asr_single_source_of_truth`):

- **Slashed HF repo** (`onnx-community/whisper-tiny`, `Xenova/whisper-medium`,
  `xeonchen/Breeze-ASR-25-ONNX`, `csukuangfj/sherpa-onnx-sense-voice-...`, `alphacep/vosk-model-ru`,
  `istupakov/canary-180m-flash-onnx`, `t-tech/t-one`) — resolved via HuggingFace snapshot.
- **Bare onnx-asr alias** (`moonshine-tiny`, `nemo-parakeet-ctc-0.6b`, `gigaam-v3-e2e-ctc`,
  `cohere-transcribe`, `dolphin-base-ctc`, `zipformer-en`) — onnx-asr's catalog maps the alias to a
  concrete repo + file set internally.

In Rust, file resolution is the **engine slice's** job (`03_stt_engine.md`). The catalog only carries
the `onnx_model_name` string verbatim; the Rust `ort` loader must reproduce onnx-asr's resolver
behaviour (or vendor an equivalent table) to find encoder/decoder/tokenizer files per quant.

---

## 2. The quantization resolution logic (`_resolve_quantization` → `effective_quantization`)

This is the heart of the slice. Three precision facts must stay in lock-step or the picker lies
("badge says cached, swap downloads"):

```
user setting (requested)  ──┐
device / accelerator       ─┼─►  _resolve_quantization  ──►  what the loader fetches  (Some / None)
param_count                 │                                       │
available_quantizations    ─┘                                       ▼
family                                            _effective_quant_for (None → "")  ──►  picker badge
```

### 2.1 The algorithm (ported verbatim into `resolve_quantization`)

Input: `requested` (e.g. `"auto"` / `""` / `"int8"` / `"fp16"`), `accel`, `param_count`,
`available` (the published quant set, `None` for off-catalog repos — permissive), `family`.

1. **`"auto"` or `""`** (empty is auto for back-compat with pre-flip configs):
   - **CUDA** + `param_count >= 500_000_000` (`FP16_AUTO_PARAM_THRESHOLD`) + publishes `fp16` → `Some("fp16")`.
     - Below 500M, fp16's encoder/decoder I/O cast overhead dominates → fp32 wins (benchmarked RTX 3080 Ti:
       tiny 718× fp32 vs 434× fp16; small ties; large-v3-turbo 73× fp32 vs 245× fp16). So fp16 only auto-fires
       on the big ones.
   - **non-CUDA** (CPU / DirectML / ROCm / CoreML / OpenVINO) + family is **int8-preferred** + publishes
     `int8` → `Some("int8")`. Mirrors how transcribe-rs / Handy load these encoders as Int8 on every backend.
   - else → `None` (fp32 default export).
2. **Concrete quant the model does NOT publish** → `None` (fp32 fallback + warn). NEVER ask onnx-asr for a
   missing file — it would `ModelFileNotFoundError` and cascade all the way down to a `tiny` fallback.
3. **Concrete sub-fp16** (`int8`/`q4`/`q4f16`/`bnb4`/`uint8`) **on CUDA** → `None` (fp32 fallback + warn).
   CUDA-EP can't fuse Q/DQ nodes (runs fp32 anyway, slower via scatter-gather) and per-channel int8
   **hallucinates** on Whisper (`microsoft/onnxruntime#25489`; benchmarked locally: int8 on CUDA emitted
   8788 hallucinated words vs 3608 true).
4. **Otherwise** → `Some(requested)` (pass-through). A concrete `fp16` here hits the in-load Whisper decoder
   repair path (`03_stt_engine.md`).

`effective_quantization()` is just `resolve_quantization().unwrap_or("")` — the **bridge** the picker badge
must use (mirror of `control_handler._effective_quant_for`). **Invariant (memory
`project_effective_quantization_bridge`):** check `cache_by_quantization[effective]`, NEVER the raw
`onnxQuantization`. Otherwise the canary shows green/downloaded but silently downloads on switch.

### 2.2 The constants

| Rust const | Value | Source |
|---|---|---|
| `FP16_AUTO_PARAM_THRESHOLD` | `500_000_000` | `bootstrap._FP16_AUTO_PARAM_THRESHOLD` |
| `GPU_COMPATIBLE_QUANTIZATIONS` | `["", "fp16"]` | `model_registry._GPU_COMPATIBLE_QUANTIZATIONS` |

### 2.3 Picker-side CUDA quant filtering

`ModelCatalog.to_dicts(device, accelerator)` filters each row's `available_quantizations` down to
`{"", "fp16"}` via `gpu_filter_quantizations()` **only on CUDA** (so the UI never offers a quant that's
slower AND worse on CUDA). DirectML / ROCm / CoreML do **NOT** filter — those route int8-preferred families
to CPU EP instead (§3), where every published quant is valid. Ported as `picker_quantizations_for(entry, accel)`.

---

## 3. The two family policy tables (and why they're the SAME set)

### 3.1 `INT8_PREFERRED_FAMILIES` (auto-int8 off-CUDA)

`{Nemo, Cohere, GigaAm, Kaldi, TOne, SenseVoice, Dolphin}`. These ONNX encoders are shipped primarily
as int8; fp32 still works but trades ~3–4× memory + ~2× latency for no accuracy gain. On any non-CUDA
backend, `"auto"` resolves to int8 for them. Whisper / Moonshine ship working fp32 graphs across every EP
and are **excluded** (their fp32/fp16 auto-promotion still wins). Source: `bootstrap._INT8_PREFERRED_FAMILIES`.

### 3.2 `DML_INCOMPATIBLE_FAMILIES` (force CPU on DML/ROCm/CoreML)

`{Nemo, Cohere, GigaAm, Kaldi, TOne, SenseVoice, Dolphin}`. Their ONNX encoder graph crashes ORT-DirectML's
`MLOperatorAuthorImpl` reshape kernel (`Reshape node 'node_view'`, `ERROR_FATAL_APP_EXIT`) at **every**
quantization — verified on istupakov's Canary-180M `encoder-model.int8.onnx` on bare ORT-DML. The crash is
the EP, not the export (the file is byte-identical to what runs fine on CPU). So when the user's accelerator
is DML / ROCm / CoreML / OpenVINO (anything that is not `cuda` and not already `cpu`), the provider list is
overridden to `["CPUExecutionProvider"]` for these families. Whisper / Moonshine keep their GPU EP. Source:
`model_registry._DML_INCOMPATIBLE_FAMILIES` + `bootstrap._override_dml_to_cpu_for_incompatible_family`.

### 3.3 THE LOAD-BEARING INVARIANT: the two sets are IDENTICAL

Memory `project_onnx_asr_single_source_of_truth`: *"added [dolphin] to `_DML_INCOMPATIBLE_FAMILIES`,
**invariant ==** `_INT8_PREFERRED_FAMILIES`."* Both lists are the same 7 families. In the Rust port a **single
predicate** backs both — `Family::is_dml_incompatible_and_int8_preferred()` — so they CANNOT drift, and the
test `dml_incompatible_equals_int8_preferred` asserts:
- for every family, `is_dml_incompatible() == prefers_int8_off_cuda()`,
- the agreeing set equals the canonical `{Nemo, Cohere, GigaAm, Kaldi, TOne, SenseVoice, Dolphin}`,
- the set has exactly 7 members,
- Whisper / Moonshine / Custom are NOT in it.

The Rust force-CPU **decision** is `must_force_cpu(family, accel)` (the provider-list *rewrite* is the engine
slice's job; this returns the boolean).

### 3.4 Engine routing summary (which family needs which EP)

| Family | DirectML (default Win GPU) | CUDA (future Linux NVIDIA) | CPU |
|---|---|---|---|
| Whisper, Moonshine | runs on DML directly (full quant list) | fp32/fp16 (auto-fp16 ≥500M) | fp32, all quants |
| Nemo, Cohere, GigaAm, Kaldi, TOne, SenseVoice, Dolphin | **forced to CPU EP** (DML crash) → int8-preferred | runs on CUDA, fp32/fp16 only (sub-fp16 filtered) | int8-preferred |
| Custom | as exported (no policy) | as exported | as exported |

---

## 4. Per-family quirks the engine slice must honor (cross-references, NOT in this file)

These are tracked here so the catalog reader knows *why* a family is special; the actual handling lives
in `03_stt_engine.md`:

- **Whisper** — fp16 merged-decoder needs in-load repair (`onnx_patch.patch_whisper_decoder`) + session-opt
  downgrade to `ORT_ENABLE_EXTENDED` (dodges `SimplifiedLayerNormFusion`). `.en` decoders need an in-cache
  patch. Only Whisper benefits from initial-prompt bias (`<|startofprev|>` /`<|startofcontext|>`); translate
  mutates the decoder prompt (`<|transcribe|>`→`<|translate|>`, multilingual only).
  `Family::supports_initial_prompt_bias()` returns true only for Whisper.
- **lite-whisper** (3 rows) — `-acc` = "accelerated" NOT "accurate" (memory). Only `""` + `fp16` work;
  int8/uint8/q4/q4f16/bnb4 are broken upstream → the catalog correctly lists only `["", "fp16"]`.
- **Moonshine** — prompt-immune (no `initial_prompt` slot); no-op for prompt-bias AND translate. uk/fr needed
  a mask-input fix in the fork.
- **Cohere / Canary (Nemo AED)** — `<|startofcontext|>` exists in vocab but is **UNTRAINED**: filling it
  truncates/hallucinates → prompt-bias deliberately NOT wired (memory `project_canary_cohere_prompt_slot_untrained`).
  Canary translate uses native `target_language="en"` (not prompt mutation). Cohere fp16 uses **sharded
  external data** (`.onnx_data_1`); refetch must glob `*.onnx?data_*`. AED engines (Cohere, Canary) get a
  1.25 s trailing-silence pad + leading-silence trim.
- **Parakeet RNN-T/TDT** — 250 ms leading-silence prepend (trained against silence-prefixed inputs).
- **SenseVoice** — special-cased pipeline (FBANK + LFR + CMVN + 4 control tokens), int8-only graph.
- **Kaldi/Vosk** — uses the `.` quant separator (`encoder.int8.onnx`) vs onnx-community's `_` separator;
  handled in the file-resolution slice.
- **Dolphin** — int8 only in the catalog (its fp32 default-export int8 DML segfaults; covered by both
  the int8-only quant list AND the DML-incompatible → force-CPU rule). The Rust struct literal is
  `available_quantizations: &["int8"]` and `quantizations_for_id()` reads it (asserted by
  `dolphin_quants_are_int8_only`).

---

## 5. Public Rust interface (what other slices call)

```rust
pub enum Family { Whisper, Moonshine, Cohere, Nemo, SenseVoice, GigaAm, Kaldi, TOne, Dolphin, Custom }
pub enum Accelerator { Cuda, DirectMl, Rocm, CoreMl, OpenVino, Cpu }

pub struct ModelEntry { id, display_name, family, onnx_model_name, available_quantizations, param_count, supports_realtime }
pub const STT_CATALOG: &[ModelEntry];                  // 42 rows
pub const FP16_AUTO_PARAM_THRESHOLD: u64;              // 500M
pub const GPU_COMPATIBLE_QUANTIZATIONS: &[&str];       // ["", "fp16"]

pub fn find(id) -> Option<&'static ModelEntry>;
pub fn quantizations_for_id(id) -> &'static [&'static str];     // Dolphin-corrected reader
pub fn picker_quantizations_for(entry, accel) -> Vec<&'static str>;   // CUDA quant filter
pub fn resolve_quantization(requested, accel, param_count, available, family) -> Option<&'static str>;
pub fn effective_quantization(requested, accel, param_count, available, family) -> &'static str; // badge bridge
pub fn must_force_cpu(family, accel) -> bool;                   // DML-incompatible → CPU decision
pub fn dml_incompatible_int8_preferred_families() -> BTreeSet<Family>;  // the canonical 7

impl Family {
    fn as_str(self) -> &'static str;           fn from_str(s) -> Family;
    fn is_dml_incompatible(self) -> bool;       fn prefers_int8_off_cuda(self) -> bool;  // same predicate
    fn supports_initial_prompt_bias(self) -> bool;  // Whisper only
}
```

## 6. Tests (`#[cfg(test)]` in `catalog.rs`)

`catalog_total_count_is_42`, `per_family_counts_match_catalog_json`, `ids_are_unique`,
`every_model_has_a_repo_and_at_least_one_quant`, `all_shipped_models_support_realtime`,
**`dml_incompatible_equals_int8_preferred`** (the invariant), `family_str_roundtrips`,
`dolphin_quants_are_int8_only`, plus full branch coverage of `resolve_quantization`
(auto-fp16-on-cuda, auto-int8-off-cuda, no-int8-for-whisper/moonshine, unpublished-quant-fallback,
sub-fp16-on-cuda-fallback, pass-through, off-catalog permissive), `effective_quantization`,
`picker_quantizations_for` (CUDA filter), `must_force_cpu`, `initial_prompt_bias_only_for_whisper`.

## 7. Wiring note

`catalog.rs` is a **leaf data module** — it registers nothing in `lib.rs` (no manager, no command, no
event). It is consumed by:
- the **engine slice** (`03_stt_engine.md`) — `resolve_quantization`, `must_force_cpu`, file resolution
  from `onnx_model_name`,
- the **commands slice** that serves the model list to the renderer — `STT_CATALOG`,
  `picker_quantizations_for`, `effective_quantization` (badge),
- the **settings slice** (`02_settings.md`) — validates the persisted model id against `find()`.

It must be declared as `pub mod catalog;` inside `winstt/mod.rs` (or wherever the `winstt` module tree is
rooted) once that file exists. No other registration required.

## 8. Open gaps / TODO for the compile loop

- **Editorial fields not modeled** (`wer`/`rtfx`/`languages`/`size_bytes_by_quantization`/`description`):
  if the renderer's model picker needs them, generate a sibling JSON from `catalog.json` and load it in the
  command slice, OR extend `ModelEntry`. Kept out here to keep this an engine table.
- **`onnx_model_name` → file set** is NOT resolved here; the Rust `ort` loader must replicate onnx-asr's
  resolver (per-quant encoder/decoder/tokenizer + the `.`-vs-`_` separator, sharded external data globbing).
  That is the highest-risk piece — see `03_stt_engine.md`.
- **`static_quant` closed set**: branch-4 pass-through maps the requested string to a `'static` via a closed
  list of all 7 known quant suffixes. An off-catalog repo with a *novel* quant suffix would collapse to fp32
  (None). This matches the practical universe (no such repo exists in the catalog) but should be revisited if
  custom/off-catalog repos with exotic quants are ever supported.
- **Cloud models** (`openai:` / `elevenlabs:` prefixed ids) are NOT in this catalog — they're handled by the
  remote-transcriber slice (`07_llm_cloud_context_longtail.md`), not the local model table.
