"""Regression coverage for the streaming downloader's per-quant file selection.

Two bugs hid behind ``_select_files_for_quant`` for months — they only
surfaced once users started downloading alphacep / Vosk models:

1. ``_matches_quantization`` only accepted ``_`` as the separator between
   the stem and the quant label. alphacep / Vosk uses ``.``
   (``am/encoder.int8.onnx``), so a default-quant download silently
   pulled BOTH precisions (filter fell through to ``quantization == ""``)
   and an int8 request matched nothing at all.
2. ``_select_files_for_quant`` only picked ``.onnx*`` weights and
   ``config.{json,yaml}``. Vosk's vocab lives in ``lang/tokens.txt``
   (and other onnx-asr loaders need ``tokenizer.json`` /
   ``tokenizer_config.json`` / ``v?_vocab.txt`` / ``vocab.json`` /
   ``added_tokens.json``). The downloader happily reported "completed"
   while the subsequent ``onnx_asr.load_model()`` died with a missing-vocab
   error.

Both fixes mirror the file declarations in onnx-asr's per-family
``_get_model_files`` (kaldi.py, moonshine.py, cohere_asr.py, granite_speech.py,
nemo.py, gigaam.py, whisper/_base.py).
"""

from __future__ import annotations

from src.recorder.infrastructure.streaming_downloader import (
    _matches_quantization,
    _select_files_for_quant,
)

#: Mirror of ``alphacep/vosk-model-small-ru``'s actual HF repo listing. Kept
#: literal so a future repo reorganisation that breaks the picker shows up here.
_VOSK_REPO_FILES: list[str] = [
    "README.md",
    "am/decoder.int8.onnx",
    "am/decoder.onnx",
    "am/encoder.int8.onnx",
    "am/encoder.onnx",
    "am/joiner.int8.onnx",
    "am/joiner.onnx",
    "decode.py",
    "lang/bpe.model",
    "lang/tokens.txt",
    "lang/unigram_500.vocab",
    "test.wav",
]


class TestMatchesQuantization:
    """Both separator conventions must round-trip cleanly."""

    def test_onnx_community_underscore_separator(self) -> None:
        # ``onnx-community`` / Optimum exports.
        assert _matches_quantization("encoder_model.onnx", "") is True
        assert _matches_quantization("encoder_model.onnx", "int8") is False
        assert _matches_quantization("encoder_model_int8.onnx", "int8") is True
        assert _matches_quantization("encoder_model_int8.onnx", "") is False

    def test_alphacep_period_separator(self) -> None:
        # Vosk / alphacep exports — this is the case that was misclassified.
        assert _matches_quantization("am/encoder.onnx", "") is True
        assert _matches_quantization("am/encoder.onnx", "int8") is False
        assert _matches_quantization("am/encoder.int8.onnx", "int8") is True
        # The regression bait: a ``.int8`` file MUST NOT count as default.
        assert _matches_quantization("am/encoder.int8.onnx", "") is False

    def test_external_data_sidecars(self) -> None:
        # Whisper-large-class models ship a ``.onnx_data`` (or ``.onnx.data``)
        # sidecar that has to ride the same quant routing as its weights.
        assert _matches_quantization("model.int8.onnx.data", "int8") is True
        assert _matches_quantization("model.int8.onnx_data", "int8") is True
        assert _matches_quantization("model.onnx.data", "") is True
        assert _matches_quantization("model_int8.onnx_data", "int8") is True


class TestSelectFilesForQuant:
    def test_vosk_default_picks_only_default_weights_plus_tokens(self) -> None:
        picked = set(_select_files_for_quant(_VOSK_REPO_FILES, ""))
        # Three default-precision weights …
        assert "am/encoder.onnx" in picked
        assert "am/decoder.onnx" in picked
        assert "am/joiner.onnx" in picked
        # … plus the vocab sidecar onnx-asr's kaldi loader requests.
        assert "lang/tokens.txt" in picked
        # And critically: NO ``.int8`` weights leak into the default download.
        assert "am/encoder.int8.onnx" not in picked
        assert "am/decoder.int8.onnx" not in picked
        assert "am/joiner.int8.onnx" not in picked
        # README / decode.py / test.wav / bpe.model / unigram_500.vocab are
        # not onnx-asr inputs.
        assert "README.md" not in picked
        assert "lang/bpe.model" not in picked

    def test_vosk_int8_picks_only_int8_weights_plus_tokens(self) -> None:
        picked = set(_select_files_for_quant(_VOSK_REPO_FILES, "int8"))
        assert "am/encoder.int8.onnx" in picked
        assert "am/decoder.int8.onnx" in picked
        assert "am/joiner.int8.onnx" in picked
        assert "lang/tokens.txt" in picked
        # Default-precision weights MUST be skipped.
        assert "am/encoder.onnx" not in picked
        assert "am/decoder.onnx" not in picked
        assert "am/joiner.onnx" not in picked

    def test_onnx_community_layout_round_trips(self) -> None:
        # Sanity: the fix doesn't regress the onnx-community / underscore
        # convention. Whisper / Cohere / Moonshine all live in this shape.
        files = [
            "encoder_model.onnx",
            "encoder_model_int8.onnx",
            "decoder_model_merged.onnx",
            "decoder_model_merged_int8.onnx",
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
        ]
        default = set(_select_files_for_quant(files, ""))
        assert default == {
            "encoder_model.onnx",
            "decoder_model_merged.onnx",
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
        }
        int8 = set(_select_files_for_quant(files, "int8"))
        assert int8 == {
            "encoder_model_int8.onnx",
            "decoder_model_merged_int8.onnx",
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
        }

    def test_gigaam_versioned_vocab_picked(self) -> None:
        # GigaAM's vocab files are version-prefixed (``v2_vocab.txt``,
        # ``v3_e2e_ctc_vocab.txt``). The ``_vocab.txt`` suffix branch is
        # what keeps them in the download set without enumerating each
        # version explicitly.
        files = [
            "v3_ctc.onnx",
            "v3_ctc_int8.onnx",
            "v3_vocab.txt",
            "v3_e2e_ctc_vocab.txt",
            "config.json",
        ]
        picked = set(_select_files_for_quant(files, ""))
        assert "v3_vocab.txt" in picked
        assert "v3_e2e_ctc_vocab.txt" in picked
        # Quant-suffixed weight MUST NOT leak into the default download.
        assert "v3_ctc_int8.onnx" not in picked
        assert "v3_ctc.onnx" in picked


class TestFileQuantizationParity:
    """``model_cache._file_quantization`` is the inverse probe of the
    selector — same separator rules must apply or the per-quant cache state
    paints "downloaded" on a quant whose bytes aren't really on disk."""

    def test_period_and_underscore_separators(self) -> None:
        from pathlib import Path

        from src.recorder.infrastructure.model_cache import _file_quantization

        assert _file_quantization(Path("encoder.int8.onnx")) == "int8"
        assert _file_quantization(Path("encoder_model_int8.onnx")) == "int8"
        assert _file_quantization(Path("encoder.onnx")) == ""
        assert _file_quantization(Path("encoder_model.onnx")) == ""
        assert _file_quantization(Path("model.int8.onnx.data")) == "int8"
        assert _file_quantization(Path("model_int8.onnx_data")) == "int8"
