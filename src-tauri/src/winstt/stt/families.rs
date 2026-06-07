// Source: onnx-asr fork (E:/DL/Projects/onnx-asr/src/onnx_asr/) — asr.py (_AsrWithCtcDecoding,
//   _AsrWithTransducerDecoding, _AsrWithDecoding decode/text), models/{sense_voice,dolphin,
//   gigaam,nemo,kaldi,cohere_asr}.py — and ort 2.0.0-rc.12 (Session, GraphOptimizationLevel,
//   Tensor::from_array, DynValue::try_extract_array/try_extract_tensor, ort::inputs!).
//
// Non-Whisper STT families on raw `ort`. Engines implementing `super::Transcriber`:
//   * CTC greedy        — SenseVoice (fbank+LFR+CMVN), GigaAM-CTC, Dolphin, NeMo-CTC
//   * RNNT/TDT          — Parakeet (NeMo-TDT/RNNT), GigaAM-RNNT, Kaldi/Zipformer transducer
//   * AED               — Canary (NeMo-AED), Cohere (merged decoder, fp16 KV-cache dtype)
//
// Routed via `super::EngineKind`. The CTC family is implemented FULLY (most tractable + exact
// numerical parity with onnx-asr). The transducer + AED loops are implemented against the real
// `ort` API with the exact onnx-asr control flow; export-specific tensor names are resolved from
// session metadata with deterministic fallbacks.
//
// HONORED INVARIANTS (see 03_stt_engine.md §6, §10):
//   * DML-incompatible or DML-slower engines are forced to CPU EP by the caller
//     (`override_dml_to_cpu_for_kind`) BEFORE the `EngineConfig.providers` reaches us; we honor
//     whatever provider list we're handed.
//   * int8-preferred resolution is done by the resolver; the `effective_quantization` on the
//     `ResolvedModel` is authoritative.
//   * Audio arrives mono 16 kHz f32 in [-1,1], ALREADY peak-normalized to 0.95 by the coordinator.
//     Engines add NO conditioning (except SenseVoice's intrinsic fbank pre-emphasis 0.97).
//   * Cohere fp16: read the past_key_values dtype off the decoder session + promote fp16 logits→f32.
//   * Zipformer/icefall ALL-CAPS vocab → lowercase decoded text (super::vocab_is_uppercase).
//   * `panic = "unwind"` is load-bearing — the COORDINATOR wraps transcribe() in catch_unwind; we
//     surface allocation/parse failures as `SttError` where feasible but ORT panics are acceptable.
//
// This file is the MODULE ROOT for the `families/` directory module. The engine implementations and
// shared support layer live in the submodules declared below; the dispatch (`build_family_engine`),
// the `pub(crate) file` re-export (used by `streaming.rs`), and the pure-logic tests stay here.

#![allow(dead_code)] // surface defined ahead of the dispatch call sites / resolver wiring.

mod aed;
mod ctc;
mod frontend;
mod support;
mod transducer;

use super::{EngineConfig, EngineKind, SttError, SttResult, Transcriber};

// Keep `families::file` reachable for `streaming.rs` (`use super::families::file;`).
pub(crate) use support::file;

// ───────────────────────────────────────────────────────────────────────────
// 9. Dispatch
// ───────────────────────────────────────────────────────────────────────────

/// Build the non-Whisper engine for a resolved model. Whisper/Moonshine live in their own files.
pub fn build_family_engine(cfg: EngineConfig) -> SttResult<Box<dyn Transcriber>> {
    let engine: Box<dyn Transcriber> = match cfg.kind {
        EngineKind::SenseVoiceCtc => Box::new(ctc::SenseVoiceEngine::load(&cfg)?),
        EngineKind::DolphinCtc => Box::new(ctc::CtcEngine::load(
            &cfg,
            ctc::CtcFrontend::KaldiWithMetaCmvn,
        )?),
        // NeMo CTC (parakeet/fastconformer) uses the PROVEN 128-mel featurizer; GigaAM v3 CTC uses
        // its own 64-mel featurizer (n_fft=320/win=320/hop=160 periodic-Hann, embedded filterbank).
        EngineKind::NemoCtc => Box::new(ctc::CtcEngine::load(&cfg, ctc::CtcFrontend::NemoMel128)?),
        EngineKind::GigaamCtc => Box::new(ctc::CtcEngine::load(&cfg, ctc::CtcFrontend::GigaamV3)?),
        EngineKind::KaldiTransducer => Box::new(transducer::TransducerEngine::load(
            &cfg,
            transducer::TransducerKind::KaldiStateless,
        )?),
        EngineKind::NemoRnnt => Box::new(transducer::TransducerEngine::load(
            &cfg,
            transducer::TransducerKind::NemoRnnt,
        )?),
        EngineKind::GigaamRnnt => Box::new(transducer::TransducerEngine::load(
            &cfg,
            transducer::TransducerKind::GigaamRnnt,
        )?),
        EngineKind::NemoTdt => Box::new(transducer::TransducerEngine::load(
            &cfg,
            transducer::TransducerKind::NemoTdt,
        )?),
        EngineKind::CohereAsr => Box::new(aed::CohereEngine::load(&cfg)?),
        EngineKind::GraniteSpeechAr => Box::new(aed::GraniteArEngine::load(&cfg)?),
        EngineKind::GraniteSpeechNar => Box::new(aed::GraniteNarEngine::load(&cfg)?),
        EngineKind::NemoAed => Box::new(aed::CanaryEngine::load(&cfg)?),
        EngineKind::ToneCtc => Box::new(aed::ToneEngine::load(&cfg)?),
        // Native streaming via sherpa-onnx OnlineRecognizer (cache-aware, sherpa's own runtime).
        EngineKind::NemoCtcStreaming => Box::new(super::streaming::SherpaStreamingEngine::load(
            &cfg,
            super::streaming::SherpaStreamFamily::NemoCtc,
        )?),
        EngineKind::NemoRnntStreaming | EngineKind::KaldiTransducerStreaming => {
            Box::new(super::streaming::SherpaStreamingEngine::load(
                &cfg,
                super::streaming::SherpaStreamFamily::Transducer,
            )?)
        }
        EngineKind::WhisperHf | EngineKind::WhisperOrt | EngineKind::Moonshine => {
            return Err(SttError::Unsupported(
                "build_family_engine: Whisper/Moonshine handled by their own engine files",
            ));
        }
    };
    Ok(engine)
}

// ───────────────────────────────────────────────────────────────────────────
// 11. Pure-logic unit tests (no ORT session required)
// ───────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::super::TranscribeOptions;
    use super::aed::{canary_prompt_tokens, COHERE_LANGUAGES};
    use super::ctc::{parse_float_vec, SvMeta};
    use super::frontend;
    use super::support::{
        argmax_1d, argmax_last_axis_2d, b64_to_utf8, is_special_token, join_and_normalize,
        pick_feat_len_inputs,
    };

    #[test]
    fn argmax_1d_picks_max() {
        assert_eq!(argmax_1d(&[0.1, 0.9, 0.3]).0, 1);
        assert_eq!(argmax_1d(&[5.0, -1.0, 2.0]).0, 0);
        assert_eq!(argmax_1d(&[1.0, 1.0, 3.0]).0, 2);
    }

    #[test]
    fn argmax_last_axis_2d_per_row() {
        let a = ndarray::array![[0.1f32, 0.2, 0.7], [0.9, 0.05, 0.05]];
        let ids = argmax_last_axis_2d(a.view());
        assert_eq!(ids, vec![2, 0]);
    }

    #[test]
    fn parse_float_vec_handles_commas_and_spaces() {
        assert_eq!(
            parse_float_vec("1.0, 2.5  3.0\n-1.0"),
            vec![1.0, 2.5, 3.0, -1.0]
        );
        assert!(parse_float_vec("").is_empty());
    }

    #[test]
    fn b64_roundtrip_ascii() {
        // "AB" → base64 "QUI=" — verify decode back to "AB".
        assert_eq!(b64_to_utf8("QUI=").as_deref(), Some("AB"));
        // "hello" → "aGVsbG8="
        assert_eq!(b64_to_utf8("aGVsbG8=").as_deref(), Some("hello"));
    }

    #[test]
    fn join_lowercases_uppercase_vocab() {
        let syms = ["THE", " QUICK", " BROWN"];
        assert_eq!(join_and_normalize(&syms, true), "the quick brown");
        assert_eq!(join_and_normalize(&syms, false), "THE QUICK BROWN");
    }

    #[test]
    fn join_strips_leading_and_squeezes_spaces() {
        let syms = [" ", "hello", "  ", "world", " "];
        assert_eq!(join_and_normalize(&syms, false), "hello world");
    }

    #[test]
    fn is_special_token_matches_markers() {
        assert!(is_special_token("<|startoftranscript|>"));
        assert!(is_special_token("<unk>"));
        assert!(is_special_token("<pad>"));
        assert!(!is_special_token("hello"));
        assert!(!is_special_token("\u{2581}the"));
    }

    #[test]
    fn lfr_stacks_and_pads_last_window() {
        // 3 frames of dim 2; window 2, shift 2 → out_frames = 1 + (3-1)/2 = 2.
        let feats = ndarray::array![[1.0f32, 2.0], [3.0, 4.0], [5.0, 6.0]];
        let lfr = frontend::apply_lfr(&feats, 2, 2);
        assert_eq!(lfr.nrows(), 2);
        assert_eq!(lfr.ncols(), 4);
        // row0 = frames [0,1] flattened
        assert_eq!(lfr.row(0).to_vec(), vec![1.0, 2.0, 3.0, 4.0]);
        // row1 = frames [2, pad(2)] flattened (last frame repeated)
        assert_eq!(lfr.row(1).to_vec(), vec![5.0, 6.0, 5.0, 6.0]);
    }

    #[test]
    fn cmvn_applies_affine() {
        let mut feats = ndarray::array![[1.0f32, 2.0], [3.0, 4.0]];
        frontend::apply_cmvn(&mut feats, &[1.0, -1.0], &[2.0, 0.5]);
        // (1+1)*2=4 ; (2-1)*0.5=0.5 ; (3+1)*2=8 ; (4-1)*0.5=1.5
        assert_eq!(feats.row(0).to_vec(), vec![4.0, 0.5]);
        assert_eq!(feats.row(1).to_vec(), vec![8.0, 1.5]);
    }

    #[test]
    fn cmvn_noop_on_shape_mismatch() {
        let mut feats = ndarray::array![[1.0f32, 2.0]];
        frontend::apply_cmvn(&mut feats, &[1.0], &[2.0]); // wrong len
        assert_eq!(feats.row(0).to_vec(), vec![1.0, 2.0]);
    }

    #[test]
    fn dolphin_cmvn_subtracts_then_scales() {
        let mut feats = ndarray::array![[2.0f32, 4.0]];
        frontend::apply_dolphin_cmvn(&mut feats, &[1.0, 2.0], &[2.0, 0.5]);
        // (2-1)*2=2 ; (4-2)*0.5=1
        assert_eq!(feats.row(0).to_vec(), vec![2.0, 1.0]);
    }

    #[test]
    fn mel_filterbank_shape() {
        let fb = frontend::build_mel_filterbank();
        assert_eq!(fb.shape(), &[frontend::N_FFT / 2 + 1, frontend::NUM_MELS]);
        // all weights non-negative
        assert!(fb.iter().all(|&v| v >= 0.0));
    }

    #[test]
    fn fbank_frame_count_snip_edges() {
        // 400 win, 160 hop, snip_edges: N=1000 → 1 + (1000-400)/160 = 1 + 3 = 4 frames.
        let samples = vec![0.01f32; 1000];
        let fb = frontend::build_mel_filterbank();
        let feats = frontend::compute_fbank(&samples, &fb);
        assert_eq!(feats.nrows(), 4);
        assert_eq!(feats.ncols(), frontend::NUM_MELS);
    }

    #[test]
    fn fbank_empty_when_too_short() {
        let samples = vec![0.0f32; 100];
        let fb = frontend::build_mel_filterbank();
        let feats = frontend::compute_fbank(&samples, &fb);
        assert_eq!(feats.nrows(), 0);
    }

    #[test]
    fn sv_meta_resolves_lang_ids() {
        let mut map = BTreeMap::new();
        map.insert("vocab_size".to_string(), "25000".to_string());
        let meta = SvMeta::from_map(&map).unwrap();
        // defaults: en→4, zh→3, auto→0
        assert_eq!(meta.resolve_lang_id("en"), 4);
        assert_eq!(meta.resolve_lang_id("zh"), 3);
        assert_eq!(meta.resolve_lang_id(""), 0);
        assert_eq!(meta.resolve_lang_id("unknown-lang"), 0);
    }

    #[test]
    fn sv_meta_missing_vocab_size_errors() {
        let map = BTreeMap::new();
        assert!(SvMeta::from_map(&map).is_err());
    }

    #[test]
    fn sv_meta_nano_detected_from_comment() {
        let mut map = BTreeMap::new();
        map.insert("vocab_size".to_string(), "1000".to_string());
        map.insert("comment".to_string(), "FunASR Nano export".to_string());
        let meta = SvMeta::from_map(&map).unwrap();
        assert!(meta.is_nano);
        assert!(meta.neg_mean.is_empty());
    }

    #[test]
    fn pick_feat_len_inputs_dolphin_and_nemo() {
        assert_eq!(
            pick_feat_len_inputs(&["x".into(), "x_len".into()]),
            ("x".into(), "x_len".into())
        );
        assert_eq!(
            pick_feat_len_inputs(&["audio_signal".into(), "length".into()]),
            ("audio_signal".into(), "length".into())
        );
        assert_eq!(
            pick_feat_len_inputs(&["features".into(), "feature_lengths".into()]),
            ("features".into(), "feature_lengths".into())
        );
    }

    #[test]
    fn cohere_lang_token_resolution() {
        // build a minimal engine-like resolver via the const + helper logic.
        let resolve = |lang: Option<&str>| -> String {
            match lang {
                Some(l) if COHERE_LANGUAGES.contains(&l.to_lowercase().as_str()) => {
                    format!("<|{}|>", l.to_lowercase())
                }
                None => "<|unklang|>".into(),
                Some(_) => "<|en|>".into(),
            }
        };
        assert_eq!(resolve(Some("FR")), "<|fr|>");
        assert_eq!(resolve(Some("xx")), "<|en|>");
        assert_eq!(resolve(None), "<|unklang|>");
    }

    fn canary_prompt_fixture() -> (Vec<i64>, BTreeMap<String, i64>) {
        let base = vec![0, 1, 2, 3, 10, 10, 6, 7, 8, 9];
        let token_to_id = BTreeMap::from([
            ("<|en|>".to_string(), 10),
            ("<|de|>".to_string(), 11),
            ("<|fr|>".to_string(), 12),
        ]);
        (base, token_to_id)
    }

    #[test]
    fn canary_prompt_uses_configured_language_as_source_and_target() {
        let (base, token_to_id) = canary_prompt_fixture();
        let opts = TranscribeOptions {
            language: Some("de".to_string()),
            ..Default::default()
        };

        let prompt = canary_prompt_tokens(&base, &token_to_id, &opts);

        assert_eq!((prompt[4], prompt[5]), (11, 11));
    }

    #[test]
    fn canary_prompt_translates_configured_source_to_english() {
        let (base, token_to_id) = canary_prompt_fixture();
        let opts = TranscribeOptions {
            language: Some("de".to_string()),
            translate: true,
            ..Default::default()
        };

        let prompt = canary_prompt_tokens(&base, &token_to_id, &opts);

        assert_eq!((prompt[4], prompt[5]), (11, 10));
    }

    #[test]
    fn canary_prompt_uses_first_candidate_when_language_is_unset() {
        let (base, token_to_id) = canary_prompt_fixture();
        let opts = TranscribeOptions {
            language_candidates: vec!["de".to_string(), "fr".to_string()],
            ..Default::default()
        };

        let prompt = canary_prompt_tokens(&base, &token_to_id, &opts);

        assert_eq!((prompt[4], prompt[5]), (11, 11));
    }
}
