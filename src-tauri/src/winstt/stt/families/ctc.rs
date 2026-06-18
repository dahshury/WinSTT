// CTC engines:
//   * SenseVoice (FBANK + LFR + CMVN + 4-control-token strip),
//   * the generic `CtcEngine` (Dolphin / NeMo-CTC / GigaAM-CTC) selected by `CtcFrontend`.
//
// Lifted verbatim out of the old monolithic `families.rs`; depends only on the shared `support`
// layer and the `frontend` featurizers, never on a peer engine.

use std::collections::BTreeMap;

use ndarray::{Array2, Axis};
use ort::session::Session;
use ort::value::Tensor;

use super::super::{
    ctc_greedy_collapse, EngineConfig, EngineKind, SttError, SttResult, TranscribeOptions,
    Transcriber, Transcription,
};
use super::frontend;
use super::support::*;

// ───────────────────────────────────────────────────────────────────────────
// 4. SenseVoice CTC  (FULL impl — fbank + LFR + CMVN + 4-control-token strip)
// ───────────────────────────────────────────────────────────────────────────

const SV_NUM_CONTROL_TOKENS: usize = 4;
const SV_DEFAULT_LFR_WIN: usize = 7;
const SV_DEFAULT_LFR_SHIFT: usize = 6;

/// Parsed SenseVoice ONNX `custom_metadata_map`. Defaults mirror `_parse_metadata`.
pub(super) struct SvMeta {
    pub(super) is_nano: bool,
    blank_id: i64,
    lfr_window_size: usize,
    lfr_window_shift: usize,
    normalize_samples: bool,
    with_itn_id: i32,
    lang2id: BTreeMap<String, i32>,
    pub(super) neg_mean: Vec<f32>,
    inv_stddev: Vec<f32>,
}

impl SvMeta {
    pub(super) fn from_map(meta: &BTreeMap<String, String>) -> SttResult<SvMeta> {
        let int = |k: &str, d: i64| {
            meta.get(k)
                .and_then(|s| s.trim().parse::<i64>().ok())
                .unwrap_or(d)
        };
        let is_nano = meta.get("comment").is_some_and(|c| c.contains("Nano"));
        let _vocab_size = meta
            .get("vocab_size")
            .and_then(|s| s.trim().parse::<i64>().ok())
            .ok_or_else(|| SttError::Tokenizer("SenseVoice metadata missing vocab_size".into()))?;
        let blank_id = int("blank_id", 0);
        let lfr_window_size = int("lfr_window_size", SV_DEFAULT_LFR_WIN as i64).max(1) as usize;
        let lfr_window_shift = int("lfr_window_shift", SV_DEFAULT_LFR_SHIFT as i64).max(1) as usize;
        let normalize_samples = int("normalize_samples", 0) != 0;

        let (with_itn_id, lang2id, neg_mean, inv_stddev) = if is_nano {
            (14, BTreeMap::new(), Vec::new(), Vec::new())
        } else {
            let with_itn_id = int("with_itn", 14) as i32;
            let mut lang2id = BTreeMap::new();
            for (code, key) in [
                ("auto", "lang_auto"),
                ("zh", "lang_zh"),
                ("en", "lang_en"),
                ("ja", "lang_ja"),
                ("ko", "lang_ko"),
                ("yue", "lang_yue"),
            ] {
                if let Some(v) = meta.get(key).and_then(|s| s.trim().parse::<i32>().ok()) {
                    lang2id.insert(code.to_string(), v);
                }
            }
            if lang2id.is_empty() {
                for (code, id) in [
                    ("auto", 0),
                    ("zh", 3),
                    ("en", 4),
                    ("yue", 7),
                    ("ja", 11),
                    ("ko", 12),
                ] {
                    lang2id.insert(code.to_string(), id);
                }
            }
            let neg_mean = parse_float_vec(meta.get("neg_mean").map_or("", String::as_str));
            let inv_stddev = parse_float_vec(meta.get("inv_stddev").map_or("", String::as_str));
            (with_itn_id, lang2id, neg_mean, inv_stddev)
        };

        Ok(SvMeta {
            is_nano,
            blank_id,
            lfr_window_size,
            lfr_window_shift,
            normalize_samples,
            with_itn_id,
            lang2id,
            neg_mean,
            inv_stddev,
        })
    }

    pub(super) fn resolve_lang_id(&self, language: &str) -> i32 {
        let canonical = match language {
            "" | "auto" => "auto",
            "zh" | "zh-Hans" | "zh-Hant" => "zh",
            "en" => "en",
            "ja" => "ja",
            "ko" => "ko",
            "yue" => "yue",
            _ => "auto",
        };
        *self
            .lang2id
            .get(canonical)
            .or_else(|| self.lang2id.get("auto"))
            .unwrap_or(&0)
    }
}

pub(super) fn parse_float_vec(raw: &str) -> Vec<f32> {
    raw.replace(',', " ")
        .split_whitespace()
        .filter_map(|t| t.parse::<f32>().ok())
        .collect()
}

pub struct SenseVoiceEngine {
    session: Session,
    vocab: Vocab,
    meta: SvMeta,
    mel_fb: Array2<f32>,
    input_names: Vec<String>,
    model_name: String,
    providers: Vec<String>,
}

impl SenseVoiceEngine {
    pub fn load(cfg: &EngineConfig) -> SttResult<SenseVoiceEngine> {
        let model_path = file(&cfg.resolved, "model")?;
        let vocab_path = file(&cfg.resolved, "vocab")?;
        let session = build_session(model_path, &cfg.providers)?;

        let meta = read_custom_metadata(&session)?;
        let meta = SvMeta::from_map(&meta)?;
        let vocab = Vocab::load(vocab_path, meta.is_nano, false)?;
        let input_names: Vec<String> = session_input_names(&session);

        Ok(SenseVoiceEngine {
            session,
            vocab,
            meta,
            mel_fb: frontend::build_mel_filterbank(),
            input_names,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
        })
    }

    fn features_for(&self, audio: &[f32]) -> Array2<f32> {
        let scaled: Vec<f32>;
        let samples: &[f32] = if self.meta.normalize_samples {
            scaled = audio.iter().map(|&s| s * 32768.0).collect();
            &scaled
        } else {
            audio
        };
        let fbank = frontend::compute_fbank(samples, &self.mel_fb);
        let mut lfr = frontend::apply_lfr(
            &fbank,
            self.meta.lfr_window_size,
            self.meta.lfr_window_shift,
        );
        if !self.meta.is_nano && !self.meta.neg_mean.is_empty() {
            frontend::apply_cmvn(&mut lfr, &self.meta.neg_mean, &self.meta.inv_stddev);
        }
        lfr
    }
}

impl Transcriber for SenseVoiceEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::SenseVoiceCtc
    }
    fn model_name(&self) -> &str {
        &self.model_name
    }
    fn is_ready(&self) -> bool {
        true
    }
    fn active_providers(&self) -> &[String] {
        &self.providers
    }

    fn transcribe(&mut self, audio: &[f32], opts: &TranscribeOptions) -> SttResult<Transcription> {
        if audio.is_empty() {
            return Ok(Transcription::default());
        }
        let features = self.features_for(audio);
        let n_feat_frames = features.nrows();
        if n_feat_frames == 0 {
            return Ok(Transcription::default());
        }
        let feat_dim = features.ncols();

        // (1, T, feat_dim)
        let feat3 = features
            .into_shape_with_order((1, n_feat_frames, feat_dim))
            .map_err(|e| SttError::Inference(format!("sense_voice reshape: {e}")))?;
        let feat_tensor = Tensor::from_array(feat3)
            .map_err(|e| SttError::Inference(format!("sense_voice feat tensor: {e}")))?;

        let language = opts.language.as_deref().unwrap_or("");
        let outputs = if self.meta.is_nano {
            self.session
                .run(ort::inputs![self.input_names[0].as_str() => feat_tensor])
                .map_err(|e| SttError::Inference(format!("sense_voice nano run: {e}")))?
        } else {
            let x_len = tensor_i32_1d(vec![n_feat_frames as i32])?;
            let lang = tensor_i32_1d(vec![self.meta.resolve_lang_id(language)])?;
            let itn = tensor_i32_1d(vec![self.meta.with_itn_id])?;
            self.session
                .run(ort::inputs![
                    self.input_names[0].as_str() => feat_tensor,
                    self.input_names[1].as_str() => x_len,
                    self.input_names[2].as_str() => lang,
                    self.input_names[3].as_str() => itn,
                ])
                .map_err(|e| SttError::Inference(format!("sense_voice run: {e}")))?
        };

        // logits (1, T', vocab)
        let logits = out_to_f32(&outputs[0])?;
        let dims = logits.shape();
        if dims.len() != 3 {
            return Err(SttError::Inference("sense_voice logits not 3-D".into()));
        }
        let logits2 = logits
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("sense_voice dim: {e}")))?;
        let frame_logits = logits2.index_axis_move(Axis(0), 0); // (T', vocab)

        // num_frames cap: Nano → T'; full → feat_frames + 4 control tokens.
        let num_frames = if self.meta.is_nano {
            frame_logits.nrows()
        } else {
            n_feat_frames + SV_NUM_CONTROL_TOKENS
        }
        .min(frame_logits.nrows());

        let scanned = frame_logits.slice(ndarray::s![..num_frames, ..]);
        let ids = argmax_last_axis_2d(scanned);
        let collapsed = ctc_greedy_collapse(&ids, self.meta.blank_id);

        // strip leading 4 control tokens (non-Nano), ▁→space already handled at decode by symbol.
        let start = if self.meta.is_nano {
            0
        } else {
            SV_NUM_CONTROL_TOKENS
        };
        let mut text = String::new();
        for &tid in collapsed.iter().skip(start) {
            if let Some(sym) = self.vocab.get(tid) {
                // Only allocate a replacement String when the U+2581 marker is present;
                // otherwise push the symbol directly (most tokens have no marker).
                if sym.contains('\u{2581}') {
                    text.push_str(&sym.replace('\u{2581}', " "));
                } else {
                    text.push_str(sym);
                }
            }
        }
        let text = text.trim().replace(" '", "'").replace(" \u{2581}'", "'");

        Ok(Transcription {
            text,
            ..Default::default()
        })
    }
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Generic CTC engine  (Dolphin, NeMo-CTC, GigaAM-CTC)
// ───────────────────────────────────────────────────────────────────────────

/// Which kaldi/nemo front-end + CMVN a generic CTC engine uses.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CtcFrontend {
    /// 80-dim kaldi fbank + per-bin CMVN read from ONNX metadata (Dolphin).
    KaldiWithMetaCmvn,
    /// GigaAM v3 64-mel log featurizer (n_fft=320/win=320/hop=160, periodic-Hann window, no
    /// pre-emphasis, log clamp(1e-9,1e9)) — `frontend::gigaam_v3_features`. Channel-major `features`
    /// input (1,64,T); CTC frames >= encoder_out_lens=(features_lens-1)//4+1 are masked before
    /// greedy collapse (onnx-asr asr.py:348). Faithful to onnx_asr GigaamPreprocessorNumpy("gigaam_v3").
    GigaamV3,
    /// PROVEN NeMo 128-mel log-mel featurizer (per-feature norm) — parakeet/fastconformer CTC.
    /// Same featurizer that validated Canary (NemoAed). Uses `frontend::nemo_features`.
    NemoMel128,
}

pub struct CtcEngine {
    session: Session,
    vocab: Vocab,
    kind: EngineKind,
    frontend: CtcFrontend,
    mel_fb: Array2<f32>,
    // Dolphin CMVN (per-mel-bin) from metadata; empty for others.
    cmvn_mean: Vec<f32>,
    cmvn_invstd: Vec<f32>,
    blank_id: i64,
    // Encoder subsampling factor: CTC frames >= (features_lens-1)//factor+1 are masked before the
    // greedy collapse (GigaAM v3 = 4 from config.json; others leave it 1 → no extra masking since
    // the CTC output already has T'==encoder_out_lens for kaldi/nemo single-frame models).
    subsampling_factor: usize,
    // I/O names resolved at load (Dolphin output is misnamed `lob_probs`, resolved by rank).
    feat_input: String,
    len_input: String,
    logits_output: String,
    model_name: String,
    providers: Vec<String>,
}

impl CtcEngine {
    pub(crate) fn load(cfg: &EngineConfig, frontend: CtcFrontend) -> SttResult<CtcEngine> {
        let model_path = file(&cfg.resolved, "model")?;
        let vocab_path = file(&cfg.resolved, "vocab")?;
        let session = build_session(model_path, &cfg.providers)?;
        let vocab = Vocab::load(vocab_path, false, true)?;

        // Resolve I/O by name/rank. Dolphin: input `x`/`x_len`, output 3-D logprobs (`lob_probs`);
        // NeMo/GigaAM: input `audio_signal`/`length` or `features`/`feature_lengths`, output `logprobs`.
        let inputs = session_input_names(&session);
        let outputs = session_output_names(&session);
        let (feat_input, len_input) = pick_feat_len_inputs(&inputs);
        let logits_output = pick_logits_output(&session, &outputs);

        // Dolphin blank is 0; metadata CMVN. GigaAM v3 blank is the vocab `<blk>` (256).
        let (blank_id, cmvn_mean, cmvn_invstd) = match frontend {
            CtcFrontend::KaldiWithMetaCmvn => {
                let meta = read_custom_metadata(&session)?;
                let mean = parse_float_vec(meta.get("mean").map_or("", String::as_str));
                let invstd = parse_float_vec(meta.get("invstd").map_or("", String::as_str));
                (0, mean, invstd)
            }
            CtcFrontend::GigaamV3 | CtcFrontend::NemoMel128 => {
                (vocab.blank_idx, Vec::new(), Vec::new())
            }
        };

        // Per-frontend filterbank:
        //   * NeMo128 → proven Slaney bank at the model's declared mel count (parakeet/fastconformer).
        //   * KaldiWithMetaCmvn (Dolphin) → the kaldi 80-mel bank (n_fft=512, fmin=20, fmax=7600,
        //     kaldi mel scale, NO slaney norm) matching onnx-asr's KaldiPreprocessorNumpy.
        //   * GigaamV3 → embedded 64-mel bank (built into `gigaam_v3_features`, so mel_fb is unused).
        let mel_fb = match frontend {
            CtcFrontend::NemoMel128 => {
                frontend::build_nemo_mel_filterbank(feat_dim_of(&session, &feat_input))
            }
            CtcFrontend::KaldiWithMetaCmvn => frontend::build_kaldi_mel_filterbank(),
            CtcFrontend::GigaamV3 => frontend::build_mel_filterbank(),
        };

        // GigaAM v3 sub-samples ×4 in the encoder (config.json subsampling_factor) → CTC masks
        // trailing padded frames before greedy collapse. Other CTC families don't pad → factor 1.
        let subsampling_factor = match frontend {
            CtcFrontend::GigaamV3 => 4,
            _ => 1,
        };

        Ok(CtcEngine {
            session,
            vocab,
            kind: cfg.kind,
            frontend,
            mel_fb,
            cmvn_mean,
            cmvn_invstd,
            blank_id,
            subsampling_factor,
            feat_input,
            len_input,
            logits_output,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
        })
    }

    fn features_for(&self, audio: &[f32]) -> Array2<f32> {
        match self.frontend {
            CtcFrontend::GigaamV3 => {
                // GigaAM v3 64-mel log featurizer (embedded window + filterbank) — no CMVN, no norm.
                frontend::gigaam_v3_features(audio)
            }
            CtcFrontend::NemoMel128 => {
                // NeMo 128-mel featurizer w/ per-feature norm (proven on Canary) — no extra CMVN.
                frontend::nemo_features(audio, &self.mel_fb)
            }
            CtcFrontend::KaldiWithMetaCmvn => {
                // Dolphin: kaldi 80-mel fbank (symmetric-pad, n_fft=512, povey window, per-frame DC
                // removal + pre-emphasis) — onnx-asr KaldiPreprocessorNumpy — then per-mel-bin CMVN
                // `(fbank - mean) * invstd` from the ONNX metadata (dolphin.py::_encode).
                let mut fbank = frontend::compute_kaldi_fbank(audio, &self.mel_fb);
                if !self.cmvn_mean.is_empty() {
                    frontend::apply_dolphin_cmvn(&mut fbank, &self.cmvn_mean, &self.cmvn_invstd);
                }
                fbank
            }
        }
    }

    /// `encoder_out_lens = (features_lens - 1) // subsampling_factor + 1` (onnx-asr GigaamV2Ctc._encode).
    fn encoder_out_len(&self, features_lens: usize) -> usize {
        if features_lens == 0 {
            return 0;
        }
        (features_lens - 1) / self.subsampling_factor + 1
    }
}

impl Transcriber for CtcEngine {
    fn kind(&self) -> EngineKind {
        self.kind
    }
    fn model_name(&self) -> &str {
        &self.model_name
    }
    fn is_ready(&self) -> bool {
        true
    }
    fn active_providers(&self) -> &[String] {
        &self.providers
    }

    fn transcribe(&mut self, audio: &[f32], _opts: &TranscribeOptions) -> SttResult<Transcription> {
        if audio.is_empty() {
            return Ok(Transcription::default());
        }
        let features = self.features_for(audio);
        let n_frames = features.nrows();
        if n_frames == 0 {
            return Ok(Transcription::default());
        }
        let feat_dim = features.ncols();

        // Dolphin: x is (N, T, 80) time-major. NeMo/GigaAM: features (N, feat, T) channel-major.
        // We feed the kaldi-style (1, T, 80) for Dolphin; for NeMo/GigaAM we transpose to (1, feat, T).
        let (tensor, len_val) = match self.frontend {
            CtcFrontend::KaldiWithMetaCmvn => {
                let x = features
                    .into_shape_with_order((1, n_frames, feat_dim))
                    .map_err(|e| SttError::Inference(format!("ctc reshape: {e}")))?;
                (
                    Tensor::from_array(x)
                        .map_err(|e| SttError::Inference(format!("ctc tensor: {e}")))?,
                    n_frames as i64,
                )
            }
            CtcFrontend::GigaamV3 | CtcFrontend::NemoMel128 => {
                // (T, feat) → (feat, T) → (1, feat, T). `.t()` is an F-order view; force a
                // C-contiguous owned copy before reshaping (into_shape_with_order rejects F-order).
                let t = features.t().as_standard_layout().into_owned();
                let x = t
                    .into_shape_with_order((1, feat_dim, n_frames))
                    .map_err(|e| SttError::Inference(format!("nemo reshape: {e}")))?;
                (
                    Tensor::from_array(x)
                        .map_err(|e| SttError::Inference(format!("nemo tensor: {e}")))?,
                    n_frames as i64,
                )
            }
        };
        let len_tensor = tensor_i64_1d(vec![len_val])?;
        // encoder_out_lens (= (features_lens-1)//subsampling+1) — computed before the &mut session
        // borrow so the post-run masking can use it without re-borrowing self.
        let enc_len_unclamped = self.encoder_out_len(n_frames);
        let blank_id = self.blank_id;
        let logits_output = self.logits_output.clone();

        let outputs = self
            .session
            .run(ort::inputs![
                self.feat_input.as_str() => tensor,
                self.len_input.as_str() => len_tensor,
            ])
            .map_err(|e| SttError::Inference(format!("ctc run: {e}")))?;

        let logits = out_to_f32(&outputs[logits_output.as_str()])?;
        let logits3 = logits
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("ctc logits dim: {e}")))?;
        let frame_logits = logits3.index_axis_move(Axis(0), 0); // (T', vocab)
        let mut ids = argmax_last_axis_2d(frame_logits.view());
        // Mask CTC frames >= encoder_out_lens before the greedy collapse — onnx-asr asr.py:348 builds
        // `batch_mask` from encoder_out_lens, so trailing padded encoder frames cannot emit spurious
        // tokens. We force those frames to the blank id (collapse drops blanks). subsampling_factor==1
        // (kaldi/dolphin) makes this a no-op.
        let enc_len = enc_len_unclamped.min(ids.len());
        for id in ids.iter_mut().skip(enc_len) {
            *id = blank_id;
        }
        let collapsed = ctc_greedy_collapse(&ids, blank_id);

        let syms: Vec<&str> = collapsed
            .iter()
            .filter_map(|&id| self.vocab.get(id))
            .collect();
        let text = join_and_normalize(&syms, self.vocab.lowercase_decoded);
        Ok(Transcription {
            text,
            ..Default::default()
        })
    }
}
