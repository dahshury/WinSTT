# Wake Word Accuracy Options

Date: 2026-06-04

## Summary

The current sherpa-onnx KWS path is the best open-source option for typed,
no-training custom phrases, but it is not the best reliability ceiling for
always-on wake-word activation. The product should treat "typed custom phrase"
and "reliable custom wake phrase" as different modes:

- Typed phrase, available immediately: keep sherpa-onnx KWS, expose boost and
  threshold tuning, and label it as flexible/lower-confidence.
- Reliable custom phrase: train or enroll a dedicated detector. Prototype
  LiveKit WakeWord first, then compare against openWakeWord and rustpotter on
  WinSTT's own microphone/background corpus.
- Built-in supported phrases: consider legacy Porcupine 1.9.5 only for bundled
  built-in keywords after legal review. Current Porcupine should not be bundled
  as the default for a free/open app because it requires an AccessKey.

## Local Evidence

From the existing WinSTT synthetic benchmark report:

- sherpa-onnx exact SentencePiece KWS: strong on some common phrases, weak on
  others, and poor for arbitrary custom text (`hey winstt` was 0/8 in the small
  synthetic set).
- legacy Porcupine 1.9.5: 4/4 for each tested built-in phrase in the small
  synthetic set.
- rustpotter reference mode: 3/3 true positives and 0 false positives across the
  small synthetic fixtures with tuned thresholds.

These are smoke tests, not production accuracy numbers. They are useful because
they match the user-facing complaint: arbitrary custom words are much harder
than trained/built-in wake words.

## Accuracy And Fit Matrix

| Engine | Accuracy evidence | Custom support | License / shipping | Fit |
|---|---|---|---|---|
| LiveKit WakeWord | Project reports `0.08` FPPH and `86.1%` recall on a "hey livekit" validation set with 15,000 positives and 25 hours of negatives; conv-attention head is the win. | Train from text/config, export ONNX classifier. | Apache-2.0, Rust crate, embedding/front-end compiled into crate; classifier loaded at runtime. | Best first prototype for reliable trained custom phrases. |
| openWakeWord | Project targets `<0.5` false accepts/hour and `<5%` false rejects for included models with tuning; authors caution real evaluation is hard. | Train custom models, ONNX/TFLite; not instant runtime text-only. | Code Apache-2.0; included pretrained models are CC BY-NC-SA 4.0. | Strong baseline, but shipping pretrained models is license-sensitive. |
| sherpa-onnx KWS | No directly comparable public wake-word accuracy found; local results are mixed. It is a tiny ASR-style open-vocabulary KWS. | Text keyword list, no retraining; per-keyword boost and threshold. | Apache-2.0 ecosystem, ONNX/int8, Rust bindings already in use. | Best immediate typed custom phrase path, not best high-reliability path. |
| Porcupine current | Official FAQ claims `97%+` detection with `<1` false alarm per 10 hours and low Raspberry Pi CPU/memory. | Console creates platform-specific `.ppn` files from typed phrase. | Requires AccessKey; custom model generation tied to Picovoice Console. | Excellent technically, poor default-bundle fit for free/open distribution. |
| Porcupine 1.9.5 | Local smoke test was excellent on built-ins. PyPI metadata/API is keyless and Apache-classified; local wheel includes Windows DLL and bundled `.ppn` built-ins. | Built-ins and external `.ppn` paths; do not assume redistributable modern custom `.ppn` files. | Likely redistributable with Apache notices, but needs legal review. | Viable optional legacy built-in-keyword provider. |
| rustpotter | No large public benchmark; local tuned reference smoke test was good. | User enrollment from 3-8 WAVs, or train model from data. | Apache-2.0, Rust-native, no ONNX. | Useful near-term local enrollment fallback. |
| Vosk grammar | Mature ASR with vocabulary reconfiguration, but not a tiny wake-word engine. | Text grammar/vocabulary. | Apache-2.0, streaming API, heavier models. | Good second-stage confirmation, not primary always-on detector. |
| WeKWS / WeNet | Production-oriented small-footprint KWS toolkit, streaming predefined wake words. | Customizable/personalized via training, not typed runtime enrollment. | Open training/export stack; heavier integration. | Research/training reference, not quickest WinSTT swap. |
| Mycroft Precise / Snowboy / PocketSphinx | Historically relevant, but generally old, less maintained, or lower accuracy. | Varies. | Varies; Snowboy is effectively dead. | Do not use as new default. |

## Recommendation

1. Keep sherpa-onnx KWS as the immediate typed custom wake phrase backend, but
   stop presenting it as equally reliable to trained wake words.
2. Add an engine router:
   - legacy Porcupine 1.9.5 for supported built-ins, if legal review accepts it;
   - LiveKit WakeWord ONNX for trained custom models;
   - sherpa-onnx for instant typed custom phrases and/or confirmation.
3. Add a "train custom wake word" flow. It should generate/train a LiveKit model
   when possible, and keep rustpotter enrollment as a fast local path if GPU/cloud
   training is not available.
4. Benchmark on WinSTT-owned data before changing defaults: false positives/hour,
   false rejects, latency, CPU, memory, quiet/loud speakers, mic gain differences,
   Bluetooth headset latency, and background speech/music.

## Sources

- Picovoice Porcupine docs: https://picovoice.ai/docs/porcupine/
- Picovoice Porcupine FAQ: https://picovoice.ai/docs/faq/porcupine/
- Picovoice wake-word benchmark: https://picovoice.ai/docs/benchmark/wake-word/
- pvporcupine 1.9.5 PyPI: https://pypi.org/project/pvporcupine/1.9.5/
- LiveKit WakeWord: https://github.com/livekit/livekit-wakeword
- openWakeWord: https://github.com/dscripka/openWakeWord
- sherpa-onnx KWS: https://k2-fsa.github.io/sherpa/onnx/kws/index.html
- rustpotter: https://github.com/GiviMAD/rustpotter
- Vosk: https://alphacephei.com/vosk/
- WeKWS: https://github.com/wenet-e2e/wekws
- CTC-aligned open-vocabulary KWS paper: https://arxiv.org/abs/2406.07923
- Hyper-matched filters KWS paper: https://arxiv.org/abs/2508.04857

