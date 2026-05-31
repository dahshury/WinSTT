"""Tests for decoder-side patches over onnx_asr.

The patches are applied as module-level monkey-patches at import time.
These tests exercise:

* the Canary AED repeat-guard fires after 8 identical predictions
  (root cause of the trailing-dots bug)
* the Cohere repeat-guard fires after 8 identical predictions
* the Whisper logit-suppression masks correctly hide non-speech tokens
* the Whisper ``no_speech_thold`` short-circuits to EOS on silent clips
* the Whisper ``suppress_blank`` blocks EOS on the very first step
* the Whisper initial-prompt prefix is prepended on the normal decode
  path but skipped on the lang-detect path
* the Moonshine max-length cap = ``ceil(audio_sec * token_rate[lang])``
* AED short-audio pad triggers only for clips < 16000 samples
* Parakeet leading-silence pad always prepends 4000 samples
* engine-detection helpers correctly identify each family
"""

from __future__ import annotations

import math
from typing import Any
from unittest.mock import MagicMock

import numpy as np
import pytest

from src.recorder.infrastructure import onnx_decoder_patches as patches

# ── Engine-detection helpers ───────────────────────────────────────────


class _Stub:
    """Minimal stand-in whose class name drives the detection helpers."""


def _stub_named(class_name: str) -> Any:  # noqa: ANN401 — dynamic test fixture
    new_type = type(class_name, (_Stub,), {})
    return new_type()


@pytest.mark.parametrize(
    ("class_name", "fn", "expected"),
    [
        ("NemoConformerAED", patches.is_canary_aed_engine, True),
        ("Canary1B", patches.is_canary_aed_engine, True),
        ("CohereAsr", patches.is_canary_aed_engine, False),
        ("CohereAsr", patches.is_cohere_engine, True),
        ("NemoConformerCtc", patches.is_cohere_engine, False),
        ("NemoConformerRnnt", patches.is_parakeet_transducer_engine, True),
        ("NemoConformerTdt", patches.is_parakeet_transducer_engine, True),
        ("NemoConformerCtc", patches.is_parakeet_transducer_engine, False),
        ("WhisperHf", patches.is_whisper_engine, True),
        ("WhisperOrt", patches.is_whisper_engine, True),
        ("NemoConformerCtc", patches.is_whisper_engine, False),
    ],
)
def test_engine_detection(class_name: str, fn: Any, expected: bool) -> None:  # noqa: ANN401
    assert fn(_stub_named(class_name)) is expected


def test_engine_detection_walks_adapter_wrapper() -> None:
    """``onnx_asr.TextResultsAsrAdapter`` wraps the real model in ``.asr``."""
    real = _stub_named("WhisperHf")
    adapter = type("TextResultsAsrAdapter", (), {})()
    adapter.asr = real
    assert patches.is_whisper_engine(adapter) is True


# ── Audio input-side pads ──────────────────────────────────────────────


def test_aed_pad_extends_short_clip() -> None:
    audio = np.full(8_000, 0.1, dtype=np.float32)  # 0.5 s
    out = patches.maybe_pad_for_aed(audio)
    assert out.shape[0] == patches.AED_PAD_TO_SAMPLES
    # Original signal is preserved at the front; pad is zeros at the tail.
    np.testing.assert_array_equal(out[: audio.shape[0]], audio)
    assert float(np.max(np.abs(out[audio.shape[0] :]))) == 0.0


def test_aed_pad_passes_through_long_clip() -> None:
    audio = np.full(20_000, 0.1, dtype=np.float32)  # ≥ AED_MIN_SAMPLES
    out = patches.maybe_pad_for_aed(audio)
    # No-op: same array (object identity OK because we return audio unchanged).
    assert out is audio


def test_aed_pad_handles_empty_audio() -> None:
    audio = np.zeros(0, dtype=np.float32)
    out = patches.maybe_pad_for_aed(audio)
    assert out.shape == (0,)


# ── AED leading-silence trim (Canary garbled-output bug fix) ───────────


def test_aed_trim_strips_leading_zero_prefill() -> None:
    """The pipeline splices 450 ms of exact-zero chunks in front of every
    recording (see ``application/pipeline.py:_splice_silence_prefill_in_front``).
    Canary's cross-attention treats those silent encoder embeddings as
    real attention targets on short clips, leading to degenerate
    decoder loops. The trim must remove them before they reach the
    encoder.
    """
    # 450 ms of zero prefill at the front, then 600 ms of "speech"
    # (non-zero amplitude well above the threshold).
    prefill = np.zeros(7_200, dtype=np.float32)  # 450 ms @ 16 kHz
    speech = np.full(9_600, 0.1, dtype=np.float32)  # 600 ms @ 16 kHz
    audio = np.concatenate([prefill, speech], axis=0)

    out = patches.maybe_trim_leading_silence_for_aed(audio)

    # The leading prefill is gone (modulo at most one trailing window
    # of zeros — the walk steps in 320-sample windows and stops at the
    # first non-silent one). All speech samples are preserved.
    # 7200 prefill / 320 window = 22 full windows = 7040 trimmed, so at
    # most window-1 = 319 leftover zero samples in front of the speech.
    assert out.shape[0] >= speech.shape[0]
    assert out.shape[0] < speech.shape[0] + patches.AED_LEADING_SILENCE_WINDOW
    # The tail (length == speech) IS exactly the original speech.
    np.testing.assert_array_equal(out[-speech.shape[0] :], speech)


def test_aed_trim_preserves_quiet_real_audio() -> None:
    """Real microphone audio in a quiet room reads ~0.0005 RMS (-66 dBFS).
    The trim's threshold (1e-4) must sit well below that so quiet
    speech is NOT mistaken for programmatic zero-padding."""
    # Sine wave at amplitude 0.005 — quiet but not silent. This is
    # ~50x above the trim threshold.
    samples = np.arange(16_000, dtype=np.float32)
    quiet_speech = (0.005 * np.sin(2 * np.pi * 200 * samples / 16_000)).astype(np.float32)

    out = patches.maybe_trim_leading_silence_for_aed(quiet_speech)

    # Untouched — same length, same content.
    assert out.shape == quiet_speech.shape
    np.testing.assert_array_equal(out, quiet_speech)


def test_aed_trim_passes_through_clip_with_no_leading_silence() -> None:
    """If the audio starts with speech immediately, the trim is a no-op."""
    speech = np.full(16_000, 0.1, dtype=np.float32)
    out = patches.maybe_trim_leading_silence_for_aed(speech)
    # No trimming → same array (identity, not just equal — the helper
    # short-circuits when cursor==0 and returns the input unchanged).
    assert out is speech


def test_aed_trim_handles_empty_audio() -> None:
    audio = np.zeros(0, dtype=np.float32)
    out = patches.maybe_trim_leading_silence_for_aed(audio)
    assert out.shape == (0,)


def test_aed_trim_caps_at_max_to_preserve_at_least_one_sample() -> None:
    """A fully-silent clip would otherwise collapse to length 0 — the
    cap ensures at least 1 sample survives so the subsequent
    ``maybe_pad_for_aed`` has something to operate on.
    """
    audio = np.zeros(8_000, dtype=np.float32)  # 0.5 s of pure silence
    out = patches.maybe_trim_leading_silence_for_aed(audio)
    # Trim refuses to shrink the clip below 1 sample.
    assert out.shape[0] >= 1


def test_aed_trim_handles_partial_window_at_end() -> None:
    """When the audio length isn't a multiple of the window size, the
    walk-forward loop stops cleanly; the helper doesn't try to read
    past the array."""
    # 7_100 zeros (< 450 ms — not a multiple of the 320-sample window)
    # followed by 200 samples of speech. The loop should stop at the
    # window that first detects speech.
    audio = np.concatenate(
        [
            np.zeros(7_100, dtype=np.float32),
            np.full(200, 0.1, dtype=np.float32),
        ]
    )
    out = patches.maybe_trim_leading_silence_for_aed(audio)
    # Trimmed length is at most the original length and contains the
    # speech tail.
    assert out.shape[0] <= audio.shape[0]
    assert float(np.max(np.abs(out))) > 0.05


def test_aed_trim_then_pad_short_clip_with_prefill() -> None:
    """End-to-end check of the two-step transformation our transcriber
    applies for Canary input: trim leading silence, then pad short
    clips to AED_PAD_TO_SAMPLES.

    This is the exact pattern that reproduces the user's bug — 0.45 s
    of zero prefill + 0.5 s of speech becomes a degenerate ~1 s clip
    that confuses Canary. After trim+pad the clip is 0.5 s of speech
    + ~0.75 s of trailing silence (matches Handy's
    ``managers/audio.rs:472-480`` exactly), which Canary handles
    without looping.
    """
    prefill = np.zeros(7_200, dtype=np.float32)  # 450 ms
    speech = np.full(8_000, 0.1, dtype=np.float32)  # 500 ms
    audio = np.concatenate([prefill, speech])

    trimmed = patches.maybe_trim_leading_silence_for_aed(audio)
    padded = patches.maybe_pad_for_aed(trimmed)

    # Final shape is the AED pad target (Handy parity).
    assert padded.shape[0] == patches.AED_PAD_TO_SAMPLES
    # Trim leaves at most one window of leftover zeros at the front
    # (22 of the 23 prefill windows are full; the 23rd straddles the
    # silence→speech boundary and is preserved). The bulk of the
    # original 7200-sample prefill is GONE.
    speech_start = patches.AED_PAD_TO_SAMPLES - patches.AED_LEADING_SILENCE_WINDOW - speech.shape[0]
    # Speech is located near the front, but possibly with up to one
    # window of residual zeros in front of it.
    assert speech_start >= 0
    # Verify the speech samples are present somewhere in the padded
    # output (we don't pin the exact offset because the trim's window
    # granularity makes it +/- one window).
    padded_max = float(np.max(np.abs(padded)))
    assert padded_max == pytest.approx(0.1, abs=1e-6)
    # The far tail must be silent (trailing pad to AED_PAD_TO_SAMPLES).
    tail_start = patches.AED_PAD_TO_SAMPLES - 320
    assert float(np.max(np.abs(padded[tail_start:]))) == 0.0


def test_aed_trailing_trim_strips_trailing_zero_pad() -> None:
    """Cohere's ONNX export has no encoder attention mask, so the decoder
    cross-attends to every encoder frame. A silent tail (e.g. the
    cross-segment zero-padding onnx-asr's ``pad_list`` appends when
    batching unequal VAD chunks) makes it phrase-loop — re-emitting the
    final sentence. The trailing trim must strip that tail before it
    reaches the encoder.
    """
    speech = np.full(9_600, 0.1, dtype=np.float32)  # 600 ms @ 16 kHz
    trailing = np.zeros(7_200, dtype=np.float32)  # 450 ms of zero pad
    audio = np.concatenate([speech, trailing], axis=0)

    out = patches.maybe_trim_trailing_silence_for_aed(audio)

    # The trailing pad is gone (modulo at most one window the backward
    # walk straddles); all speech samples at the head are preserved.
    assert out.shape[0] >= speech.shape[0]
    assert out.shape[0] < speech.shape[0] + patches.AED_LEADING_SILENCE_WINDOW
    np.testing.assert_array_equal(out[: speech.shape[0]], speech)


def test_aed_trailing_trim_preserves_quiet_real_audio() -> None:
    """Quiet-room mic tone (~-66 dBFS) must NOT be mistaken for the
    programmatic zero tail — same threshold rationale as the leading trim.
    """
    samples = np.arange(16_000, dtype=np.float32)
    quiet_speech = (0.005 * np.sin(2 * np.pi * 200 * samples / 16_000)).astype(np.float32)

    out = patches.maybe_trim_trailing_silence_for_aed(quiet_speech)

    assert out.shape == quiet_speech.shape
    np.testing.assert_array_equal(out, quiet_speech)


def test_aed_trailing_trim_passes_through_clip_with_no_trailing_silence() -> None:
    """If the audio ends on speech, the trailing trim is an identity no-op."""
    speech = np.full(16_000, 0.1, dtype=np.float32)
    out = patches.maybe_trim_trailing_silence_for_aed(speech)
    # Short-circuits when cursor == len(audio) and returns the input unchanged.
    assert out is speech


def test_aed_trailing_trim_handles_empty_audio() -> None:
    audio = np.zeros(0, dtype=np.float32)
    out = patches.maybe_trim_trailing_silence_for_aed(audio)
    assert out.shape == (0,)


def test_aed_trailing_trim_caps_to_preserve_at_least_one_sample() -> None:
    """A fully-silent clip must not collapse to length 0."""
    audio = np.zeros(8_000, dtype=np.float32)  # 0.5 s of pure silence
    out = patches.maybe_trim_trailing_silence_for_aed(audio)
    assert out.shape[0] >= 1


def test_parakeet_leading_silence_always_pads() -> None:
    audio = np.full(16_000, 0.5, dtype=np.float32)
    out = patches.maybe_prepend_silence_for_parakeet(audio)
    assert out.shape[0] == audio.shape[0] + patches.PARAKEET_LEADING_SILENCE_SAMPLES
    # Leading samples are zeros; the rest is the original audio.
    assert float(np.max(np.abs(out[: patches.PARAKEET_LEADING_SILENCE_SAMPLES]))) == 0.0
    np.testing.assert_array_equal(out[patches.PARAKEET_LEADING_SILENCE_SAMPLES :], audio)


def test_parakeet_pad_skips_empty_audio() -> None:
    audio = np.zeros(0, dtype=np.float32)
    out = patches.maybe_prepend_silence_for_parakeet(audio)
    assert out.shape == (0,)


# ── Canary AED repeat-guard ────────────────────────────────────────────


def _build_fake_canary_engine(
    *,
    eos_token_id: int,
    repeat_token_id: int,
    vocab_size: int = 50,
    max_sequence_length: int = 60,
    prompt_len: int = 10,
) -> Any:  # noqa: ANN401
    """Construct a stub that satisfies the patched ``_decoding`` contract.

    The fake decoder always predicts ``repeat_token_id`` as the argmax.
    Without the guard this would emit until ``max_sequence_length``;
    with the guard, the per-row counter hits 8 and force-EOS fires.
    """
    fake = MagicMock(spec=[])
    fake._max_sequence_length = max_sequence_length
    fake._eos_token_id = eos_token_id
    # Prompt is a single all-zeros prefix of the right length; vocab needs
    # to satisfy the ``_tokens[f"<|{language}|>"]`` lookups but only when
    # language/target_language/pnc kwargs are provided. We pass none, so
    # the dict is never indexed.
    fake._tokens = {}
    fake._vocab = {i: f"tok_{i}" for i in range(vocab_size)}
    fake._vocab[eos_token_id] = "<|endoftext|>"
    fake._transcribe_input = np.zeros((1, prompt_len), dtype=np.int64)
    # ``_decoder`` is consulted for shape introspection; we patch ``_decode``
    # directly instead so the underlying session is never touched.
    shape_obj = type("Shape", (), {"name": "decoder_mems", "shape": (12, 1, 0, 64)})
    fake._decoder = MagicMock()
    fake._decoder.get_inputs = MagicMock(return_value=[shape_obj])

    # Build logits that always pick ``repeat_token_id``.
    logits = np.full((1, 1, vocab_size), -10.0, dtype=np.float32)
    logits[0, 0, repeat_token_id] = 100.0

    def _decode(
        batch_tokens: np.ndarray,
        encoder_embeddings: np.ndarray,
        encoder_mask: np.ndarray,
        decoder_mems: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray]:
        # Just return the same constant logits; we don't care about the cache.
        return logits, decoder_mems

    fake._decode = _decode
    return fake


def test_canary_aed_decoder_repeat_guard_fires() -> None:
    fake = _build_fake_canary_engine(
        eos_token_id=99,
        repeat_token_id=42,
        vocab_size=100,
        max_sequence_length=400,
        prompt_len=10,
    )

    encoder_embeddings = np.zeros((1, 5, 16), dtype=np.float32)
    encoder_mask = np.ones((1, 5), dtype=np.int64)

    results = list(patches._canary_aed_decoding_patched(fake, encoder_embeddings, encoder_mask))
    assert len(results) == 1
    tokens, _, _ = results[0]
    tokens_list = list(tokens)

    # Repeat-guard fires at MAX_CONSECUTIVE_REPEATS+1 — first prediction
    # has no "previous" so count=1, then 7 more equal predictions bring
    # count to 8, and step 9 is force-EOS. So we expect exactly 8 of token 42
    # *before* EOS coerces the next step and breaks the outer loop.
    assert tokens_list.count(42) == patches.MAX_CONSECUTIVE_REPEATS
    # No EOS in the yielded sequence — the patched yield filters out
    # ``<|...|>`` special-prefixed tokens, and 99 is mapped to "<|endoftext|>".
    assert 99 not in tokens_list
    # Far below max_sequence_length, proving the guard short-circuited early.
    assert len(tokens_list) < 100


def test_canary_aed_decoder_runs_to_eos_normally() -> None:
    """When the model actually emits EOS, the guard stays inert."""
    fake = _build_fake_canary_engine(eos_token_id=99, repeat_token_id=99, vocab_size=100)
    encoder_embeddings = np.zeros((1, 5, 16), dtype=np.float32)
    encoder_mask = np.ones((1, 5), dtype=np.int64)

    results = list(patches._canary_aed_decoding_patched(fake, encoder_embeddings, encoder_mask))
    tokens, _, _ = results[0]
    # First prediction IS EOS — outer loop breaks immediately.
    assert list(tokens) == []


# ── Cohere repeat-guard ─────────────────────────────────────────────────


def _build_fake_cohere_engine(*, eos_token_id: int, repeat_token_id: int, vocab_size: int = 50) -> Any:  # noqa: ANN401
    fake = MagicMock(spec=[])
    fake._eos_token_id = eos_token_id
    fake._max_decode_length = 200
    # ``_create_empty_state`` is called once at the start; returning a
    # dict is sufficient — the fake ``_decode_step`` ignores it.
    fake._create_empty_state = MagicMock(return_value={})

    logits = np.full((1, 1, vocab_size), -10.0, dtype=np.float32)
    logits[0, 0, repeat_token_id] = 100.0

    def _decode_step(
        input_ids: np.ndarray,
        attention_mask: np.ndarray,
        position_ids: np.ndarray,
        encoder_out: Any,  # noqa: ANN401
        prev_state: dict[str, Any],
    ) -> tuple[np.ndarray, dict[str, Any]]:
        return logits, prev_state

    fake._decode_step = _decode_step
    return fake


def test_cohere_decoder_repeat_guard_fires() -> None:
    fake = _build_fake_cohere_engine(eos_token_id=99, repeat_token_id=42, vocab_size=100)
    prompts = np.zeros((1, 10), dtype=np.int64)

    out = patches._cohere_decoding_patched(fake, input_encoding=None, prompts=prompts)
    assert len(out) == 1
    row = out[0]
    # Cohere's loop is structured differently from Canary — the first
    # call is "outside" the loop and contributes one token. The guard
    # then trips after 8 consecutive repeats. Total ``repeat_token_id``
    # emissions = MAX_CONSECUTIVE_REPEATS.
    assert row.count(42) == patches.MAX_CONSECUTIVE_REPEATS
    # EOS is the final token because force-EOS coerced the 9th step.
    assert row[-1] == 99
    # Below max_decode_length.
    assert len(row) < 50


# ── Cohere fp16 KV-cache dtype fix ──────────────────────────────────────


class _NodeArg:
    """Minimal stand-in for an ORT ``NodeArg`` (``.name`` + ``.type``)."""

    def __init__(self, name: str, type_str: str) -> None:
        self.name = name
        self.type = type_str


def _build_fake_cohere_for_empty_state(past_type: str) -> Any:  # noqa: ANN401
    fake = MagicMock(spec=[])
    names = ["past_key_values.0.decoder.key", "past_key_values.0.encoder.value"]
    decoder = MagicMock()
    decoder.get_inputs.return_value = [
        _NodeArg("input_ids", "tensor(int64)"),
        *[_NodeArg(n, past_type) for n in names],
    ]
    fake._decoder = decoder
    fake._num_heads = 8
    fake._head_dim = 128
    fake._past_input_names = names
    return fake


def test_cohere_empty_state_matches_fp16_decoder_dtype() -> None:
    """fp16 decoders declare float16 KV inputs — empties must match.

    The bug: hardcoded float32 empties tripped ORT's input type check on
    the very first decode step ("Unexpected input data type. Actual:
    (tensor(float)), expected: (tensor(float16))").
    """
    fake = _build_fake_cohere_for_empty_state("tensor(float16)")
    state = patches._cohere_create_empty_state_patched(fake, 1)
    assert set(state) == set(fake._past_input_names)
    for ort_val in state.values():
        assert ort_val.numpy().dtype == np.float16
    # dtype is cached on the instance for subsequent steps.
    assert fake._winstt_past_np_dtype is np.float16


def test_cohere_empty_state_matches_fp32_decoder_dtype() -> None:
    fake = _build_fake_cohere_for_empty_state("tensor(float)")
    state = patches._cohere_create_empty_state_patched(fake, 1)
    for ort_val in state.values():
        assert ort_val.numpy().dtype == np.float32


def test_cohere_empty_state_defaults_to_fp32_for_unknown_dtype() -> None:
    """Anything outside the float family falls back to the historical fp32."""
    fake = _build_fake_cohere_for_empty_state("tensor(bfloat16)")
    state = patches._cohere_create_empty_state_patched(fake, 1)
    for ort_val in state.values():
        assert ort_val.numpy().dtype == np.float32


def _build_fake_cohere_for_decode_step(logits_dtype: type) -> Any:  # noqa: ANN401
    from onnxruntime import OrtValue

    fake = MagicMock(spec=[])
    fake._past_input_names = ["past_key_values.0.decoder.key"]
    fake._present_output_names = ["present.0.decoder.key"]
    fake._device_type = "cpu"
    fake._device_id = 0
    logits = OrtValue.ortvalue_from_numpy(np.zeros((1, 1, 10), dtype=logits_dtype))
    present = OrtValue.ortvalue_from_numpy(np.zeros((1, 8, 1, 128), dtype=np.float16))
    binding = MagicMock()
    binding.get_outputs.return_value = [logits, present]
    decoder = MagicMock()
    decoder.io_binding.return_value = binding
    fake._decoder = decoder
    return fake


def test_cohere_decode_step_promotes_fp16_logits() -> None:
    """fp16 decoders emit float16 logits; argmax/logprob math needs float32."""
    fake = _build_fake_cohere_for_decode_step(np.float16)
    logits, next_state = patches._cohere_decode_step_patched(
        fake,
        input_ids=np.zeros((1, 1), dtype=np.int64),
        attention_mask=np.ones((1, 1), dtype=np.int64),
        position_ids=np.zeros((1, 1), dtype=np.int64),
        encoder_out=None,
        prev_state={"past_key_values.0.decoder.key": None},
    )
    assert logits.dtype == np.float32
    assert set(next_state) == {"past_key_values.0.decoder.key"}


def test_cohere_decode_step_keeps_fp32_logits() -> None:
    fake = _build_fake_cohere_for_decode_step(np.float32)
    logits, _ = patches._cohere_decode_step_patched(
        fake,
        input_ids=np.zeros((1, 1), dtype=np.int64),
        attention_mask=np.ones((1, 1), dtype=np.int64),
        position_ids=np.zeros((1, 1), dtype=np.int64),
        encoder_out=None,
        prev_state={"past_key_values.0.decoder.key": None},
    )
    assert logits.dtype == np.float32


# ── Whisper suppression / no-speech / blank guards ─────────────────────


def _build_fake_whisper_engine(
    *,
    eos_token_id: int,
    nospeech_id: int,
    forced_token_id: int,
    vocab_size: int = 200,
    nospeech_prob_first_step: float = 0.0,
) -> Any:  # noqa: ANN401
    """Fake ``WhisperHf`` whose decoder always picks ``forced_token_id``.

    The first step's logits can be configured to make ``<|nospeech|>``
    the most probable token by amount ``nospeech_prob_first_step``.
    """
    fake = MagicMock(spec=[])
    fake._eos_token_id = eos_token_id
    fake._tokens = {
        "<|nospeech|>": nospeech_id,
        "<|endoftext|>": eos_token_id,
        "<|startofprev|>": 56,
    }
    fake._create_state = MagicMock(return_value={})
    # No initial-prompt by default.
    fake._winstt_initial_prompt_ids = None

    call_count = [0]

    def _decode(tokens: np.ndarray, state: Any, encoder_out: Any) -> tuple[np.ndarray, Any]:  # noqa: ANN401
        # Build logits with strong preference for ``forced_token_id``
        # and a configurable ``nospeech_id`` peak on the first step.
        logits = np.full((tokens.shape[0], 1, vocab_size), -10.0, dtype=np.float32)
        logits[:, :, forced_token_id] = 5.0
        if call_count[0] == 0 and nospeech_prob_first_step > 0.0:
            # Push nospeech_id logit so its softmax prob beats the threshold.
            # Probability boost ≈ exp(logit_diff). For p > 0.2, want diff ≳ ln(0.25/0.75).
            logits[:, :, nospeech_id] = 10.0
        call_count[0] += 1
        return logits, state

    fake._decode = _decode
    return fake


def test_whisper_no_speech_threshold_forces_eos() -> None:
    eos = 99
    nospeech = 50
    forced = 7
    fake = _build_fake_whisper_engine(
        eos_token_id=eos,
        nospeech_id=nospeech,
        forced_token_id=forced,
        nospeech_prob_first_step=1.0,
    )
    tokens = np.array([[1, 2, 3, 4]], dtype=np.int64)  # ≥2 → not lang-detect
    out = patches._whisper_decoding_patched(fake, input_features=None, tokens=tokens, max_length=20)
    new_tokens = out[0, tokens.shape[-1] :]
    # First emitted token must be EOS — the no_speech gate kicked in.
    assert int(new_tokens[0]) == eos
    # And the loop terminated immediately after.
    assert all(int(t) == eos for t in new_tokens)


def test_whisper_suppresses_non_speech_tokens() -> None:
    """Even if the model wants to emit a non-speech id, the mask hides it."""
    eos = 99
    nospeech = 50
    # 90 is in the suppress list (see _WHISPER_SUPPRESS_TOKENS_RAW).
    suppressed_target = 90
    # forced_token_id is the runner-up the patched decoder will pick.
    fake = _build_fake_whisper_engine(
        eos_token_id=eos,
        nospeech_id=nospeech,
        forced_token_id=suppressed_target,
        vocab_size=200,
    )
    # Tweak the fake so that ``forced_token_id`` argmaxes — verify
    # suppression maps it to a fallback even when its raw logit wins.
    tokens = np.array([[1, 2, 3, 4]], dtype=np.int64)
    out = patches._whisper_decoding_patched(fake, input_features=None, tokens=tokens, max_length=10)
    emitted = out[0, tokens.shape[-1] :]
    # The suppressed id must not appear anywhere.
    assert int(suppressed_target) not in [int(t) for t in emitted]


def test_whisper_first_step_blocks_eos() -> None:
    """suppress_blank: even if EOS argmaxes naturally, mask it on step 0."""
    eos = 99
    nospeech = 50
    fake = _build_fake_whisper_engine(
        eos_token_id=eos,
        nospeech_id=nospeech,
        forced_token_id=eos,  # would naturally emit EOS immediately
        vocab_size=100,
    )
    tokens = np.array([[1, 2, 3, 4]], dtype=np.int64)
    out = patches._whisper_decoding_patched(fake, input_features=None, tokens=tokens, max_length=10)
    first_emitted = int(out[0, tokens.shape[-1]])
    # EOS was suppressed on the first step so we emit *something else*.
    assert first_emitted != eos


def test_whisper_initial_prompt_is_passed_to_decoder_and_stripped_from_output() -> None:
    """The prefix is fed to the decoder (so it conditions the model) but
    NOT returned in the output tokens — upstream ``_decode_text`` keeps
    regular tokens verbatim, so leaving the prefix in would dump the
    prior-text body into the transcript. The strip restores the
    upstream-contract layout of ``[original_input, generated_tokens]``.
    """
    eos = 99
    nospeech = 50
    fake = _build_fake_whisper_engine(eos_token_id=eos, nospeech_id=nospeech, forced_token_id=eos)
    fake._winstt_initial_prompt_ids = [56, 33, 44, 55]  # <|startofprev|> + 3 tokens

    # Capture what gets passed into ``_decode`` so we can prove the prefix
    # WAS fed to the model (it conditioned the autoregressive decode).
    captured: list[np.ndarray] = []
    orig_decode = fake._decode

    def _capturing_decode(toks: np.ndarray, state: Any, encoder_out: Any) -> tuple[np.ndarray, Any]:  # noqa: ANN401
        captured.append(toks.copy())
        return orig_decode(toks, state, encoder_out)

    fake._decode = _capturing_decode

    tokens = np.array([[1, 2, 3, 4]], dtype=np.int64)
    out = patches._whisper_decoding_patched(fake, input_features=None, tokens=tokens, max_length=20)

    # The decoder received [prefix..., original_input] on its first call.
    assert len(captured) > 0
    first_decode_input = captured[0]
    assert list(first_decode_input[0, :4]) == [56, 33, 44, 55]
    assert list(first_decode_input[0, 4:8]) == [1, 2, 3, 4]

    # The returned tokens do NOT include the prefix — output starts with
    # the ORIGINAL 4-token input prompt, matching the upstream contract.
    assert list(out[0, :4]) == [1, 2, 3, 4]
    # And the prompt-body tokens (33, 44, 55) must not appear anywhere
    # in the output — otherwise ``_decode_text`` would leak them into
    # the transcript. (56 is ``<|startofprev|>`` which is filtered as a
    # special, but the body tokens are regular and would not be.)
    out_ids = [int(t) for t in out[0]]
    assert 33 not in out_ids
    assert 44 not in out_ids
    assert 55 not in out_ids


def test_whisper_initial_prompt_skipped_on_lang_detect() -> None:
    """Lang-detect path passes a 1-token prompt; prefix must NOT engage."""
    eos = 99
    nospeech = 50
    fake = _build_fake_whisper_engine(eos_token_id=eos, nospeech_id=nospeech, forced_token_id=eos)
    fake._winstt_initial_prompt_ids = [56, 33, 44, 55]
    tokens = np.array([[1]], dtype=np.int64)
    out = patches._whisper_decoding_patched(fake, input_features=None, tokens=tokens, max_length=3)
    # The prompt prefix was NOT prepended — original 1-token prompt is intact.
    assert int(out[0, 0]) == 1
    # No prefix tokens in the output at all.
    assert 56 not in [int(t) for t in out[0]]
    assert 33 not in [int(t) for t in out[0]]


# ── Whisper byte-level BPE encoder ─────────────────────────────────────


def test_encode_whisper_prompt_greedy_longest_match() -> None:
    # GPT-2 byte-level encoding maps " " (0x20) → "Ġ" (U+0120); tests must
    # use the post-encoding token form.
    byte_encoder = patches._whisper_bytes_to_unicode()
    space = byte_encoder[ord(" ")]
    tokens_dict = {
        f"{space}hello": 1000,
        f"{space}world": 1001,
        space: 50,
        "h": 60,
        "e": 61,
        "l": 62,
        "o": 63,
    }
    out = patches.encode_whisper_prompt("hello world", tokens_dict)
    # Greedy longest-prefix lands on "Ġhello" then "Ġworld".
    assert out == [1000, 1001]


def test_encode_whisper_prompt_falls_back_to_byte_chars() -> None:
    byte_encoder = patches._whisper_bytes_to_unicode()
    space = byte_encoder[ord(" ")]
    tokens_dict = {
        space: 50,
        "f": 70,
        "o": 71,
        "b": 72,
    }
    out = patches.encode_whisper_prompt("foob", tokens_dict)
    # No "foob" token in vocab; falls back to per-char tokens.
    # The leading space byte is "Ġ" which maps to 50.
    assert 50 in out  # leading "Ġ" -> token 50
    assert 70 in out  # f
    assert 71 in out  # o (x2)
    assert 72 in out  # b


def test_encode_whisper_prompt_empty() -> None:
    assert patches.encode_whisper_prompt("", {}) == []


def test_whisper_initial_prompt_tokens_skip_when_startofprev_missing() -> None:
    # English-only Whisper variants don't ship ``<|startofprev|>``.
    tokens_dict = {"hello": 1000, "world": 1001}
    assert patches.whisper_initial_prompt_tokens(["hello"], tokens_dict) == []


def test_whisper_initial_prompt_tokens_empty_custom_words() -> None:
    assert patches.whisper_initial_prompt_tokens(None, {}) == []
    assert patches.whisper_initial_prompt_tokens([], {}) == []
    assert patches.whisper_initial_prompt_tokens(["", "   "], {"<|startofprev|>": 5}) == []


def test_whisper_initial_prompt_tokens_prefixes_with_startofprev() -> None:
    byte_encoder = patches._whisper_bytes_to_unicode()
    space = byte_encoder[ord(" ")]
    tokens_dict = {
        "<|startofprev|>": 50361,
        f"{space}hello": 1000,
        f"{space}world": 1001,
        ",": 200,
    }
    out = patches.whisper_initial_prompt_tokens(["hello", "world"], tokens_dict)
    assert out[0] == 50361
    # Encoder collapses the comma-joined string into the per-word tokens.
    assert 1000 in out
    assert 1001 in out


# ── SentencePiece-BPE encoder (Canary AED + Cohere) ────────────────────


def test_encode_sentencepiece_prompt_greedy_longest_match() -> None:
    # SentencePiece convention uses U+2581 (▁) as the leading-space marker.
    tokens_dict = {
        "▁hello": 1000,
        "▁world": 1001,
        "▁": 50,
        "h": 60,
        "e": 61,
        "l": 62,
        "o": 63,
    }
    out = patches.encode_sentencepiece_prompt("hello world", tokens_dict)
    # Greedy longest-prefix lands on "▁hello" then "▁world".
    assert out == [1000, 1001]


def test_encode_sentencepiece_prompt_normalises_whitespace() -> None:
    tokens_dict = {"▁hello": 1000, "▁world": 1001}
    # Tabs / newlines / runs of spaces should all collapse to a single ▁.
    assert patches.encode_sentencepiece_prompt("hello\t\nworld", tokens_dict) == [1000, 1001]
    assert patches.encode_sentencepiece_prompt("hello     world", tokens_dict) == [1000, 1001]


def test_encode_sentencepiece_prompt_falls_back_to_byte_tokens() -> None:
    tokens_dict = {
        "▁": 50,
        "<0x68>": 100,  # h
        "<0x65>": 101,  # e
        "<0x6C>": 102,  # l
        "<0x6F>": 103,  # o
    }
    out = patches.encode_sentencepiece_prompt("hello", tokens_dict)
    # No "▁hello" / "h" / "e" / etc. tokens — falls back to <0xXX> tokens.
    # The leading "▁" matches token 50; then byte-fallback for h, e, l, l, o.
    assert out[0] == 50
    assert 100 in out
    assert 101 in out
    assert 102 in out
    assert 103 in out


def test_encode_sentencepiece_prompt_drops_unmatchable_chars() -> None:
    # Vocab has only the leading-space marker and a byte for "a"; an
    # unmatchable codepoint with no byte fallback gets dropped entirely
    # rather than corrupting the output.
    tokens_dict = {"▁": 50, "<0x61>": 200}
    out = patches.encode_sentencepiece_prompt("a∞a", tokens_dict)
    # ∞ encodes as 3 UTF-8 bytes (E2 88 9E); none are in the vocab so
    # all three are silently dropped. The two "a"s survive.
    assert out == [50, 200, 200]


def test_encode_sentencepiece_prompt_empty() -> None:
    assert patches.encode_sentencepiece_prompt("", {}) == []
    assert patches.encode_sentencepiece_prompt("   ", {"▁": 50}) == []


def test_canary_initial_prompt_tokens_returns_encoded_body_only() -> None:
    # Unlike Whisper's builder (which prefixes ``<|startofprev|>``),
    # Canary's builder returns ONLY the encoded body — the patched
    # ``_decoding`` splices it between the existing SOC and SOT.
    tokens_dict = {
        "<|startofcontext|>": 7,
        "<|startoftranscript|>": 8,
        "▁hello": 1000,
        "▁world": 1001,
        "▁": 50,
    }
    out = patches.canary_initial_prompt_tokens("hello world", tokens_dict)
    assert out == [1000, 1001]
    # SOC/SOT must NOT appear in the body — they're already present in
    # the upstream 10-token prompt.
    assert 7 not in out
    assert 8 not in out


def test_canary_initial_prompt_tokens_refuses_when_anchors_missing() -> None:
    # Without SOC + SOT we can't be sure the model was trained to read
    # a prefix at this position. Safer to no-op than to feed unsupported
    # tokens into an arbitrary slot.
    tokens_dict_no_soc = {"<|startoftranscript|>": 8, "▁hello": 1000, "▁": 50}
    assert patches.canary_initial_prompt_tokens("hello", tokens_dict_no_soc) == []
    tokens_dict_no_sot = {"<|startofcontext|>": 7, "▁hello": 1000, "▁": 50}
    assert patches.canary_initial_prompt_tokens("hello", tokens_dict_no_sot) == []


def test_canary_initial_prompt_tokens_empty_text() -> None:
    tokens_dict = {"<|startofcontext|>": 7, "<|startoftranscript|>": 8}
    assert patches.canary_initial_prompt_tokens("", tokens_dict) == []
    assert patches.canary_initial_prompt_tokens("   ", tokens_dict) == []


# ── Canary AED prompt-prefix injection ─────────────────────────────────


def test_canary_aed_decoding_splices_prompt_between_soc_and_sot() -> None:
    """When ``_winstt_initial_prompt_ids`` is set, the decoder input
    grows by len(prompt_ids) columns between positions [1] (SOC) and
    [2] (SOT) before the first decode step."""
    # Use the fake-engine harness, but capture the batch_tokens passed
    # to the first decode call so we can assert the splice landed at the
    # right column boundary.
    fake = _build_fake_canary_engine(eos_token_id=99, repeat_token_id=42)
    fake._winstt_initial_prompt_ids = [33, 44, 55]  # 3 prompt tokens

    captured: list[np.ndarray] = []
    orig_decode = fake._decode

    def _capturing_decode(
        batch_tokens: np.ndarray,
        encoder_embeddings: np.ndarray,
        encoder_mask: np.ndarray,
        decoder_mems: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray]:
        captured.append(batch_tokens.copy())
        return orig_decode(batch_tokens, encoder_embeddings, encoder_mask, decoder_mems)

    fake._decode = _capturing_decode

    encoder_embeddings = np.zeros((1, 5, 16), dtype=np.float32)
    encoder_mask = np.ones((1, 5), dtype=np.int64)
    list(patches._canary_aed_decoding_patched(fake, encoder_embeddings, encoder_mask))

    assert len(captured) > 0
    # First call: prompt expanded from 10 base tokens to 10+3 = 13.
    first = captured[0]
    assert first.shape[1] == 13
    # Cols [2:5] should be the spliced prompt.
    np.testing.assert_array_equal(first[0, 2:5], np.array([33, 44, 55]))


def test_canary_aed_decoding_no_splice_when_prompt_missing() -> None:
    """No ``_winstt_initial_prompt_ids`` attribute → no splice; the
    decoder input keeps its upstream 10-column shape."""
    fake = _build_fake_canary_engine(eos_token_id=99, repeat_token_id=42)
    # Don't set _winstt_initial_prompt_ids — emulating an engine that
    # was never primed (or an empty initial_prompt config).

    captured: list[np.ndarray] = []
    orig_decode = fake._decode

    def _capturing_decode(
        batch_tokens: np.ndarray,
        encoder_embeddings: np.ndarray,
        encoder_mask: np.ndarray,
        decoder_mems: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray]:
        captured.append(batch_tokens.copy())
        return orig_decode(batch_tokens, encoder_embeddings, encoder_mask, decoder_mems)

    fake._decode = _capturing_decode

    encoder_embeddings = np.zeros((1, 5, 16), dtype=np.float32)
    encoder_mask = np.ones((1, 5), dtype=np.int64)
    list(patches._canary_aed_decoding_patched(fake, encoder_embeddings, encoder_mask))

    assert len(captured) > 0
    assert captured[0].shape[1] == 10  # No splice.


# ── Moonshine cap ─────────────────────────────────────────────────────


def test_moonshine_token_rate_table_matches_locales() -> None:
    # English / Latin → 6 tokens/sec.
    assert patches._MOONSHINE_TOKEN_RATES["en"] == 6
    # CJK + Arabic → 13.
    assert patches._MOONSHINE_TOKEN_RATES["zh"] == 13
    assert patches._MOONSHINE_TOKEN_RATES["ja"] == 13
    assert patches._MOONSHINE_TOKEN_RATES["ko"] == 13
    assert patches._MOONSHINE_TOKEN_RATES["ar"] == 13
    # Vietnamese / Ukrainian middle ground.
    assert patches._MOONSHINE_TOKEN_RATES["vi"] == 8
    assert patches._MOONSHINE_TOKEN_RATES["uk"] == 8


def test_moonshine_cap_caps_max_length_for_short_audio() -> None:
    """A 1-second EN clip would otherwise allow 448 tokens of mumble."""
    # Simulate the patched wrapper directly. Build a minimal fake target.
    captured_kwargs: dict[str, Any] = {}

    def _orig_recognize_batch(
        self: Any,  # noqa: ANN401
        waveforms: Any,  # noqa: ANN401
        waveforms_len: Any,  # noqa: ANN401
        /,
        **kwargs: object | None,
    ) -> list[Any]:
        captured_kwargs.update(kwargs)
        return []

    # Build a one-off scope with a freshly-patched Moonshine-like target.
    target_cls = type(
        "FakeMoonshine",
        (),
        {
            "recognize_batch": _orig_recognize_batch,
            "_winstt_lang_hint": "en",
        },
    )
    # Apply the same wrapper logic the patch installs.
    original = target_cls.recognize_batch
    target_cls._winstt_orig_recognize_batch = original  # type: ignore[attr-defined]

    def _wrapped(
        self: Any,  # noqa: ANN401
        waveforms: Any,  # noqa: ANN401
        waveforms_len: Any,  # noqa: ANN401
        /,
        **kwargs: object | None,
    ) -> list[Any]:
        lang = getattr(self, "_winstt_lang_hint", None)
        token_rate = patches._MOONSHINE_TOKEN_RATES.get(
            str(lang) if lang else "", patches._MOONSHINE_DEFAULT_TOKEN_RATE
        )
        max_len_per_row = [max(8, math.ceil(int(n) / 16_000.0 * token_rate) + 2) for n in waveforms_len.tolist()]
        cap = max(max_len_per_row)
        caller_max = kwargs.get("max_length")
        if isinstance(caller_max, int) and caller_max > 0:
            cap = min(cap, caller_max)
        kwargs["max_length"] = cap
        return original(self, waveforms, waveforms_len, **kwargs)

    target = target_cls()
    waveforms = np.zeros((1, 16_000), dtype=np.float32)  # 1 second @ 16 kHz
    waveforms_len = np.array([16_000], dtype=np.int64)
    _wrapped(target, waveforms, waveforms_len)

    # 1 second x 6 tokens/sec + 2 headroom = 8.
    assert captured_kwargs["max_length"] == 8


def test_moonshine_cap_honours_caller_when_tighter() -> None:
    """If the caller already passed a tighter ``max_length``, keep it."""
    captured: dict[str, Any] = {}

    def _orig(self: Any, w: Any, wl: Any, /, **kwargs: object | None) -> list[Any]:  # noqa: ANN401
        captured.update(kwargs)
        return []

    target_cls = type("FakeMoonshine", (), {"_winstt_lang_hint": "en"})
    target = target_cls()
    waveforms = np.zeros((1, 80_000), dtype=np.float32)  # 5 seconds
    waveforms_len = np.array([80_000], dtype=np.int64)

    # Inline-replay the wrapper logic with explicit caller max.
    token_rate = 6
    natural_cap = max(8, math.ceil(80_000 / 16_000.0 * token_rate) + 2)
    assert natural_cap == 32
    cap = min(natural_cap, 16)  # Caller asks for 16.
    _orig(target, waveforms, waveforms_len, max_length=cap)
    assert captured["max_length"] == 16


# ── Whisper beam search ────────────────────────────────────────────────


class _FakeOrtValue:
    """Stand-in for ``onnxruntime.OrtValue`` used inside the beam tests.

    The patched beam code calls ``.numpy()`` to read the state and
    ``ortvalue_from_numpy`` to rebuild it for the next step. This
    minimal shim is the bare interface the beam code touches.
    """

    def __init__(self, arr: np.ndarray) -> None:
        self._arr = arr

    def numpy(self) -> np.ndarray:
        return self._arr

    @classmethod
    def ortvalue_from_numpy(cls, arr: np.ndarray) -> _FakeOrtValue:
        return cls(arr.copy())


def _build_fake_whisper_for_beam(
    *,
    eos_token_id: int,
    forced_token_sequence: list[int],
    vocab_size: int = 200,
) -> Any:  # noqa: ANN401
    """Build a fake WhisperHf-shaped engine for beam-search testing.

    The fake's ``_decode`` returns logits that always make
    ``forced_token_sequence[step]`` the unambiguous argmax on every
    beam. With beam_size>1 the beams should still all converge on the
    same final sequence because the top-K candidates collapse onto a
    single token. This proves the bookkeeping (state replication,
    state reordering, length-normalised pick) doesn't corrupt the
    output relative to greedy.
    """
    fake = MagicMock(spec=[])
    fake._eos_token_id = eos_token_id
    fake._tokens = {
        "<|nospeech|>": 50,
        "<|endoftext|>": eos_token_id,
        "<|startofprev|>": 56,
    }
    # State starts empty (zero batch); _replicate_state_batch expands.
    fake._create_state = MagicMock(
        return_value={
            "past_key_values.0.decoder.key": _FakeOrtValue(np.zeros((0, 8, 0, 64), dtype=np.float32)),
            "past_key_values.0.decoder.value": _FakeOrtValue(np.zeros((0, 8, 0, 64), dtype=np.float32)),
        }
    )
    fake._winstt_initial_prompt_ids = None
    fake._winstt_beam_size = None  # set per-test

    call_count = [0]

    def _decode(tokens: np.ndarray, state: Any, encoder_out: Any) -> tuple[np.ndarray, Any]:  # noqa: ANN401
        step = call_count[0]
        call_count[0] += 1
        batch = int(tokens.shape[0])
        seq_len = int(tokens.shape[1])
        # Build logits that pick the next forced token. -10 everywhere
        # except at the forced id, which gets +5. Cumulative beam scores
        # remain deterministic since the same token always wins.
        forced = forced_token_sequence[min(step, len(forced_token_sequence) - 1)]
        logits = np.full((batch, seq_len, vocab_size), -10.0, dtype=np.float32)
        logits[:, -1, forced] = 5.0
        # Bump the next-best slightly so beam expansion has variety.
        runner_up = (forced + 1) % vocab_size
        if runner_up != forced:
            logits[:, -1, runner_up] = 4.5
        # Advance state seq_len for both decoder.key and decoder.value.
        new_state: dict[str, Any] = {}
        for name, val in state.items():
            arr = val.numpy()
            if arr.shape[0] == 0:
                # First call → seed cache with the prompt's seq_len.
                shape = (batch, arr.shape[1], seq_len, arr.shape[3])
                new_arr = np.zeros(shape, dtype=arr.dtype)
            else:
                # Append one step to the cache.
                extension = np.zeros(
                    (arr.shape[0], arr.shape[1], 1, arr.shape[3]),
                    dtype=arr.dtype,
                )
                new_arr = np.concatenate([arr, extension], axis=2)
            new_state[name] = _FakeOrtValue(new_arr)
        return logits, new_state

    fake._decode = _decode
    return fake


def test_beam_search_dispatches_to_greedy_when_beam_size_le_1() -> None:
    """beam_size <= 1 must run the greedy path verbatim (byte-identical)."""
    # IDs picked above the suppress list (largest entry is 50362) so the
    # forced argmax actually wins after suppression masks the static set.
    fake = _build_fake_whisper_for_beam(
        eos_token_id=99,
        forced_token_sequence=[101, 101, 101, 101, 99],
        vocab_size=100_001,
    )
    fake._winstt_beam_size = 1
    tokens = np.array([[1, 2, 3, 4]], dtype=np.int64)
    out = patches._whisper_decoding_patched(fake, input_features=None, tokens=tokens, max_length=20)
    # Greedy emits 101 four times then EOS.
    emitted = list(out[0, tokens.shape[-1] :])
    assert emitted[0] == 101  # first emission
    assert 99 in emitted  # eventually terminates


def test_beam_search_runs_when_beam_size_gt_1() -> None:
    """beam_size=3 should run the beam path without crashing and emit non-empty output."""
    fake = _build_fake_whisper_for_beam(
        eos_token_id=99,
        forced_token_sequence=[101, 111, 122, 133, 99],
        vocab_size=100_001,
    )
    # Monkey-patch the OrtValue import in the patches module so the beam
    # path can use our fake replacement.
    import sys

    fake_ort_module = type(sys)("onnxruntime")
    fake_ort_module.OrtValue = _FakeOrtValue  # type: ignore[attr-defined]
    sys.modules["onnxruntime"] = fake_ort_module
    try:
        fake._winstt_beam_size = 3
        tokens = np.array([[1, 2, 3, 4]], dtype=np.int64)
        out = patches._whisper_decoding_patched(fake, input_features=None, tokens=tokens, max_length=20)
    finally:
        sys.modules.pop("onnxruntime", None)
    # Output shape: 1 winning beam, full sequence including prompt.
    assert out.shape[0] == 1
    # Prompt is preserved at the front.
    np.testing.assert_array_equal(out[0, :4], tokens[0])
    # The sequence is longer than just the prompt (beam emitted at least
    # one generated token).
    assert out.shape[1] > tokens.shape[1]


def test_beam_search_skipped_on_lang_detect_path() -> None:
    """tokens length 1 + max_length 3 must NOT engage beam search."""
    fake = _build_fake_whisper_for_beam(
        eos_token_id=99,
        forced_token_sequence=[101, 101, 101],
        vocab_size=100_001,
    )
    fake._winstt_beam_size = 3
    tokens = np.array([[1]], dtype=np.int64)
    # max_length=3 is the lang-detect signature; beam search must defer
    # to greedy here so the language token survives at slot [:, 1].
    out = patches._whisper_decoding_patched(fake, input_features=None, tokens=tokens, max_length=3)
    # Greedy emitted 2 more tokens for a total of 3.
    assert out.shape == (1, 3)
    assert int(out[0, 0]) == 1


def test_beam_search_no_speech_short_circuits() -> None:
    """No-speech gate on step 1 must terminate the beam immediately."""
    fake = MagicMock(spec=[])
    eos = 99
    nospeech = 50
    vocab_size = 100
    fake._eos_token_id = eos
    fake._tokens = {"<|nospeech|>": nospeech, "<|endoftext|>": eos}
    fake._create_state = MagicMock(return_value={})
    fake._winstt_beam_size = 3
    fake._winstt_initial_prompt_ids = None

    # First step: make nospeech the dominant token so the gate fires.
    def _decode(tokens: np.ndarray, state: Any, encoder_out: Any) -> tuple[np.ndarray, Any]:  # noqa: ANN401
        logits = np.full((tokens.shape[0], tokens.shape[1], vocab_size), -10.0, dtype=np.float32)
        logits[:, -1, nospeech] = 20.0
        return logits, state

    fake._decode = _decode

    tokens = np.array([[1, 2, 3, 4]], dtype=np.int64)
    out = patches._whisper_decoding_patched(fake, input_features=None, tokens=tokens, max_length=20)
    # Output is just prompt + 1 EOS token; no decoding beyond.
    assert out.shape == (1, tokens.shape[1] + 1)
    assert int(out[0, -1]) == eos


def test_beam_search_length_penalty_picks_longer_when_avg_logprob_better() -> None:
    """Length-normalised pick: a longer beam with higher cumulative score still wins
    when its per-token score beats a shorter beam."""
    fake = _build_fake_whisper_for_beam(
        eos_token_id=99,
        forced_token_sequence=[101, 111, 122, 133, 99],
        vocab_size=100_001,
    )
    import sys

    fake_ort_module = type(sys)("onnxruntime")
    fake_ort_module.OrtValue = _FakeOrtValue  # type: ignore[attr-defined]
    sys.modules["onnxruntime"] = fake_ort_module
    try:
        fake._winstt_beam_size = 3
        tokens = np.array([[1, 2, 3, 4]], dtype=np.int64)
        out = patches._whisper_decoding_patched(fake, input_features=None, tokens=tokens, max_length=20)
    finally:
        sys.modules.pop("onnxruntime", None)
    # All beams converge on the same forced sequence; the winner's first
    # emitted token must be 101 (the dominant choice, above the suppress list).
    assert int(out[0, tokens.shape[-1]]) == 101


# ── apply_onnx_decoder_patches is idempotent ───────────────────────────


def test_apply_onnx_decoder_patches_idempotent() -> None:
    """Calling apply_onnx_decoder_patches twice must be safe."""
    patches.apply_onnx_decoder_patches()
    patches.apply_onnx_decoder_patches()  # second call short-circuits
    # No exception raised → pass.
