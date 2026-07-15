// The EngineKind decode-archetype taxonomy enum and its capability / provider-routing policy
// methods. Split out of the stt module root for navigability; re-exported there so every
// `crate::winstt::stt::EngineKind` and sibling `super::EngineKind` path keeps resolving.

use super::Quantization;

// ---------------------------------------------------------------------------
// Family taxonomy
// ---------------------------------------------------------------------------

/// The decode-loop archetype an engine uses. Distinct from the catalog `family`
/// string (`whisper`/`moonshine`/`nemo`/`cohere`/`kaldi`/`gigaam`/`t-one`/
/// `sense_voice`/`dolphin`/`custom`) because several catalog families share a
/// decode loop (e.g. Vosk + Zipformer = transducer; Dolphin + SenseVoice = bare
/// CTC over a self-contained graph). Runtime provider routing is keyed to this
/// engine kind; catalog `family` remains input metadata for model resolution.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineKind {
    /// Optimum split encoder + `decoder_model_merged.onnx` with `use_cache_branch`
    /// and IoBinding KV-cache. Covers whisper-*, lite-whisper-*, distil-whisper-*,
    /// breeze-asr-25. Word timestamps when the export exposes `cross_attentions.*`.
    WhisperHf,
    /// onnxruntime-exported Whisper-base (single `whisper-base-ort` repo).
    WhisperOrt,
    /// 3-graph raw-audio encoder/decoder (`decoder_model.onnx` +
    /// `decoder_with_past_model.onnx`, no merged graph, no `use_cache_branch`).
    Moonshine,
    /// Conformer encoder + merged Transformer decoder; SentencePiece byte-fallback
    /// tokenizer; KV-cache branch implicit in past-tensor shapes (no flag input);
    /// fp16 KV-cache dtype must match the decoder's declared `past_key_values` type.
    CohereAsr,
    GraniteSpeechAr,
    GraniteSpeechNar,
    /// Qwen3-ASR: Whisper-style 128-mel encoder → audio embeds; a `decoder_init` graph that
    /// embeds `input_ids` internally and splices the audio embeds at `audio_offset`, then a
    /// `decoder_step` graph driven by externally-looked-up `input_embeds` (raw fp16
    /// `embed_tokens.bin`). KV cache is two stacked f32 tensors `[layers, B, kv_heads, seq, head]`.
    Qwen3Asr,
    /// NeMo Conformer single-graph CTC (`model.onnx` → `logprobs`).
    NemoCtc,
    /// NeMo Conformer RNN-T (encoder + decoder_joint, stateful predictor).
    NemoRnnt,
    /// NeMo Conformer TDT (RNN-T joint that also emits a duration head → step).
    NemoTdt,
    /// NeMo Conformer AED (Canary): encoder + decoder with `decoder_mems`,
    /// static 10-token control prompt, native `target_language` translate.
    NemoAed,
    /// Kaldi / Vosk / icefall-Zipformer stateless-2-context transducer
    /// (encoder + decoder + joiner, `(-1, blank, *ctx)[-2:]` decoder context).
    KaldiTransducer,
    /// GigaAM v2/v3 CTC and RNN-T (NeMo-shaped graphs, GigaAM mel front-end).
    GigaamCtc,
    GigaamRnnt,
    /// T-One single-graph streaming CTC (Russian telephony).
    ToneCtc,
    /// Self-contained CTC graph + CMVN-in-metadata + FBANK/LFR front-end.
    /// Dolphin (`lob_probs`, blank=0) and SenseVoice (4 control tokens, base64
    /// vocab option) share the archetype but differ in front-end detail.
    DolphinCtc,
    SenseVoiceCtc,
    /// Native ORT streaming NeMo FastConformer **CTC** (single `model.onnx`).
    NemoCtcStreaming,
    /// Native ORT streaming NeMo FastConformer **RNN-T** (encoder/decoder/joiner).
    NemoRnntStreaming,
    /// Native ORT streaming **Zipformer2 transducer** (encoder/decoder/joiner).
    KaldiTransducerStreaming,
}

impl EngineKind {
    /// Initial-prompt (decoder-bias) is ONLY meaningful for Whisper-family
    /// exports. Moonshine has no prompt slot; Canary/Cohere expose a
    /// `<|startofcontext|>` token that is UNTRAINED (filling it truncates /
    /// hallucinates) — so they are excluded. See memory
    /// `project_canary_cohere_prompt_slot_untrained` + `project_context_prompt_poisons_whisper`.
    pub fn supports_initial_prompt(self) -> bool {
        matches!(self, EngineKind::WhisperHf | EngineKind::WhisperOrt)
    }

    /// Native translate-to-English path. Whisper mutates the static decoder
    /// prompt (`<|transcribe|>` → `<|translate|>`); Canary uses the
    /// `target_language="en"` kwarg. Everything else is a no-op.
    pub fn supports_translate(self) -> bool {
        matches!(
            self,
            EngineKind::WhisperHf | EngineKind::WhisperOrt | EngineKind::NemoAed
        )
    }

    /// Cross-attention word-DTW is only available on Whisper `*_timestamped`
    /// exports; the engine still has to confirm `cross_attentions.*` outputs
    /// exist at load time (see `Transcriber::supports_word_timestamps`).
    pub fn may_support_word_timestamps(self) -> bool {
        matches!(self, EngineKind::WhisperHf)
    }

    /// Whether this engine's ONNX graph CRASHES/HANGS on DirectML (or other non-CUDA
    /// GPU EPs) in ORT 1.24 — **empirically measured** via the DirectML benchmark harness,
    /// NOT inherited from the reference's blanket family list. The reference excluded the whole
    /// `nemo`/`gigaam`/`t-one`/`kaldi`/`sense_voice`/`dolphin` families after testing ONE
    /// AED model, but only these actually fail on DML:
    ///   * `NemoAed` (Canary): was pinned here (2026-07-08) — istupakov's torch-DYNAMO-exported
    ///     conformer encoder trips two unfixed ORT-DML defects (dynamic seq → `887A0020` device
    ///     removal in the pos-table Slice→MatMul→Reshape region; static seq → `InferAndVerifyOutput`
    ///     `Sizes` 80070057; upstream #26826/#26944). RESOLVED (2026-07-08) by re-exporting the
    ///     encoder from the NeMo checkpoint via `torch.onnx.export(dynamo=False)` — parakeet's
    ///     TorchScript idiom, which runs the SAME conformer fine on DML — hosted on the `Masterx/
    ///     canary-*-onnx` repos the catalog now points at (encoder CPU-parity ~4e-6; decoder
    ///     unchanged; DML ~2× faster than CPU on a 66 s clip). So NemoAed is NO LONGER pinned. Tool:
    ///     `E:/DL/Projects/cohere-arabic-export/canary_encoder_export.py`.
    ///   * `CohereAsr`: the DML `com.microsoft.MultiHeadAttention` kernel faults on the
    ///     cross-attention (`encoder_attn`) node — but ONLY for exports that bake in that fused
    ///     contrib op (onnx-community). This flag is therefore CONSERVATIVE/pre-resolve: it pins
    ///     Cohere to CPU before the files are on disk. Hand-decomposed exports (Masterx: plain
    ///     MatMul/Softmax, zero `MultiHeadAttention` nodes) run correctly and ~2.7× FASTER than CPU
    ///     on DirectML, so `backend::resolve_catalog` probes the resolved graph
    ///     (`cohere_export_dml_safe`) and RESTORES the GPU EP when it's MHA-free.
    ///   * `GraniteSpeechNar` was pinned after its rank-5 block-attention MatMul/Einsum failed on
    ///     DirectML. The engine now derives a rank-4-equivalent encoder graph beside the download,
    ///     preserving CPU parity while allowing DirectML, so it is no longer pinned.
    ///   * `KaldiTransducer` (zipformer/vosk), `SenseVoiceCtc`, `DolphinCtc`: the DML session
    ///     BUILD terminates the whole process silently (exit 0, no panic, no error — reproduced
    ///     2026-07-08 via `examples/stt_dml_spike.rs`); in-app that would kill WinSTT outright.
    ///     These graphs are also 20-70× realtime on CPU (39-66 ms per 3 s clip), so the GPU has
    ///     nothing to win — the pin is final, not conservative.
    ///   * Streaming Zipformer2 remains CPU-pinned like the offline Zipformer graph (same sherpa
    ///     export family as the process-killing offline graph). Streaming NeMo CTC/RNN-T use
    ///     WinSTT's native `ort` implementation and follow their own per-quant policy.
    ///
    /// The NeMo CTC/TDT (parakeet) + GigaAM CTC + T-One CTC graphs RUN CORRECTLY and **2–3×
    /// FASTER on DirectML than CPU** (parakeet-ctc 73 vs 223ms, parakeet-tdt 144 vs 270ms,
    /// gigaam-ctc 51 vs 134ms, t-one 913 vs 1916ms) — so they are NOT here and keep the GPU EP.
    /// Whisper keeps GPU (IoBinding); Moonshine is CPU-pinned separately (perf for a tiny model).
    /// int8 stays the auto quant for these — int8-on-DML beats fp32-on-DML here.
    pub fn is_dml_incompatible(self) -> bool {
        matches!(
            self,
            EngineKind::CohereAsr
                | EngineKind::KaldiTransducer
                | EngineKind::SenseVoiceCtc
                | EngineKind::DolphinCtc
                | EngineKind::KaldiTransducerStreaming
        )
        // Qwen3-ASR was conservatively pinned here until 2026-07-08, then verified on DirectML with
        // the real engine (examples/stt_dml_spike.rs, int4): correct transcripts and 1.85× faster
        // than CPU (66 s clip: 4.5 s DML vs 8.2 s CPU) — so it keeps the GPU EP.
    }

    /// Works on DirectML but is FASTER on CPU at THIS quant → routed to CPU as a PERF choice
    /// (distinct from `is_dml_incompatible`, which is a crash). EMPIRICALLY per-(engine, quant):
    /// the RNN-T transducers run a per-ENCODER-FRAME predictor/joint loop (hundreds of tiny ops).
    /// On DirectML each is a kernel launch, AND a QUANTIZED (int8/QDQ) graph additionally demotes
    /// its QuantizeLinear/DequantizeLinear nodes to CPU per-op.
    ///
    /// `NemoRnnt` (parakeet-rnnt) was here for int8 until 2026-07-11 (all-CPU 252 ms beat
    /// all-DML 361 ms on an 11 s clip) — but `transducer.rs::load` now splits the sessions
    /// (encoder → GPU EP, decoder_joint → CPU), and hybrid int8 measures 645 ms vs 2.38 s
    /// all-CPU on a 66 s clip (the int8 ENCODER still wins on DML; only the per-frame loop
    /// demotes) — so parakeet RNN-T keeps the GPU EP at every quant now.
    ///
    /// `GigaamRnnt` int8 stays (measured ≈ tie, engine has no hybrid split — untested).
    /// Streaming NeMo RNN-T int8 stays — RE-VERIFIED 2026-07-11 on a clean machine
    /// (Nemotron-3.5 1120ms, 66 s clip, warm min-of-3): int8 all-CPU 4.94 s vs the
    /// enc-DML/dec-CPU hybrid 5.50 s — the streaming int8 ENCODER's QDQ nodes demote on DML too
    /// (unlike parakeet's offline export), so there is no hybrid win to unlock there; the
    /// engine's quantized hybrid split in `nemo_streaming.rs::load` stays as a spike/env-escape
    /// path only. (fp32 keeps all-DML: 4.07 s vs 4.94 s int8-CPU — fastest AND most accurate.)
    pub fn dml_slower_than_cpu(self, quant: Quantization) -> bool {
        matches!(self, EngineKind::GigaamRnnt | EngineKind::NemoRnntStreaming)
            && matches!(
                quant,
                Quantization::Int8
                    | Quantization::Q4
                    | Quantization::Q4f16
                    | Quantization::Bnb4
                    | Quantization::Uint8
            )
    }

    /// True iff this kind has a cache-aware/stateful streaming ONNX graph we drive chunk-by-chunk
    /// (carrying encoder/predictor state across `Transcriber::stream_accept`), so the realtime
    /// worker feeds only NEW samples per tick instead of re-decoding a growing window. Today only
    /// T-One — its PUBLISHED graph IS the streaming graph (single stateful session). The streaming
    /// FastConformer/Zipformer variants join this as they land. The OFFLINE graphs
    /// (NemoCtc/NemoRnnt/KaldiTransducer/Gigaam*/…) are NOT here — they re-encode the whole clip, so
    /// they use the committed-watermark window-redecode preview + the VAD-segment final.
    pub fn supports_native_streaming(self) -> bool {
        matches!(
            self,
            EngineKind::ToneCtc
                | EngineKind::NemoCtcStreaming
                | EngineKind::NemoRnntStreaming
                | EngineKind::KaldiTransducerStreaming
        )
    }

    /// True iff decode quality depends on cross-chunk CONTEXT (an autoregressive attention decoder /
    /// a fixed receptive window) — so a properly VAD-segmented decode is the AUTHORITATIVE final and
    /// the chunked realtime preview must NOT be reused as the paste. These are the attention
    /// encoder-decoder families. The frame-synchronous CTC / transducer / non-autoregressive
    /// families have no cross-utterance text dependence, so their realtime output CAN be reused as
    /// the final (the reuse-vs-retranscribe policy keys off this).
    pub fn needs_past_context(self) -> bool {
        matches!(
            self,
            EngineKind::WhisperHf
                | EngineKind::WhisperOrt
                | EngineKind::NemoAed
                | EngineKind::CohereAsr
                | EngineKind::GraniteSpeechAr
                | EngineKind::Qwen3Asr
        )
    }

    /// True when the latest realtime preview can safely be promoted to the final paste.
    /// Context-dependent attention decoders still need a fresh full-context final decode.
    pub fn final_reuse_safe(self) -> bool {
        !self.needs_past_context()
    }
}
