import argparse
import csv
import struct
import sys
import time
import wave
from pathlib import Path

import pvporcupine


def phrase_from_path(path: Path) -> str:
    return path.stem.replace("_", " ").lower()


def iter_wavs(path: Path):
    if path.is_dir():
        yield from sorted(path.glob("*.wav"))
    else:
        yield path


def run_case(path: Path, keyword: str, sensitivity: float):
    porcupine = pvporcupine.create(
        keywords=[keyword],
        sensitivities=[sensitivity],
    )
    try:
        with wave.open(str(path), "rb") as wav:
            if wav.getframerate() != porcupine.sample_rate:
                raise ValueError(
                    f"{path} sample rate {wav.getframerate()} != {porcupine.sample_rate}"
                )
            if wav.getnchannels() != 1:
                raise ValueError(f"{path} channels {wav.getnchannels()} != 1")
            if wav.getsampwidth() != 2:
                raise ValueError(f"{path} sample width {wav.getsampwidth()} != 2")

            frame_length = porcupine.frame_length
            frame_index = 0
            started = time.perf_counter()
            while True:
                data = wav.readframes(frame_length)
                if len(data) < frame_length * 2:
                    run_ms = (time.perf_counter() - started) * 1000.0
                    return False, "", None, run_ms
                pcm = struct.unpack_from("<" + "h" * frame_length, data)
                result = porcupine.process(pcm)
                if result >= 0:
                    run_ms = (time.perf_counter() - started) * 1000.0
                    hit_time = (frame_index + 1) * frame_length / porcupine.sample_rate
                    return True, keyword, hit_time, run_ms
                frame_index += 1
    finally:
        porcupine.delete()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--sensitivity", default="0.5", help="single value or CSV")
    parser.add_argument("--keyword", help="override keyword for a single WAV")
    args = parser.parse_args()

    sensitivities = [float(item) for item in args.sensitivity.split(",")]
    writer = csv.writer(sys.stdout, lineterminator="\n")
    writer.writerow(
        [
            "audio",
            "keyword",
            "sensitivity",
            "detected",
            "hit_word",
            "hit_time_s",
            "run_ms",
        ]
    )
    for wav_path in iter_wavs(args.audio):
        keyword = args.keyword or phrase_from_path(wav_path)
        if keyword not in pvporcupine.KEYWORDS:
            continue
        for sensitivity in sensitivities:
            detected, hit_word, hit_time, run_ms = run_case(wav_path, keyword, sensitivity)
            writer.writerow(
                [
                    str(wav_path),
                    keyword,
                    sensitivity,
                    str(detected).lower(),
                    hit_word,
                    "" if hit_time is None else f"{hit_time:.3f}",
                    f"{run_ms:.3f}",
                ]
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
