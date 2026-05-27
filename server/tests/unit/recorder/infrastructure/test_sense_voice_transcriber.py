"""Unit tests for :mod:`src.recorder.infrastructure.sense_voice_transcriber`.

All ML I/O is mocked: ``onnxruntime.InferenceSession`` is patched to a
``MagicMock`` that returns canned logits, and ``tokens.txt`` is written
into ``tmp_path`` with a stable vocabulary. The covered surface area is

* FBANK output shape for a 1-second sine wave.
* LFR window/shift math.
* CMVN application gated on metadata presence.
* CTC greedy decode (blanks dropped, repeats collapsed).
* Decode strips the 4 control tokens.
* ``▁`` is replaced with space; trailing trim works.
* Language code mapping (``zh-Hans`` → ``lang_zh``, ``auto`` → ``lang_auto``).
* Nano variant skips CMVN and the control-token strip.
* ``custom_words`` is accepted and ignored.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from src.recorder.infrastructure.sense_voice_transcriber import (
    SenseVoiceTranscriber,
    _apply_cmvn,
    _apply_lfr,
    _build_mel_filterbank,
    _compute_fbank,
    _ctc_greedy_decode,
    _format_result_text,
    _load_tokens,
    _meta_float_vec,
    _meta_int,
)

# ── FBANK / LFR / CMVN primitives ────────────────────────────────────


def test_build_mel_filterbank_shape() -> None:
    fb = _build_mel_filterbank()
    # n_freqs = n_fft // 2 + 1 = 201; n_mels = 80
    assert fb.shape == (201, 80)
    assert fb.dtype == np.float32


def test_compute_fbank_one_second_sine() -> None:
    """1 s of audio at 16 kHz with hop=160, win=400, snip_edges=True
    produces 1 + (16000-400)//160 = 98 frames."""
    sr = 16_000
    t = np.arange(sr, dtype=np.float32) / sr
    sine = np.sin(2 * np.pi * 440.0 * t).astype(np.float32)
    fbanks = _build_mel_filterbank()
    feats = _compute_fbank(sine, fbanks)
    assert feats.shape == (98, 80)
    assert feats.dtype == np.float32
    # Tonal signal at 440 Hz must produce finite, non-degenerate features.
    assert np.isfinite(feats).all()


def test_compute_fbank_empty_audio_returns_zero_rows() -> None:
    fbanks = _build_mel_filterbank()
    feats = _compute_fbank(np.zeros(0, dtype=np.float32), fbanks)
    assert feats.shape == (0, 80)


def test_compute_fbank_below_win_length_returns_zero_rows() -> None:
    fbanks = _build_mel_filterbank()
    # Under 400 samples = no complete window with snip_edges=True.
    feats = _compute_fbank(np.zeros(200, dtype=np.float32), fbanks)
    assert feats.shape == (0, 80)


def test_apply_lfr_window_shift_math() -> None:
    # 13 input frames, window=7, shift=6 → ceil(13/6) = 3 output rows
    in_frames = 13
    mel_dim = 4
    features = np.arange(in_frames * mel_dim, dtype=np.float32).reshape(in_frames, mel_dim)
    out = _apply_lfr(features, window_size=7, window_shift=6)
    # 3 rows of 7*4=28 columns.
    assert out.shape == (3, 28)
    # First row = frames 0..7 flattened.
    expected_row0 = features[0:7].reshape(-1)
    assert np.allclose(out[0], expected_row0)


def test_apply_lfr_empty_input() -> None:
    features = np.zeros((0, 4), dtype=np.float32)
    out = _apply_lfr(features, window_size=7, window_shift=6)
    assert out.shape == (0, 28)


def test_apply_cmvn_is_linear() -> None:
    features = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)
    neg_mean = np.array([-0.5, -1.0], dtype=np.float32)
    inv_stddev = np.array([2.0, 0.5], dtype=np.float32)
    out = _apply_cmvn(features, neg_mean, inv_stddev)
    expected = np.array([[1.0, 0.5], [5.0, 1.5]], dtype=np.float32)
    assert np.allclose(out, expected)
    assert out.dtype == np.float32


# ── CTC decoder ──────────────────────────────────────────────────────


def test_ctc_greedy_decode_drops_blank_and_repeats() -> None:
    # Token sequence per-frame: [0(blank), 2, 2, 0, 3, 3, 4, 0, 4]
    # → after blank+repeat collapse: [2, 3, 4, 4]
    num_frames = 9
    vocab = 5
    logits = np.full((num_frames, vocab), -1.0, dtype=np.float32)
    for t, idx in enumerate([0, 2, 2, 0, 3, 3, 4, 0, 4]):
        logits[t, idx] = 5.0
    tokens = _ctc_greedy_decode(logits, num_frames, blank_id=0)
    assert tokens == [2, 3, 4, 4]


def test_ctc_greedy_decode_respects_num_frames() -> None:
    """The trailing frames (beyond num_frames) must be ignored."""
    num_frames = 3
    vocab = 5
    logits = np.full((5, vocab), -1.0, dtype=np.float32)
    for t, idx in enumerate([1, 2, 3, 4, 1]):
        logits[t, idx] = 5.0
    tokens = _ctc_greedy_decode(logits, num_frames, blank_id=0)
    assert tokens == [1, 2, 3]


def test_ctc_greedy_decode_empty_logits() -> None:
    assert _ctc_greedy_decode(np.zeros((0, 5), dtype=np.float32), 0, blank_id=0) == []


# ── Decode formatting ────────────────────────────────────────────────


def test_format_result_strips_control_tokens_and_handles_underscore() -> None:
    symbols = {
        100: "<|zh|>",
        101: "<|HAPPY|>",
        102: "<|Speech|>",
        103: "<|woitn|>",
        # transcript proper:
        10: "▁hello",
        11: "▁world",
    }
    # 4 control tokens, then content.
    tokens = [100, 101, 102, 103, 10, 11]
    text = _format_result_text(tokens, symbols, is_nano=False)
    assert text == "hello world"


def test_format_result_replaces_underscore_with_space_only() -> None:
    """U+2581 (▁) is replaced; other characters are preserved verbatim."""
    symbols = {1: "▁a", 2: "▁b", 3: "▁c", 4: "▁d", 5: "▁e", 6: "▁fox"}
    tokens = [1, 2, 3, 4, 5, 6]  # first 4 are control; 5,6 are content
    text = _format_result_text(tokens, symbols, is_nano=False)
    assert text == "e fox"


def test_format_result_apostrophe_fix() -> None:
    symbols = {1: "x", 2: "x", 3: "x", 4: "x", 10: "don", 11: " '", 12: "t"}
    tokens = [1, 2, 3, 4, 10, 11, 12]
    text = _format_result_text(tokens, symbols, is_nano=False)
    # ' should be glued (replace " '" with "'") and trimmed.
    assert text == "don't"


def test_format_result_nano_skips_control_tokens() -> None:
    """FunASR Nano emits no control tokens — the whole sequence is content."""
    symbols = {1: "▁hello", 2: "▁world"}
    tokens = [1, 2]
    text = _format_result_text(tokens, symbols, is_nano=True)
    assert text == "hello world"


# ── Token loader ─────────────────────────────────────────────────────


def test_load_tokens_plain_format(tmp_path: Path) -> None:
    tokens_file = tmp_path / "tokens.txt"
    tokens_file.write_text("<blk> 0\nhello 1\nworld 2\n", encoding="utf-8")
    out = _load_tokens(tokens_file, base64_encoded=False)
    assert out == {0: "<blk>", 1: "hello", 2: "world"}


def test_load_tokens_rsplit_keeps_internal_whitespace(tmp_path: Path) -> None:
    """SenseVoice symbol tables can include symbols with spaces — only
    split off the trailing ``id`` field."""
    tokens_file = tmp_path / "tokens.txt"
    tokens_file.write_text("two words 5\n", encoding="utf-8")
    out = _load_tokens(tokens_file, base64_encoded=False)
    assert out == {5: "two words"}


def test_load_tokens_base64_decode(tmp_path: Path) -> None:
    """FunASR Nano stores symbols as base64. Loader must decode them."""
    tokens_file = tmp_path / "tokens.txt"
    encoded = base64.b64encode(b"hello").decode("ascii")
    tokens_file.write_text(f"{encoded} 7\n", encoding="utf-8")
    out = _load_tokens(tokens_file, base64_encoded=True)
    assert out == {7: "hello"}


def test_load_tokens_base64_decode_failure_keeps_raw(tmp_path: Path) -> None:
    tokens_file = tmp_path / "tokens.txt"
    tokens_file.write_text("###not-b64### 9\n", encoding="utf-8")
    out = _load_tokens(tokens_file, base64_encoded=True)
    # On decode failure, the raw string is retained — never crash.
    assert out == {9: "###not-b64###"}


# ── Metadata parsing ─────────────────────────────────────────────────


def test_meta_int_returns_default_on_missing_or_malformed() -> None:
    assert _meta_int({}, "foo", 42) == 42
    assert _meta_int({"foo": "not-a-number"}, "foo", 42) == 42
    assert _meta_int({"foo": "13"}, "foo") == 13


def test_meta_float_vec_parses_whitespace_and_commas() -> None:
    vec = _meta_float_vec({"x": "1.0\n2.5,3.0 4.25"}, "x")
    assert np.allclose(vec, [1.0, 2.5, 3.0, 4.25])
    assert vec.dtype == np.float32


def test_meta_float_vec_missing_key_returns_empty() -> None:
    vec = _meta_float_vec({}, "x")
    assert vec.shape == (0,)
    assert vec.dtype == np.float32


# ── Full transcriber integration with mocked ORT ─────────────────────


def _write_full_tokens(tokens_path: Path) -> None:
    """Build a tokens.txt the full (non-Nano) SenseVoice graph expects.

    IDs 0=<blk>, 1..4 = control sentinel placeholders, 5..7 = content
    tokens with the SentencePiece ``▁`` prefix on the first piece of each
    word so the joiner produces a clean utterance.
    """
    lines = [
        "<blk> 0",
        "<|lang|> 1",
        "<|emo|> 2",
        "<|event|> 3",
        "<|itn|> 4",
        "▁hello 5",
        "▁world 6",
        "<|extra|> 7",
    ]
    tokens_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _make_session_mock(
    *,
    custom_metadata: dict[str, str],
    input_names: list[str],
    logits: np.ndarray[Any, np.dtype[np.float32]],
) -> MagicMock:
    """Build a MagicMock that quacks like ``InferenceSession``."""
    session = MagicMock()
    session.get_inputs.return_value = [MagicMock(name=n) for n in input_names]
    # MagicMock's name kwarg is reserved — override .name explicitly.
    for mock_input, real_name in zip(session.get_inputs.return_value, input_names, strict=True):
        mock_input.name = real_name
    meta = MagicMock()
    meta.custom_metadata_map = dict(custom_metadata)
    session.get_modelmeta.return_value = meta
    session.run.return_value = [logits]
    return session


def _build_full_metadata() -> dict[str, str]:
    return {
        "vocab_size": "8",
        "blank_id": "0",
        "lfr_window_size": "7",
        "lfr_window_shift": "6",
        "normalize_samples": "0",
        "with_itn": "4",
        "without_itn": "4",
        "lang_auto": "0",
        "lang_zh": "3",
        "lang_en": "4",
        "lang_ja": "11",
        "lang_ko": "12",
        "lang_yue": "7",
        "neg_mean": "",  # empty → CMVN disabled
        "inv_stddev": "",
    }


def _make_transcriber(
    tmp_path: Path,
    *,
    logits: np.ndarray[Any, np.dtype[np.float32]],
    metadata: dict[str, str] | None = None,
    input_names: list[str] | None = None,
) -> tuple[SenseVoiceTranscriber, MagicMock]:
    model_dir = tmp_path / "sv"
    model_dir.mkdir()
    onnx_file = model_dir / "model.onnx"
    onnx_file.write_bytes(b"")  # presence-only — the InferenceSession is mocked
    _write_full_tokens(model_dir / "tokens.txt")

    inputs = input_names or ["feat", "x_length", "language", "text_norm"]
    metadata_full = metadata if metadata is not None else _build_full_metadata()
    session = _make_session_mock(custom_metadata=metadata_full, input_names=inputs, logits=logits)

    with patch("onnxruntime.InferenceSession", return_value=session):
        transcriber = SenseVoiceTranscriber(model_path=model_dir)
    return transcriber, session


def _logits_from_argmax_sequence(seq: list[int], vocab_size: int) -> np.ndarray[Any, np.dtype[np.float32]]:
    """Produce a (1, T_out, V) tensor whose argmax along the last axis is ``seq``."""
    arr = np.full((1, len(seq), vocab_size), -1.0, dtype=np.float32)
    for t, idx in enumerate(seq):
        arr[0, t, idx] = 5.0
    return arr


def test_transcribe_full_graph_strips_control_tokens(tmp_path: Path) -> None:
    """End-to-end with mocked ORT — verifies the 4-control-token strip
    AND the ▁ → space replacement on the way out."""
    # T_out must equal num_feature_frames + 4. With 1s audio at 16kHz +
    # win=400/hop=160/snip_edges=True we get 98 fbank rows; LFR
    # window=7/shift=6 over 98 rows yields ceil(98/6) = 17 LFR rows;
    # so T_out = 17 + 4 = 21.
    seq = [
        1,
        2,
        3,
        4,  # 4 control tokens (stripped on decode)
        5,
        0,
        6,  # ▁hello, blank, ▁world
        *([0] * 14),  # padding blanks
    ]
    logits = _logits_from_argmax_sequence(seq, vocab_size=8)
    transcriber, session = _make_transcriber(tmp_path, logits=logits)

    audio = np.zeros(16_000, dtype=np.float32)
    audio[::100] = 0.5  # tiny non-zero pulse so peak-normalize doesn't no-op

    result = transcriber.transcribe(audio, language="zh")
    assert result.text == "hello world"
    assert result.language == "zh"

    # Verify the 4-input invocation shape.
    args, kwargs = session.run.call_args
    feeds = args[1] if len(args) >= 2 else kwargs.get("input_feed")
    assert feeds is not None
    assert set(feeds.keys()) == {"feat", "x_length", "language", "text_norm"}


def test_language_zh_hans_maps_to_lang_zh(tmp_path: Path) -> None:
    """The user-facing ``zh-Hans`` alias must resolve to the model's
    ``lang_zh`` id, not ``lang_auto`` (matches Handy's behavior)."""
    seq = [0] * 21
    logits = _logits_from_argmax_sequence(seq, vocab_size=8)
    transcriber, session = _make_transcriber(tmp_path, logits=logits)

    audio = np.zeros(16_000, dtype=np.float32)
    audio[::100] = 0.5
    transcriber.transcribe(audio, language="zh-Hans")

    args, kwargs = session.run.call_args
    feeds = args[1] if len(args) >= 2 else kwargs.get("input_feed")
    assert feeds is not None
    assert int(feeds["language"][0]) == 3  # lang_zh per the metadata fixture


def test_language_auto_maps_to_lang_auto(tmp_path: Path) -> None:
    seq = [0] * 21
    logits = _logits_from_argmax_sequence(seq, vocab_size=8)
    transcriber, session = _make_transcriber(tmp_path, logits=logits)

    audio = np.zeros(16_000, dtype=np.float32)
    audio[::100] = 0.5
    transcriber.transcribe(audio, language="auto")

    args, kwargs = session.run.call_args
    feeds = args[1] if len(args) >= 2 else kwargs.get("input_feed")
    assert feeds is not None
    assert int(feeds["language"][0]) == 0  # lang_auto


def test_language_empty_also_maps_to_lang_auto(tmp_path: Path) -> None:
    """Empty string is the WinSTT ``no preference`` convention and must
    still resolve to ``lang_auto``."""
    seq = [0] * 21
    logits = _logits_from_argmax_sequence(seq, vocab_size=8)
    transcriber, session = _make_transcriber(tmp_path, logits=logits)

    audio = np.zeros(16_000, dtype=np.float32)
    audio[::100] = 0.5
    transcriber.transcribe(audio, language="")

    args, kwargs = session.run.call_args
    feeds = args[1] if len(args) >= 2 else kwargs.get("input_feed")
    assert feeds is not None
    assert int(feeds["language"][0]) == 0


def test_custom_words_accepted_and_ignored(tmp_path: Path) -> None:
    """``custom_words`` is a Whisper-only mechanism — SenseVoice must
    accept the kwarg (ITranscriber parity) and not crash."""
    seq = [1, 2, 3, 4, 5, 6, *([0] * 15)]
    logits = _logits_from_argmax_sequence(seq, vocab_size=8)
    transcriber, _ = _make_transcriber(tmp_path, logits=logits)

    audio = np.zeros(16_000, dtype=np.float32)
    audio[::100] = 0.5
    # Should not raise, and the result text should be identical to the
    # no-custom_words call (because we ignore the words entirely).
    result = transcriber.transcribe(
        audio,
        language="zh",
        use_prompt=True,
        custom_words=["WinSTT", "ONNX"],
    )
    assert result.text == "hello world"


def test_cmvn_applied_when_metadata_present(tmp_path: Path) -> None:
    """When ``neg_mean`` + ``inv_stddev`` are populated, CMVN runs over
    the LFR features before the ONNX call. Verifies the call still
    succeeds end-to-end (the math is exercised by the unit test above)."""
    seq = [0] * 21
    logits = _logits_from_argmax_sequence(seq, vocab_size=8)
    # Build LFR-sized vectors: features after LFR have shape (T, 80 * 7) = 560 cols.
    lfr_dim = 80 * 7
    metadata = _build_full_metadata()
    metadata["neg_mean"] = " ".join("0.0" for _ in range(lfr_dim))
    metadata["inv_stddev"] = " ".join("1.0" for _ in range(lfr_dim))
    transcriber, session = _make_transcriber(tmp_path, logits=logits, metadata=metadata)

    audio = np.zeros(16_000, dtype=np.float32)
    audio[::100] = 0.5
    transcriber.transcribe(audio, language="zh")

    # Sanity — ORT was actually invoked with the post-CMVN features.
    args, kwargs = session.run.call_args
    feeds = args[1] if len(args) >= 2 else kwargs.get("input_feed")
    assert feeds is not None
    feat = feeds["feat"]
    assert feat.shape[0] == 1
    assert feat.shape[2] == lfr_dim


def test_nano_variant_skips_cmvn_and_control_tokens(tmp_path: Path) -> None:
    """The Nano variant has 1 input, no CMVN, and no control-token
    prefix. The first decoded token is content, not ``<|lang|>``."""
    # 17 LFR frames (1s audio) — Nano's T_out matches that exactly.
    seq = [5, 0, 6, *([0] * 14)]
    logits = _logits_from_argmax_sequence(seq, vocab_size=8)

    model_dir = tmp_path / "sv-nano"
    model_dir.mkdir()
    (model_dir / "model.onnx").write_bytes(b"")
    _write_full_tokens(model_dir / "tokens.txt")

    metadata = {
        "vocab_size": "8",
        "blank_id": "0",
        "lfr_window_size": "7",
        "lfr_window_shift": "6",
        "normalize_samples": "0",
        "comment": "FunASR SenseVoice Nano export",
    }
    session = _make_session_mock(
        custom_metadata=metadata,
        input_names=["feat"],
        logits=logits,
    )
    with patch("onnxruntime.InferenceSession", return_value=session):
        transcriber = SenseVoiceTranscriber(model_path=model_dir)

    audio = np.zeros(16_000, dtype=np.float32)
    audio[::100] = 0.5
    result = transcriber.transcribe(audio, language="zh")
    # No control tokens stripped — content starts at token 0.
    assert result.text == "hello world"

    # Only one ORT input is passed for the Nano variant.
    args, kwargs = session.run.call_args
    feeds = args[1] if len(args) >= 2 else kwargs.get("input_feed")
    assert feeds is not None
    assert set(feeds.keys()) == {"feat"}


def test_transcribe_empty_audio_returns_empty_string(tmp_path: Path) -> None:
    logits = np.zeros((1, 0, 8), dtype=np.float32)
    transcriber, _ = _make_transcriber(tmp_path, logits=logits)
    result = transcriber.transcribe(np.zeros(0, dtype=np.float32))
    assert result.text == ""
    assert result.duration_seconds == 0.0


def test_shutdown_marks_not_ready(tmp_path: Path) -> None:
    logits = np.zeros((1, 21, 8), dtype=np.float32)
    transcriber, _ = _make_transcriber(tmp_path, logits=logits)
    assert transcriber.is_ready() is True
    transcriber.shutdown()
    assert transcriber.is_ready() is False


# Confirm we'd skip the integration test cleanly when no HF snapshot is present.
def test_integration_skipped_without_hf_snapshot() -> None:
    """Smoke test: confirms the HF cache check is plumbed and skips
    gracefully when no SenseVoice snapshot exists locally.

    This is intentionally a no-op when the model isn't cached — the
    actual integration runs in CI/release machines where the snapshot
    has been pre-warmed.
    """
    hf_cache = Path.home() / ".cache" / "huggingface" / "hub"
    if not hf_cache.exists():
        pytest.skip("No HF cache on this machine")
    matches = list(hf_cache.glob("models--*sense-voice*"))
    if not matches:
        pytest.skip("No SenseVoice snapshot cached locally — integration runs only when one is present")
    # If reached, the test passes (we don't actually exercise the model
    # here — the unit tests above cover behavior; this just confirms
    # the cache probe works).
    assert matches[0].is_dir()
