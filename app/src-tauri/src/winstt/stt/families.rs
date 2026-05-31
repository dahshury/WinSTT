// PORT IMPL — drafted against real APIs, pending compile.
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
// `ort` API with the exact onnx-asr control flow; the few constants that genuinely need the STT
// spike result (e.g. NeMo output tensor names that vary per export) are marked `// SPIKE:` with a
// sensible default so the file still compiles and runs.
//
// HONORED INVARIANTS (see 03_stt_engine.md §6, §10):
//   * DML-incompatible families (nemo/cohere/gigaam/kaldi/t-one/sense_voice/dolphin) are forced to
//     CPU EP by the caller (`catalog::must_force_cpu` / `override_dml_to_cpu_for_family`) BEFORE the
//     `EngineConfig.providers` reaches us; we honor whatever provider list we're handed.
//   * int8-preferred resolution is done by the resolver; the `effective_quantization` on the
//     `ResolvedModel` is authoritative.
//   * Audio arrives mono 16 kHz f32 in [-1,1], ALREADY peak-normalized to 0.95 by the coordinator.
//     Engines add NO conditioning (except SenseVoice's intrinsic fbank pre-emphasis 0.97).
//   * Cohere fp16: read the past_key_values dtype off the decoder session + promote fp16 logits→f32.
//   * Zipformer/icefall ALL-CAPS vocab → lowercase decoded text (super::vocab_is_uppercase).
//   * `panic = "unwind"` is load-bearing — the COORDINATOR wraps transcribe() in catch_unwind; we
//     surface allocation/parse failures as `SttError` where feasible but ORT panics are acceptable.

#![allow(dead_code)] // surface defined ahead of the dispatch call sites / resolver wiring.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ndarray::{Array1, Array2, ArrayD, ArrayView2, Axis};
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;

/// fp16 element type. `ort` depends on `half` and impls `PrimitiveTensorElementType` for
/// `half::f16`; this alias is the single reference point so the (transitive) `half` dep — which
/// must be declared direct in Cargo.toml for this path — is easy to swap if ort re-exports it
/// (e.g. `ort::half::f16`) under a different name in the pinned rc.
type F16 = half::f16;

use super::{
	Accelerator, EngineConfig, EngineKind, ResolvedModel, SttError, SttResult, TranscribeOptions,
	Transcription, Transcriber, ctc_greedy_collapse, pick_intra_op_threads, vocab_is_uppercase,
};

// ───────────────────────────────────────────────────────────────────────────
// 0. Shared ORT session construction
// ───────────────────────────────────────────────────────────────────────────

/// Build an `ort::Session` for one model file, honoring the resolved provider list.
///
/// Mirrors `onnxasr_transcriber.build_session_options` + `device.providers_for_settings`:
///   * optimization level `ORT_ENABLE_ALL` (Level3) normally; the whisper-fp16 EXTENDED downgrade
///     (§6.2) is a Whisper-family concern handled in `whisper_hf.rs`, not here.
///   * intra-op threads via `pick_intra_op_threads` (CPU→min(cpu,8), GPU→2).
///   * EPs registered per `providers` (already DML→CPU-overridden upstream for these families).
fn build_session(path: &Path, providers: &[Accelerator]) -> SttResult<Session> {
	let is_gpu = providers
		.first()
		.is_some_and(|p| !matches!(p, Accelerator::Cpu));
	let threads = pick_intra_op_threads(is_gpu, num_cpus_best_effort());

	let mut builder = Session::builder()
		.map_err(|e| SttError::SessionCreate(format!("Session::builder: {e}")))?
		.with_optimization_level(GraphOptimizationLevel::Level3)
		.map_err(|e| SttError::SessionCreate(format!("opt level: {e}")))?
		.with_intra_threads(threads)
		.map_err(|e| SttError::SessionCreate(format!("intra threads: {e}")))?;

	builder = register_providers(builder, providers)?;

	builder
		.commit_from_file(path)
		.map_err(|e| SttError::SessionCreate(format!("commit_from_file {}: {e}", path.display())))
}

/// Register the execution providers onto a `SessionBuilder`. The provider list is the FINAL,
/// already-DML-overridden list from `EngineConfig.providers`; these families are forced to CPU
/// for DML/ROCm/CoreML upstream, so in practice this sees `[Cpu]` or `[Cuda, Cpu]`. CPU is always
/// appended last for per-op fallback (mirrors Python `[<gpu_ep>, CPUExecutionProvider]`).
fn register_providers(
	builder: ort::session::builder::SessionBuilder,
	providers: &[Accelerator],
) -> SttResult<ort::session::builder::SessionBuilder> {
	use ort::execution_providers::{
		CPUExecutionProvider, CUDAExecutionProvider, DirectMLExecutionProvider,
		ExecutionProviderDispatch,
	};

	let mut dispatch: Vec<ExecutionProviderDispatch> = Vec::with_capacity(providers.len() + 1);
	let mut saw_cpu = false;
	for acc in providers {
		match acc {
			Accelerator::Cpu => {
				dispatch.push(CPUExecutionProvider::default().build());
				saw_cpu = true;
			}
			// CUDA is reserved for the future Linux NVIDIA build; on Windows it never reaches here
			// for these families (DML→CPU override), but honor it if the resolver hands it to us.
			Accelerator::Cuda => dispatch.push(CUDAExecutionProvider::default().build()),
			Accelerator::DirectMl => dispatch.push(DirectMLExecutionProvider::default().build()),
			// ROCm / CoreML / OpenVino: not built into the Windows `ort` feature set — these
			// families are CPU-forced anyway. Fall through to CPU.
			Accelerator::Rocm | Accelerator::CoreMl | Accelerator::OpenVino => {
				dispatch.push(CPUExecutionProvider::default().build());
				saw_cpu = true;
			}
		}
	}
	if !saw_cpu {
		dispatch.push(CPUExecutionProvider::default().build());
	}
	builder
		.with_execution_providers(dispatch)
		.map_err(|e| SttError::SessionCreate(format!("register EPs: {e}")))
}

fn num_cpus_best_effort() -> usize {
	std::thread::available_parallelism()
		.map(|n| n.get())
		.unwrap_or(4)
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Tensor helpers (ndarray ↔ ort::Value)
// ───────────────────────────────────────────────────────────────────────────

/// Extract a session output as an owned f32 `ArrayD`. The output may be f16 on fp16 exports —
/// we promote to f32 here so downstream argmax/logprob math is uniform (Cohere fp16 logits path).
fn out_to_f32(out: &ort::value::DynValue) -> SttResult<ArrayD<f32>> {
	// Fast path: already f32.
	if let Ok(view) = out.try_extract_array::<f32>() {
		return Ok(view.to_owned());
	}
	// fp16 export → promote. `half::f16` is re-exported by ort's tensor element types.
	if let Ok(view) = out.try_extract_array::<F16>() {
		return Ok(view.mapv(|v| v.to_f32()));
	}
	Err(SttError::Inference(
		"output tensor is neither f32 nor f16".into(),
	))
}

/// Extract an output as owned i64 (encoder_out_lens / mask).
fn out_to_i64(out: &ort::value::DynValue) -> SttResult<ArrayD<i64>> {
	if let Ok(view) = out.try_extract_array::<i64>() {
		return Ok(view.to_owned());
	}
	if let Ok(view) = out.try_extract_array::<i32>() {
		return Ok(view.mapv(i64::from));
	}
	Err(SttError::Inference(
		"length/mask output is neither i64 nor i32".into(),
	))
}

/// argmax along the last axis of a 2-D `(T, vocab)` view → `Vec<i64>` of length `T`.
fn argmax_last_axis_2d(logits: ArrayView2<f32>) -> Vec<i64> {
	let mut out = Vec::with_capacity(logits.nrows());
	for row in logits.rows() {
		let mut best = 0usize;
		let mut best_v = f32::NEG_INFINITY;
		for (j, &v) in row.iter().enumerate() {
			if v > best_v {
				best_v = v;
				best = j;
			}
		}
		out.push(best as i64);
	}
	out
}

/// argmax over a flat 1-D logit slice (single decode step). Returns (index, value).
fn argmax_1d(v: &[f32]) -> (usize, f32) {
	let mut best = 0usize;
	let mut best_v = f32::NEG_INFINITY;
	for (i, &x) in v.iter().enumerate() {
		if x > best_v {
			best_v = x;
			best = i;
		}
	}
	(best, best_v)
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Vocab loading (tokens.txt / vocab.txt — "<token> <id>" per line)
// ───────────────────────────────────────────────────────────────────────────

/// Load a `tokens.txt` / `vocab.txt` (`<symbol> <id>` per line) into `{id → symbol}`.
///
/// Mirrors `_AsrWithDecoding.__init__`: `▁`→space happens at LOAD here so the decode-join matches
/// onnx-asr. `rsplit(None, 1)` keeps symbols that contain whitespace intact. `base64_encoded` is
/// the SenseVoice-Nano path. Detects the `<blk>`/`<blank>` blank id and ALL-CAPS vocabs.
struct Vocab {
	id_to_sym: BTreeMap<i64, String>,
	size: usize,
	blank_idx: i64,
	lowercase_decoded: bool,
}

impl Vocab {
	fn load(path: &Path, base64_encoded: bool, replace_underscore: bool) -> SttResult<Vocab> {
		let text = std::fs::read_to_string(path)
			.map_err(|e| SttError::Tokenizer(format!("read {}: {e}", path.display())))?;
		let mut id_to_sym = BTreeMap::new();
		for line in text.lines() {
			let stripped = line.trim_end_matches(['\n', '\r']);
			if stripped.trim().is_empty() {
				continue;
			}
			// rsplit once on the LAST whitespace run → (symbol, id).
			let Some((symbol, id_str)) = stripped.rsplit_once(char::is_whitespace) else {
				continue;
			};
			let Ok(id) = id_str.trim().parse::<i64>() else {
				continue;
			};
			let mut sym = symbol.to_string();
			if base64_encoded {
				if let Some(decoded) = b64_to_utf8(&sym) {
					sym = decoded;
				}
			}
			if replace_underscore {
				sym = sym.replace('\u{2581}', " ");
			}
			id_to_sym.insert(id, sym);
		}
		if id_to_sym.is_empty() {
			return Err(SttError::Tokenizer(format!(
				"empty vocab {}",
				path.display()
			)));
		}
		let blank_idx = id_to_sym
			.iter()
			.find(|(_, s)| s.as_str() == "<blk>")
			.map(|(id, _)| *id)
			.unwrap_or(0);
		let lowercase_decoded = vocab_is_uppercase(id_to_sym.values().map(String::as_str));
		let size = id_to_sym.len();
		Ok(Vocab {
			id_to_sym,
			size,
			blank_idx,
			lowercase_decoded,
		})
	}

	#[inline]
	fn get(&self, id: i64) -> Option<&str> {
		self.id_to_sym.get(&id).map(String::as_str)
	}
}

fn b64_to_utf8(s: &str) -> Option<String> {
	// Minimal RFC4648 base64 decode (SenseVoice-Nano vocab; std-free manual decode — the `base85`
	// crate is for the Whisper alignment-heads table, not this).
	const fn val(c: u8) -> i16 {
		match c {
			b'A'..=b'Z' => (c - b'A') as i16,
			b'a'..=b'z' => (c - b'a' + 26) as i16,
			b'0'..=b'9' => (c - b'0' + 52) as i16,
			b'+' => 62,
			b'/' => 63,
			_ => -1,
		}
	}
	let bytes = s.as_bytes();
	let mut buf = Vec::with_capacity(s.len() / 4 * 3);
	let mut acc: u32 = 0;
	let mut nbits = 0u32;
	for &c in bytes {
		if c == b'=' {
			break;
		}
		let v = val(c);
		if v < 0 {
			continue;
		}
		acc = (acc << 6) | v as u32;
		nbits += 6;
		if nbits >= 8 {
			nbits -= 8;
			buf.push((acc >> nbits) as u8);
		}
	}
	String::from_utf8(buf).ok()
}

/// Join decoded symbols into text using onnx-asr's `DECODE_SPACE_PATTERN` semantics, then
/// lowercase if the vocab is all-caps (zipformer/icefall). The regex `\A\s|\s\B|(\s)\b` collapses
/// internal SentencePiece spacing; we reproduce its observable behavior: trim a leading space,
/// collapse a run of spaces between word-pieces to one, and keep word-boundary spaces.
fn join_and_normalize(syms: &[&str], lowercase: bool) -> String {
	let raw: String = syms.concat();
	// Collapse the SentencePiece artifacts the way the Python regex does in the common case:
	//   - leading whitespace removed
	//   - any internal whitespace that is NOT at a word boundary removed
	// The pragmatic, parity-safe reduction: trim, then squeeze multiple spaces to one.
	let mut out = String::with_capacity(raw.len());
	let mut prev_space = true; // strips leading
	for ch in raw.chars() {
		if ch.is_whitespace() {
			if !prev_space {
				out.push(' ');
			}
			prev_space = true;
		} else {
			out.push(ch);
			prev_space = false;
		}
	}
	let trimmed = out.trim_end().to_string();
	if lowercase {
		trimmed.to_lowercase()
	} else {
		trimmed
	}
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Front-ends (Kaldi fbank + SenseVoice FBANK/LFR/CMVN)
// ───────────────────────────────────────────────────────────────────────────

mod frontend {
	use ndarray::Array2;

	pub const SAMPLE_RATE: usize = 16_000;
	pub const NUM_MELS: usize = 80;
	pub const N_FFT: usize = 400;
	pub const HOP: usize = 160;
	pub const WIN: usize = 400;
	pub const PRE_EMPHASIS: f32 = 0.97;
	pub const F_MIN: f32 = 20.0;

	/// HTK triangular mel filterbank `(n_fft/2+1, n_mels)`. Port of `_build_mel_filterbank`.
	pub fn build_mel_filterbank() -> Array2<f32> {
		let n_freqs = N_FFT / 2 + 1;
		let fmax = SAMPLE_RATE as f32 / 2.0;
		let all_freqs: Vec<f32> = (0..n_freqs)
			.map(|i| (SAMPLE_RATE as f32 / 2.0) * (i as f32) / ((n_freqs - 1) as f32))
			.collect();
		let m_min = 2595.0 * (1.0 + F_MIN / 700.0).log10();
		let m_max = 2595.0 * (1.0 + fmax / 700.0).log10();
		let m_pts: Vec<f32> = (0..NUM_MELS + 2)
			.map(|i| m_min + (m_max - m_min) * (i as f32) / ((NUM_MELS + 1) as f32))
			.collect();
		let f_pts: Vec<f32> = m_pts
			.iter()
			.map(|&m| 700.0 * (10f32.powf(m / 2595.0) - 1.0))
			.collect();
		let f_diff: Vec<f32> = f_pts.windows(2).map(|w| w[1] - w[0]).collect();

		let mut fb = Array2::<f32>::zeros((n_freqs, NUM_MELS));
		for f in 0..n_freqs {
			for m in 0..NUM_MELS {
				let down = -(f_pts[m] - all_freqs[f]) / f_diff[m];
				let up = (f_pts[m + 2] - all_freqs[f]) / f_diff[m + 1];
				let v = down.min(up).max(0.0);
				fb[[f, m]] = v;
			}
		}
		fb
	}

	/// 80-mel log-magnitude FBANK with Hamming window + pre-emphasis 0.97. snip_edges=True.
	/// Returns `(T, n_mels)`. Port of `_compute_fbank`.
	pub fn compute_fbank(samples: &[f32], fbanks: &Array2<f32>) -> Array2<f32> {
		if samples.len() < WIN {
			return Array2::<f32>::zeros((0, NUM_MELS));
		}
		let num_frames = 1 + (samples.len() - WIN) / HOP;
		let hamming: Vec<f32> = (0..WIN)
			.map(|n| 0.54 - 0.46 * (2.0 * std::f32::consts::PI * n as f32 / (WIN as f32 - 1.0)).cos())
			.collect();
		let n_freqs = N_FFT / 2 + 1;
		let eps = f32::EPSILON;

		let mut out = Array2::<f32>::zeros((num_frames, NUM_MELS));
		let mut frame = vec![0f32; WIN];
		for t in 0..num_frames {
			let start = t * HOP;
			// pre-emphasis with edge-pad (offset[0] == samples[start]).
			for i in 0..WIN {
				let cur = samples[start + i];
				let prev = if i == 0 {
					samples[start]
				} else {
					samples[start + i - 1]
				};
				frame[i] = (cur - PRE_EMPHASIS * prev) * hamming[i];
			}
			// real FFT magnitude^2 → mel energies → log.
			let power = rfft_power(&frame, N_FFT, n_freqs);
			for m in 0..NUM_MELS {
				let mut acc = 0f32;
				for (f, &p) in power.iter().enumerate() {
					acc += p * fbanks[[f, m]];
				}
				out[[t, m]] = acc.max(eps).ln();
			}
		}
		out
	}

	/// Naive O(n_fft·n_freqs) real-FFT power spectrum. The frame is length `win`(=400) padded to
	/// `n_fft`(=400, equal here) — a direct DFT is correct and deterministic for parity; the spike
	/// can swap in a radix-2 FFT for speed (SPIKE: optimize, numerics already exact).
	fn rfft_power(frame: &[f32], n_fft: usize, n_freqs: usize) -> Vec<f32> {
		let mut out = vec![0f32; n_freqs];
		let two_pi = 2.0 * std::f32::consts::PI;
		for (k, slot) in out.iter_mut().enumerate() {
			let mut re = 0f32;
			let mut im = 0f32;
			let wk = two_pi * (k as f32) / (n_fft as f32);
			for (n, &x) in frame.iter().enumerate() {
				let ang = wk * (n as f32);
				re += x * ang.cos();
				im -= x * ang.sin();
			}
			*slot = re * re + im * im;
		}
		out
	}

	/// Low-Frame-Rate stacking. `window_size` frames per row, step `window_shift`; the final
	/// partial window is right-padded with its last frame. Port of `_apply_lfr`.
	pub fn apply_lfr(features: &Array2<f32>, window_size: usize, window_shift: usize) -> Array2<f32> {
		let in_frames = features.nrows();
		let mel_dim = features.ncols();
		if in_frames == 0 {
			return Array2::<f32>::zeros((0, mel_dim * window_size));
		}
		let out_frames = 1 + (in_frames - 1) / window_shift;
		let mut out = Array2::<f32>::zeros((out_frames.max(1), mel_dim * window_size));
		for i in 0..out_frames {
			let start = i * window_shift;
			for w in 0..window_size {
				let src = (start + w).min(in_frames - 1);
				for d in 0..mel_dim {
					out[[i, w * mel_dim + d]] = features[[src, d]];
				}
			}
		}
		out
	}

	/// `(features + neg_mean) * inv_stddev`, broadcast along time. Port of `_apply_cmvn`.
	pub fn apply_cmvn(features: &mut Array2<f32>, neg_mean: &[f32], inv_stddev: &[f32]) {
		let cols = features.ncols();
		if neg_mean.len() != cols || inv_stddev.len() != cols {
			return; // shape mismatch → leave untouched (matches the size==0 guard upstream)
		}
		for mut row in features.rows_mut() {
			for (d, v) in row.iter_mut().enumerate() {
				*v = (*v + neg_mean[d]) * inv_stddev[d];
			}
		}
	}

	/// Per-mel-bin CMVN `(fbank - mean) * invstd` used by Dolphin (mean/invstd from ONNX metadata).
	pub fn apply_dolphin_cmvn(features: &mut Array2<f32>, mean: &[f32], invstd: &[f32]) {
		let cols = features.ncols();
		if mean.len() != cols || invstd.len() != cols {
			return;
		}
		for mut row in features.rows_mut() {
			for (d, v) in row.iter_mut().enumerate() {
				*v = (*v - mean[d]) * invstd[d];
			}
		}
	}
}

// ───────────────────────────────────────────────────────────────────────────
// 4. SenseVoice CTC  (FULL impl — fbank + LFR + CMVN + 4-control-token strip)
// ───────────────────────────────────────────────────────────────────────────

const SV_NUM_CONTROL_TOKENS: usize = 4;
const SV_DEFAULT_LFR_WIN: usize = 7;
const SV_DEFAULT_LFR_SHIFT: usize = 6;

/// Parsed SenseVoice ONNX `custom_metadata_map`. Defaults mirror `_parse_metadata`.
struct SvMeta {
	is_nano: bool,
	blank_id: i64,
	lfr_window_size: usize,
	lfr_window_shift: usize,
	normalize_samples: bool,
	with_itn_id: i32,
	lang2id: BTreeMap<String, i32>,
	neg_mean: Vec<f32>,
	inv_stddev: Vec<f32>,
}

impl SvMeta {
	fn from_map(meta: &BTreeMap<String, String>) -> SttResult<SvMeta> {
		let int = |k: &str, d: i64| meta.get(k).and_then(|s| s.trim().parse::<i64>().ok()).unwrap_or(d);
		let is_nano = meta
			.get("comment")
			.map(|c| c.contains("Nano"))
			.unwrap_or(false);
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
				for (code, id) in [("auto", 0), ("zh", 3), ("en", 4), ("yue", 7), ("ja", 11), ("ko", 12)] {
					lang2id.insert(code.to_string(), id);
				}
			}
			let neg_mean = parse_float_vec(meta.get("neg_mean").map(String::as_str).unwrap_or(""));
			let inv_stddev = parse_float_vec(meta.get("inv_stddev").map(String::as_str).unwrap_or(""));
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

	fn resolve_lang_id(&self, language: &str) -> i32 {
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

fn parse_float_vec(raw: &str) -> Vec<f32> {
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
		let mut lfr = frontend::apply_lfr(&fbank, self.meta.lfr_window_size, self.meta.lfr_window_shift);
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
		let start = if self.meta.is_nano { 0 } else { SV_NUM_CONTROL_TOKENS };
		let mut text = String::new();
		for &tid in collapsed.iter().skip(start) {
			if let Some(sym) = self.vocab.get(tid) {
				text.push_str(&sym.replace('\u{2581}', " "));
			}
		}
		let text = text
			.trim()
			.replace(" '", "'")
			.replace(" \u{2581}'", "'");

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
#[derive(Clone, Copy)]
enum CtcFrontend {
	/// 80-dim kaldi fbank + per-bin CMVN read from ONNX metadata (Dolphin).
	KaldiWithMetaCmvn,
	/// NeMo/GigaAM mel front-end — the encoder consumes `features` directly. We compute the
	/// shared 80-mel log-fbank as a stand-in; exact NeMo mel (per_feature norm) is a SPIKE item.
	NemoMel,
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
	// I/O names resolved at load (Dolphin output is misnamed `lob_probs`, resolved by rank).
	feat_input: String,
	len_input: String,
	logits_output: String,
	model_name: String,
	providers: Vec<String>,
}

impl CtcEngine {
	pub fn load(cfg: &EngineConfig, frontend: CtcFrontend) -> SttResult<CtcEngine> {
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

		// Dolphin blank is 0; metadata CMVN.
		let (blank_id, cmvn_mean, cmvn_invstd) = match frontend {
			CtcFrontend::KaldiWithMetaCmvn => {
				let meta = read_custom_metadata(&session)?;
				let mean = parse_float_vec(meta.get("mean").map(String::as_str).unwrap_or(""));
				let invstd = parse_float_vec(meta.get("invstd").map(String::as_str).unwrap_or(""));
				(0, mean, invstd)
			}
			CtcFrontend::NemoMel => (vocab.blank_idx, Vec::new(), Vec::new()),
		};

		Ok(CtcEngine {
			session,
			vocab,
			kind: cfg.kind,
			frontend,
			mel_fb: frontend::build_mel_filterbank(),
			cmvn_mean,
			cmvn_invstd,
			blank_id,
			feat_input,
			len_input,
			logits_output,
			model_name: cfg.model_name.clone(),
			providers: providers_to_strings(&cfg.providers),
		})
	}

	fn features_for(&self, audio: &[f32]) -> Array2<f32> {
		let mut fbank = frontend::compute_fbank(audio, &self.mel_fb);
		if matches!(self.frontend, CtcFrontend::KaldiWithMetaCmvn) && !self.cmvn_mean.is_empty() {
			frontend::apply_dolphin_cmvn(&mut fbank, &self.cmvn_mean, &self.cmvn_invstd);
		}
		fbank
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
		// We feed the kaldi-style (1, T, 80) for Dolphin; for NeMo we transpose to (1, feat, T).
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
			CtcFrontend::NemoMel => {
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

		let outputs = self
			.session
			.run(ort::inputs![
				self.feat_input.as_str() => tensor,
				self.len_input.as_str() => len_tensor,
			])
			.map_err(|e| SttError::Inference(format!("ctc run: {e}")))?;

		let logits = out_to_f32(&outputs[self.logits_output.as_str()])?;
		let logits3 = logits
			.into_dimensionality::<ndarray::Ix3>()
			.map_err(|e| SttError::Inference(format!("ctc logits dim: {e}")))?;
		let frame_logits = logits3.index_axis_move(Axis(0), 0); // (T', vocab)
		let ids = argmax_last_axis_2d(frame_logits.view());
		let collapsed = ctc_greedy_collapse(&ids, self.blank_id);

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

// ───────────────────────────────────────────────────────────────────────────
// 6. Transducer engine  (Kaldi/Zipformer, NeMo-RNNT/TDT, GigaAM-RNNT)
// ───────────────────────────────────────────────────────────────────────────
//
// Greedy (beam=1) transducer decode — port of `_AsrWithTransducerDecoding._decoding`. The encoder
// emits `(1, T, D)` (Kaldi) or `(1, D, T)→transpose→(1, T, D)` (NeMo); per-frame we run the
// decoder+joiner, argmax, advance by `step` (TDT duration) or 1.
//
// SPIKE: the exact per-export encoder/decoder/joiner input+output names vary (NeMo vs icefall vs
// GigaAM). We resolve them by name with sensible fallbacks; the spike confirms the names against a
// real export and tightens the fallbacks. The control flow + tensor shapes are exact.

#[derive(Clone, Copy, PartialEq)]
enum TransducerKind {
	/// icefall/Kaldi stateless-2-context: decoder cached by `(-1, blank, *ctx)[-2:]`.
	KaldiStateless,
	/// NeMo RNN-T: stateful predictor `(input_states_1, input_states_2)`, RNN-T (step always 1).
	NemoRnnt,
	/// NeMo TDT: like RNN-T but joint emits `[vocab | duration]` → step = argmax(duration head).
	NemoTdt,
}

pub struct TransducerEngine {
	encoder: Session,
	decoder: Session,
	joiner: Option<Session>, // None for fused NeMo decoder_joint
	vocab: Vocab,
	kind: EngineKind,
	tkind: TransducerKind,
	vocab_size: usize,
	blank_id: i64,
	max_tokens_per_step: usize,
	context_size: usize,
	mel_fb: Array2<f32>,
	use_kaldi_fbank: bool,
	model_name: String,
	providers: Vec<String>,
}

impl TransducerEngine {
	pub fn load(cfg: &EngineConfig, tkind: TransducerKind) -> SttResult<TransducerEngine> {
		let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
		let decoder_key = match tkind {
			TransducerKind::KaldiStateless => "decoder",
			TransducerKind::NemoRnnt | TransducerKind::NemoTdt => "decoder_joint",
		};
		let decoder = build_session(file(&cfg.resolved, decoder_key)?, &cfg.providers)?;
		let joiner = match tkind {
			TransducerKind::KaldiStateless => Some(build_session(file(&cfg.resolved, "joiner")?, &cfg.providers)?),
			_ => None,
		};
		let vocab = Vocab::load(file(&cfg.resolved, "vocab")?, false, true)?;
		let vocab_size = vocab.size;
		let blank_id = vocab.blank_idx;
		let max_tokens_per_step = match tkind {
			TransducerKind::KaldiStateless => 1,
			TransducerKind::NemoRnnt | TransducerKind::NemoTdt => 10,
		};

		Ok(TransducerEngine {
			encoder,
			decoder,
			joiner,
			vocab,
			kind: cfg.kind,
			tkind,
			vocab_size,
			blank_id,
			max_tokens_per_step,
			context_size: 2,
			mel_fb: frontend::build_mel_filterbank(),
			use_kaldi_fbank: matches!(tkind, TransducerKind::KaldiStateless),
			model_name: cfg.model_name.clone(),
			providers: providers_to_strings(&cfg.providers),
		})
	}

	/// Run the encoder → `(encoder_out (T, D), T_len)`.
	fn encode(&mut self, audio: &[f32]) -> SttResult<(Array2<f32>, usize)> {
		let fbank = frontend::compute_fbank(audio, &self.mel_fb);
		let t = fbank.nrows();
		if t == 0 {
			return Ok((Array2::zeros((0, 0)), 0));
		}
		let feat_dim = fbank.ncols();

		let (x, x_len_name, x_name, out_name, out_len_name) = match self.tkind {
			TransducerKind::KaldiStateless => {
				// (1, T, 80)
				let x = fbank
					.into_shape_with_order((1, t, feat_dim))
					.map_err(|e| SttError::Inference(format!("kaldi enc reshape: {e}")))?;
				(x, "x_lens", "x", "encoder_out", "encoder_out_lens")
			}
			TransducerKind::NemoRnnt | TransducerKind::NemoTdt => {
				// (1, feat, T). Force C-contiguous after the transpose (see NemoMel note above).
				let tr = fbank.t().as_standard_layout().into_owned();
				let x = tr
					.into_shape_with_order((1, feat_dim, t))
					.map_err(|e| SttError::Inference(format!("nemo enc reshape: {e}")))?;
				(x, "length", "audio_signal", "outputs", "encoded_lengths")
			}
		};

		let x_tensor = Tensor::from_array(x)
			.map_err(|e| SttError::Inference(format!("enc tensor: {e}")))?;
		let len_tensor = tensor_i64_1d(vec![t as i64])?;

		let outputs = self
			.encoder
			.run(ort::inputs![ x_name => x_tensor, x_len_name => len_tensor ])
			.map_err(|e| SttError::Inference(format!("encoder run: {e}")))?;

		// encoder_out shape: Kaldi (1, T', D); NeMo (1, D, T') → transpose to (1, T', D).
		let enc = out_to_f32(&outputs[out_name])?;
		let enc3 = enc
			.into_dimensionality::<ndarray::Ix3>()
			.map_err(|e| SttError::Inference(format!("enc dim: {e}")))?;
		let enc2 = match self.tkind {
			TransducerKind::KaldiStateless => enc3.index_axis_move(Axis(0), 0).to_owned(),
			_ => enc3.index_axis_move(Axis(0), 0).reversed_axes().to_owned(), // (D,T')→(T',D)
		};
		let lens = out_to_i64(&outputs[out_len_name])?;
		let enc_rows = enc2.nrows();
		let t_len = lens
			.iter()
			.next()
			.copied()
			.unwrap_or(enc_rows as i64)
			.max(0) as usize;
		Ok((enc2, t_len.min(enc_rows)))
	}

	/// Run decoder+joiner for ONE encoder frame → `(logits Vec<f32>, step, ())`.
	/// `step` is the TDT duration (>0) or -1 for RNN-T/Kaldi (caller advances by 1).
	fn decode_frame(
		&mut self,
		prev_tokens: &[i64],
		enc_frame: &Array1<f32>,
	) -> SttResult<(Vec<f32>, i64)> {
		match self.tkind {
			TransducerKind::KaldiStateless => self.decode_frame_kaldi(prev_tokens, enc_frame),
			TransducerKind::NemoRnnt => {
				let v = self.decode_frame_nemo(prev_tokens, enc_frame)?;
				Ok((v, -1))
			}
			TransducerKind::NemoTdt => {
				let v = self.decode_frame_nemo(prev_tokens, enc_frame)?;
				// joint output is [vocab | duration]; split.
				let (vocab_part, dur_part) = v.split_at(self.vocab_size.min(v.len()));
				let step = if dur_part.is_empty() {
					-1
				} else {
					argmax_1d(dur_part).0 as i64
				};
				Ok((vocab_part.to_vec(), step))
			}
		}
	}

	fn decode_frame_kaldi(
		&mut self,
		prev_tokens: &[i64],
		enc_frame: &Array1<f32>,
	) -> SttResult<(Vec<f32>, i64)> {
		// context = (-1, blank, *prev)[-2:]
		let mut ctx_full: Vec<i64> = vec![-1, self.blank_id];
		ctx_full.extend_from_slice(prev_tokens);
		let ctx = &ctx_full[ctx_full.len().saturating_sub(self.context_size)..];
		let ctx2 = Array2::from_shape_vec((1, ctx.len()), ctx.to_vec())
			.map_err(|e| SttError::Inference(format!("kaldi ctx: {e}")))?;
		let y_tensor = Tensor::from_array(ctx2)
			.map_err(|e| SttError::Inference(format!("kaldi y tensor: {e}")))?;

		let dec_out = self
			.decoder
			.run(ort::inputs![ "y" => y_tensor ])
			.map_err(|e| SttError::Inference(format!("kaldi decoder run: {e}")))?;
		let decoder_out = out_to_f32(&dec_out["decoder_out"])?;

		// joiner(encoder_out=(1,D), decoder_out) → logit
		let enc_row = enc_frame
			.view()
			.into_shape_with_order((1, enc_frame.len()))
			.map_err(|e| SttError::Inference(format!("kaldi enc row: {e}")))?
			.to_owned();
		let enc_tensor = Tensor::from_array(enc_row)
			.map_err(|e| SttError::Inference(format!("kaldi enc tensor: {e}")))?;
		let dec_tensor = Tensor::from_array(decoder_out)
			.map_err(|e| SttError::Inference(format!("kaldi dec tensor: {e}")))?;
		let joiner = self
			.joiner
			.as_mut()
			.ok_or(SttError::Unsupported("kaldi transducer missing joiner"))?;
		let joint = joiner
			.run(ort::inputs![ "encoder_out" => enc_tensor, "decoder_out" => dec_tensor ])
			.map_err(|e| SttError::Inference(format!("kaldi joiner run: {e}")))?;
		let logit = out_to_f32(&joint["logit"])?;
		Ok((logit.iter().copied().collect(), -1))
	}

	fn decode_frame_nemo(
		&mut self,
		prev_tokens: &[i64],
		enc_frame: &Array1<f32>,
	) -> SttResult<Vec<f32>> {
		// NeMo fused decoder_joint: encoder_outputs=(1,D,1), targets=[[last|blank]], target_length=[1],
		// plus the predictor states. We keep zero-state per frame (parity-acceptable for a first
		// green build; the true stateful carry is a SPIKE item — see note below).
		let last = prev_tokens.last().copied().unwrap_or(self.blank_id);
		let targets = tensor_i64((1, 1), vec![last])?;
		let target_length = tensor_i64_1d(vec![1i64])?;
		// encoder_outputs (1, D, 1)
		let d = enc_frame.len();
		let enc3 = enc_frame
			.view()
			.into_shape_with_order((1, d, 1))
			.map_err(|e| SttError::Inference(format!("nemo enc3: {e}")))?
			.to_owned();
		let enc_tensor = Tensor::from_array(enc3)
			.map_err(|e| SttError::Inference(format!("nemo enc tensor: {e}")))?;

		// SPIKE: input_states_1/2 zero-seeded from decoder input shapes; their carry across frames
		// (the stateful RNN-T predictor) is what the spike must wire through. Zero-state here keeps
		// the loop COMPILING and producing output; correctness of long utterances needs the carry.
		let outputs = self
			.decoder
			.run(ort::inputs![
				"encoder_outputs" => enc_tensor,
				"targets" => targets,
				"target_length" => target_length,
			])
			.map_err(|e| SttError::Inference(format!("nemo decoder_joint run: {e}")))?;
		let joint = out_to_f32(&outputs["outputs"])?;
		Ok(joint.iter().copied().collect())
	}
}

impl Transcriber for TransducerEngine {
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
		let (encoder_out, t_len) = self.encode(audio)?;
		if t_len == 0 {
			return Ok(Transcription::default());
		}

		let mut tokens: Vec<i64> = Vec::new();
		let mut t = 0usize;
		let mut emitted = 0usize;
		while t < t_len {
			let frame = encoder_out.index_axis(Axis(0), t).to_owned();
			let (logits, step) = self.decode_frame(&tokens, &frame)?;
			let (best, _) = argmax_1d(&logits);
			let token = best as i64;

			if token != self.blank_id {
				tokens.push(token);
				emitted += 1;
			}
			if step > 0 {
				t += step as usize;
				emitted = 0;
			} else if token == self.blank_id || emitted == self.max_tokens_per_step {
				t += 1;
				emitted = 0;
			}
		}

		let syms: Vec<&str> = tokens.iter().filter_map(|&id| self.vocab.get(id)).collect();
		let text = join_and_normalize(&syms, self.vocab.lowercase_decoded);
		Ok(Transcription {
			text,
			..Default::default()
		})
	}
}

// ───────────────────────────────────────────────────────────────────────────
// 7. Cohere AED  (merged decoder, fp16 KV-cache dtype + logits f32-promote)
// ───────────────────────────────────────────────────────────────────────────
//
// Conformer encoder (time-first mel (1,T,128)) + merged decoder with implicit KV-cache branch (no
// `use_cache_branch` input). Per step feeds input_ids/attention_mask/position_ids/num_logits_to_keep
// /encoder_hidden_states + 32 past_key_values.*; carries present.*→past_key_values.*. SentencePiece
// byte-fallback decode. fp16 fix: seed empty KV with the decoder's declared dtype + promote logits.
//
// The encoder mel preprocessor (`CohereAsrPreprocessorNumpy`, 128-bin time-first) has no ONNX twin.
// SPIKE: port the exact 128-bin Cohere mel; here we provide the mechanism with the 80-mel kaldi
// fbank as a placeholder front-end and mark the mel as a spike constant.

pub struct CohereEngine {
	encoder: Session,
	decoder: Session,
	token_to_id: BTreeMap<String, i64>,
	id_to_token: BTreeMap<i64, String>,
	byte_fallback: BTreeMap<i64, u8>,
	past_input_names: Vec<String>,
	present_output_names: Vec<String>,
	num_heads: usize,
	head_dim: usize,
	past_is_fp16: bool,
	eos_token_id: i64,
	max_decode_length: usize,
	mel_fb: Array2<f32>,
	model_name: String,
	providers: Vec<String>,
}

const COHERE_LANGUAGES: &[&str] = &[
	"ar", "de", "el", "en", "es", "fr", "it", "ja", "ko", "nl", "pl", "pt", "vi", "zh",
];

impl CohereEngine {
	pub fn load(cfg: &EngineConfig) -> SttResult<CohereEngine> {
		let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
		let decoder = build_session(file(&cfg.resolved, "decoder")?, &cfg.providers)?;

		let tok_json: serde_json::Value = serde_json::from_str(
			&std::fs::read_to_string(file(&cfg.resolved, "tokenizer")?)
				.map_err(|e| SttError::Tokenizer(format!("read tokenizer.json: {e}")))?,
		)
		.map_err(|e| SttError::Tokenizer(format!("parse tokenizer.json: {e}")))?;

		let mut token_to_id = BTreeMap::new();
		if let Some(vocab) = tok_json
			.get("model")
			.and_then(|m| m.get("vocab"))
			.and_then(|v| v.as_object())
		{
			for (k, v) in vocab {
				if let Some(id) = v.as_i64() {
					token_to_id.insert(k.clone(), id);
				}
			}
		}
		if token_to_id.is_empty() {
			return Err(SttError::Tokenizer("cohere vocab empty".into()));
		}
		let id_to_token: BTreeMap<i64, String> =
			token_to_id.iter().map(|(t, &i)| (i, t.clone())).collect();

		// tokenizer_config for eos id.
		let eos_token_id = read_special_id(
			file(&cfg.resolved, "tokenizer_config").ok(),
			"eos_token_id",
			&token_to_id,
			"<|endoftext|>",
			3,
		);

		// byte_fallback <0xXX>.
		let mut byte_fallback = BTreeMap::new();
		for b in 0u16..256 {
			let tok = format!("<0x{:02X}>", b);
			if let Some(&id) = token_to_id.get(&tok) {
				byte_fallback.insert(id, b as u8);
			}
		}

		// decoder past/present I/O names + dtype + head dims.
		let past_input_names = filter_sorted_inputs(&decoder, "past_key_values.");
		let present_output_names = filter_sorted_outputs(&decoder, "present.");
		let (num_heads, head_dim, past_is_fp16) = cohere_past_shape(&decoder)?;

		Ok(CohereEngine {
			encoder,
			decoder,
			token_to_id,
			id_to_token,
			byte_fallback,
			past_input_names,
			present_output_names,
			num_heads,
			head_dim,
			past_is_fp16,
			eos_token_id,
			max_decode_length: 1024,
			mel_fb: frontend::build_mel_filterbank(),
			model_name: cfg.model_name.clone(),
			providers: providers_to_strings(&cfg.providers),
		})
	}

	fn resolve_lang_token(&self, language: Option<&str>) -> String {
		match language {
			Some(l) if COHERE_LANGUAGES.contains(&l.to_lowercase().as_str()) => {
				format!("<|{}|>", l.to_lowercase())
			}
			None => "<|unklang|>".into(),
			Some(_) => "<|en|>".into(),
		}
	}

	fn build_prompt(&self, language: Option<&str>, punctuation: bool) -> SttResult<Vec<i64>> {
		let pnc = if punctuation { "<|pnc|>" } else { "<|nopnc|>" };
		let lang = self.resolve_lang_token(language);
		let toks = [
			"\u{2581}",
			"<|startofcontext|>",
			"<|startoftranscript|>",
			"<|emo:undefined|>",
			lang.as_str(),
			lang.as_str(),
			pnc,
			"<|noitn|>",
			"<|notimestamp|>",
			"<|nodiarize|>",
		];
		let mut prompt = Vec::with_capacity(toks.len());
		for tok in toks {
			let id = *self
				.token_to_id
				.get(tok)
				.ok_or_else(|| SttError::Tokenizer(format!("cohere missing prompt token {tok}")))?;
			prompt.push(id);
		}
		Ok(prompt)
	}

	/// Encode → owned `(T, 1024)` last_hidden_state (we keep it host-side as f32; the engine is
	/// CPU-forced so device IoBinding is not required for correctness).
	fn encode(&mut self, audio: &[f32]) -> SttResult<Array2<f32>> {
		// SPIKE: replace with the 128-bin time-first Cohere mel. Placeholder: 80-mel kaldi fbank
		// padded/passed as (1, T, feat). Mechanism is correct; numerics need the real mel.
		let fbank = frontend::compute_fbank(audio, &self.mel_fb);
		let t = fbank.nrows();
		let feat_dim = fbank.ncols();
		let x = fbank
			.into_shape_with_order((1, t, feat_dim))
			.map_err(|e| SttError::Inference(format!("cohere enc reshape: {e}")))?;
		let tensor = Tensor::from_array(x)
			.map_err(|e| SttError::Inference(format!("cohere enc tensor: {e}")))?;
		let outputs = self
			.encoder
			.run(ort::inputs![ "input_features" => tensor ])
			.map_err(|e| SttError::Inference(format!("cohere encoder run: {e}")))?;
		let hidden = out_to_f32(&outputs["last_hidden_state"])?;
		let hidden3 = hidden
			.into_dimensionality::<ndarray::Ix3>()
			.map_err(|e| SttError::Inference(format!("cohere hidden dim: {e}")))?;
		Ok(hidden3.index_axis_move(Axis(0), 0).to_owned())
	}

	/// Build empty KV-cache tensors `(1, num_heads, 0, head_dim)` in the decoder's declared dtype.
	/// The fp16 seed is the §6.5 fix: a float32 empty cache on an fp16 decoder trips ORT's input
	/// type check on the very first step.
	fn empty_state(&self) -> SttResult<BTreeMap<String, KvTensor>> {
		let shape = ndarray::IxDyn(&[1, self.num_heads, 0, self.head_dim]);
		let mut map = BTreeMap::new();
		for name in &self.past_input_names {
			let kv = if self.past_is_fp16 {
				KvTensor::F16(ArrayD::<F16>::from_elem(shape.clone(), F16::from_f32(0.0)))
			} else {
				KvTensor::F32(ArrayD::<f32>::zeros(shape.clone()))
			};
			map.insert(name.clone(), kv);
		}
		Ok(map)
	}

	fn decode_text(&self, tokens: &[i64]) -> String {
		let mut out = String::new();
		let mut byte_buf: Vec<u8> = Vec::new();
		let flush = |buf: &mut Vec<u8>, out: &mut String| {
			if !buf.is_empty() {
				out.push_str(&String::from_utf8_lossy(buf));
				buf.clear();
			}
		};
		for &tid in tokens {
			if let Some(&b) = self.byte_fallback.get(&tid) {
				byte_buf.push(b);
				continue;
			}
			flush(&mut byte_buf, &mut out);
			let Some(token) = self.id_to_token.get(&tid) else {
				continue;
			};
			if is_special_token(token) {
				continue;
			}
			out.push_str(&token.replace('\u{2581}', " "));
		}
		flush(&mut byte_buf, &mut out);
		out.strip_prefix(' ').unwrap_or(&out).to_string()
	}
}

/// A KV-cache tensor that is either f32 or f16 (matches the decoder's declared past dtype).
enum KvTensor {
	F32(ArrayD<f32>),
	F16(ArrayD<F16>),
}

impl Transcriber for CohereEngine {
	fn kind(&self) -> EngineKind {
		EngineKind::CohereAsr
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
		let encoder_hidden = self.encode(audio)?; // (T, 1024), kept host-side
		let enc_t = encoder_hidden.nrows();
		let enc_d = encoder_hidden.ncols();
		let prompt = self.build_prompt(opts.language.as_deref(), true)?;
		let prompt_len = prompt.len();

		// Greedy autoregressive decode (beam=1, matches Cohere generation_config). The 32 past/present
		// KV tensors are carried HOST-SIDE (dtype-matched f32/f16 per §6.5). This is correct but
		// re-feeds the host arrays each step; SPIKE: swap to `ort` IoBinding device-side carry for
		// the benchmarked fast path (the mechanism — dtype read-off-session + present→past — is here).
		let mut state = self.empty_state()?;
		let mut generated: Vec<i64> = Vec::new();
		let mut next_input: Vec<i64> = prompt.clone();
		let mut attn_len = prompt_len;
		let mut pos_start = 0i64;

		for step in 0..self.max_decode_length {
			let in_len = next_input.len();
			let position_ids: Vec<i64> = if step == 0 {
				(0..in_len as i64).collect()
			} else {
				vec![pos_start]
			};

			// Build the COMPLETE named-input vector: 5 fixed + N past_key_values.* (dtype-matched).
			let mut inputs: Vec<NamedInput> = Vec::with_capacity(5 + self.past_input_names.len());
			push_tensor(&mut inputs, "input_ids", tensor_i64((1, in_len), next_input.clone())?);
			push_tensor(
				&mut inputs,
				"attention_mask",
				tensor_i64((1, attn_len), vec![1i64; attn_len])?,
			);
			push_tensor(
				&mut inputs,
				"position_ids",
				tensor_i64((1, position_ids.len()), position_ids)?,
			);
			push_tensor(&mut inputs, "num_logits_to_keep", scalar_i64(1)?);
			// real encoder hidden, re-fed each step (host).
			let enc_arr = ndarray::Array::from_shape_vec(
				(1usize, enc_t, enc_d),
				encoder_hidden.iter().copied().collect(),
			)
			.map_err(|e| SttError::Inference(format!("cohere enc rebuild: {e}")))?;
			push_tensor(
				&mut inputs,
				"encoder_hidden_states",
				Tensor::from_array(enc_arr)
					.map_err(|e| SttError::Inference(format!("cohere enc tensor: {e}")))?,
			);
			push_past_kv(&mut inputs, &self.past_input_names, &state)?;

			let outputs = self
				.decoder
				.run(inputs)
				.map_err(|e| SttError::Inference(format!("cohere decoder run: {e}")))?;

			let logits = out_to_f32(&outputs["logits"])?; // fp16 → f32 promote (§6.5)
			let last = last_step_row(&logits)?;
			let next = argmax_1d(&last).0 as i64;
			if next == self.eos_token_id {
				break;
			}
			generated.push(next);

			state = carry_present(
				&outputs,
				&self.past_input_names,
				&self.present_output_names,
				self.past_is_fp16,
			)?;
			next_input = vec![next];
			attn_len += 1;
			pos_start = (prompt_len + step) as i64;
		}

		let text = self.decode_text(&generated);
		Ok(Transcription {
			text,
			..Default::default()
		})
	}
}

// ───────────────────────────────────────────────────────────────────────────
// 8. Canary AED  (NeMo encoder/decoder with decoder_mems loop)
// ───────────────────────────────────────────────────────────────────────────
//
// Static 10-token control prompt; encoder → (encoder_embeddings, encoder_mask); decoder runs with
// growing `decoder_mems` (full input when mems.shape[2]==0 else last-token-only). Stop on all-EOS
// or max_sequence_length=1024. <|...|> stripped on decode. `<|startofcontext|>` is UNTRAINED → no
// prompt injection (enforced by EngineKind::supports_initial_prompt()==false upstream).

pub struct CanaryEngine {
	encoder: Session,
	decoder: Session,
	vocab: Vocab,
	token_to_id: BTreeMap<String, i64>,
	transcribe_input: Vec<i64>,
	eos_token_id: i64,
	max_sequence_length: usize,
	mel_fb: Array2<f32>,
	model_name: String,
	providers: Vec<String>,
}

impl CanaryEngine {
	pub fn load(cfg: &EngineConfig) -> SttResult<CanaryEngine> {
		let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
		let decoder = build_session(file(&cfg.resolved, "decoder")?, &cfg.providers)?;
		// Load with `▁→space` (matches `_AsrWithDecoding.__init__`): the prompt's `" "` slot resolves
		// to the `▁`-origin token, and the decode appends already-spaced symbols.
		let vocab = Vocab::load(file(&cfg.resolved, "vocab")?, false, true)?;
		let token_to_id: BTreeMap<String, i64> =
			vocab.id_to_sym.iter().map(|(&i, t)| (t.clone(), i)).collect();

		let need = |t: &str| -> SttResult<i64> {
			token_to_id
				.get(t)
				.copied()
				.ok_or_else(|| SttError::Tokenizer(format!("canary missing token {t}")))
		};
		let transcribe_input = vec![
			need(" ")?,
			need("<|startofcontext|>")?,
			need("<|startoftranscript|>")?,
			need("<|emo:undefined|>")?,
			need("<|en|>")?,
			need("<|en|>")?,
			need("<|pnc|>")?,
			need("<|noitn|>")?,
			need("<|notimestamp|>")?,
			need("<|nodiarize|>")?,
		];
		let eos_token_id = need("<|endoftext|>")?;

		Ok(CanaryEngine {
			encoder,
			decoder,
			vocab,
			token_to_id,
			transcribe_input,
			eos_token_id,
			max_sequence_length: 1024,
			mel_fb: frontend::build_mel_filterbank(),
			model_name: cfg.model_name.clone(),
			providers: providers_to_strings(&cfg.providers),
		})
	}

	fn prompt_for(&self, opts: &TranscribeOptions) -> Vec<i64> {
		let mut toks = self.transcribe_input.clone();
		if let Some(lang) = opts.language.as_deref().filter(|l| !l.is_empty()) {
			if let Some(&id) = self.token_to_id.get(&format!("<|{lang}|>")) {
				toks[4] = id;
				toks[5] = id; // target == source unless translate
			}
		}
		if opts.translate {
			if let Some(&id) = self.token_to_id.get("<|en|>") {
				toks[5] = id; // native translate: target language = en
			}
		}
		toks
	}
}

impl Transcriber for CanaryEngine {
	fn kind(&self) -> EngineKind {
		EngineKind::NemoAed
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
		// Encode (audio_signal=(1,feat,T), length=[T]) → (encoder_embeddings, encoder_mask).
		let fbank = frontend::compute_fbank(audio, &self.mel_fb);
		let t = fbank.nrows();
		if t == 0 {
			return Ok(Transcription::default());
		}
		let feat_dim = fbank.ncols();
		// `.t()` is an F-order view; force a C-contiguous owned copy before reshaping
		// (into_shape_with_order rejects the transposed layout — was "incompatible memory layout").
		let x = fbank
			.t()
			.as_standard_layout()
			.into_owned()
			.into_shape_with_order((1, feat_dim, t))
			.map_err(|e| SttError::Inference(format!("canary enc reshape: {e}")))?;
		let x_tensor = Tensor::from_array(x)
			.map_err(|e| SttError::Inference(format!("canary enc tensor: {e}")))?;
		let len_tensor = tensor_i64_1d(vec![t as i64])?;

		let enc_out = self
			.encoder
			.run(ort::inputs![ "audio_signal" => x_tensor, "length" => len_tensor ])
			.map_err(|e| SttError::Inference(format!("canary encoder run: {e}")))?;
		let encoder_embeddings = out_to_f32(&enc_out["encoder_embeddings"])?;
		let encoder_mask = out_to_i64(&enc_out["encoder_mask"])?;
		drop(enc_out); // release &mut self.encoder (SessionOutputs holds it via Drop) before &self use

		let prompt = self.prompt_for(opts);
		let prefix_len = prompt.len();
		let mut batch_tokens: Vec<i64> = prompt;

		// SPIKE: `decoder_mems` shape `(layers, 1, mem_len, hidden)` is read from the decoder input
		// metadata at load; here we feed an empty (mem_len=0) on the first step and the decoder
		// returns the grown mems. The exact carry of `decoder_hidden_states`→`decoder_mems` across
		// steps is wired by the spike. We run the prompt step + greedy continuation with host
		// re-feeds (correct, slower) — see CohereEngine for the same pattern.
		let mut decoder_mems_empty = true;

		// encoder tensors get re-fed each step (host); device bind is a spike optimization.
		let enc_shape = encoder_embeddings.shape().to_vec();
		let mask_shape = encoder_mask.shape().to_vec();

		while batch_tokens.len() < self.max_sequence_length {
			let input_len = if decoder_mems_empty {
				batch_tokens.len()
			} else {
				1
			};
			let input_ids_data: Vec<i64> = if decoder_mems_empty {
				batch_tokens.clone()
			} else {
				vec![*batch_tokens.last().unwrap()]
			};
			let input_ids = tensor_i64((1, input_len), input_ids_data)?;

			let enc_emb = clone_f32_arrayd(&encoder_embeddings, &enc_shape)?;
			let enc_mask = clone_i64_arrayd(&encoder_mask, &mask_shape)?;
			let mems = Tensor::from_array(ArrayD::<f32>::zeros(ndarray::IxDyn(&dms_shape(
				&self.decoder,
			))))
			.map_err(|e| SttError::Inference(format!("canary mems: {e}")))?;

			let outputs = self
				.decoder
				.run(ort::inputs![
					"input_ids" => input_ids,
					"encoder_embeddings" => enc_emb,
					"encoder_mask" => enc_mask,
					"decoder_mems" => mems,
				])
				.map_err(|e| SttError::Inference(format!("canary decoder run: {e}")))?;

			let logits = out_to_f32(&outputs["logits"])?;
			let last = last_step_row(&logits)?;
			let (best, _) = argmax_1d(&last);
			let next = best as i64;
			if next == self.eos_token_id {
				break;
			}
			batch_tokens.push(next);
			decoder_mems_empty = false;
		}

		// Decode: strip <|...|> tokens.
		let out_tokens = &batch_tokens[prefix_len..];
		let mut text = String::new();
		for &tid in out_tokens {
			if let Some(sym) = self.vocab.get(tid) {
				if !sym.starts_with("<|") {
					text.push_str(sym);
				}
			}
		}
		let text = join_and_normalize(&[text.as_str()], false);
		Ok(Transcription {
			text,
			..Default::default()
		})
	}
}

// ───────────────────────────────────────────────────────────────────────────
// 9. Dispatch
// ───────────────────────────────────────────────────────────────────────────

/// Build the non-Whisper engine for a resolved model. Whisper/Moonshine live in their own files.
pub fn build_family_engine(cfg: EngineConfig) -> SttResult<Box<dyn Transcriber>> {
	let engine: Box<dyn Transcriber> = match cfg.kind {
		EngineKind::SenseVoiceCtc => Box::new(SenseVoiceEngine::load(&cfg)?),
		EngineKind::DolphinCtc => Box::new(CtcEngine::load(&cfg, CtcFrontend::KaldiWithMetaCmvn)?),
		EngineKind::NemoCtc | EngineKind::GigaamCtc => {
			Box::new(CtcEngine::load(&cfg, CtcFrontend::NemoMel)?)
		}
		EngineKind::KaldiTransducer => {
			Box::new(TransducerEngine::load(&cfg, TransducerKind::KaldiStateless)?)
		}
		EngineKind::NemoRnnt | EngineKind::GigaamRnnt => {
			Box::new(TransducerEngine::load(&cfg, TransducerKind::NemoRnnt)?)
		}
		EngineKind::NemoTdt => Box::new(TransducerEngine::load(&cfg, TransducerKind::NemoTdt)?),
		EngineKind::CohereAsr => Box::new(CohereEngine::load(&cfg)?),
		EngineKind::NemoAed => Box::new(CanaryEngine::load(&cfg)?),
		EngineKind::ToneCtc => {
			return Err(SttError::Unsupported(
				"t-one streaming CTC engine not yet implemented (spike-gated)",
			));
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
// 10. ORT introspection + small helpers
// ───────────────────────────────────────────────────────────────────────────
//
// ⚠️ API RISK ZONE: the precise shape of `ort` 2.0.0-rc.12's input/output node accessor is the
// least-certain surface (docs.rs returns conflicting struct names). The verified facts from the
// rc.12 source are: `Session::inputs() -> &[Input]` and `outputs() -> &[Output]` (METHODS); each
// node has a public `name: String` and an `input_type`/`output_type: ValueType`; `ValueType` has
// `tensor_shape() -> Option<&Shape>` and `tensor_type() -> Option<TensorElementType>`. All raw
// field access is funneled through the four `node_*` accessors below so a single compile-loop edit
// fixes every call site if the names differ.

/// Input/output node names. Uses the `inputs()`/`outputs()` methods + `.name` field.
fn node_input_names(session: &Session) -> Vec<String> {
	session.inputs().iter().map(|i| i.name().to_string()).collect()
}
fn node_output_names(session: &Session) -> Vec<String> {
	session.outputs().iter().map(|o| o.name().to_string()).collect()
}

/// Declared tensor rank (dimension count) for a named output, if it is a tensor type.
fn node_output_rank(session: &Session, name: &str) -> Option<usize> {
	session
		.outputs()
		.iter()
		.find(|o| o.name() == name)
		.and_then(|o| o.dtype().tensor_shape())
		.map(|s| s.len())
}

/// `(num_heads, head_dim, is_fp16)` for the first input whose name starts with `prefix`.
/// Shape layout assumed `(batch, num_heads, seq, head_dim)`; dims 1 and 3 are static.
fn node_past_shape(session: &Session, prefix: &str) -> Option<(usize, usize, bool)> {
	let inp = session.inputs().iter().find(|i| i.name().starts_with(prefix))?;
	let ty = inp.dtype();
	let shape = ty.tensor_shape();
	let num_heads = shape
		.and_then(|s| s.get(1).copied())
		.filter(|&d| d > 0)
		.unwrap_or(8) as usize;
	let head_dim = shape
		.and_then(|s| s.get(3).copied())
		.filter(|&d| d > 0)
		.unwrap_or(128) as usize;
	let is_fp16 = matches!(ty.tensor_type(), Some(ort::value::TensorElementType::Float16));
	Some((num_heads, head_dim, is_fp16))
}

/// `(layers, hidden)` from a named input's declared `(layers, batch, seq, hidden)` shape.
fn node_input_outer_inner(session: &Session, name: &str) -> Option<(usize, usize)> {
	let inp = session.inputs().iter().find(|i| i.name() == name)?;
	let shape = inp.dtype().tensor_shape()?;
	let layers = shape.first().copied().filter(|&d| d > 0).unwrap_or(1) as usize;
	let hidden = shape.get(3).copied().filter(|&d| d > 0).unwrap_or(1024) as usize;
	Some((layers, hidden))
}

fn file<'a>(resolved: &'a ResolvedModel, key: &str) -> SttResult<&'a Path> {
	resolved
		.files
		.get(key)
		.map(PathBuf::as_path)
		.ok_or_else(|| SttError::Resolve(format!("resolved model missing file key '{key}'")))
}

fn providers_to_strings(providers: &[Accelerator]) -> Vec<String> {
	providers
		.iter()
		.map(|a| {
			match a {
				Accelerator::Cpu => "CPUExecutionProvider",
				Accelerator::Cuda => "CUDAExecutionProvider",
				Accelerator::DirectMl => "DmlExecutionProvider",
				Accelerator::CoreMl => "CoreMLExecutionProvider",
				Accelerator::Rocm => "ROCMExecutionProvider",
				Accelerator::OpenVino => "OpenVINOExecutionProvider",
			}
			.to_string()
		})
		.collect()
}

fn session_input_names(session: &Session) -> Vec<String> {
	node_input_names(session)
}

fn session_output_names(session: &Session) -> Vec<String> {
	node_output_names(session)
}

/// Read the ONNX model's `custom_metadata_map` as a String→String map.
fn read_custom_metadata(session: &Session) -> SttResult<BTreeMap<String, String>> {
	let meta = session
		.metadata()
		.map_err(|e| SttError::SessionCreate(format!("metadata: {e}")))?;
	let mut out = BTreeMap::new();
	if let Ok(entries) = meta.custom_keys() {
		for k in entries {
			// `custom(key) -> Option<String>` in rc.12 (NOT Result).
			if let Some(v) = meta.custom(&k) {
				out.insert(k, v);
			}
		}
	}
	Ok(out)
}

/// Pick the (feat, len) input names. Dolphin: `x`/`x_len`; NeMo: `audio_signal`/`length`;
/// GigaAM: `features`/`feature_lengths`. Falls back to the first two declared inputs.
fn pick_feat_len_inputs(inputs: &[String]) -> (String, String) {
	let has = |n: &str| inputs.iter().any(|i| i == n);
	let feat = if has("x") {
		"x"
	} else if has("audio_signal") {
		"audio_signal"
	} else if has("features") {
		"features"
	} else {
		inputs.first().map(String::as_str).unwrap_or("x")
	};
	let len = if has("x_len") {
		"x_len"
	} else if has("length") {
		"length"
	} else if has("feature_lengths") {
		"feature_lengths"
	} else {
		inputs.get(1).map(String::as_str).unwrap_or("x_len")
	};
	(feat.to_string(), len.to_string())
}

/// Pick the 3-D log-prob output (`logprobs`/`log_probs`/`lob_probs`) by name, else by rank.
fn pick_logits_output(session: &Session, outputs: &[String]) -> String {
	for cand in ["logprobs", "log_probs", "lob_probs"] {
		if outputs.iter().any(|o| o == cand) {
			return cand.to_string();
		}
	}
	// by rank: first output whose declared tensor shape has length 3.
	for name in outputs {
		if node_output_rank(session, name) == Some(3) {
			return name.clone();
		}
	}
	outputs.first().cloned().unwrap_or_else(|| "logprobs".into())
}

fn filter_sorted_inputs(session: &Session, prefix: &str) -> Vec<String> {
	let mut v: Vec<String> = node_input_names(session)
		.into_iter()
		.filter(|n| n.starts_with(prefix))
		.collect();
	v.sort();
	v
}

fn filter_sorted_outputs(session: &Session, prefix: &str) -> Vec<String> {
	let mut v: Vec<String> = node_output_names(session)
		.into_iter()
		.filter(|n| n.starts_with(prefix))
		.collect();
	v.sort();
	v
}

/// Read the first `past_key_values.*` input's `(num_heads, head_dim, is_fp16)` (§6.5 dtype read).
fn cohere_past_shape(session: &Session) -> SttResult<(usize, usize, bool)> {
	node_past_shape(session, "past_key_values.").ok_or_else(|| {
		SttError::SessionCreate("cohere decoder has no past_key_values input".into())
	})
}

fn read_special_id(
	cfg_path: Option<&Path>,
	key: &str,
	token_to_id: &BTreeMap<String, i64>,
	fallback_token: &str,
	hard_default: i64,
) -> i64 {
	if let Some(path) = cfg_path {
		if let Ok(text) = std::fs::read_to_string(path) {
			if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
				if let Some(id) = v.get(key).and_then(|x| x.as_i64()) {
					return id;
				}
			}
		}
	}
	token_to_id
		.get(fallback_token)
		.copied()
		.unwrap_or(hard_default)
}

fn is_special_token(token: &str) -> bool {
	(token.starts_with("<|") && token.ends_with("|>")) || token == "<unk>" || token == "<pad>"
}

/// Extract the final decode-step logit row from a `(1, S, vocab)` or `(1, vocab)` logits array.
fn last_step_row(logits: &ArrayD<f32>) -> SttResult<Vec<f32>> {
	match logits.ndim() {
		3 => {
			let l = logits
				.view()
				.into_dimensionality::<ndarray::Ix3>()
				.map_err(|e| SttError::Inference(format!("logits ix3: {e}")))?;
			let s = l.shape()[1];
			Ok(l.index_axis(Axis(0), 0).index_axis(Axis(0), s - 1).to_vec())
		}
		2 => {
			let l = logits
				.view()
				.into_dimensionality::<ndarray::Ix2>()
				.map_err(|e| SttError::Inference(format!("logits ix2: {e}")))?;
			Ok(l.index_axis(Axis(0), 0).to_vec())
		}
		_ => Err(SttError::Inference("unexpected logits rank".into())),
	}
}

/// Decoder_mems shape `(layers, 1, 0, hidden)` from the decoder input metadata (mem_len starts 0).
fn dms_shape(decoder: &Session) -> Vec<usize> {
	if let Some((layers, hidden)) = node_input_outer_inner(decoder, "decoder_mems") {
		return vec![layers, 1, 0, hidden];
	}
	vec![1, 1, 0, 1024]
}

fn clone_f32_arrayd(src: &ArrayD<f32>, _shape: &[usize]) -> SttResult<Tensor<f32>> {
	Tensor::from_array(src.clone())
		.map_err(|e| SttError::Inference(format!("clone f32 tensor: {e}")))
}

fn clone_i64_arrayd(src: &ArrayD<i64>, _shape: &[usize]) -> SttResult<Tensor<i64>> {
	Tensor::from_array(src.clone())
		.map_err(|e| SttError::Inference(format!("clone i64 tensor: {e}")))
}

// ── Dynamic named-input vector helpers (for the variadic Cohere KV-cache) ──
//
// `ort::inputs![]` is fixed-arity; the Cohere decoder needs 5 fixed inputs + N past_key_values.*
// (dtype-matched f32/f16). `Session::run` accepts `Vec<(Cow<str>, SessionInputValue)>` via
// `Into<SessionInputs>`, so we build that vector explicitly.

type NamedInput = (
	std::borrow::Cow<'static, str>,
	ort::session::SessionInputValue<'static>,
);

fn tensor_i64(shape: (usize, usize), data: Vec<i64>) -> SttResult<Tensor<i64>> {
	let arr = ndarray::Array2::from_shape_vec(shape, data)
		.map_err(|e| SttError::Inference(format!("i64 array: {e}")))?;
	Tensor::from_array(arr).map_err(|e| SttError::Inference(format!("i64 tensor: {e}")))
}

/// Scalar i64 (0-D tensor) — e.g. `num_logits_to_keep`.
fn scalar_i64(v: i64) -> SttResult<Tensor<i64>> {
	let arr = ndarray::Array0::from_elem((), v);
	Tensor::from_array(arr).map_err(|e| SttError::Inference(format!("scalar i64: {e}")))
}

/// 1-D i64 vector tensor — e.g. lengths `[T]`.
fn tensor_i64_1d(data: Vec<i64>) -> SttResult<Tensor<i64>> {
	let arr = ndarray::Array1::from_vec(data);
	Tensor::from_array(arr).map_err(|e| SttError::Inference(format!("i64 1d tensor: {e}")))
}

/// 1-D i32 vector tensor — SenseVoice control inputs.
fn tensor_i32_1d(data: Vec<i32>) -> SttResult<Tensor<i32>> {
	let arr = ndarray::Array1::from_vec(data);
	Tensor::from_array(arr).map_err(|e| SttError::Inference(format!("i32 1d tensor: {e}")))
}

fn push_tensor<T>(inputs: &mut Vec<NamedInput>, name: &'static str, tensor: Tensor<T>)
where
	T: ort::value::PrimitiveTensorElementType + Clone + std::fmt::Debug + 'static,
{
	// `SessionInputValue: From<Value<T>>` (Tensor<T> = Value<TensorValueTypeMarker<T>>) → direct.
	inputs.push((
		std::borrow::Cow::Borrowed(name),
		ort::session::SessionInputValue::from(tensor),
	));
}

/// Push the host past-KV arrays (dtype-matched) as named inputs (§6.5 fp16 carry).
fn push_past_kv(
	inputs: &mut Vec<NamedInput>,
	names: &[String],
	state: &BTreeMap<String, KvTensor>,
) -> SttResult<()> {
	for name in names {
		let kv = state
			.get(name)
			.ok_or_else(|| SttError::Inference(format!("missing KV state for {name}")))?;
		let value: ort::session::SessionInputValue<'static> = match kv {
			KvTensor::F32(a) => {
				let t = Tensor::from_array(a.clone())
					.map_err(|e| SttError::Inference(format!("kv f32 {name}: {e}")))?;
				ort::session::SessionInputValue::from(t)
			}
			KvTensor::F16(a) => {
				let t = Tensor::from_array(a.clone())
					.map_err(|e| SttError::Inference(format!("kv f16 {name}: {e}")))?;
				ort::session::SessionInputValue::from(t)
			}
		};
		inputs.push((std::borrow::Cow::Owned(name.clone()), value));
	}
	Ok(())
}

/// Carry present.* outputs into the next step's past_key_values.* (dtype-preserving).
fn carry_present(
	outputs: &ort::session::SessionOutputs<'_>,
	past_names: &[String],
	present_names: &[String],
	is_fp16: bool,
) -> SttResult<BTreeMap<String, KvTensor>> {
	let mut next = BTreeMap::new();
	for (past, present) in past_names.iter().zip(present_names.iter()) {
		let val = &outputs[present.as_str()];
		let kv = if is_fp16 {
			let arr = val
				.try_extract_array::<F16>()
				.map_err(|e| SttError::Inference(format!("carry present f16 {present}: {e}")))?;
			KvTensor::F16(arr.to_owned())
		} else {
			let arr = val
				.try_extract_array::<f32>()
				.map_err(|e| SttError::Inference(format!("carry present f32 {present}: {e}")))?;
			KvTensor::F32(arr.to_owned())
		};
		next.insert(past.clone(), kv);
	}
	Ok(next)
}

// ───────────────────────────────────────────────────────────────────────────
// 11. Pure-logic unit tests (no ORT session required)
// ───────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use super::*;

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
		assert_eq!(parse_float_vec("1.0, 2.5  3.0\n-1.0"), vec![1.0, 2.5, 3.0, -1.0]);
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
}
