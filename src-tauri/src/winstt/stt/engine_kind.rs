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
    /// sherpa-onnx `OnlineRecognizer` streaming NeMo FastConformer **CTC** (single `model.onnx`).
    /// Cache-aware chunked streaming handled inside the sherpa runtime.
    NemoCtcStreaming,
    /// sherpa-onnx `OnlineRecognizer` streaming NeMo FastConformer **RNN-T** (encoder/decoder/joiner).
    NemoRnntStreaming,
    /// sherpa-onnx `OnlineRecognizer` streaming **Zipformer2 transducer** (encoder/decoder/joiner).
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
    /// NOT inherited from the reference's blanket family list. the reference excluded the whole
    /// `nemo`/`gigaam`/`t-one`/`kaldi`/`sense_voice`/`dolphin` families after testing ONE
    /// AED model, but only these actually fail on DML:
    ///   * `NemoAed` (Canary): conformer-encoder `Reshape` kernel crash (MLOperatorAuthorImpl).
    ///   * `CohereAsr`: `MultiHeadAttention` kernel crash.
    ///   * `KaldiTransducer` (zipformer/vosk), `SenseVoiceCtc`, `DolphinCtc`: silent hang/crash.
    ///   * Sherpa streaming Conformer/Zipformer graphs: CPU-pinned because DirectML is unstable
    ///     for the stateful streaming sessions.
    ///
    /// The NeMo CTC/TDT (parakeet) + GigaAM CTC + T-One CTC graphs RUN CORRECTLY and **2–3×
    /// FASTER on DirectML than CPU** (parakeet-ctc 73 vs 223ms, parakeet-tdt 144 vs 270ms,
    /// gigaam-ctc 51 vs 134ms, t-one 913 vs 1916ms) — so they are NOT here and keep the GPU EP.
    /// Whisper keeps GPU (IoBinding); Moonshine is CPU-pinned separately (perf for a tiny model).
    /// int8 stays the auto quant for these — int8-on-DML beats fp32-on-DML here.
    pub fn is_dml_incompatible(self) -> bool {
        matches!(
            self,
            EngineKind::NemoAed
                | EngineKind::CohereAsr
                | EngineKind::KaldiTransducer
                | EngineKind::SenseVoiceCtc
                | EngineKind::DolphinCtc
                | EngineKind::NemoCtcStreaming
                | EngineKind::NemoRnntStreaming
                | EngineKind::KaldiTransducerStreaming
        )
    }

    /// Works on DirectML but is FASTER on CPU at THIS quant → routed to CPU as a PERF choice
    /// (distinct from `is_dml_incompatible`, which is a crash). EMPIRICALLY per-(engine, quant):
    /// the RNN-T transducers run a per-ENCODER-FRAME predictor/joint loop (hundreds of tiny ops).
    /// On DirectML each is a kernel launch, AND a QUANTIZED (int8/QDQ) graph additionally demotes
    /// its QuantizeLinear/DequantizeLinear nodes to CPU per-op — so QUANTIZED RNN-T loses to CPU
    /// (parakeet-rnnt int8: CPU 252 vs DML 361ms; gigaam-rnnt int8 ≈ tie). But FLOAT RNN-T (fp32/
    /// fp16, no QDQ demotion) WINS on DML (parakeet-rnnt fp32: DML 120 vs CPU 322; gigaam-rnnt fp32:
    /// DML 126 vs CPU 211). So: quantized RNN-T → CPU, float RNN-T → DML. The CTC/TDT single-pass
    /// engines win on DML at EVERY quant (gigaam-ctc fp32 32ms / int8 51ms both « CPU), so excluded.
    pub fn dml_slower_than_cpu(self, quant: Quantization) -> bool {
        matches!(self, EngineKind::NemoRnnt | EngineKind::GigaamRnnt)
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
        )
    }

    /// True when the latest realtime preview can safely be promoted to the final paste.
    /// Context-dependent attention decoders still need a fresh full-context final decode.
    pub fn final_reuse_safe(self) -> bool {
        !self.needs_past_context()
    }
}
