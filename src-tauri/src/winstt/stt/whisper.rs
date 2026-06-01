// PORT IMPL — drafted against real APIs, pending compile.
// Source (decode correctness): onnx-asr fork src/onnx_asr/models/whisper/_hf.py + _base.py
//   (E:/DL/Projects/onnx-asr/src/onnx_asr/models/whisper/).
// Source (load fixes): server/src/recorder/infrastructure/onnxasr_transcriber.py
//   (fp16 decoder repair §6.1, ORT_ENABLE_EXTENDED §6.2, .en prompt-slot §6.3, vocab.get §6.4).
// Source (ort API, verified against the installed crate src):
//   ort-2.0.0-rc.12/src/{session/mod.rs,session/input.rs,session/output.rs,
//   value/type.rs,value/impl_tensor/{create.rs,extract.rs,shape.rs}}.
//     * Session::builder() -> SessionBuilder; .with_execution_providers(impl AsRef<[EPDispatch]>)
//       -> .with_optimization_level(GraphOptimizationLevel::{Level2,Level3}) -> .with_intra_threads(usize)
//       -> .commit_from_file(path) -> Session.
//     * Session::run(impl Into<SessionInputs>) -> SessionOutputs; a Vec<(Cow<str>, SessionInputValue)>
//       Into<SessionInputs> (input.rs:62). SessionInputValue: From<Value<T>> and From<ValueRef<T>>.
//     * value::Tensor::from_array((shape, Box<[T]>)) -> Tensor<T>; TensorRef::from_array_view((shape, &[T])).
//     * SessionOutputs::get(name) -> Option<&DynValue>; DynValue::try_extract_tensor::<f32>()
//       -> Result<(&Shape, &[f32])>; Shape derefs to [i64].
//     * Session::{inputs(),outputs()} -> &[Outlet]; Outlet::{name(),dtype()->&ValueType};
//       ValueType::Tensor { ty, shape, dimension_symbols }.
//
// The Whisper / lite-whisper / distil-whisper ONNX engine — the dictation core.
//
// Topology (Optimum split export):
//   * encoder_model{_q}.onnx        : input_features (1, n_mels, T) → last_hidden_state
//   * decoder_model_merged{_q}.onnx : autoregressive decoder with an optional
//     `use_cache_branch` flag + past_key_values.* inputs / present.* outputs, and
//     (for `*_timestamped` exports) cross_attentions.* outputs.
//
// Decode is a greedy KV-cache loop, ONE token per cached step (multi-token-per-call is
// broken on these merged-decoder exports — memory project_onnx_whisper_cache_bug). lite-whisper
// is byte-identical here: same decoder graph, only the encoder is the low-rank/factorized
// variant which loads as-is.
//
// PERF NOTE (SPIKE): the Python reference binds past/present KV device-side via IoBinding to
// avoid host round-trips per step. ort 2.0.0-rc.12 ships an IoBinding API
// (session/io_binding.rs) but this impl uses the host-copy `Session::run` path
// (correct-first; the spec-sanctioned escape hatch in 03_stt_engine.md §12) and carries
// present→past forward host-side as owned tensors. The hot loop is isolated in
// `decode_greedy` so the IoBinding upgrade is a localized swap once the spike confirms perf.

#![allow(dead_code)]

use std::borrow::Cow;
use std::path::Path;

use ort::ep::ExecutionProviderDispatch;
use ort::memory::Allocator;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::{Session, SessionInputValue};
use ort::value::{Tensor, TensorRef, ValueType};

use super::mel::{HOP_LENGTH, MelExtractor};
use super::whisper_tokenizer::WhisperTokenizer;
use super::{
	Accelerator, EngineConfig, EngineKind, Segment, SttError, SttResult, TranscribeOptions,
	Transcriber, Transcription, WordResult,
};
use crate::winstt::word_timestamps::{
	self, AlignArgs, CrossAttentions, lookup_alignment_heads,
};

/// Maximum decoder length (Whisper's hard cap). The loop also stops on all-EOS.
const MAX_LENGTH: usize = 448;

/// A loaded Whisper-family engine (covers `EngineKind::WhisperHf`). Holds the two ORT
/// sessions, the parsed tokenizer, the mel front-end, and the per-load capability flags.
pub struct WhisperEngine {
	model_name: String,
	encoder: Session,
	decoder: Session,
	tokenizer: WhisperTokenizer,
	mel: MelExtractor,
	providers: Vec<String>,
	/// Sorted `past_key_values.*` decoder input names (canonical layer order).
	past_kv_names: Vec<String>,
	/// (num_heads, head_dim) per past-kv name, read from the decoder graph at load.
	kv_dims: Vec<(i64, i64)>,
	has_use_cache_branch: bool,
	has_cross_attention: bool,
	/// Sorted `cross_attentions.*` decoder output names (canonical layer 0..N-1 order),
	/// empty unless this is a `*_timestamped` export. Mirrors `_hf.py`
	/// `_cross_attention_output_names` (sorted by trailing integer layer index).
	cross_attn_names: Vec<String>,
	ready: bool,
}

impl WhisperEngine {
	/// Build both sessions from a resolved file set. Applies the fp16 decoder repair and
	/// the `ORT_ENABLE_EXTENDED` downgrade when `cfg.whisper_fp16_workaround` is set.
	pub fn load(cfg: &EngineConfig) -> SttResult<Self> {
		let files = &cfg.resolved.files;
		let get = |k: &str| -> SttResult<&Path> {
			files
				.get(k)
				.map(|p| p.as_path())
				.ok_or_else(|| SttError::Resolve(format!("whisper: missing resolved file '{k}'")))
		};
		let encoder_path = get("encoder")?;
		let decoder_path = get("decoder")?;
		let vocab_path = get("vocab")?;
		let added_tokens_path = files.get("added_tokens").map(|p| p.as_path());

		let tokenizer = WhisperTokenizer::load(vocab_path, added_tokens_path)?;

		// n_mels resolution order: explicit "num_mel_bins" pseudo-entry (spike) → the
		// config.json `num_mel_bins` (the resolver provides a "config" path; else the sibling
		// of vocab.json) → 80 (every export except large-v3 = 128). Getting this wrong silently
		// breaks 128-mel models loaded through the live resolver path (they'd run at 80 mel).
		let n_mels = files
			.get("num_mel_bins")
			.and_then(|p| p.to_str())
			.and_then(|s| s.parse::<usize>().ok())
			.or_else(|| {
				let cfg = files
					.get("config")
					.map(|p| p.to_path_buf())
					.or_else(|| vocab_path.parent().map(|d| d.join("config.json")))?;
				read_config_usize(&cfg, "num_mel_bins")
			})
			.unwrap_or(80);
		let mel = MelExtractor::new(n_mels);

		let is_gpu = cfg
			.providers
			.first()
			.map(|a| !matches!(a, Accelerator::Cpu))
			.unwrap_or(false);
		let intra = super::pick_intra_op_threads(is_gpu, num_cpus());

		let encoder = build_session(encoder_path, cfg, intra, cfg.whisper_fp16_workaround)?;
		let decoder = load_decoder_with_fp16_repair(decoder_path, cfg, intra)?;

		// Introspect the decoder graph (inputs()/outputs() return &[Outlet]).
		let mut past_kv_names: Vec<String> = decoder
			.inputs()
			.iter()
			.map(|o| o.name().to_string())
			.filter(|n| n.starts_with("past_key_values."))
			.collect();
		past_kv_names.sort_by_key(|n| kv_sort_key(n));
		let mut kv_dims: Vec<(i64, i64)> = past_kv_names.iter().map(|n| kv_head_dim(&decoder, n)).collect();
		// Optimum exports often declare past_key_values dims (num_heads, head_dim) as
		// SYMBOLIC — ort reports those as 0/-1 (unlike onnxruntime-python, which yields the
		// concrete ints). The empty step-0 cache must still be (0, num_heads, 0, head_dim)
		// or the merged decoder's If-node branch shapes mismatch. Fall back to config.json
		// (sibling of vocab.json): decoder_attention_heads + d_model/heads.
		if kv_dims.iter().any(|&(h, d)| h <= 0 || d <= 0) {
			if let Some((h, d)) = read_whisper_head_dims(vocab_path) {
				for kv in kv_dims.iter_mut() {
					if kv.0 <= 0 {
						kv.0 = h;
					}
					if kv.1 <= 0 {
						kv.1 = d;
					}
				}
			}
		}

		let has_use_cache_branch = decoder.inputs().iter().any(|o| o.name() == "use_cache_branch");
		// Collect + sort the `cross_attentions.{i}` output names by the trailing integer layer
		// index (canonical layer-0..N-1 order), exactly like `_hf.py::_cross_attention_output_names`.
		let mut cross_attn_names: Vec<String> = decoder
			.outputs()
			.iter()
			.map(|o| o.name().to_string())
			.filter(|n| n.starts_with("cross_attentions."))
			.collect();
		cross_attn_names.sort_by_key(|n| {
			n.trim_start_matches("cross_attentions.")
				.parse::<i64>()
				.unwrap_or(i64::MAX)
		});
		let has_cross_attention = !cross_attn_names.is_empty();

		if std::env::var("WINSTT_STT_DEBUG").is_ok() {
			eprintln!(
				"[whisper] {} past_kv tensors; dims[0]={:?}; use_cache_branch={}; cross_attn={}; multilingual={}",
				past_kv_names.len(),
				kv_dims.first(),
				has_use_cache_branch,
				has_cross_attention,
				tokenizer.is_multilingual
			);
		}

		let providers = cfg.providers.iter().map(provider_label).collect();

		Ok(Self {
			model_name: cfg.model_name.clone(),
			encoder,
			decoder,
			tokenizer,
			mel,
			providers,
			past_kv_names,
			kv_dims,
			has_use_cache_branch,
			has_cross_attention,
			cross_attn_names,
			ready: true,
		})
	}

	/// Encode mel features once → `last_hidden_state` carried host-side as (shape, f32 data).
	fn encode(&mut self, audio: &[f32]) -> SttResult<(Vec<i64>, Vec<f32>)> {
		let (feats, n_mels, n_frames) = self.mel.extract(audio);
		// input_features: (1, n_mels, T).
		let input = Tensor::from_array(([1usize, n_mels, n_frames], feats.into_boxed_slice()))
			.map_err(|e| SttError::Inference(format!("encoder input tensor: {e}")))?;
		let inputs: Vec<(Cow<'_, str>, SessionInputValue<'_>)> =
			vec![(Cow::Borrowed("input_features"), SessionInputValue::from(input))];
		let outputs = self
			.encoder
			.run(inputs)
			.map_err(|e| SttError::Inference(format!("encoder run: {e}")))?;
		let hidden = outputs
			.get("last_hidden_state")
			.ok_or_else(|| SttError::Inference("encoder produced no last_hidden_state".into()))?;
		let (shape, data) = hidden
			.try_extract_tensor::<f32>()
			.map_err(|e| SttError::Inference(format!("encoder output extract: {e}")))?;
		let shape_i64: Vec<i64> = shape.to_vec();
		Ok((shape_i64, data.to_vec()))
	}

	/// Build the static decoder prompt for one utterance (mirrors `_base.py`).
	///
	/// Multilingual: `[sot, <lang|eos-sentinel>, transcribe|translate, (notimestamps?)]`.
	/// `.en` exports keep the eos sentinel in position 1 — writing a language token there
	/// corrupts the prompt (memory project_whisper_incomplete_vocab...; §6.3).
	fn build_prompt(&self, opts: &TranscribeOptions) -> Vec<i64> {
		let tk = &self.tokenizer;
		let task = if opts.translate && tk.is_multilingual {
			tk.translate_token_id
		} else {
			tk.transcribe_token_id
		};
		let mut prompt = if opts.return_timestamps {
			vec![tk.bos_token_id, tk.eos_token_id, task]
		} else {
			vec![tk.bos_token_id, tk.eos_token_id, task, tk.notimestamps_token_id]
		};
		if tk.is_multilingual {
			if let Some(lang) = opts.language.as_deref().filter(|l| !l.is_empty()) {
				if let Some(tok) = tk.language_token(lang) {
					prompt[1] = tok;
				}
			}
		}
		prompt
	}

	/// Short 3-token decode from `[sot]`; position-1 argmax = detected language token.
	fn detect_language(&mut self, enc_shape: &[i64], enc_data: &[f32]) -> SttResult<i64> {
		let prompt = vec![self.tokenizer.bos_token_id];
		let tokens = self.decode_greedy(enc_shape, enc_data, prompt, 3)?;
		Ok(*tokens.get(1).unwrap_or(&self.tokenizer.eos_token_id))
	}

	/// The greedy autoregressive KV-cache loop. Returns the full token sequence
	/// (prompt + generated incl. trailing eos). Port of `_hf.py::_decoding` / `_decode`.
	fn decode_greedy(
		&mut self,
		enc_shape: &[i64],
		enc_data: &[f32],
		prompt: Vec<i64>,
		max_length: usize,
	) -> SttResult<Vec<i64>> {
		let (tokens, _) = self.decode_inner(enc_shape, enc_data, prompt, max_length, false)?;
		Ok(tokens)
	}

	/// Greedy decode that ALSO collects per-step cross-attention from the
	/// `cross_attentions.{i}` decoder outputs (word-timestamp path). Port of
	/// `_hf.py::_decoding_with_cross_attention`. Returns the full token sequence and a
	/// stacked `(num_layers, num_heads, num_decoder_tokens, num_encoder_frames)` tensor.
	///
	/// Requires `self.has_cross_attention`; callers gate on `supports_word_timestamps()`.
	fn decode_with_cross_attn(
		&mut self,
		enc_shape: &[i64],
		enc_data: &[f32],
		prompt: Vec<i64>,
		max_length: usize,
	) -> SttResult<(Vec<i64>, CrossAttentions)> {
		let (tokens, attn) = self.decode_inner(enc_shape, enc_data, prompt, max_length, true)?;
		let attn = attn.ok_or_else(|| {
			SttError::Inference("cross-attention requested but decoder produced none".into())
		})?;
		Ok((tokens, attn))
	}

	/// Shared greedy KV-cache decode body. When `collect_cross_attn` is set the loop reads the
	/// sorted `cross_attentions.{i}` outputs each step and concatenates them along the decoder-
	/// token axis, returning the stacked `(num_layers, num_heads, num_dec_tokens, num_enc_frames)`.
	fn decode_inner(
		&mut self,
		enc_shape: &[i64],
		enc_data: &[f32],
		prompt: Vec<i64>,
		max_length: usize,
		collect_cross_attn: bool,
	) -> SttResult<(Vec<i64>, Option<CrossAttentions>)> {
		let eos = self.tokenizer.eos_token_id;
		let mut tokens = prompt;
		// Carried KV cache host-side: name → (shape, data). Empty (0,H,0,D) on step 0.
		let mut past: Vec<(Vec<i64>, Vec<f32>)> = self
			.kv_dims
			.iter()
			.map(|&(h, d)| (vec![0i64, h, 0, d], Vec::<f32>::new()))
			.collect();

		let want_attn = collect_cross_attn && self.has_cross_attention && !self.cross_attn_names.is_empty();
		// Per-layer running buffers: each entry is (heads, dec_step_len, enc_frames) FLAT data, one
		// per decode step. Concatenated along the decoder-token (step) axis at the end, exactly like
		// `_hf.py` `np.concatenate(layer_steps, axis=2)` then `np.stack(..., axis=1)`.
		let n_layers = self.cross_attn_names.len();
		let mut per_layer_steps: Vec<Vec<Vec<f32>>> = vec![Vec::new(); n_layers];
		// Resolved at the FIRST step from the actual output shapes (steps are uniform per layer).
		let mut ca_heads = 0usize;
		let mut ca_frames = 0usize;

		let enc_shape_usize: Vec<usize> = enc_shape.iter().map(|&d| d.max(0) as usize).collect();
		let total_steps = max_length.saturating_sub(tokens.len());

		for _ in 0..total_steps {
			let use_cache = past.iter().any(|(s, _)| s.first().copied().unwrap_or(0) != 0);

			// input_ids: full prompt on step 0, else only the last token.
			let (id_data, id_len): (Vec<i64>, usize) = if use_cache {
				(vec![*tokens.last().unwrap()], 1)
			} else {
				(tokens.clone(), tokens.len())
			};
			let input_ids = Tensor::from_array(([1usize, id_len], id_data.into_boxed_slice()))
				.map_err(|e| SttError::Inference(format!("decoder input_ids: {e}")))?;
			let enc_hidden = TensorRef::from_array_view((enc_shape_usize.clone(), enc_data))
				.map_err(|e| SttError::Inference(format!("decoder enc_hidden: {e}")))?;

			let mut named: Vec<(Cow<'_, str>, SessionInputValue<'_>)> = Vec::with_capacity(self.past_kv_names.len() + 3);
			named.push((Cow::Borrowed("input_ids"), SessionInputValue::from(input_ids)));
			named.push((Cow::Borrowed("encoder_hidden_states"), SessionInputValue::from(enc_hidden)));
			if self.has_use_cache_branch {
				// Whisper merged decoders declare use_cache_branch as a bool tensor.
				let flag = Tensor::from_array(([1usize], vec![use_cache].into_boxed_slice()))
					.map_err(|e| SttError::Inference(format!("use_cache_branch: {e}")))?;
				named.push((Cow::Borrowed("use_cache_branch"), SessionInputValue::from(flag)));
			}
			// past_key_values.* : each carried-forward (or empty) cache tensor.
			// Build owned tensors; keep them alive in a side vec so the SessionInputValues
			// (which borrow nothing for owned values) are valid through run().
			for (i, name) in self.past_kv_names.iter().enumerate() {
				let (shape, data) = &past[i];
				let usize_shape: Vec<usize> = shape.iter().map(|&x| x.max(0) as usize).collect();
				let num_elem: usize = usize_shape.iter().product();
				let val: SessionInputValue<'_> = if num_elem == 0 {
					// Empty past (step 0): the merged decoder's use_cache_branch=False path
					// needs the (0, num_heads, 0, head_dim) empty cache (onnx-asr _create_state).
					// from_array's raw-data path REJECTS any 0-sized dim ("dimension #N must be
					// >= 1"); the allocator-backed ctor accepts 0-element tensors (= np.zeros).
					let t = Tensor::<f32>::new(&Allocator::default(), usize_shape)
						.map_err(|e| SttError::Inference(format!("empty past kv {name}: {e}")))?;
					SessionInputValue::from(t)
				} else {
					let t = Tensor::from_array((usize_shape, data.clone().into_boxed_slice()))
						.map_err(|e| SttError::Inference(format!("past kv {name}: {e}")))?;
					SessionInputValue::from(t)
				};
				named.push((Cow::Owned(name.clone()), val));
			}

			let outputs = self
				.decoder
				.run(named)
				.map_err(|e| SttError::Inference(format!("decoder run: {e}")))?;

			// logits: (1, seq, vocab) → argmax of the LAST position. Scoped so the
			// borrow of `outputs` ends before the present→past carry borrows it again.
			let mut next: i64 = {
				let logits = outputs
					.get("logits")
					.ok_or_else(|| SttError::Inference("decoder produced no logits".into()))?;
				let (lshape, ldata) = logits
					.try_extract_tensor::<f32>()
					.map_err(|e| SttError::Inference(format!("logits extract: {e}")))?;
				let vocab = *lshape.last().unwrap_or(&0) as usize;
				let seq = if lshape.len() >= 2 { lshape[lshape.len() - 2] as usize } else { 1 };
				if vocab == 0 {
					return Err(SttError::Inference("decoder logits had 0-width vocab".into()));
				}
				let last_off = seq.saturating_sub(1) * vocab;
				argmax(&ldata[last_off..last_off + vocab]) as i64
			};
			// EOS-sticky: once a row hit eos, freeze it.
			if *tokens.last().unwrap() == eos {
				next = eos;
			}

			// Collect this step's cross-attention BEFORE the present→past carry drops `outputs`.
			// Each `cross_attentions.{i}` output is (batch=1, num_heads, dec_step_len, enc_frames)
			// where dec_step_len == id_len (the number of decoder tokens fed THIS step — the full
			// prompt on step 0, then 1 thereafter). We store the FLAT (heads*dec_step_len*frames)
			// data per layer per step; the dec_step_len axis is what we concat over.
			if want_attn {
				for (li, name) in self.cross_attn_names.iter().enumerate() {
					let v = outputs.get(name.as_str()).ok_or_else(|| {
						SttError::Inference(format!("decoder produced no {name}"))
					})?;
					let (shape, data) = v.try_extract_tensor::<f32>().map_err(|e| {
						SttError::Inference(format!("{name} extract: {e}"))
					})?;
					// shape = [batch, heads, dec_step_len, frames]; batch is always 1.
					let h = shape.get(1).copied().unwrap_or(0).max(0) as usize;
					let f = shape.get(3).copied().unwrap_or(0).max(0) as usize;
					if li == 0 && per_layer_steps[0].is_empty() {
						ca_heads = h;
						ca_frames = f;
					}
					per_layer_steps[li].push(data.to_vec());
				}
			}

			// Carry present.* → past.* (the "keep prev when present is 0-length" zip merge).
			let mut new_past: Vec<(Vec<i64>, Vec<f32>)> = Vec::with_capacity(self.past_kv_names.len());
			for (i, name) in self.past_kv_names.iter().enumerate() {
				let present_name = name.replace("past_key_values.", "present.");
				let mut carried: Option<(Vec<i64>, Vec<f32>)> = None;
				if let Some(v) = outputs.get(present_name.as_str()) {
					if let Ok((s, d)) = v.try_extract_tensor::<f32>() {
						if s.first().copied().unwrap_or(0) != 0 {
							carried = Some((s.to_vec(), d.to_vec()));
						}
					}
				}
				new_past.push(carried.unwrap_or_else(|| past[i].clone()));
			}
			drop(outputs);
			past = new_past;

			tokens.push(next);
			if next == eos {
				break;
			}
		}

		// Stack the collected per-layer per-step attention into one dense
		// (num_layers, num_heads, num_dec_tokens, num_enc_frames) buffer in CrossAttentions's
		// canonical layout. The per-step `dec_step_len` segments concatenate along the token axis
		// in generation order (step 0's prompt rows first, then one row per subsequent step) — the
		// same order the decoder tokens themselves were produced, so token row i lines up with
		// `tokens[i]`. Mirrors `np.concatenate(steps, axis=2)` then `np.stack(layers, axis=1)`.
		let attn = if want_attn && ca_heads > 0 && ca_frames > 0 && !per_layer_steps[0].is_empty() {
			// Total decoder tokens = sum of each step's dec_step_len for layer 0.
			let total_tokens: usize = per_layer_steps[0]
				.iter()
				.map(|step| step.len() / (ca_heads * ca_frames).max(1))
				.sum();
			let mut ca = CrossAttentions::new(n_layers, ca_heads, total_tokens, ca_frames);
			for (li, steps) in per_layer_steps.iter().enumerate() {
				let mut tok_base = 0usize; // running decoder-token offset across steps
				for step in steps {
					// step is (heads, dec_step_len, frames) row-major.
					let step_tokens = step.len() / (ca_heads * ca_frames).max(1);
					for h in 0..ca_heads {
						for t in 0..step_tokens {
							for fr in 0..ca_frames {
								let src = (h * step_tokens + t) * ca_frames + fr;
								ca.set(li, h, tok_base + t, fr, step[src]);
							}
						}
					}
					tok_base += step_tokens;
				}
			}
			Some(ca)
		} else {
			None
		};

		Ok((tokens, attn))
	}

	/// Run cross-attention DTW on `cross_attentions` to recover per-word start/end seconds.
	/// `full_tokens` is the FULL decoded sequence (prompt + generated incl. trailing eos);
	/// `prompt_length` is the number of decoder-prompt tokens at its head (cross-attention row 0
	/// aligns with `full_tokens[0]`). Mirrors `_base.py::_align_word_timestamps`.
	fn align_word_timestamps(
		&self,
		cross_attentions: &CrossAttentions,
		full_tokens: &[i64],
		prompt_length: usize,
		num_audio_frames: usize,
		language: Option<&str>,
	) -> Vec<WordResult> {
		// Generated text tokens = everything after the prompt, eos stripped, then ONE eos appended
		// (the aligner needs the trailing-eot anchor to bound the last real word). Mirrors
		// `recognize_batch`: `generated = [t for t in row[prompt_length:] if t != eos] + [eos]`.
		let eos = self.tokenizer.eos_token_id;
		let mut generated: Vec<i64> = full_tokens
			.iter()
			.skip(prompt_length)
			.copied()
			.filter(|&t| t != eos)
			.collect();
		generated.push(eos);

		let num_layers = cross_attentions.num_layers;
		let num_heads = cross_attentions.num_heads;
		let vocab_size = self.tokenizer.vocab_size().max(0) as usize;
		let heads_mask = lookup_alignment_heads(num_layers, num_heads, vocab_size);

		// decode_one MUST preserve the leading space (`Ġ`/" ") so word-boundary splitting works.
		let decode_one = |ids: &[i64]| -> String {
			self.tokenizer.decode_text_preserve_leading_space(ids)
		};

		let args = AlignArgs {
			text_tokens: &generated,
			decode_one: &decode_one,
			eot_id: eos,
			prompt_length,
			num_audio_frames,
			language,
			medfilt_width: 7,
			qk_scale: 1.0,
		};
		match word_timestamps::align_words(cross_attentions, &heads_mask, args) {
			Ok(timings) => timings
				.into_iter()
				.map(|t| WordResult { text: t.word, start: t.start as f32, end: t.end as f32 })
				.collect(),
			Err(_) => Vec::new(),
		}
	}
}

impl Transcriber for WhisperEngine {
	fn kind(&self) -> EngineKind {
		EngineKind::WhisperHf
	}

	fn model_name(&self) -> &str {
		&self.model_name
	}

	fn is_ready(&self) -> bool {
		self.ready
	}

	fn active_providers(&self) -> &[String] {
		&self.providers
	}

	fn supports_word_timestamps(&self) -> bool {
		self.has_cross_attention
	}

	fn transcribe(&mut self, audio: &[f32], opts: &TranscribeOptions) -> SttResult<Transcription> {
		if audio.is_empty() {
			return Ok(Transcription::default());
		}
		let (enc_shape, enc_data) = self.encode(audio)?;

		// Resolve the language slot for multilingual + no-language via the 3-token detect.
		let mut prompt = self.build_prompt(opts);
		if self.tokenizer.is_multilingual {
			let no_lang = opts.language.as_deref().map(|l| l.is_empty()).unwrap_or(true);
			if no_lang && prompt.get(1).copied() == Some(self.tokenizer.eos_token_id) {
				let lang_tok = self.detect_language(&enc_shape, &enc_data)?;
				prompt[1] = lang_tok;
			}
		}

		let want_words = opts.return_word_timestamps && self.has_cross_attention;

		// ── Word-timestamp path: cross-attention DTW (no initial-prompt prefix) ──
		// The aligner needs each cross-attention row to line up 1:1 with a decoder-prompt /
		// generated token, so we DON'T inject the `<|startofprev|>` prefix here (it would shift
		// every row index and the history aligner has no prior-text bias to apply anyway). The
		// `prompt_length` is the plain decoder prompt length; cross-attention row 0 == prompt[0].
		if want_words {
			let prompt_length = prompt.len();
			let (tokens, cross_attn) =
				self.decode_with_cross_attn(&enc_shape, &enc_data, prompt, MAX_LENGTH)?;
			let text = self.tokenizer.decode_text(&tokens);
			let segments = if opts.return_timestamps { Some(self.to_segments(&tokens)) } else { None };
			// num_audio_frames = num_samples // HOP_LENGTH (pre 2× encoder downsample). The aligner
			// crops to `// 2` internally to match the encoder frame count.
			let num_audio_frames = audio.len() / HOP_LENGTH;
			let language = opts.language.as_deref().filter(|l| !l.is_empty());
			let words = self.align_word_timestamps(
				&cross_attn,
				&tokens,
				prompt_length,
				num_audio_frames,
				language,
			);
			let words = if words.is_empty() { None } else { Some(words) };
			return Ok(Transcription { text, segments, words });
		}

		// ── Standard path: greedy decode (optional initial-prompt biasing) ──
		// Initial-prompt biasing (Whisper-only; `EngineKind::supports_initial_prompt`).
		// Prepend `[<|startofprev|>, *encoded]` BEFORE the standard prompt so the decoder
		// soft-attends to the prior text (custom vocab / continuation). Sanitized upstream
		// (context slice) — raised noise here would poison whisper-tiny (memory
		// project_context_prompt_poisons_whisper). No-op on `.en` / Canary / Cohere.
		//
		// The prefix tokens are NOT special markers, so they must be STRIPPED from the
		// generated sequence before decode or the prompt body bleeds into the transcript
		// (memory-confirmed bug; WinSTT onnx_decoder_patches slices `out[:, prefix_len:]`).
		// max_length is bumped by prefix_len (capped at 448) so the prefix is "free".
		let mut prefix_len = 0usize;
		let mut max_length = MAX_LENGTH;
		if let Some(prompt_text) = opts.initial_prompt_text.as_deref() {
			let prefix = self.tokenizer.initial_prompt_prefix(prompt_text);
			if !prefix.is_empty() {
				prefix_len = prefix.len();
				// Allow the prefix tokens up to the 448 positional cap (we're already at
				// the cap, so the prefix shares the budget — Python: min(448, ml+prefix)).
				max_length = (MAX_LENGTH + prefix_len).min(MAX_LENGTH);
				let mut full = prefix;
				full.extend(prompt);
				prompt = full;
			}
		}

		let tokens = self.decode_greedy(&enc_shape, &enc_data, prompt, max_length)?;
		// Strip the injected initial-prompt prefix before decode.
		let tokens: &[i64] = if prefix_len > 0 && prefix_len <= tokens.len() {
			&tokens[prefix_len..]
		} else {
			&tokens
		};

		let text = self.tokenizer.decode_text(tokens);
		let segments = if opts.return_timestamps {
			Some(self.to_segments(tokens))
		} else {
			None
		};
		Ok(Transcription { text, segments, words: None })
	}

	fn shutdown(&mut self) {
		self.ready = false;
		// Sessions drop here; explicit hook lets the coordinator unload-before-load.
	}
}

impl WhisperEngine {
	fn to_segments(&self, tokens: &[i64]) -> Vec<Segment> {
		self.tokenizer
			.extract_segments(tokens)
			.into_iter()
			.map(|(start, end, text)| Segment { start, end, text })
			.collect()
	}
}

// ---------------------------------------------------------------------------
// Session construction + fp16 repair
// ---------------------------------------------------------------------------

/// Build one ORT session with the resolved providers + thread count. `is_whisper_fp16`
/// lowers the optimization level to EXTENDED (Level2) to dodge `SimplifiedLayerNormFusion`
/// mis-fusing the fp16 encoder (§6.2).
fn build_session(path: &Path, cfg: &EngineConfig, intra: usize, is_whisper_fp16: bool) -> SttResult<Session> {
	let level = if is_whisper_fp16 {
		GraphOptimizationLevel::Level2 // = ORT_ENABLE_EXTENDED (dodges SimplifiedLayerNormFusion)
	} else {
		GraphOptimizationLevel::All // = ORT_ENABLE_ALL (Level3 is layout-only, NOT "all")
	};
	let mut builder = Session::builder()
		.map_err(|e| SttError::SessionCreate(format!("session builder: {e}")))?
		.with_execution_providers(execution_providers(&cfg.providers))
		.map_err(|e| SttError::SessionCreate(format!("set providers: {e}")))?
		.with_optimization_level(level)
		.map_err(|e| SttError::SessionCreate(format!("opt level: {e}")))?
		.with_intra_threads(intra)
		.map_err(|e| SttError::SessionCreate(format!("intra threads: {e}")))?;
	builder
		.commit_from_file(path)
		.map_err(|e| SttError::SessionCreate(format!("commit {}: {e}", path.display())))
}

/// Load the merged decoder, recovering from the fp16-export defect (§6.1): on the fp16
/// subgraph-dtype error, surgically patch the `.onnx` in place and retry ONCE.
fn load_decoder_with_fp16_repair(path: &Path, cfg: &EngineConfig, intra: usize) -> SttResult<Session> {
	match build_session(path, cfg, intra, cfg.whisper_fp16_workaround) {
		Ok(s) => Ok(s),
		Err(e) if cfg.whisper_fp16_workaround && is_fp16_decoder_error(&e) => {
			patch_whisper_decoder_fp16(path)
				.map_err(|pe| SttError::SessionCreate(format!("fp16 decoder patch failed: {pe}")))?;
			build_session(path, cfg, intra, true)
		}
		Err(e) => Err(e),
	}
}

/// True if a session-create error matches the fp16 merged-decoder subgraph defect
/// (`onnxasr_transcriber._FP16_DECODER_LOAD_ERROR`): the "outer scope value ... float vs
/// float16" type mismatch ORT raises at create.
fn is_fp16_decoder_error(e: &SttError) -> bool {
	let msg = e.to_string().to_lowercase();
	(msg.contains("float16") || msg.contains("fp16"))
		&& (msg.contains("type") || msg.contains("subgraph") || msg.contains("outer scope"))
}

/// Bridge to the resolver agent's in-file fp16 decoder patch (`winstt::stt::fp16_patch`).
///
/// SPIKE: the resolver/fp16-patch agent owns that module. Contract (03_stt_engine.md §6.1):
///   `pub fn patch_whisper_decoder_fp16(path: &Path) -> Result<(), String>` — parses the
///   ONNX protobuf, rewrites the named subgraph output ValueInfoProto elem_type fp32→fp16,
///   writes the file back, idempotently. When that module lands, replace this body with a
///   direct call to it.
fn patch_whisper_decoder_fp16(path: &Path) -> Result<(), String> {
	#[allow(unused)]
	let _ = path;
	// Until the module is wired, surface a clear error so the loader falls back to fp32
	// (the documented escape hatch in 03_stt_engine.md §11).
	Err("fp16_patch module not yet wired (resolver agent owns winstt::stt::fp16_patch)".into())
}

// ---------------------------------------------------------------------------
// ORT helpers
// ---------------------------------------------------------------------------

/// Map our `Accelerator` list to ort `ExecutionProviderDispatch`es. CPU is always appended
/// as the op-level fallback. In ort 2.0.0-rc.12 the providers live under `ort::ep` and are
/// named `DirectML` / `CUDA` / `CPU` (built via `.build()`); the EP backends are compiled in
/// via the `ort` crate features on Windows (`directml`, declared in Cargo.toml by the
/// orchestrator). `.build()` returns an `ExecutionProviderDispatch` regardless of whether the
/// backend is actually present — availability is resolved at session-create with CPU fallback.
fn execution_providers(providers: &[Accelerator]) -> Vec<ExecutionProviderDispatch> {
	let mut out: Vec<ExecutionProviderDispatch> = Vec::new();
	for acc in providers {
		match acc {
			Accelerator::DirectMl => {
				// DirectML is compiled in on Windows via transcribe-rs's `ort-directml`
				// feature (NOT a winstt crate feature). The old `feature = "directml"` gate
				// referenced a winstt feature that doesn't exist → cfg ALWAYS false → DirectML
				// was never registered → Whisper silently ran on CPU (~10s for a short clip).
				// Gate on the OS only, mirroring families.rs.
				#[cfg(windows)]
				{
					out.push(ort::ep::DirectML::default().build());
				}
			}
			Accelerator::Cuda => {
				#[cfg(feature = "cuda")]
				{
					out.push(ort::ep::CUDA::default().build());
				}
			}
			// CPU is appended unconditionally below; CoreML/ROCm/OpenVino aren't built on
			// the shipped Windows target (the resolver already overrode incompatible
			// families to CPU, so these arms are no-ops here).
			_ => {}
		}
	}
	out.push(ort::ep::CPU::default().build());
	out
}

fn provider_label(a: &Accelerator) -> String {
	match a {
		Accelerator::Cpu => "CPUExecutionProvider",
		Accelerator::Cuda => "CUDAExecutionProvider",
		Accelerator::DirectMl => "DmlExecutionProvider",
		Accelerator::CoreMl => "CoreMLExecutionProvider",
		Accelerator::Rocm => "ROCMExecutionProvider",
		Accelerator::OpenVino => "OpenVINOExecutionProvider",
	}
	.to_string()
}

/// Read (num_heads, head_dim) for a past_key_values input from the declared graph dims.
/// Whisper exports declare `(batch, num_heads, past_len, head_dim)`; dims 1 & 3 are static.
/// Unknown/dynamic dims → 0, yielding a (0,0,0,0) empty cache ORT accepts as "no past".
fn kv_head_dim(decoder: &Session, name: &str) -> (i64, i64) {
	if let Some(outlet) = decoder.inputs().iter().find(|o| o.name() == name) {
		if let ValueType::Tensor { shape, .. } = outlet.dtype() {
			let dims: &[i64] = shape; // Shape derefs to [i64]
			let h = dims.get(1).copied().filter(|&d| d > 0).unwrap_or(0);
			let d = dims.get(3).copied().filter(|&d| d > 0).unwrap_or(0);
			return (h, d);
		}
	}
	(0, 0)
}

/// argmax over an f32 slice (greedy next-token). Empty → 0.
fn argmax(xs: &[f32]) -> usize {
	let mut best = 0usize;
	let mut best_v = f32::NEG_INFINITY;
	for (i, &v) in xs.iter().enumerate() {
		if v > best_v {
			best_v = v;
			best = i;
		}
	}
	best
}

/// Sort key for `past_key_values.N.{decoder|encoder}.{key|value}` by integer layer index
/// then sub-tensor, giving a canonical total order independent of graph iteration order.
fn kv_sort_key(name: &str) -> (i64, i64) {
	let rest = name.trim_start_matches("past_key_values.");
	let mut parts = rest.split('.');
	let layer = parts.next().and_then(|s| s.parse::<i64>().ok()).unwrap_or(i64::MAX);
	let sub = match (parts.next(), parts.next()) {
		(Some("decoder"), Some("key")) => 0,
		(Some("decoder"), Some("value")) => 1,
		(Some("encoder"), Some("key")) => 2,
		(Some("encoder"), Some("value")) => 3,
		_ => 4,
	};
	(layer, sub)
}

/// Best-effort CPU count (for `pick_intra_op_threads`). Falls back to 4 when unknown.
fn num_cpus() -> usize {
	std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}

/// Read an integer field (e.g. `num_mel_bins`) from a Whisper `config.json`. Tolerant: missing
/// file / key / non-integer → None (caller falls back to a default).
fn read_config_usize(config_path: &Path, key: &str) -> Option<usize> {
	let raw = std::fs::read_to_string(config_path).ok()?;
	let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
	v.get(key).and_then(|x| x.as_u64()).map(|n| n as usize)
}

/// Read (num_heads, head_dim) from the Whisper `config.json` that sits beside `vocab.json`
/// in the HF snapshot. `head_dim = d_model / decoder_attention_heads`. Used to shape the
/// step-0 empty KV cache when the decoder graph declares those dims symbolically (ort → 0).
fn read_whisper_head_dims(vocab_path: &Path) -> Option<(i64, i64)> {
	let cfg_path = vocab_path.parent()?.join("config.json");
	let raw = std::fs::read_to_string(cfg_path).ok()?;
	let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
	let heads = v.get("decoder_attention_heads").and_then(|x| x.as_i64())?;
	let d_model = v.get("d_model").and_then(|x| x.as_i64())?;
	if heads > 0 && d_model > 0 {
		Some((heads, d_model / heads))
	} else {
		None
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn argmax_picks_largest() {
		assert_eq!(argmax(&[0.1, 0.9, 0.3]), 1);
		assert_eq!(argmax(&[-5.0, -1.0, -9.0]), 1);
		assert_eq!(argmax(&[]), 0);
	}

	#[test]
	fn kv_sort_orders_by_layer_then_sub() {
		let mut names = vec![
			"past_key_values.10.encoder.value".to_string(),
			"past_key_values.2.decoder.key".to_string(),
			"past_key_values.2.decoder.value".to_string(),
			"past_key_values.2.encoder.key".to_string(),
		];
		names.sort_by_key(|n| kv_sort_key(n));
		assert_eq!(names[0], "past_key_values.2.decoder.key");
		assert_eq!(names[1], "past_key_values.2.decoder.value");
		assert_eq!(names[2], "past_key_values.2.encoder.key");
		assert_eq!(names[3], "past_key_values.10.encoder.value");
	}

	#[test]
	fn fp16_error_classifier() {
		let yes = SttError::SessionCreate(
			"Type Error: outer scope value 'present.0' float vs float16 in subgraph".into(),
		);
		assert!(is_fp16_decoder_error(&yes));
		let no = SttError::SessionCreate("file not found".into());
		assert!(!is_fp16_decoder_error(&no));
	}

	#[test]
	fn provider_labels_stable() {
		assert_eq!(provider_label(&Accelerator::DirectMl), "DmlExecutionProvider");
		assert_eq!(provider_label(&Accelerator::Cpu), "CPUExecutionProvider");
	}
}
