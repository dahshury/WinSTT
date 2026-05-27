"""Unit coverage for the WAV writer that persists single-utterance PCM.

The writer mirrors Handy's ``audio_toolkit::save_wav_file`` (16 kHz mono
16-bit PCM) so the renderer's ``<audio>`` element can play it back without a
provider-specific decoder. These tests pin the format + the error-tolerant
contract (writer never raises, returns "" on failure) the recorder service
depends on.
"""

from __future__ import annotations

import os
import wave
from pathlib import Path

import pytest

from src.recorder.application.wav_writer import make_wav_filename, write_pcm_wav


def _silence_pcm(samples: int) -> bytes:
    """``samples`` int16 zero samples — convenient as a deterministic input."""
    return b"\x00\x00" * samples


def test_make_wav_filename_uses_explicit_timestamp() -> None:
    assert make_wav_filename(1_700_000_000) == "winstt-1700000000.wav"


def test_make_wav_filename_defaults_to_now(monkeypatch: pytest.MonkeyPatch) -> None:
    # Pin time.time so the file name is deterministic.
    import time

    monkeypatch.setattr(time, "time", lambda: 42)
    assert make_wav_filename() == "winstt-42.wav"


def test_write_pcm_wav_writes_16k_mono_16bit(tmp_path: Path) -> None:
    """The file format matches Handy's ``save_wav_file`` so the renderer
    can play it back without re-encoding."""
    samples = 1600  # 100 ms at 16 kHz
    out = write_pcm_wav(str(tmp_path), _silence_pcm(samples), timestamp=1234)
    assert out != ""
    full = Path(out)
    assert full.exists()
    with wave.open(str(full), "rb") as f:
        assert f.getnchannels() == 1
        assert f.getsampwidth() == 2  # 16-bit
        assert f.getframerate() == 16000
        assert f.getnframes() == samples


def test_write_pcm_wav_skips_empty_directory(tmp_path: Path) -> None:
    """Empty `directory` is the "save_wav=off" sentinel — return ""."""
    out = write_pcm_wav("", _silence_pcm(8), timestamp=42)
    assert out == ""


def test_write_pcm_wav_skips_empty_audio(tmp_path: Path) -> None:
    """No PCM (PTT release that captured nothing) → no file, no error."""
    out = write_pcm_wav(str(tmp_path), b"", timestamp=42)
    assert out == ""
    assert len(list(tmp_path.iterdir())) == 0


def test_write_pcm_wav_creates_recordings_dir(tmp_path: Path) -> None:
    target = tmp_path / "nested" / "subdir"
    out = write_pcm_wav(str(target), _silence_pcm(160), timestamp=99)
    assert out != ""
    assert target.exists()
    assert os.path.basename(out) == "winstt-99.wav"


def test_write_pcm_wav_swallows_write_errors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A disk error must never bubble — return "" and log instead."""
    monkeypatch.setattr(
        wave,
        "open",
        lambda *_args, **_kw: (_ for _ in ()).throw(OSError("disk full")),
    )
    out = write_pcm_wav(str(tmp_path), _silence_pcm(160), timestamp=11)
    assert out == ""


def test_write_pcm_wav_swallows_mkdir_errors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """If we can't create the recordings dir we still don't raise."""
    monkeypatch.setattr(
        Path,
        "mkdir",
        lambda *_a, **_kw: (_ for _ in ()).throw(OSError("EACCES")),
    )
    out = write_pcm_wav(str(tmp_path / "x"), _silence_pcm(160), timestamp=11)
    assert out == ""


def test_write_pcm_wav_honours_custom_sample_rate(tmp_path: Path) -> None:
    out = write_pcm_wav(str(tmp_path), _silence_pcm(320), sample_rate=8000, timestamp=7)
    assert out != ""
    with wave.open(out, "rb") as f:
        assert f.getframerate() == 8000
