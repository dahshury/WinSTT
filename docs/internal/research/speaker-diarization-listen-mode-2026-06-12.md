# Speaker Diarization Options for WinSTT Listen Mode

Date: 2026-06-12  
Scope: models and services that can plausibly add speaker labels to WinSTT's existing transcription pipeline for passive listening to system audio, including YouTube/video playback. This is not a survey of every diarization paper; it is a deployability survey for low-latency listening mode.

## Executive Summary

WinSTT already has the right architectural pieces for a local diarizer: loopback capture produces 16 kHz mono audio, the app already links `sherpa-onnx`, and the Rust tree already contains session-stable clustering/timeline code. The current production gap is not model discovery; it is that `DiarizationManager::assign_speakers` still degrades every utterance to speaker 0, and the listen worker currently calls it with no useful time span. The highest-leverage local path is to finish the existing sherpa/ONNX design: run a rolling segmentation plus embedding worker, merge results into the existing `SpeakerTimeline`, and assign speaker IDs to finalized transcript words or segments.

The best "fast enough while a YouTube video plays" local candidates are:

1. **Finish the current sherpa-onnx/pyannote-style pipeline**: pyannote segmentation via ONNX plus 3D-Speaker/NeMo/WeSpeaker embeddings and the existing `OnlineSpeakerClustering`. This fits the repo with the least dependency risk because `sherpa-onnx` is already linked and official sherpa docs expose Rust APIs and pretrained diarization assets.
2. **NVIDIA Streaming Sortformer v2.1**: strongest open true-streaming diarization model family found, with 1.04s and 30.4s latency modes in the model card, but it is NeMo/PyTorch first, capped at four output speakers, and governed by NVIDIA's open model license.
3. **Diart sidecar**: proven Python real-time diarization framework with 500 ms to 5 s configurable latency. It is a strong prototype path but not ideal for WinSTT's local-first Rust distribution unless a Python sidecar is acceptable.
4. **Cloud streaming APIs**: AssemblyAI, Deepgram, Speechmatics, Azure, and pyannoteAI Streaming can label speakers in real time with far less local work, but they change the product privacy/cost model.

Recommendation: implement the sherpa/ONNX path first, instrument real-time factor (RTF), and keep Sortformer as an experimental "advanced local diarizer" once the event/timeline plumbing exists.

## Current WinSTT Constraints

The listen-mode pipeline captures system audio, folds it to mono, resamples it to 16 kHz f32, applies Silero VAD, keeps a bounded speech buffer, and finalizes rolling transcription commits at about 20 seconds or after sustained silence. The worker also emits real-time transcription preview from the native streaming recognizer before final commit. This means diarization should not wait for a 20 second final transcription job. It should receive the same 16 kHz frames in parallel and maintain its own rolling state.

The Rust module split already anticipates this. `winstt::diarization` contains pure arithmetic for active intervals, AHC clustering, online centroid clustering, `SpeakerTimeline`, and word-to-speaker assignment. `DiarizationManager` is the lifecycle shell, but it currently returns a single speaker segment and has comments marking the model wiring as a spike. That is important: replacing the whole subsystem would discard code that was written for session-stable IDs, which is exactly what listen mode needs.

The listener UI should expect two latencies: text latency and speaker attribution latency. Realistic local diarization should target RTF < 1.0 and attribution lag of roughly 1-3 seconds for usable live captions. A stricter sub-500 ms speaker label is possible with cloud/pyannoteAI beta and some Diart settings, but it is not a reasonable first local target if the app must stay small and CPU-friendly.

## Model and Service Matrix

| Option | Local/cloud | Streaming fit | Integration fit for WinSTT | Main constraints |
| --- | --- | --- | --- | --- |
| sherpa-onnx diarization assets | Local | Rolling windows, not necessarily true online | Best fit; Rust API, already linked | Need segmentation output wiring and model download/cache policy |
| pyannote-rs | Local | Batch/sliding window | Good Rust prototype, DirectML/CoreML claims | Separate ONNX runtime stack may collide with existing `ort` policy |
| NVIDIA Streaming Sortformer v2.1 | Local/server | True streaming | Strong model, but NeMo/PyTorch first | Four-speaker output cap; heavier dependency/licensing review |
| Diart | Local sidecar | True online, 500 ms-5 s | Excellent prototype sidecar | Python/PyTorch packaging burden |
| pyannote.audio Community-1 | Local/server | Batch/offline | High accuracy offline fallback | PyTorch, HF gated model flow, not true live without chunk orchestration |
| pyannoteAI Streaming | Cloud | True streaming | Fastest external diarization-only API | Beta, cloud dependency |
| AssemblyAI Streaming Diarization | Cloud | True streaming | Easiest if replacing/adding cloud STT stream | Diarization tied to their streaming STT |
| Deepgram diarize_model | Cloud | Streaming v1 | Easy if using Deepgram STT | v2 diarizer is batch-only as of docs |
| Speechmatics Realtime Diarization | Cloud/on-prem | True streaming | Good enterprise/cloud path | Usually full STT provider integration |
| Azure real-time diarization | Cloud | True streaming | Useful for enterprise option | Uses Azure Speech SDK/conversation transcriber |
| SpeechBrain ECAPA/VBx/FunASR CAM++ | Local/server | Mostly batch or custom | Useful components, not primary live path | More glue code, often Python-first |

## Findings

### 1. The native local path should reuse sherpa-onnx and WinSTT's existing online clustering

Sherpa-onnx is the cleanest local fit because WinSTT already links `sherpa-onnx` for wake word and diarization embedding, and the upstream docs list pretrained speaker segmentation models, pretrained speaker embedding extraction models, and examples across languages including Rust. The sherpa docs specifically list pyannote segmentation 3.0, 3D-Speaker, NeMo, int8 variants, and Rust API examples for speaker diarization [1].

That maps directly to the code already present in `src-tauri/src/winstt/diarization`. The intended design is standard: segmentation estimates active speakers over frames; crops produce embeddings; an online clusterer keeps session-stable IDs; a timeline assigns speakers to transcript words. This is better than running sherpa's offline diarizer per utterance because offline AHC IDs can swap across utterances. Listen mode needs "Speaker 1" to remain the same person over a long video/call.

The most practical implementation is a new `DiarizationWorker` fed by loopback frames before VAD commit. It should keep a 30-60 second ring buffer, process 3-5 second windows on a 0.5-1.0 second hop, and publish updated `SpeakerTimeline` spans. On final transcription, the existing `assign_speakers_to_words` logic should map words to the current timeline. If a selected STT model does not expose word timings, WinSTT can initially emit segment-level labels by intersecting the transcript chunk time span with the timeline, then improve with word alignment later.

This can be real-time on modern CPUs if the segmentation/embedding window is bounded and computed on a background worker. It is also the least risky licensing/distribution path: no Python runtime, no network dependency, and no new cloud data flow.

### 2. NVIDIA Streaming Sortformer is the strongest true-streaming local model family, but it is not the first integration step

NVIDIA's Streaming Sortformer paper describes a streaming extension that uses an Arrival-Order Speaker Cache to keep speaker labels consistent across chunks, and the model/code are made available through NeMo and Hugging Face [7]. NVIDIA's technical blog positions Streaming Sortformer as real-time diarization for meetings, contact centers, voicebots, and media, with frame-level speaker tags, timestamps, minimal latency, and up to four speakers in current output [8].

The Hugging Face v2.1 model card confirms the practical details that matter for WinSTT. The model has a 4-sigmoid output head, needs NeMo for official use, is governed by NVIDIA's open model license, and reports evaluation in both 30.4s and 1.04s latency modes [9]. At 1.04s latency, it is a plausible local live-caption diarizer. The catch is packaging and runtime: official support is PyTorch/NeMo, not the existing Rust `ort` stack. There are community Rust/ONNX ports, but they should be treated as experimental until tested against WinSTT's Windows build, DirectML policy, model download cache, and binary size constraints.

Sortformer is a better second engine than first engine. If WinSTT builds the diarization worker API around "audio in, timeline spans out," then Sortformer can be swapped in later. Starting with Sortformer first would solve the model choice while leaving the same product plumbing unsolved.

### 3. Diart is the best open-source Python sidecar for low-latency online diarization

Diart is explicitly built for real-time speaker diarization. Its pipeline combines segmentation, speaker embedding, and incremental clustering, and its docs show microphone/file stream processing, WebSocket serving, and a 5 second window with 500 ms shift [5]. The original Diart paper/design adjusts latency between 500 ms and 5 seconds, and the project exposes WebSocket server/client patterns that could be used as a sidecar boundary [5]. JOSS published Diart as a real-time speaker diarization Python library in 2024 [6].

For WinSTT, Diart is best used as a research/prototype harness or optional external service. It can validate UX quickly: feed captured loopback PCM over WebSocket, receive RTTM-like speaker spans, map spans to transcripts. It is not ideal as the default local engine because packaging Python, PyTorch, pyannote model auth, GPU/CPU selection, and wheels inside a Tauri Windows app adds a lot of failure modes.

### 4. pyannote.audio Community-1 and pyannoteAI Precision-2 are accuracy leaders, but live integration differs sharply by product

pyannote Community-1 is a strong self-hosted/offline model. Its model card says it improves over earlier pyannote.audio pipelines, provides exclusive diarization output for easier STT reconciliation, and can be run fully offline after accepting the model terms [2]. pyannoteAI's Precision-2 is the hosted premium model; pyannoteAI reports a 28% accuracy improvement over pyannote.audio OSS 3.1 and 14% over Precision-1 on its benchmarks, plus better speaker-count control and exclusive mode [3].

For live listening, the key update is pyannoteAI's May 4, 2026 streaming beta: live audio over WebSocket, timestamped speaker labels in real time, around 300 ms diarization latency, max 8 speakers, and 16 kHz mono audio in 100 ms chunks [4]. That is an excellent cloud diarization-only option if WinSTT can offer a cloud mode separate from local-first mode. It also gives a useful target interface for the local worker: 100 ms PCM chunks in, timestamped speaker spans out.

The local pyannote option remains batch/sliding-window. It can be made "near real-time" with rolling windows, but pyannote's standard pipelines are not the same as a true streaming diarizer unless wrapped as Diart or a custom worker.

### 5. Cloud APIs are fastest to ship but change the product promise

AssemblyAI's Streaming Diarization is a mature real-time API path. Their docs show `speaker_labels=true`, a turn-level `speaker_label`, word-level final speaker fields, support across streaming models, and an optional max-speaker hint. They also document that short turns under roughly one second can be unknown because embeddings need enough audio [10].

Deepgram's diarization docs show `diarize_model=latest` as the recommended selector. Their docs state that streaming currently resolves to the v1 diarizer, while v2 is batch-only and not supported for streaming [11]. Speechmatics offers realtime speaker diarization with speaker IDs on word/punctuation objects, optional sensitivity, max speaker controls, and a "prefer current speaker" setting to reduce false switches [12]. Google Cloud Speech-to-Text supports diarization for streaming recognition, but its docs note the streaming response contains an aggregate of results, which means clients must handle repeated prior words and final aggregation carefully [13]. Azure Speech has a real-time diarization quickstart using the Speech SDK and conversation transcription; Microsoft notes that early intermediate results may be `Unknown` unless intermediate diarization results are enabled [14].

These are viable if WinSTT wants a cloud listen mode. They are less attractive for the local-first default because they require sending system audio to a provider. They also often couple diarization to the provider's transcription stream, which conflicts with the user's stated desire to keep WinSTT's transcription pipeline and add diarization.

### 6. Component models are useful, but not enough by themselves

SpeechBrain's ECAPA-TDNN model is a high-quality speaker embedding model under Apache-2.0 that extracts embeddings at 16 kHz and supports GPU inference [15]. VBx is a strong clustering/backend method for x-vector sequences and is well established for offline diarization [16]. FunASR/CAM++ and 3D-Speaker are also useful components, especially for Chinese/multilingual ecosystems, and sherpa-onnx already exposes 3D-Speaker/NeMo combinations for diarization [1].

These are building blocks, not complete listen-mode systems. A production live diarizer still needs segmentation, overlap handling, incremental clustering, timeline reconciliation, and stable speaker IDs. WinSTT already owns most of that deterministic glue; the missing part is the model-backed segmentation/embedding worker.

## Recommended Architecture

The implementation should be model-agnostic at the manager boundary:

```text
LoopbackCapture -> 16 kHz mono f32 frames
        |-> current VAD/STT preview/final transcription path
        |-> DiarizationWorker: rolling audio ring -> model -> SpeakerTimeline

Final transcript + word/segment times -> assign speakers from SpeakerTimeline -> emit speaker_segments
```

The `DiarizationWorker` trait should expose:

```rust
trait StreamingDiarizer {
    fn reset(&mut self);
    fn accept_audio(&mut self, absolute_start_s: f64, pcm_16k: &[f32]);
    fn drain_segments(&mut self) -> Vec<SpeakerSegment>;
}
```

Start with `SherpaRollingDiarizer`, backed by pyannote-style segmentation and a speaker embedder. Keep `SortformerDiarizer` and `CloudDiarizer` as later engines behind the same interface.

Key engineering requirements:

- Add absolute timing to loopback commits. `assign_speakers(0.0, 0.0, text)` cannot support diarization.
- Keep a ring buffer and process windows in a single dedicated worker to avoid blocking capture or STT.
- Measure RTF, queue depth, and attribution lag in logs. Gate feature enablement on RTF < 1 under CPU default.
- Prefer exclusive diarization spans for transcript reconciliation. Overlap-aware spans are useful for analysis but complicate one-speaker-per-word UI.
- Keep speaker IDs session-stable with `OnlineSpeakerClustering`; do not trust per-window offline cluster IDs.
- Add a "speaker labels pending" UI state if transcript text arrives before diarization spans.

## Ranked Recommendation

**First implementation: sherpa-onnx rolling diarizer.** It fits WinSTT's current dependencies and code shape, preserves local-first behavior, and gets speaker labels into listen mode without a Python stack.

**Best optional cloud mode: pyannoteAI Streaming if diarization-only is desired, AssemblyAI/Speechmatics/Deepgram/Azure if WinSTT is willing to let the provider own STT too.** pyannoteAI's streaming beta is closest to "keep our transcription, outsource only diarization."

**Best experimental local advanced engine: NVIDIA Streaming Sortformer v2.1.** Use it after the local worker/timeline plumbing is done. It is compelling for true streaming but heavier and capped at four output speakers.

**Avoid as primary path:** WhisperX-style batch diarization, pure SpeechBrain/VBx, FunASR sentence speaker labels, and cloud batch APIs. They are useful for file transcription or prototyping, but they do not naturally meet listen-mode real-time requirements.

## Bibliography

[1] sherpa-onnx documentation. "Speaker Diarization." https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html

[2] pyannote. "pyannote/speaker-diarization-community-1." Hugging Face model card. https://huggingface.co/pyannote/speaker-diarization-community-1

[3] pyannoteAI. "Setting a new standard with Precision-2." https://www.pyannote.ai/blog/precision-2

[4] pyannoteAI. "Streaming Diarization - Beta access." Changelog, May 4 2026. https://www.pyannote.ai/changelog

[5] Coria et al. "diart: A python package to build AI-powered real-time audio applications." GitHub. https://github.com/juanmc2005/diart

[6] Coria et al. "Diart: A Python Library for Real-Time Speaker Diarization." Journal of Open Source Software, 2024. https://joss.theoj.org/papers/10.21105/joss.05266

[7] Medennikov et al. "Streaming Sortformer: Speaker Cache-Based Online Speaker Diarization with Arrival-Time Ordering." arXiv, 2025. https://arxiv.org/html/2507.18446v1

[8] NVIDIA Developer Blog. "Identify Speakers in Meetings, Calls, and Voice Apps in Real-Time with NVIDIA Streaming Sortformer." https://developer.nvidia.com/blog/identify-speakers-in-meetings-calls-and-voice-apps-in-real-time-with-nvidia-streaming-sortformer/

[9] NVIDIA. "nvidia/diar_streaming_sortformer_4spk-v2.1." Hugging Face model card. https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1

[10] AssemblyAI. "Streaming Diarization and Multichannel." https://www.assemblyai.com/docs/streaming/label-speakers-and-separate-channels

[11] Deepgram. "Speaker Diarization." https://developers.deepgram.com/docs/diarization

[12] Speechmatics. "Realtime diarization." https://docs.speechmatics.com/speech-to-text/realtime/realtime-diarization

[13] Google Cloud. "Detect different speakers in an audio recording." https://docs.cloud.google.com/speech-to-text/docs/multiple-voices

[14] Microsoft Learn. "Quickstart: Create real-time diarization." https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-stt-diarization

[15] SpeechBrain. "speechbrain/spkrec-ecapa-voxceleb." Hugging Face model card. https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb

[16] BUTSpeechFIT. "VBx: Variational Bayes HMM over x-vectors diarization." https://github.com/BUTSpeechFIT/VBx

[17] thewh1teagle. "pyannote-rs." GitHub. https://github.com/thewh1teagle/pyannote-rs

[18] Aperdannier, Schacht, Piazza. "Systematic Evaluation of Online Speaker Diarization Systems Regarding their Latency." arXiv, 2024. https://arxiv.org/abs/2407.04293

