"""Decoder-side safety patches over onnx_asr's engine implementations.

Six monkey-patches that bring our decoding behaviour in line with
``transcribe-rs``, where the upstream onnx_asr
library lacks safeguards that transcribe-rs ships by default.

1. **Canary AED consecutive-repeat guard.** ``NemoConformerAED._decoding``
   does pure ``argmax`` until ``<|endoftext|>`` or ``max_sequence_length=1024``.
   With nothing else to stop it, the model can emit ``.``/``..`` tokens
   dozens of times in a row when audio is ambiguous (silence at the tail,
   intra-sentence pauses). transcribe-rs ships
   ``GreedyDecoder { max_consecutive_repeats: 8 }`` for exactly this — we
   port the same constant. After 8 identical tokens we force the row to
   EOS so the existing ``.all()`` stop condition fires.

2. **Cohere consecutive-repeat guard.** Same fix at
   ``CohereAsr._decoding``; same constant.

3. **Whisper suppress_non_speech_tokens + suppress_blank + no_speech_thold.**
   ``WhisperHf._decoding`` is pure greedy. The whisper.cpp default
   masks out the well-known non-speech token ids (``[Music]``,
   ``(laughter)``, ``♪``, …), suppresses an all-blank output, and gates
   the segment on the first-step ``<|nospeech|>`` probability vs a 0.2
   threshold. Reimplemented here as a logit-mask + EOS-redirect on the
   first step.

4. **Whisper custom_words → initial_prompt.** Whisper's classical
   conditioning mechanism uses a ``<|startofprev|>``-prefixed prompt to
   bias the decoder toward user vocabulary. Hand-rolled byte-level BPE
   encoder (no ``tokenizers`` runtime dep) prepends an encoded prompt
   built from the user's ``custom_words`` list.

5. **Moonshine audio-aware ``max_length`` cap.** Moonshine encodes ``N``
   tokens per second of audio (6 EN / 8 UK / 13 CJK+AR). The default
   ``max_length=448`` allows runaway emits on short clips. We override
   ``Moonshine.recognize_batch`` to compute
   ``min(provided, ceil(audio_sec * token_rate[lang]))``.

6. **Apply hook.** ``apply_onnx_decoder_patches()`` installs every patch
   once per process. Idempotent — successive calls short-circuit.

All patches are applied as in-place reassignments of the upstream class
methods, mirroring the precedent set by ``onnx_patch.py``'s Whisper fp16
fixer. None of them mutate library files on disk; the runtime classes are
patched at first import. If ``onnx_asr`` isn't installed (test fakes,
remote-only configs), this module is a no-op import.
"""

from __future__ import annotations

import logging
import math
import os
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    import numpy.typing as npt

logger = logging.getLogger(__name__)


# ── Tunables ───────────────────────────────────────────────────────────

#: Max consecutive identical-token emissions before we force-EOS an AED
#: decoder row. Matches ``transcribe-rs``'s
#: ``DEFAULT_MAX_CONSECUTIVE_REPEATS = 8`` (greedy.rs:8).
MAX_CONSECUTIVE_REPEATS: int = 8

#: Whisper's classic ``no_speech_thold`` — segments whose first-step
#: ``<|nospeech|>`` softmax prob exceeds this are deemed silence and
#: short-circuit to an empty transcript. whisper.cpp default; matches
#: ``WhisperInferenceParams::default()``.
WHISPER_NO_SPEECH_THRESHOLD: float = 0.2

#: Moonshine token-rate budget per locale (tokens emitted per second
#: of input audio). Mirrors ``moonshine_mod.rs`` in transcribe-rs:
#: 6 tokens/s for English/most Latin scripts, 8 for Ukrainian-like
#: morphology, 13 for CJK + Arabic where one phoneme often maps to
#: several tokens.
_MOONSHINE_TOKEN_RATES: dict[str, int] = {
    "en": 6,
    "uk": 8,
    "zh": 13,
    "ja": 13,
    "ko": 13,
    "ar": 13,
    "vi": 8,
}
_MOONSHINE_DEFAULT_TOKEN_RATE: int = 8

#: Audio length floor (in 16 kHz samples) at which we pad up to the AED
#: "comfort" window for Canary / Cohere. Below this Canary's decoder
#: prompt context (10 tokens) is large compared to its encoder
#: features and the model is prone to either silent-EOS or
#: dot-loop. Anything under 16000 samples is padded up to 20000.
AED_MIN_SAMPLES: int = 16_000
AED_PAD_TO_SAMPLES: int = 20_000  # 1.25 s

#: Leading-silence pad (in 16 kHz samples) prepended to Parakeet inputs.
#: Matches ``transcribe-rs/parakeet/mod.rs:124, 433``'s default
#: ``leading_silence_ms=250`` — Parakeet's RNN-T predictor was trained
#: against silence-prefixed inputs and very occasionally drops or
#: duplicates the first emitted token when fed a hot-start waveform.
PARAKEET_LEADING_SILENCE_SAMPLES: int = 4_000  # 250 ms @ 16 kHz

#: Per-sample amplitude floor below which a leading region is considered
#: "near-zero silence" for the AED leading-silence trim. Our pipeline's
#: ``vad_prefill_ms`` mechanism splices a deque of exact-zero PyAudio
#: chunks in front of the recording (see
#: ``application/pipeline.py:_splice_silence_prefill_in_front``). Live
#: microphone noise during a quiet room reads as ~0.0005 (-66 dBFS); we
#: pick a threshold safely below that so we only strip programmatic
#: zero-padding and not real (quiet) audio.
AED_LEADING_SILENCE_RMS_THRESHOLD: float = 1e-4

#: Window (in 16 kHz samples) over which we measure RMS to decide whether
#: a region is silence. 320 samples = 20 ms, matching one PyAudio chunk
#: at the default ``buffer_size=512`` (32 ms) is close enough that a
#: chunk of zeros is detected in a single window.
AED_LEADING_SILENCE_WINDOW: int = 320  # 20 ms @ 16 kHz

#: Maximum leading-silence prefix we'll trim from AED inputs. Defends
#: against pathological cases where the entire clip is silent (would
#: otherwise leave a length-0 array). Matches the pipeline's max
#: ``vad_prefill_ms=2000`` ceiling plus generous head room.
AED_MAX_LEADING_TRIM_SAMPLES: int = 48_000  # 3 s @ 16 kHz


# ── Patch installer ────────────────────────────────────────────────────

_PATCHES_APPLIED: bool = False


def apply_onnx_decoder_patches() -> None:
    """Install all decoder-side patches over the bundled onnx_asr library.

    Idempotent across calls and safe to invoke before any model is
    loaded. Each individual patch logs a single line on first install
    and skips silently if the corresponding upstream class can't be
    imported (test fakes, slim builds).
    """
    global _PATCHES_APPLIED
    if _PATCHES_APPLIED:
        return
    _PATCHES_APPLIED = True

    _patch_canary_aed_decoder()
    _patch_cohere_decoder()
    _patch_whisper_decoder()
    _patch_moonshine_decoder()


# ── Patch 1 — Canary AED consecutive-repeat guard ──────────────────────


def _patch_canary_aed_decoder() -> None:
    """Reassign ``NemoConformerAED._decoding`` with a repeat-guarded version."""
    try:
        from onnx_asr.models import nemo as _nemo
    except ImportError:
        logger.debug("onnx_asr not installed — skipping Canary AED patch")
        return

    target = getattr(_nemo, "NemoConformerAED", None)
    if target is None:  # pragma: no cover — defensive
        logger.warning("NemoConformerAED missing from onnx_asr.models.nemo")
        return

    if getattr(target._decoding, "_winstt_patched", False):
        return

    target._decoding = _canary_aed_decoding_patched
    target._decoding._winstt_patched = True
    logger.info(
        "Patched NemoConformerAED._decoding with max_consecutive_repeats=%d",
        MAX_CONSECUTIVE_REPEATS,
    )


def _canary_aed_decoding_patched(
    self: Any,  # noqa: ANN401 — patched onto upstream class
    encoder_embeddings: npt.NDArray[np.float32],
    encoder_mask: npt.NDArray[np.int64],
    /,
    **kwargs: object | None,
) -> Any:  # noqa: ANN401 — yields (tokens, None, logprobs)
    """Drop-in replacement for ``NemoConformerAED._decoding``.

    Mirrors the upstream implementation byte-for-byte except for two
    additional behaviours:

    1. Repeat-guard: when a row's most-recent
       ``MAX_CONSECUTIVE_REPEATS`` predictions are all the same
       (non-EOS) token, the row is force-finished by overwriting its
       next prediction with the EOS id. This lets the existing
       ``(next_tokens == eos).all()`` early-exit fire normally instead
       of waiting out the 1024-token cap.

    2. Optional ``<|startofcontext|>`` prior-text injection: when the
       engine carries a ``_winstt_initial_prompt_ids`` list, splice
       those token ids between positions [1] (``<|startofcontext|>``)
       and [2] (``<|startoftranscript|>``) of the upstream 10-token
       prompt. Canary AED's training recipe documents this slot as
       the prior-context anchor, so the injected tokens are read
       exactly as "what came before this clip" — biasing the decoder
       toward continuing that context.
    """
    batch_size = encoder_embeddings.shape[0]
    batch_tokens = np.repeat(self._transcribe_input, batch_size, axis=0)

    # Splice optional prior-context tokens between SOC ([1]) and SOT
    # ([2]). ``_winstt_initial_prompt_ids`` is set by
    # OnnxAsrTranscriber._install_canary_initial_prompt for the duration
    # of one transcribe() call. Stale state (attribute absent or empty)
    # is the no-op path.
    prompt_ids: list[int] | None = getattr(self, "_winstt_initial_prompt_ids", None)
    if prompt_ids:
        prefix_block = np.array([prompt_ids], dtype=np.int64).repeat(batch_size, axis=0)
        # batch_tokens layout becomes:
        #   [SPACE, SOC, *prompt_ids, SOT, EMO, LANG, LANG, PNC, NOITN, NOTS, NODIA]
        batch_tokens = np.concatenate(
            (batch_tokens[:, :2], prefix_block, batch_tokens[:, 2:]),
            axis=1,
        )

    language = kwargs.get("language")
    if language:
        # Indexing into batch_tokens by absolute column position would
        # mis-target the lang slot when a prompt was spliced in. Compute
        # the offset from the trailing fixed-shape suffix (8 control
        # tokens after SOT) to stay correct in both cases.
        lang_col = batch_tokens.shape[1] - 6
        batch_tokens[:, lang_col] = self._tokens[f"<|{language}|>"]

    target_language = kwargs.get("target_language") or language
    if target_language:
        target_col = batch_tokens.shape[1] - 5
        batch_tokens[:, target_col] = self._tokens[f"<|{target_language}|>"]

    pnc = kwargs.get("pnc")
    if pnc is not None:
        if isinstance(pnc, bool):
            pnc = "pnc" if pnc else "nopnc"
        pnc_col = batch_tokens.shape[1] - 4
        batch_tokens[:, pnc_col] = self._tokens[f"<|{pnc}|>"]

    prefix_len = batch_tokens.shape[1]
    shapes = {x.name: x.shape for x in self._decoder.get_inputs()}
    decoder_mems = np.empty(
        (shapes["decoder_mems"][0], batch_size, 0, shapes["decoder_mems"][3]),
        dtype=np.float32,
    )
    batch_logprobs = np.zeros((batch_size, 0), dtype=np.float32)
    # Per-row tracking for the consecutive-repeat guard. ``last_token``
    # holds the previous prediction for each batch row; ``repeat_count``
    # is incremented when the new prediction equals it. Initialised to a
    # sentinel that can't collide with any vocab id (-1) and 0 respectively.
    last_token = np.full(batch_size, -1, dtype=np.int64)
    repeat_count = np.zeros(batch_size, dtype=np.int64)
    while batch_tokens.shape[1] < self._max_sequence_length:
        logits, decoder_mems = self._decode(batch_tokens, encoder_embeddings, encoder_mask, decoder_mems)
        next_tokens = np.argmax(logits[:, -1], axis=-1)

        # Repeat-guard: any row whose next token would extend an
        # 8-in-a-row run gets coerced to EOS so the batch-wise stop
        # fires. We only count non-EOS repetitions — an EOS run is the
        # normal terminating state and is allowed.
        same_as_last = next_tokens == last_token
        not_eos = next_tokens != self._eos_token_id
        repeat_count = np.where(same_as_last & not_eos, repeat_count + 1, 1)
        # Strict ``>`` not ``>=`` so we match transcribe-rs's policy:
        # AT MOST ``MAX_CONSECUTIVE_REPEATS`` identical tokens are
        # allowed through. The (N+1)-th identical prediction is coerced
        # to EOS (transcribe-rs returns ``None`` from GreedyDecoder at
        # the same boundary; greedy.rs:46-53).
        force_eos = repeat_count > MAX_CONSECUTIVE_REPEATS
        if force_eos.any():
            next_tokens = np.where(force_eos, self._eos_token_id, next_tokens)

        # Track the (potentially coerced) token for the next iteration.
        last_token = next_tokens

        if (next_tokens == self._eos_token_id).all():
            break

        next_logprobs = np.take_along_axis(logits[:, -1], next_tokens[:, None], axis=-1).squeeze(axis=-1)
        batch_tokens = np.concatenate((batch_tokens, next_tokens[:, None]), axis=-1)
        batch_logprobs = np.concatenate((batch_logprobs, next_logprobs[:, None]), axis=-1)

    for tokens, logprobs in zip(batch_tokens[:, prefix_len:], batch_logprobs, strict=True):
        yield (
            [id for id in tokens if not self._vocab[id].startswith("<|")],
            None,
            logprobs[tokens != self._eos_token_id],
        )


# ── Patch 2 — Cohere consecutive-repeat guard ──────────────────────────


def _patch_cohere_decoder() -> None:
    """Reassign ``CohereAsr._decoding`` with a repeat-guarded version."""
    try:
        from onnx_asr.models import cohere_asr as _cohere
    except ImportError:
        logger.debug("onnx_asr.models.cohere_asr not installed — skipping Cohere patch")
        return

    target = getattr(_cohere, "CohereAsr", None)
    if target is None:  # pragma: no cover — defensive
        logger.warning("CohereAsr missing from onnx_asr.models.cohere_asr")
        return

    if getattr(target._decoding, "_winstt_patched", False):
        return

    target._decoding = _cohere_decoding_patched
    target._decoding._winstt_patched = True
    logger.info(
        "Patched CohereAsr._decoding with max_consecutive_repeats=%d",
        MAX_CONSECUTIVE_REPEATS,
    )


def _cohere_decoding_patched(
    self: Any,  # noqa: ANN401
    input_encoding: Any,  # noqa: ANN401 — OrtValue
    prompts: npt.NDArray[np.int64],
    max_length: int | None = None,
) -> list[list[int]]:
    """Drop-in replacement for ``CohereAsr._decoding`` with repeat-guard
    AND optional ``<|startofcontext|>`` prior-text injection.

    The upstream prompt layout is identical to Canary AED:
    ``[▁, <|startofcontext|>, <|startoftranscript|>, <|emo:undef|>,
    lang, lang, pnc, <|noitn|>, <|notimestamp|>, <|nodiarize|>]`` —
    so the splice point is the same (between [1] and [2]). When the
    engine carries a ``_winstt_initial_prompt_ids`` list, splice it in
    before running the first decoder step; the loop is
    prompt-length-agnostic, so no further changes are needed.
    """
    prompt_ids: list[int] | None = getattr(self, "_winstt_initial_prompt_ids", None)
    if prompt_ids:
        batch_size = prompts.shape[0]
        prefix_block = np.array([prompt_ids], dtype=np.int64).repeat(batch_size, axis=0)
        prompts = np.concatenate(
            (prompts[:, :2], prefix_block, prompts[:, 2:]),
            axis=1,
        )
    batch_size, prompt_len = prompts.shape
    max_len = max_length or self._max_decode_length

    state = self._create_empty_state(batch_size)
    attention_mask = np.ones((batch_size, prompt_len), dtype=np.int64)
    position_ids = np.tile(np.arange(prompt_len, dtype=np.int64), (batch_size, 1))
    logits, state = self._decode_step(prompts, attention_mask, position_ids, input_encoding, state)
    next_tokens = logits[:, -1].argmax(axis=-1).astype(np.int64)

    generated: list[list[int]] = [[int(next_tokens[i])] for i in range(batch_size)]
    finished = next_tokens == self._eos_token_id
    current_pos = prompt_len

    # Per-row repeat-guard bookkeeping.
    last_token = next_tokens.copy()
    repeat_count = np.ones(batch_size, dtype=np.int64)

    for _step in range(prompt_len + 1, max_len):
        if finished.all():
            break
        input_ids = next_tokens.reshape(batch_size, 1)
        attention_mask = np.ones((batch_size, current_pos + 1), dtype=np.int64)
        position_ids = np.full((batch_size, 1), current_pos, dtype=np.int64)
        logits, state = self._decode_step(input_ids, attention_mask, position_ids, input_encoding, state)
        next_tokens = logits[:, -1].argmax(axis=-1).astype(np.int64)
        next_tokens = np.where(finished, self._eos_token_id, next_tokens)

        # Repeat-guard: same as Canary, only non-EOS repeats count.
        same_as_last = next_tokens == last_token
        not_eos = next_tokens != self._eos_token_id
        repeat_count = np.where(same_as_last & not_eos, repeat_count + 1, 1)
        # Strict ``>`` not ``>=`` so we match transcribe-rs's policy:
        # AT MOST ``MAX_CONSECUTIVE_REPEATS`` identical tokens are
        # allowed through. The (N+1)-th identical prediction is coerced
        # to EOS (transcribe-rs returns ``None`` from GreedyDecoder at
        # the same boundary; greedy.rs:46-53).
        force_eos = repeat_count > MAX_CONSECUTIVE_REPEATS
        if force_eos.any():
            next_tokens = np.where(force_eos, self._eos_token_id, next_tokens)

        last_token = next_tokens

        for i in range(batch_size):
            if not finished[i]:
                generated[i].append(int(next_tokens[i]))
        finished = finished | (next_tokens == self._eos_token_id)
        current_pos += 1

    return generated


# ── Patch 3 — Whisper logit suppression + no_speech gate ───────────────


def _patch_whisper_decoder() -> None:
    """Reassign ``WhisperHf._decoding`` with a suppression-aware version."""
    try:
        from onnx_asr.models.whisper import _hf as _whisper_hf
    except ImportError:
        logger.debug("onnx_asr.models.whisper._hf not installed — skipping Whisper patch")
        return

    target = getattr(_whisper_hf, "WhisperHf", None)
    if target is None:  # pragma: no cover — defensive
        logger.warning("WhisperHf missing from onnx_asr.models.whisper._hf")
        return

    if getattr(target._decoding, "_winstt_patched", False):
        return

    target._decoding = _whisper_decoding_patched
    target._decoding._winstt_patched = True
    logger.info(
        "Patched WhisperHf._decoding with suppress_non_speech / suppress_blank / no_speech_thold=%.2f",
        WHISPER_NO_SPEECH_THRESHOLD,
    )


#: Whisper's classic ``suppress_tokens`` list — the text-token ids that
#: the model is biased *away from* emitting because they're non-speech /
#: markup artifacts (musical notes, square-bracket annotations, …). The
#: list is copy-pasted from OpenAI Whisper's ``decoding.py`` / whisper.cpp
#: ``whisper_default_suppress_tokens``. We resolve each id at first use
#: against the loaded vocab so missing ids (English-only variants) are
#: skipped silently.
_WHISPER_SUPPRESS_TOKENS_RAW: tuple[int, ...] = (
    1,
    2,
    7,
    8,
    9,
    10,
    14,
    25,
    26,
    27,
    28,
    29,
    31,
    58,
    59,
    60,
    61,
    62,
    63,
    90,
    91,
    92,
    93,
    359,
    503,
    522,
    542,
    873,
    893,
    902,
    918,
    922,
    931,
    1350,
    1853,
    1982,
    2460,
    2627,
    3246,
    3253,
    3268,
    3536,
    3846,
    3961,
    4183,
    4667,
    6585,
    6647,
    7273,
    9061,
    9383,
    10428,
    10929,
    11938,
    12033,
    12331,
    12562,
    13793,
    14157,
    14635,
    15265,
    15618,
    16553,
    16604,
    18362,
    18956,
    20075,
    21675,
    22520,
    26130,
    26161,
    26435,
    28279,
    29464,
    31650,
    32302,
    32470,
    36865,
    42863,
    47425,
    49870,
    50254,
    50258,
    50360,
    50361,
    50362,
)


def _whisper_softmax_row(logits_row: npt.NDArray[np.float32]) -> npt.NDArray[np.float32]:
    """Numerically-stable softmax over a 1-D logit vector."""
    m = float(np.max(logits_row))
    e = np.exp(logits_row - m)
    out: npt.NDArray[np.float32] = (e / float(np.sum(e))).astype(np.float32, copy=False)
    return out


def _whisper_decoding_patched(
    self: Any,  # noqa: ANN401
    input_features: Any,  # noqa: ANN401 — OrtValue
    tokens: npt.NDArray[np.int64],
    max_length: int = 448,
) -> npt.NDArray[np.int64]:
    """Drop-in replacement for ``WhisperHf._decoding`` adding five guards:

    * **suppress_non_speech_tokens** — Whisper's classic ``suppress_tokens``
      list is set to ``-inf`` in every step before argmax. Kills
      ``[Music]`` / ``♪`` / ``(laughter)`` / ``Thanks for watching!``
      style emissions.
    * **no_speech_thold** — first step computes the softmax probability
      of the ``<|nospeech|>`` token; if it exceeds 0.2 (whisper.cpp
      default) the row is force-finished as EOS.
    * **suppress_blank** — empty-EOS-immediately-after-prompt rows would
      yield empty text, which is what whisper.cpp's ``suppress_blank``
      avoids. We mask EOS on the very first generated step to give the
      decoder one chance to emit speech.
    * **initial_prompt** — if the engine carries a
      ``_winstt_initial_prompt_ids`` list, prepend it (along with
      ``<|startofprev|>``) to the tokens before decoding. The prefix is
      only injected on the normal decode path (tokens already include
      the 4-token transcribe prompt); the 1-token lang-detect mode is
      detected by ``tokens.shape[-1] <= 1`` and bypasses the prefix.
    * **beam search (width ``B = _winstt_beam_size``)** — when ``B > 1``
      the decode runs as a length-normalised beam search instead of pure
      argmax. Matches the ``SamplingStrategy::BeamSearch { beam_size: 3 }``
      default. ``B == 1`` (default) runs greedy verbatim, byte-identical
      to the existing path. Beam search is skipped for lang-detect calls
      (``max_length <= 3``) since those run a 1-step argmax over language
      tokens and don't benefit.
    """
    # Initial-prompt prefix injection. The lang-detect path passes a
    # single-token (BOS) prompt; only prepend when the caller has already
    # built the full multi-token transcribe prompt (``tokens.shape[-1] >= 2``).
    prompt_ids: list[int] | None = getattr(self, "_winstt_initial_prompt_ids", None)
    prefix_len = 0
    if prompt_ids and tokens.shape[-1] >= 2:
        batch_size = tokens.shape[0]
        prefix = np.array([prompt_ids], dtype=np.int64).repeat(batch_size, axis=0)
        tokens = np.concatenate([prefix, tokens], axis=1)
        # Bump max_length so the prefix doesn't eat into the model's
        # actual generation budget. Whisper's positional embedding cap is
        # 448 — we leave the user's budget intact and allow the prefix
        # tokens "for free" up to the cap.
        max_length = min(448, max_length + int(prefix.shape[1]))
        prefix_len = int(prefix.shape[1])

    # Beam-search dispatch. Greedy (B<=1) runs verbatim; beam runs the
    # alternate path. Three other gates send us back to greedy:
    #  * batch_size > 1 — beam search only supports a single input clip
    #    at a time, which matches every call site we have today
    #    (recognize() always runs one clip per ``transcribe`` invocation).
    #  * max_length <= 3 — Whisper's lang-detect path, which doesn't
    #    benefit from beam expansion.
    beam_size = int(getattr(self, "_winstt_beam_size", 1) or 1)
    if beam_size > 1 and tokens.shape[0] == 1 and max_length > 3:
        out = _whisper_decoding_beam(self, input_features, tokens, max_length, beam_size)
    else:
        out = _whisper_decoding_greedy(self, input_features, tokens, max_length)
    # Strip the injected prefix from the returned tokens. Upstream
    # ``_decode_text`` filters out ``<|...|>`` specials but keeps regular
    # tokens, so without this slice the prompt-body bleeds into the
    # transcript verbatim (the bug that prompted this fix). The
    # generated tokens land after ``prefix_len + original_prompt_len``
    # so slicing the leading ``prefix_len`` columns leaves the original
    # prompt + generated body — which is what upstream contract expects.
    if prefix_len > 0:
        out = out[:, prefix_len:]
    return out


def _whisper_decoding_greedy(
    self: Any,  # noqa: ANN401
    input_features: Any,  # noqa: ANN401 — OrtValue
    tokens: npt.NDArray[np.int64],
    max_length: int,
) -> npt.NDArray[np.int64]:
    """Greedy argmax decode with suppress / no_speech / suppress_blank.

    Extracted from :func:`_whisper_decoding_patched` so it can be called
    directly for ``beam_size <= 1`` and from the lang-detect / batched
    fallback paths.
    """
    state = self._create_state()
    vocab_size = max(self._tokens.values()) + 1
    suppress_mask: list[int] = [t for t in _WHISPER_SUPPRESS_TOKENS_RAW if 0 <= t < vocab_size]
    nospeech_id = self._tokens.get("<|nospeech|>") or self._tokens.get("<|nocaptions|>")

    is_first_step = True
    for _ in range(tokens.shape[-1], max_length):
        logits, state = self._decode(tokens, state, input_features)
        last_logits = logits[:, -1, :].copy()

        force_eos_rows: list[int] = []
        if is_first_step and nospeech_id is not None:
            for row_idx in range(last_logits.shape[0]):
                probs = _whisper_softmax_row(last_logits[row_idx])
                if float(probs[nospeech_id]) > WHISPER_NO_SPEECH_THRESHOLD:
                    force_eos_rows.append(row_idx)

        if suppress_mask:
            last_logits[:, suppress_mask] = -np.inf

        if is_first_step:
            last_logits[:, self._eos_token_id] = -np.inf

        for row_idx in force_eos_rows:
            last_logits[row_idx, :] = -np.inf
            last_logits[row_idx, self._eos_token_id] = 0.0

        next_tokens = last_logits.argmax(axis=-1)
        next_tokens[tokens[:, -1] == self._eos_token_id] = self._eos_token_id
        tokens = np.hstack((tokens, next_tokens[:, None]))
        if (tokens[:, -1] == self._eos_token_id).all():
            break

        is_first_step = False

    return tokens


def _log_softmax_row(logits_row: npt.NDArray[np.float32]) -> npt.NDArray[np.float32]:
    """Numerically-stable log-softmax over a 1-D logit vector.

    Cumulative beam-search scoring works in log-probability space so
    every step is just an add — no overflow / underflow over long
    sequences and no precision loss vs the multiplicative form.
    """
    m = float(np.max(logits_row))
    shifted = logits_row - m
    log_denom = float(np.log(np.sum(np.exp(shifted))))
    out: npt.NDArray[np.float32] = (shifted - log_denom).astype(np.float32, copy=False)
    return out


#: Length-normalisation exponent applied to the cumulative log-prob when
#: picking the final beam. Matches the default in whisper.cpp /
#: OpenAI Whisper (``length_penalty=1.0`` → divide by sequence length).
#: Higher values penalise long sequences less; we go with neutral 1.0 so
#: short and long candidate transcripts are scored on an equal-per-token
#: footing.
_WHISPER_BEAM_LENGTH_PENALTY: float = 1.0


def _whisper_decoding_beam(
    self: Any,  # noqa: ANN401
    input_features: Any,  # noqa: ANN401 — OrtValue
    tokens: npt.NDArray[np.int64],
    max_length: int,
    beam_size: int,
) -> npt.NDArray[np.int64]:
    """Beam-search decode of width ``beam_size``.

    Standard length-normalised greedy beam: at each step expand every
    live beam by its top ``beam_size`` next-token candidates, score by
    cumulative log-probability + a length-penalty, prune to ``beam_size``,
    re-order the KV-cache state by parent-beam id, and continue.

    All four logit-side guards from the greedy path apply identically:
    ``suppress_non_speech_tokens``, ``suppress_blank`` (first generated
    step only), ``no_speech_thold`` (force every beam to EOS), and the
    suppressing of EOS-extension on already-finished beams.

    Returns a ``(1, total_seq_len)`` int64 array matching the upstream
    contract — the highest-scoring beam wins. Finished beams have their
    final tokens repeated with EOS-coercion so the caller's existing
    ``[prompt_length:]`` slice extracts just the generated text.
    """
    from onnxruntime import OrtValue

    vocab_size = max(self._tokens.values()) + 1
    suppress_mask: list[int] = [t for t in _WHISPER_SUPPRESS_TOKENS_RAW if 0 <= t < vocab_size]
    nospeech_id = self._tokens.get("<|nospeech|>") or self._tokens.get("<|nocaptions|>")
    eos_id = int(self._eos_token_id)

    # First decode call: full prompt against an empty KV state.
    state = self._create_state()
    logits, state = self._decode(tokens, state, input_features)
    last_logits = logits[:, -1, :].copy()

    # No-speech gate on the first step — if it fires, short-circuit with
    # an EOS-only completion (no point running beam search over silence).
    if nospeech_id is not None:
        probs = _whisper_softmax_row(last_logits[0])
        if float(probs[nospeech_id]) > WHISPER_NO_SPEECH_THRESHOLD:
            eos_col = np.array([[eos_id]], dtype=np.int64)
            return np.concatenate([tokens, eos_col], axis=1)

    if suppress_mask:
        last_logits[:, suppress_mask] = -np.inf
    # suppress_blank on the very first generated step.
    last_logits[:, eos_id] = -np.inf

    # Top-K candidates seed the beams.
    log_probs = _log_softmax_row(last_logits[0])
    top_k_idx = np.argpartition(-log_probs, beam_size - 1)[:beam_size]
    top_k_scores = log_probs[top_k_idx]
    # Sort by score descending so beam 0 is the strongest from step 0
    # onwards (only matters for ties-and-display, but cheap).
    order = np.argsort(-top_k_scores)
    top_k_idx = top_k_idx[order]
    top_k_scores = top_k_scores[order]

    # Expand to ``beam_size`` parallel beams.
    beam_tokens = np.repeat(tokens, beam_size, axis=0)
    beam_tokens = np.hstack((beam_tokens, top_k_idx[:, None]))
    beam_scores = top_k_scores.astype(np.float32)
    beam_finished = beam_tokens[:, -1] == eos_id  # all False on first step (EOS was suppressed)

    # Replicate KV state along batch dim to match the beams.
    state = _replicate_state_batch(state, beam_size, OrtValue)

    for _ in range(tokens.shape[-1] + 1, max_length):
        if bool(beam_finished.all()):
            break

        # Feed only the last-emitted token per beam (cache supplies the
        # rest). All beams advance in lock-step so the decoder runs once
        # per step regardless of beam width.
        step_in = beam_tokens[:, -1:].astype(np.int64, copy=False)
        logits, state = self._decode(step_in, state, input_features)
        last_logits = logits[:, -1, :].astype(np.float32, copy=True)

        # Per-beam EOS lock — once a beam has emitted EOS, future
        # extensions are pinned to EOS and accumulate zero score.
        if suppress_mask:
            last_logits[:, suppress_mask] = -np.inf
        for b_idx in range(beam_size):
            if beam_finished[b_idx]:
                last_logits[b_idx, :] = -np.inf
                last_logits[b_idx, eos_id] = 0.0

        # Compute beam-level log-probs and candidate scores.
        # log_softmax per beam; finished beams contribute 0 to score (EOS at log_prob 0).
        candidate_scores = np.empty((beam_size, beam_size), dtype=np.float32)
        candidate_tokens = np.empty((beam_size, beam_size), dtype=np.int64)
        for b_idx in range(beam_size):
            row_log_probs = _log_softmax_row(last_logits[b_idx])
            top_idx = np.argpartition(-row_log_probs, beam_size - 1)[:beam_size]
            top_scores = row_log_probs[top_idx]
            # Beam's cumulative score + per-candidate log-prob.
            candidate_scores[b_idx] = beam_scores[b_idx] + top_scores
            candidate_tokens[b_idx] = top_idx

        # Flatten and pick the global top-K.
        flat_scores = candidate_scores.reshape(-1)
        flat_tokens = candidate_tokens.reshape(-1)
        parent_idx = np.repeat(np.arange(beam_size, dtype=np.int64), beam_size)
        # argpartition is faster than full argsort when only the top K
        # are needed. The result is unsorted within the top K — we sort
        # after to get a stable beam ordering.
        top_global = np.argpartition(-flat_scores, beam_size - 1)[:beam_size]
        top_global_sorted = top_global[np.argsort(-flat_scores[top_global])]

        new_parents = parent_idx[top_global_sorted]
        new_tokens_col = flat_tokens[top_global_sorted]
        new_scores = flat_scores[top_global_sorted]

        # Gather the parent rows' tokens and append the new token.
        beam_tokens = beam_tokens[new_parents]
        beam_tokens = np.hstack((beam_tokens, new_tokens_col[:, None]))
        beam_scores = new_scores
        beam_finished = beam_tokens[:, -1] == eos_id

        # Reorder the KV cache state to match the new parent ordering.
        state = _reorder_state_by_parents(state, new_parents, OrtValue)

    # Length-normalised pick. ``len(tokens_generated)`` is the count of
    # generated (not prompt) tokens in each beam — Whisper's standard
    # length penalty. ``beam_scores`` are cumulative log-probabilities
    # so we divide by ``length ** length_penalty`` to get the per-token
    # mean log-prob equivalent.
    prompt_len = tokens.shape[-1]
    final_scores = np.empty(beam_size, dtype=np.float32)
    for b_idx in range(beam_size):
        gen_len = beam_tokens.shape[-1] - prompt_len
        # Strip trailing EOS-padding from the length used for normalisation
        # so a beam that terminated early isn't penalised against a beam
        # that ran to max_length.
        beam_seq = beam_tokens[b_idx, prompt_len:]
        if beam_seq.size:
            eos_positions = np.flatnonzero(beam_seq == eos_id)
            if eos_positions.size:
                gen_len = int(eos_positions[0])
        gen_len = max(gen_len, 1)
        final_scores[b_idx] = beam_scores[b_idx] / (gen_len**_WHISPER_BEAM_LENGTH_PENALTY)

    winner = int(np.argmax(final_scores))
    winning_tokens: npt.NDArray[np.int64] = beam_tokens[winner].astype(np.int64, copy=False)
    # The caller expects shape ``(1, seq_len)``.
    return winning_tokens[None, :]


def _replicate_state_batch(
    state: dict[str, Any],
    new_batch: int,
    ortvalue_cls: Any,  # noqa: ANN401 — onnxruntime.OrtValue, deferred-imported
) -> dict[str, Any]:
    """Repeat each KV-cache tensor's batch dimension to ``new_batch``.

    Operates via a single device→host→device round trip per tensor. On
    CPU sessions this is essentially free; on GPU it's a few KB of
    bandwidth per layer per step (the first beam step only). Acceptable
    vs. the alternative — keeping a stale singleton state — which would
    feed the same cached attention to every beam and collapse beam
    diversity.
    """
    new_state: dict[str, Any] = {}
    for name, val in state.items():
        arr = val.numpy()
        if arr.shape[0] == new_batch:
            new_state[name] = val
            continue
        # Cache tensors start at batch=0 (no-cache sentinel); we honour
        # that shape — the decoder treats a zero-batch state as
        # "no cache" and re-encodes from scratch. Replicate to new_batch.
        if arr.shape[0] == 0:
            empty_shape = (new_batch, *arr.shape[1:])
            new_state[name] = ortvalue_cls.ortvalue_from_numpy(np.zeros(empty_shape, dtype=arr.dtype))
            continue
        repeated = np.repeat(arr, new_batch // arr.shape[0], axis=0)
        new_state[name] = ortvalue_cls.ortvalue_from_numpy(repeated)
    return new_state


def _reorder_state_by_parents(
    state: dict[str, Any],
    parents: npt.NDArray[np.int64],
    ortvalue_cls: Any,  # noqa: ANN401 — onnxruntime.OrtValue, deferred-imported
) -> dict[str, Any]:
    """Gather each KV-cache tensor's batch dim along ``parents``.

    Beam search's invariant is that beam ``i`` at step ``t`` extends
    beam ``parents[i]`` from step ``t-1`` — so the cached attention for
    beam ``i`` must come from ``parents[i]``'s past row, not its own.
    """
    new_state: dict[str, Any] = {}
    for name, val in state.items():
        arr = val.numpy()
        if arr.shape[0] == 0:
            # No cache content yet — nothing to gather. Keep as is.
            new_state[name] = val
            continue
        gathered = arr[parents]
        new_state[name] = ortvalue_cls.ortvalue_from_numpy(gathered)
    return new_state


# ── Patch 5 — Moonshine audio-aware max_length cap ─────────────────────


def _patch_moonshine_decoder() -> None:
    """Wrap ``Moonshine.recognize_batch`` with an audio-duration max_length cap."""
    try:
        from onnx_asr.models import moonshine as _moonshine
    except ImportError:
        logger.debug("onnx_asr.models.moonshine not installed — skipping Moonshine patch")
        return

    target = getattr(_moonshine, "Moonshine", None)
    if target is None:  # pragma: no cover — defensive
        logger.warning("Moonshine missing from onnx_asr.models.moonshine")
        return

    if getattr(target.recognize_batch, "_winstt_patched", False):
        return

    original_recognize_batch = target.recognize_batch

    def _capped_recognize_batch(
        self: Any,  # noqa: ANN401
        waveforms: npt.NDArray[np.float32],
        waveforms_len: npt.NDArray[np.int64],
        /,
        **kwargs: object | None,
    ) -> Any:  # noqa: ANN401
        # Resolve the per-locale token rate. Moonshine variants
        # (moonshine-tiny-zh, moonshine-base-ja, …) have no language
        # input — the locale is baked into the checkpoint at training
        # time. We sniff it from the configured model name on the
        # parent transcriber via a contextvar-like attr; absent any
        # signal we fall back to a conservative 8 tokens/s.
        lang = getattr(self, "_winstt_lang_hint", None)
        token_rate = _MOONSHINE_TOKEN_RATES.get(str(lang) if lang else "", _MOONSHINE_DEFAULT_TOKEN_RATE)

        # Audio durations per row, in seconds. ``waveforms_len`` is in
        # samples at 16 kHz.
        max_len_per_row = [max(8, math.ceil(int(n) / 16_000.0 * token_rate) + 2) for n in waveforms_len.tolist()]
        # Single batch call gets a single max_length. Take the worst
        # case across the batch so no row is starved; we still avoid
        # the upstream-default 448 on a 1-second clip (would have
        # allowed 448 tokens for ~6 expected) which is the failure mode
        # this patch is fixing.
        cap = max(max_len_per_row)
        # Honour an explicit caller-provided max_length only when it's
        # *tighter* than our audio-derived cap.
        caller_max = kwargs.get("max_length")
        if isinstance(caller_max, int) and caller_max > 0:
            cap = min(cap, caller_max)
        kwargs["max_length"] = cap

        return original_recognize_batch(self, waveforms, waveforms_len, **kwargs)

    _capped_recognize_batch._winstt_patched = True  # type: ignore[attr-defined]
    target.recognize_batch = _capped_recognize_batch
    logger.info(
        "Patched Moonshine.recognize_batch with per-locale token-rate caps (default=%d tok/s)",
        _MOONSHINE_DEFAULT_TOKEN_RATE,
    )


# ── Whisper byte-level BPE prompt encoder (patch 4 helper) ─────────────


def _whisper_bytes_to_unicode() -> dict[int, str]:
    """Whisper / GPT-2 byte-to-printable-unicode map. Duplicates the
    one in :mod:`onnx_asr.models.whisper._base` so we don't reach into
    a private attribute on the upstream module.
    """
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(2**8):
        if b not in bs:
            bs.append(b)
            cs.append(2**8 + n)
            n += 1
    cs_str = [chr(x) for x in cs]
    return dict(zip(bs, cs_str, strict=True))


def encode_whisper_prompt(text: str, tokens_dict: dict[str, int]) -> list[int]:
    """Encode arbitrary text into Whisper token ids.

    This is a deliberately *approximate* GPT-2 byte-level BPE encoder —
    no ``merges.txt`` is read; instead we do greedy longest-prefix
    matching against the vocab. For Whisper's ``initial_prompt`` use case
    this is sufficient because:

    * the prompt is a soft attention bias, not a hard label
    * common-English custom-vocabulary tokens (proper nouns, brand
      names) almost always exist as whole-word entries in the vocab
    * any residual mismatch with the trained tokenizer is a quality
      regression of approximately zero (the model never sees a
      "wrong" string, just a slightly differently segmented one)

    Returns the encoded id sequence ready to insert between
    ``<|startofprev|>`` and ``<|startoftranscript|>`` in the prompt
    array. Empty input returns an empty list.
    """
    if not text:
        return []
    byte_encoder = _whisper_bytes_to_unicode()
    # Whisper conventionally prepends one space to the prompt content so
    # the first token gets the "G" (Ġ → 0x120) leading marker that the
    # BPE was trained on.
    rendered = "".join(byte_encoder[b] for b in (" " + text).encode("utf-8"))

    out: list[int] = []
    i = 0
    n = len(rendered)
    while i < n:
        # Greedy longest-prefix match. Walk back from the end of the
        # string to the current position; first hit is the longest.
        # Capped at 32 chars to keep the inner loop bounded — Whisper
        # BPE merges almost never produce pieces longer than that, and
        # the vast majority resolve at <8 chars.
        upper = min(n, i + 32)
        matched = False
        for j in range(upper, i, -1):
            piece = rendered[i:j]
            tid = tokens_dict.get(piece)
            if tid is not None:
                out.append(int(tid))
                i = j
                matched = True
                break
        if not matched:
            # Single-byte fallback; every single byte_encoder unicode
            # codepoint is also a vocab entry (Whisper exports include
            # the 256-byte alphabet). If even that misses, drop the
            # character — we'd rather feed a shorter prompt than a
            # corrupt one.
            single = rendered[i]
            tid = tokens_dict.get(single)
            if tid is not None:
                out.append(int(tid))
            i += 1
    return out


def _detect_word_boundary_marker(tokens_dict: dict[str, int]) -> str:
    """Detect the leading-space convention the model's tokenizer uses.

    Two patterns we see in the wild:
      * SentencePiece-style with ``▁`` (U+2581) — Cohere, Whisper-base
        sometimes (when exported with sentencepiece preset), most
        multilingual seq2seq vocabs.
      * NeMo Canary / NeMo Parakeet style with a literal ``" "`` (U+0020) —
        the vocab carries tokens like ``" hello"`` / ``" the"`` directly.

    Returns whichever marker prefixes the most vocab tokens (one
    sub-token-style scan over the whole dict). Falls back to ``""`` (no
    marker prepended) if neither convention is present, which keeps the
    byte-fallback path productive without spamming dropped characters.
    """
    saw_underscore = False
    saw_space = False
    for tok in tokens_dict:
        if not tok or tok.startswith("<"):
            continue
        first = tok[0]
        if first == "▁":
            saw_underscore = True
            if saw_space:
                break
        elif first == " ":
            saw_space = True
            if saw_underscore:
                break
    # ``▁`` wins ties; we've never seen a vocab carry both.
    if saw_underscore:
        return "▁"
    if saw_space:
        return " "
    return ""


def encode_sentencepiece_prompt(text: str, tokens_dict: dict[str, int]) -> list[int]:
    """Encode arbitrary text into BPE-style token ids.

    Used by Canary AED (NeMo-style vocab; leading-space marker is
    literal ``" "``) and Cohere Transcribe (SentencePiece-style;
    leading-space marker is ``▁`` (U+2581)). Auto-detects which
    convention applies via :func:`_detect_word_boundary_marker` so we
    don't have to thread an engine-specific knob through every caller.

    Same approximate longest-prefix algorithm as
    :func:`encode_whisper_prompt`: no ``merges.txt`` is read; we just
    greedy-match the rendered string against the vocabulary. Failure to
    find a piece falls back to single-character byte-fallback tokens
    (``<0xXX>`` IDs) when the vocab provides them, or drops the
    character otherwise. The output is a soft attention bias — a
    slightly different segmentation never produces a "wrong" string,
    just a less-optimal one.
    """
    if not text:
        return []
    # Treat a whitespace-only string as "no prompt" — feeding the
    # word-boundary marker alone biases the decoder toward an arbitrary
    # word start with no actual prior-context content.
    stripped = text.strip()
    if not stripped:
        return []
    marker = _detect_word_boundary_marker(tokens_dict)
    # Normalise internal whitespace runs to single space, then convert
    # spaces to the detected marker (or leave as space if marker is "").
    collapsed = " ".join(stripped.split())
    if marker == "" or marker == " ":
        # Either no marker convention detected, or the marker IS a
        # regular space — render the text with leading + internal
        # spaces and let the longest-prefix matcher pick up
        # space-prefixed vocab entries (Canary's `" the"`, `" of"`).
        rendered = " " + collapsed if marker == " " else collapsed
    else:
        rendered = marker + collapsed.replace(" ", marker)

    out: list[int] = []
    i = 0
    n = len(rendered)
    while i < n:
        upper = min(n, i + 32)
        matched = False
        for j in range(upper, i, -1):
            piece = rendered[i:j]
            tid = tokens_dict.get(piece)
            if tid is not None:
                out.append(int(tid))
                i = j
                matched = True
                break
        if matched:
            continue
        # Byte-fallback: SentencePiece-with-byte-fallback vocabs expose
        # ``<0xXX>`` tokens for every byte. Encode the UTF-8 bytes of
        # the unmatched character and append each one.
        char = rendered[i]
        i += 1
        for byte in char.encode("utf-8"):
            byte_token = f"<0x{byte:02X}>"
            tid = tokens_dict.get(byte_token)
            if tid is not None:
                out.append(int(tid))
            # If even byte-fallback misses (no byte tokens at all), we
            # drop the character — a shorter prompt beats a corrupt one.
    return out


def canary_initial_prompt_tokens(text: str, tokens_dict: dict[str, int]) -> list[int]:
    """Encode prior-context text into Canary-AED-prompt-ready ids.

    Returns the token ids that should be spliced between positions [1]
    (``<|startofcontext|>``) and [2] (``<|startoftranscript|>``) of the
    upstream 10-token prompt. The slot is exactly what NeMo's training
    recipe documents as the prior-context anchor — no extra special
    tokens needed; the surrounding ``<|startofcontext|>`` already marks
    the region as "what was said before this clip".

    Empty / vocab-mismatch paths return ``[]`` (caller treats this as
    "no prompt").
    """
    if not text:
        return []
    soc = tokens_dict.get("<|startofcontext|>")
    sot = tokens_dict.get("<|startoftranscript|>")
    if soc is None or sot is None:
        # Old / stripped exports without the AED prompt layout. We
        # refuse to inject because we have no guarantee the model was
        # trained to read a prefix.
        return []
    encoded = encode_sentencepiece_prompt(text, tokens_dict)
    if not encoded:
        return []
    return encoded


def whisper_initial_prompt_tokens(
    custom_words: list[str] | None,
    tokens_dict: dict[str, int],
) -> list[int]:
    """Build the prefix-prompt token ids for Whisper from ``custom_words``.

    Returns the ``[<|startofprev|>, *encoded_words]`` sequence, suitable
    for prepending to the standard ``[<|startoftranscript|>, <|lang|>,
    <|transcribe|>, <|notimestamps|>]`` prompt array. Empty / None /
    no-startofprev-in-vocab paths all return an empty list (caller
    treats this as "no prompt").
    """
    if not custom_words:
        return []
    sop = tokens_dict.get("<|startofprev|>")
    if sop is None:
        # English-only and very old Whisper exports drop ``<|startofprev|>``.
        # Without it we can't insert a previous-segment prompt safely.
        return []
    prompt_text = ", ".join(w.strip() for w in custom_words if w.strip())
    if not prompt_text:
        return []
    encoded = encode_whisper_prompt(prompt_text, tokens_dict)
    if not encoded:
        return []
    return [int(sop), *encoded]


# ── Helper: AED / Parakeet detection for input-side padding ────────────


def is_canary_aed_engine(model: Any) -> bool:  # noqa: ANN401
    """True iff ``model`` is an onnx_asr NeMo Canary AED engine."""
    for candidate in (model, getattr(model, "asr", None), getattr(model, "model", None)):
        if candidate is None:
            continue
        cls = type(candidate).__name__
        if cls in {"NemoConformerAED"} or "Canary" in cls:
            return True
    return False


def is_cohere_engine(model: Any) -> bool:  # noqa: ANN401
    """True iff ``model`` is an onnx_asr Cohere ASR engine."""
    for candidate in (model, getattr(model, "asr", None), getattr(model, "model", None)):
        if candidate is None:
            continue
        cls = type(candidate).__name__
        if cls == "CohereAsr":
            return True
    return False


def is_parakeet_transducer_engine(model: Any) -> bool:  # noqa: ANN401
    """True iff ``model`` is a NeMo Parakeet RNN-T or TDT engine.

    Parakeet CTC has no autoregressive predictor and doesn't benefit
    from the leading-silence pad, so it's intentionally excluded.
    """
    for candidate in (model, getattr(model, "asr", None), getattr(model, "model", None)):
        if candidate is None:
            continue
        cls = type(candidate).__name__
        if cls in {"NemoConformerRnnt", "NemoConformerTdt"}:
            return True
    return False


def is_whisper_engine(model: Any) -> bool:  # noqa: ANN401
    """True iff ``model`` is a Whisper-family engine (any variant)."""
    for candidate in (model, getattr(model, "asr", None), getattr(model, "model", None)):
        if candidate is None:
            continue
        cls = type(candidate).__name__
        if cls in {"WhisperHf", "WhisperOrt"} or cls.startswith("Whisper"):
            return True
    return False


# ── Input-side audio adjustments ───────────────────────────────────────


def maybe_trim_leading_silence_for_aed(
    audio: npt.NDArray[np.float32],
) -> npt.NDArray[np.float32]:
    """Strip programmatic leading silence from AED inputs (Canary, Cohere).

    Our pipeline splices up to ``vad_prefill_ms`` (default 450 ms) of
    silence-classified PyAudio chunks in front of every recording before
    handing the buffer to the transcriber — see
    ``application/pipeline.py:_splice_silence_prefill_in_front``. That
    prefix is excellent for Whisper (the encoder was trained on
    silence→speech transitions) and harmless for Parakeet CTC/RNNT, but
    catastrophic for Canary AED on short clips:

    The Canary encoder produces ``N`` embeddings spaced ~80 ms apart
    (subsampling factor 8 over 10 ms mel hops). 450 ms of leading zeros
    consumes ~5 of those embeddings before any real speech information
    arrives — and Canary's decoder cross-attends to ALL encoder
    positions at every step. On a 1.5 s clip, that's 5/19 = ~26% of the
    attention budget pointing at noise. Combined with the 10-token
    prompt prefix (``<|startoftranscript|><|en|>…``), the decoder gets
    trapped in degenerate loops: ``"I speak if I spe, if I speak..."``
    or character-level ``"ikkkkkkkk"`` until the repeat-guard fires.
    The ``transcribe-rs`` pipeline never injects leading silence
    (VAD is applied BEFORE the recorder yields samples).

    We trim by walking forward in 20 ms windows (``AED_LEADING_SILENCE_WINDOW``
    samples) while the RMS stays below ``AED_LEADING_SILENCE_RMS_THRESHOLD``,
    capped at ``AED_MAX_LEADING_TRIM_SAMPLES`` so a fully-silent clip
    doesn't collapse to length 0 (the AED pad runs after this and
    needs at least 1 sample to operate on).

    The RMS threshold is chosen so this only catches programmatic
    zero-padding (exactly 0.0 samples) — real quiet-room mic noise
    reads above the threshold and is preserved untouched.
    """
    if audio.size == 0:
        return audio
    window = AED_LEADING_SILENCE_WINDOW
    threshold = AED_LEADING_SILENCE_RMS_THRESHOLD
    max_trim = min(AED_MAX_LEADING_TRIM_SAMPLES, audio.shape[0] - 1)
    cursor = 0
    while cursor + window <= max_trim:
        chunk = audio[cursor : cursor + window]
        # RMS = sqrt(mean(x^2)). Compute in float64 to avoid underflow
        # on near-zero windows.
        rms = float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))
        if rms > threshold:
            break
        cursor += window
    if cursor == 0:
        return audio
    return audio[cursor:].astype(np.float32, copy=False)


def maybe_pad_for_aed(audio: npt.NDArray[np.float32]) -> npt.NDArray[np.float32]:
    """Zero-pad short audio up to ``AED_PAD_TO_SAMPLES`` for Canary/Cohere.

    Sub-second clips give Canary's 10-token prompt context an outsized
    influence on the decoder argmax — the model will keep emitting
    intra-sentence ``.`` until it hits something resembling an end-of-
    utterance acoustic feature. Padding to ~1.25 s of trailing silence
    gives the model the acoustic "rest" cue it expects and dramatically
    reduces dot-loops on accidental short taps.
    """
    if audio.size == 0:
        return audio
    if audio.shape[0] >= AED_MIN_SAMPLES:
        return audio
    pad = np.zeros(AED_PAD_TO_SAMPLES - audio.shape[0], dtype=np.float32)
    return np.concatenate([audio, pad], axis=0).astype(np.float32, copy=False)


def maybe_prepend_silence_for_parakeet(
    audio: npt.NDArray[np.float32],
) -> npt.NDArray[np.float32]:
    """Prepend 250 ms zero silence for Parakeet transducer engines.

    Matches transcribe-rs's default. Inexpensive — adds ~4 KB to the
    waveform and is dwarfed by even one mel-frame's worth of compute.
    """
    if audio.size == 0:
        return audio
    pad = np.zeros(PARAKEET_LEADING_SILENCE_SAMPLES, dtype=np.float32)
    return np.concatenate([pad, audio], axis=0).astype(np.float32, copy=False)


# Apply patches at module import so the ``OnnxAsrTranscriber`` adapter
# never sees an un-patched engine class. Tests can re-import after
# clearing ``_PATCHES_APPLIED`` for assertion purposes.
if os.environ.get("WINSTT_SKIP_DECODER_PATCHES") != "1":
    apply_onnx_decoder_patches()
