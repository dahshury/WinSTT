"""FunAudioLLM SenseVoice ONNX transcriber.

SenseVoice is a CTC-based multilingual ASR model from FunAudioLLM / FunASR
with first-class support for Mandarin (zh), English (en), Japanese (ja),
Korean (ko), and Cantonese (yue). The ONNX exports we ship target Handy's
sherpa-onnx / FunASR Nano variants — both load via plain
``onnxruntime.InferenceSession`` (no onnx-asr wrapping, no torch).

The pipeline is a faithful port of transcribe-rs' ``sense_voice_mod.rs``:

1. Peak-normalize the input (matches every other WinSTT transcriber).
2. Optional sample normalization (read from model metadata).
3. Compute an 80-mel FBANK with Hamming window, pre-emphasis 0.97,
   ``n_fft=400``, ``hop=160``, ``snip_edges=True``.
4. Apply Low Frame Rate stacking (default window=7, shift=6, both read
   from model metadata).
5. Apply CMVN — additive mean + multiplicative inv-stddev arrays from
   model metadata. Skipped on FunASR Nano.
6. Run the ONNX forward pass. Full SenseVoice expects four inputs
   (``feat``, ``x_length``, ``language``, ``text_norm``); Nano expects
   just ``feat``.
7. CTC greedy decode the logits, then strip the first 4 control tokens
   (lang / emotion / event / itn) and detokenize — replace ``▁``
   (U+2581) with spaces.
"""

from __future__ import annotations

import base64
import binascii
import logging
import time
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
from typing_extensions import override

from src.building_blocks.types import AudioArray
from src.recorder.domain.events import DownloadProgress
from src.recorder.domain.ports.transcriber import ITranscriber, TranscriptionResult
from src.recorder.infrastructure.onnxasr_transcriber import (
    _peak_normalize,
    _pick_intra_op_threads,
)

if TYPE_CHECKING:
    from numpy.typing import NDArray

logger = logging.getLogger(__name__)

# ── Constants from the transcribe-rs reference implementation ──────────

#: SenseVoice operates at a fixed 16 kHz sample rate.
_SAMPLE_RATE: int = 16_000

#: FBANK feature parameters. Identical to the ``MelConfig`` in
#: ``transcribe-rs/sense_voice_mod.rs``.
_NUM_MELS: int = 80
_N_FFT: int = 400
_HOP_LENGTH: int = 160
_WIN_LENGTH: int = 400
_PRE_EMPHASIS: float = 0.97
_F_MIN: float = 20.0
_F_MAX: float | None = None  # auto = sample_rate / 2

#: 4 control tokens (language / emotion / event / itn) are prepended by
#: the model before the transcript proper. We strip them on decode.
_NUM_CONTROL_TOKENS: int = 4

#: Mapping from user-facing language codes to the metadata key the model
#: stores the language id under. The two zh aliases are normalized to
#: ``zh`` because Handy does the same in ``transcription.rs:577-585``.
_LANGUAGE_KEY_MAP: dict[str, str] = {
    "auto": "lang_auto",
    "": "lang_auto",  # empty string → auto-detect (matches Handy behavior)
    "zh": "lang_zh",
    "zh-Hans": "lang_zh",
    "zh-Hant": "lang_zh",
    "en": "lang_en",
    "ja": "lang_ja",
    "ko": "lang_ko",
    "yue": "lang_yue",
}

#: Default lang→id table used when the ONNX model metadata doesn't carry
#: explicit ``lang_*`` entries (the original FunASR export, pre-sherpa).
_DEFAULT_LANG_IDS: dict[str, int] = {
    "auto": 0,
    "zh": 3,
    "en": 4,
    "yue": 7,
    "ja": 11,
    "ko": 12,
}

#: Default text-normalization sentinel token ids. ``with_itn`` is 14 and
#: ``without_itn`` is 15 per the original FunASR FunCodec export.
_DEFAULT_WITH_ITN_ID: int = 14
_DEFAULT_WITHOUT_ITN_ID: int = 15


# ── FBANK primitives ──────────────────────────────────────────────────


def _build_mel_filterbank(
    *,
    sample_rate: int = _SAMPLE_RATE,
    n_fft: int = _N_FFT,
    n_mels: int = _NUM_MELS,
    f_min: float = _F_MIN,
    f_max: float | None = _F_MAX,
) -> NDArray[np.float32]:
    """Build an HTK-style triangular mel filterbank.

    Mirrors Kaldi's ``compute-fbank-feats`` (which is what FunASR uses in
    its preprocessing pipeline) — HTK mel scale, no Slaney norm. Returns a
    matrix of shape ``(n_freqs=n_fft//2 + 1, n_mels)`` that you can
    matmul into the power spectrogram to get per-frame mel energies.

    The HTK mel scale is ``mel = 2595 * log10(1 + f / 700)``; we lay out
    ``n_mels + 2`` mel-spaced anchor points between ``f_min`` and
    ``f_max`` (defaults to Nyquist) then build triangular filters between
    consecutive triplets, exactly as Kaldi does. No torch dependency.
    """
    n_freqs = n_fft // 2 + 1
    fmax = f_max if f_max is not None else sample_rate / 2.0
    all_freqs = np.linspace(0.0, sample_rate / 2.0, n_freqs)
    m_min = 2595.0 * np.log10(1.0 + f_min / 700.0)
    m_max = 2595.0 * np.log10(1.0 + fmax / 700.0)
    m_pts = np.linspace(m_min, m_max, n_mels + 2)
    f_pts = 700.0 * (10.0 ** (m_pts / 2595.0) - 1.0)
    f_diff = np.diff(f_pts)
    slopes = f_pts[None, :] - all_freqs[:, None]
    down_slopes = -slopes[:, :-2] / f_diff[:-1]
    up_slopes = slopes[:, 2:] / f_diff[1:]
    fb = np.maximum(np.zeros_like(down_slopes), np.minimum(down_slopes, up_slopes))
    return fb.astype(np.float32)


def _compute_fbank(samples: NDArray[np.float32], fbanks: NDArray[np.float32]) -> NDArray[np.float32]:
    """Compute an 80-mel log-magnitude FBANK with Hamming + pre-emphasis.

    Mirrors the Rust reference (``transcribe-rs/sense_voice_mod.rs``)
    and matches Kaldi's ``compute-fbank-feats`` with the wespeaker
    profile (Hamming window, snip_edges=True, pre-emphasis 0.97).
    Returns a ``(T, n_mels)`` float32 array — time-first orientation,
    same as the upstream Rust ``compute_mel`` helper.

    Numerical detail: pre-emphasis is applied per-frame against an
    edge-padded prefix so the first sample doesn't accidentally cancel
    itself out, then the Hamming window is multiplied in, and finally
    we go through ``rfft`` → magnitude-squared → mel matmul → log.
    """
    if samples.size < _WIN_LENGTH:
        return np.zeros((0, _NUM_MELS), dtype=np.float32)

    # snip_edges=True: T = 1 + (N - win) // hop. No padding.
    num_frames = 1 + (samples.size - _WIN_LENGTH) // _HOP_LENGTH
    # Build the strided view of windows.
    strided = np.lib.stride_tricks.sliding_window_view(samples, _WIN_LENGTH)[::_HOP_LENGTH][:num_frames]
    strided = strided.astype(np.float32, copy=True)

    if _PRE_EMPHASIS != 0.0:
        # Apply per-frame pre-emphasis: y[n] = x[n] - 0.97 * x[n-1].
        # Edge-pad with the leading sample so n=0 cancels to ~0 only when
        # the frame is silent (matches Kaldi's `--preemphasis-coefficient`).
        offset = np.pad(strided, ((0, 0), (1, 0)), mode="edge")
        strided = strided - _PRE_EMPHASIS * offset[..., :-1]

    window = np.hamming(_WIN_LENGTH).astype(np.float32)
    strided = strided * window

    spectrum = np.abs(np.fft.rfft(strided, _N_FFT)).astype(np.float32) ** 2
    mel_energies = np.matmul(spectrum, fbanks)
    # Same log-zero guard the Kaldi preprocessor uses.
    eps = float(np.finfo(np.float32).eps)
    features = np.log(np.maximum(mel_energies, eps))
    result: NDArray[np.float32] = features.astype(np.float32, copy=False)
    return result


def _apply_lfr(features: NDArray[np.float32], window_size: int, window_shift: int) -> NDArray[np.float32]:
    """Apply Low Frame Rate stacking.

    Stacks ``window_size`` consecutive feature frames into one and steps
    by ``window_shift`` to produce a sequence ``window_size``x wider per
    step but ``window_shift``x shorter overall. The final partial window
    is right-padded with its own last frame so we always emit at least
    one row when the input is non-empty — matches the FunASR `apply_lfr`
    behavior.
    """
    if features.shape[0] == 0:
        return np.zeros((0, features.shape[1] * window_size), dtype=np.float32)
    in_frames, mel_dim = features.shape
    # ceil division so we never drop the final partial chunk.
    out_frames = max(1, 1 + (in_frames - 1) // window_shift)
    out = np.zeros((out_frames, mel_dim * window_size), dtype=np.float32)
    for i in range(out_frames):
        start = i * window_shift
        end = start + window_size
        if end <= in_frames:
            chunk = features[start:end]
        else:
            # Pad the tail with the last available frame (FunASR uses
            # edge-padding here so the partial chunk still has shape
            # (window_size, mel_dim)).
            last_idx = min(in_frames - 1, in_frames - 1)
            chunk = np.concatenate(
                [features[start:in_frames], np.tile(features[last_idx : last_idx + 1], (end - in_frames, 1))]
            )
        out[i] = chunk.reshape(-1)
    return out


def _apply_cmvn(
    features: NDArray[np.float32],
    neg_mean: NDArray[np.float32],
    inv_stddev: NDArray[np.float32],
) -> NDArray[np.float32]:
    """Apply Cepstral Mean and Variance Normalization.

    ``(features + neg_mean) * inv_stddev`` — both arrays are broadcast
    along the time axis. This is the only normalization step in the
    SenseVoice pipeline; the FBANK above is logged but otherwise raw.
    """
    return ((features + neg_mean) * inv_stddev).astype(np.float32, copy=False)


# ── CTC greedy decoding ────────────────────────────────────────────────


def _ctc_greedy_decode(logits: NDArray[np.float32], num_frames: int, blank_id: int) -> list[int]:
    """Single-utterance CTC greedy decode.

    For every step, take the argmax token. Drop blanks and collapse
    consecutive repeats. Returns the resulting token ids.

    ``logits`` has shape ``(T_out, vocab_size)`` (the batch dimension
    is already removed by the caller) and ``num_frames`` is the number
    of frames to actually scan — anything beyond that is ignored
    (matches the Rust reference's ``x_length`` plumbing).
    """
    if logits.shape[0] == 0:
        return []
    scan = logits[:num_frames]
    ids = scan.argmax(axis=-1).astype(np.int64)
    out: list[int] = []
    prev = -1
    for token in ids.tolist():
        if token != blank_id and token != prev:
            out.append(int(token))
        prev = int(token)
    return out


# ── Tokenizer ──────────────────────────────────────────────────────────


def _load_tokens(tokens_path: Path, *, base64_encoded: bool) -> dict[int, str]:
    """Load a SenseVoice ``tokens.txt`` symbol table.

    Each line is ``<symbol> <id>``. We split from the right because some
    symbols (rare punctuation) themselves contain spaces — Kaldi's symbol
    tables historically allow that. When ``base64_encoded`` is True
    (FunASR Nano), every symbol is base64-decoded after parsing.

    Returns an ``id -> symbol`` mapping.
    """
    out: dict[int, str] = {}
    raw = tokens_path.read_text(encoding="utf-8")
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        # rsplit so a symbol containing whitespace stays intact.
        parts = stripped.rsplit(None, 1)
        if len(parts) != 2:
            continue
        symbol, id_str = parts
        try:
            token_id = int(id_str)
        except ValueError:
            continue
        if base64_encoded:
            try:
                decoded_bytes = base64.b64decode(symbol.encode("ascii"))
                symbol = decoded_bytes.decode("utf-8")
            except (binascii.Error, UnicodeDecodeError, UnicodeEncodeError):
                # Leave the raw symbol on failure — never crash on a
                # single malformed line. Non-ASCII inputs are common
                # when a "Nano" comment is set on a non-Nano export
                # (the loader must stay forgiving).
                logger.debug("base64 decode failed for token %r — keeping raw", symbol)
        out[token_id] = symbol
    return out


# ── Metadata parsing ───────────────────────────────────────────────────


def _meta_int(meta: dict[str, str], key: str, default: int | None = None) -> int | None:
    """Read an integer-valued metadata entry, falling back to ``default``."""
    raw = meta.get(key)
    if raw is None:
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def _meta_float_vec(meta: dict[str, str], key: str) -> NDArray[np.float32]:
    """Read a newline-separated float vector from model metadata.

    Returns an empty array when the key is missing or malformed — the
    caller treats that as "no CMVN" rather than crashing.
    """
    raw = meta.get(key)
    if raw is None:
        return np.zeros(0, dtype=np.float32)
    values: list[float] = []
    # FunASR exports separate by whitespace (incl. newline) or comma.
    cleaned = raw.replace(",", " ").split()
    for tok in cleaned:
        try:
            values.append(float(tok))
        except ValueError:
            continue
    return np.asarray(values, dtype=np.float32)


# ── Result formatting ──────────────────────────────────────────────────


def _format_result_text(tokens: list[int], symbols: dict[int, str], *, is_nano: bool) -> str:
    """Turn decoded token ids into the user-facing string.

    Strips the first 4 control tokens (lang / emotion / event / itn)
    unless the model is the FunASR Nano variant (no control tokens).
    Replaces ``▁`` (U+2581) with a space and fixes the apostrophe
    spacing the Rust reference's ``replace`` chain handles too.
    """
    start = 0 if is_nano else _NUM_CONTROL_TOKENS
    pieces: list[str] = []
    for token_id in tokens[start:]:
        sym = symbols.get(token_id, "")
        if not sym:
            continue
        pieces.append(sym.replace("▁", " "))
    text = "".join(pieces).strip()
    # Matches the Rust reference: ``replace(" '", "'").replace(" ▁'", "'")``
    text = text.replace(" '", "'").replace(" ▁'", "'")
    return text


# ── Main transcriber ───────────────────────────────────────────────────


class SenseVoiceTranscriber(ITranscriber):
    """ITranscriber adapter for the FunAudioLLM SenseVoice ONNX export.

    The model is loaded directly via ``onnxruntime.InferenceSession`` —
    no onnx-asr involvement — because SenseVoice has its own preprocessor
    that doesn't fit onnx-asr's family abstractions (FBANK + LFR + CMVN +
    four control tokens). The session-options threading policy is shared
    with :mod:`onnxasr_transcriber` so every transcriber in the codebase
    obeys the same E-core-collapse and GPU-fallback rules.

    The constructor accepts the bundled model directory; it expects
    ``model.onnx`` (or ``model.int8.onnx``) and ``tokens.txt`` to be
    side-by-side under that directory. The FunASR Nano flag is auto-
    detected via the ``comment`` field on the ONNX model metadata.
    """

    def __init__(
        self,
        *,
        model_path: Path,
        providers: list[str | tuple[str, dict[str, str]]] | None = None,
        on_download_progress: Callable[[DownloadProgress], None] | None = None,
        normalize_audio: bool = True,
    ) -> None:
        """Construct a SenseVoiceTranscriber.

        Args:
            model_path: Either the directory holding ``model.onnx`` +
                ``tokens.txt``, or the direct path to the ``.onnx`` file
                (``tokens.txt`` resolved as a sibling). Both shapes are
                accepted so downstream callers can hand us whatever
                ``hf_hub_download`` / catalog resolution gave them.
            providers: Optional list of ORT providers (forwarded as-is
                to ``InferenceSession``). ``None`` lets ORT pick the
                default. Shape matches every other transcriber in the
                codebase so the bootstrap helper doesn't need a SenseVoice
                special case.
            on_download_progress: Reserved for parity with
                :class:`OnnxAsrTranscriber` — SenseVoice doesn't trigger
                downloads itself (the caller is responsible for placing
                the files on disk), so this is currently unused. Kept on
                the signature so a future asset-downloader can plug in
                without bumping the constructor.
            normalize_audio: Run :func:`_peak_normalize` on the input
                before computing FBANK. Defaults True — matches every
                other transcriber.
        """
        # progress callback is reserved for future use (asset downloader).
        del on_download_progress

        import onnxruntime as rt

        model_dir, model_file = self._resolve_model_paths(model_path)
        tokens_path = model_dir / "tokens.txt"
        if not tokens_path.exists():
            msg = f"tokens.txt not found next to {model_file}"
            raise FileNotFoundError(msg)
        if not model_file.exists():
            msg = f"SenseVoice model file not found: {model_file}"
            raise FileNotFoundError(msg)

        providers_tuple: tuple[str | tuple[str, dict[str, str]], ...] | None = tuple(providers) if providers else None

        sess_options = rt.SessionOptions()
        sess_options.intra_op_num_threads = _pick_intra_op_threads(providers_tuple)

        logger.info("Loading SenseVoice model from %s", model_file)
        if providers_tuple is not None:
            self._session: Any = rt.InferenceSession(
                str(model_file), sess_options=sess_options, providers=list(providers_tuple)
            )
        else:
            self._session = rt.InferenceSession(str(model_file), sess_options=sess_options)

        self._input_names: list[str] = [inp.name for inp in self._session.get_inputs()]
        logger.debug("SenseVoice model inputs: %s", self._input_names)

        # Parse model metadata. ORT's custom_metadata_map is dict[str, str].
        meta_map: dict[str, str] = dict(self._session.get_modelmeta().custom_metadata_map or {})
        self._metadata = self._parse_metadata(meta_map)
        self._fbanks: NDArray[np.float32] = _build_mel_filterbank()
        self._symbols: dict[int, str] = _load_tokens(tokens_path, base64_encoded=self._metadata["is_funasr_nano"])

        self._normalize_audio = normalize_audio
        self._ready = True
        logger.info(
            "SenseVoice loaded: vocab=%d, lfr=(%d,%d), nano=%s",
            self._metadata["vocab_size"],
            self._metadata["lfr_window_size"],
            self._metadata["lfr_window_shift"],
            self._metadata["is_funasr_nano"],
        )

    @staticmethod
    def _resolve_model_paths(model_path: Path) -> tuple[Path, Path]:
        """Normalize ``model_path`` into ``(directory, onnx_file)``.

        Two shapes are accepted:

        * **Directory** — looks for ``model.int8.onnx`` first (Handy's
          default, which is what the catalog promises), then
          ``model.onnx``. Returns the first that exists; if neither
          exists, the caller's ``not found`` check fires.
        * **File** — assumes the parent directory holds ``tokens.txt``.
        """
        path = Path(model_path)
        if path.is_dir():
            for candidate in ("model.int8.onnx", "model.onnx"):
                f = path / candidate
                if f.exists():
                    return path, f
            # Return a synthetic path so the not-found error names the
            # file we expected (better UX than a generic dir error).
            return path, path / "model.onnx"
        return path.parent, path

    @staticmethod
    def _parse_metadata(meta: dict[str, str]) -> dict[str, Any]:
        """Resolve the SenseVoice-relevant metadata into a plain dict.

        Reads vocab_size, blank_id, the LFR window/shift, the language
        ID table, the with/without-ITN token ids, the CMVN
        ``neg_mean`` + ``inv_stddev`` vectors, and the ``is_funasr_nano``
        flag (parsed from the ``comment`` field — Nano builds advertise
        that string). Missing values fall back to the same defaults the
        Rust reference uses.
        """
        comment = meta.get("comment", "") or ""
        is_nano = "Nano" in comment

        vocab_size = _meta_int(meta, "vocab_size")
        if vocab_size is None:
            # Without vocab_size we can't trust CTC decode bounds —
            # surface a clear error instead of guessing.
            msg = "SenseVoice model metadata is missing required 'vocab_size'"
            raise ValueError(msg)
        blank_id = _meta_int(meta, "blank_id", 0) or 0
        lfr_window_size = _meta_int(meta, "lfr_window_size", 7) or 7
        lfr_window_shift = _meta_int(meta, "lfr_window_shift", 6) or 6
        normalize_samples_int = _meta_int(meta, "normalize_samples", 0) or 0

        if is_nano:
            with_itn_id = 14
            without_itn_id = 15
            lang2id: dict[str, int] = {}
            neg_mean = np.zeros(0, dtype=np.float32)
            inv_stddev = np.zeros(0, dtype=np.float32)
        else:
            with_itn_id = _meta_int(meta, "with_itn", _DEFAULT_WITH_ITN_ID) or _DEFAULT_WITH_ITN_ID
            without_itn_id = _meta_int(meta, "without_itn", _DEFAULT_WITHOUT_ITN_ID) or _DEFAULT_WITHOUT_ITN_ID
            lang2id = {}
            for lang_code, meta_key in (
                ("auto", "lang_auto"),
                ("zh", "lang_zh"),
                ("en", "lang_en"),
                ("ja", "lang_ja"),
                ("ko", "lang_ko"),
                ("yue", "lang_yue"),
            ):
                lang_id = _meta_int(meta, meta_key)
                if lang_id is not None:
                    lang2id[lang_code] = lang_id
            if not lang2id:
                lang2id = dict(_DEFAULT_LANG_IDS)
            neg_mean = _meta_float_vec(meta, "neg_mean")
            inv_stddev = _meta_float_vec(meta, "inv_stddev")

        return {
            "vocab_size": vocab_size,
            "blank_id": blank_id,
            "lfr_window_size": lfr_window_size,
            "lfr_window_shift": lfr_window_shift,
            "normalize_samples": normalize_samples_int != 0,
            "with_itn_id": with_itn_id,
            "without_itn_id": without_itn_id,
            "lang2id": lang2id,
            "neg_mean": neg_mean,
            "inv_stddev": inv_stddev,
            "is_funasr_nano": is_nano,
        }

    def _resolve_language_id(self, language: str) -> int:
        """Map a user-facing language code to the model's language id.

        Empty / ``auto`` / any unmapped string falls back to the
        ``lang_auto`` id (or 0 if the model doesn't provide one).
        """
        mapped_key = _LANGUAGE_KEY_MAP.get(language, "lang_auto")
        canonical_lang = mapped_key.removeprefix("lang_")
        lang2id: dict[str, int] = self._metadata["lang2id"]
        if canonical_lang in lang2id:
            return lang2id[canonical_lang]
        # Auto-detect fallback if the model doesn't know the requested lang.
        return lang2id.get("auto", 0)

    def _normalize_samples_if_needed(self, audio: NDArray[np.float32]) -> NDArray[np.float32]:
        """Optional per-sample scale to int16 range, per model metadata.

        Some FunASR exports declare ``normalize_samples=1`` to indicate
        the input audio should be scaled to int16 range (the model was
        trained against int16-derived FBANKs). When the flag is unset
        we pass the float32 audio through untouched.
        """
        if not self._metadata["normalize_samples"]:
            return audio
        # Scale float32 [-1, 1] → int16 amplitude range. Matches the
        # ``normalize_samples`` branch in Kaldi compute-fbank-feats.
        return (audio * 32768.0).astype(np.float32, copy=False)

    def _run_full(
        self,
        features: NDArray[np.float32],
        language_id: int,
        text_norm_id: int,
    ) -> NDArray[np.float32]:
        """Run the full SenseVoice graph with all four inputs."""
        feat = features[np.newaxis, ...]  # (1, T, mel_dim * lfr_window)
        x_length = np.array([features.shape[0]], dtype=np.int32)
        language = np.array([language_id], dtype=np.int32)
        text_norm = np.array([text_norm_id], dtype=np.int32)
        feeds = {
            self._input_names[0]: feat,
            self._input_names[1]: x_length,
            self._input_names[2]: language,
            self._input_names[3]: text_norm,
        }
        outputs = self._session.run(None, feeds)
        return np.asarray(outputs[0], dtype=np.float32)

    def _run_nano(self, features: NDArray[np.float32]) -> NDArray[np.float32]:
        """Run the FunASR Nano graph (single input: feat)."""
        feat = features[np.newaxis, ...]
        feeds = {self._input_names[0]: feat}
        outputs = self._session.run(None, feeds)
        return np.asarray(outputs[0], dtype=np.float32)

    @override
    def transcribe(
        self,
        audio: AudioArray,
        language: str = "",
        use_prompt: bool = True,
        custom_words: list[str] | None = None,
        initial_prompt_text: str | None = None,
    ) -> TranscriptionResult:
        # Decoder-bias prompts (whether from ``custom_words`` or
        # ``initial_prompt_text``) are autoregressive-decoder mechanisms;
        # SenseVoice has no analog (it's a CTC head without a decoder
        # prompt). Accepted on the signature for ITranscriber parity and
        # silently ignored — server-side rapidfuzz still cleans up.
        del custom_words, use_prompt, initial_prompt_text

        start_t = time.time()
        if audio.size == 0:
            return TranscriptionResult(text="", language=language, language_probability=0.0, duration_seconds=0.0)

        prepared = _peak_normalize(audio) if self._normalize_audio else audio
        prepared = self._normalize_samples_if_needed(prepared)

        features = _compute_fbank(prepared, self._fbanks)
        features = _apply_lfr(
            features,
            self._metadata["lfr_window_size"],
            self._metadata["lfr_window_shift"],
        )

        if features.shape[0] == 0:
            return TranscriptionResult(
                text="",
                language=language,
                language_probability=0.0,
                duration_seconds=time.time() - start_t,
            )

        is_nano: bool = self._metadata["is_funasr_nano"]
        if not is_nano and self._metadata["neg_mean"].size > 0:
            features = _apply_cmvn(features, self._metadata["neg_mean"], self._metadata["inv_stddev"])

        num_feature_frames = features.shape[0]

        if is_nano:
            logits_b = self._run_nano(features)
        else:
            language_id = self._resolve_language_id(language)
            text_norm_id = self._metadata["with_itn_id"]  # default = use ITN
            logits_b = self._run_full(features, language_id, text_norm_id)

        # logits_b shape: (1, T_out, vocab_size)
        logits = logits_b[0]
        # Full graph emits the 4 control-token rows ahead of the feature
        # frames; Nano emits one row per LFR frame with no control prefix.
        num_frames = int(logits.shape[0]) if is_nano else num_feature_frames + _NUM_CONTROL_TOKENS
        token_ids = _ctc_greedy_decode(logits, num_frames, int(self._metadata["blank_id"]))
        text = _format_result_text(token_ids, self._symbols, is_nano=is_nano)

        return TranscriptionResult(
            text=text,
            language=language,
            language_probability=0.0,
            duration_seconds=time.time() - start_t,
        )

    @override
    def is_ready(self) -> bool:
        return self._ready

    @override
    def shutdown(self) -> None:
        """Release the ORT session — ``onnxruntime`` cleans up on GC, but
        we drop the reference eagerly so the next swap doesn't pay any
        residual lifetime tax."""
        self._ready = False
        # Best-effort: ORT InferenceSession doesn't expose an explicit
        # ``close``; dropping the reference triggers C-side cleanup at GC.
        self._session = None
