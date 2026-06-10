# onnx-asr Fork Strategy

> **Status:** Decision proposal — 2026-05-11 (revised after follow-up review)
> **Author:** Research synthesis (6 agent investigations — see Methodology at end)
> **Scope:** Strategic direction for `winstt/onnx-asr` to reach feature parity with the old WinSTT (RealtimeSTT-backed) stack while keeping the path to SaaS open.

---

## TL;DR — The Eight Decisions (revised)

| # | Question | Decision | Confidence |
|---|---|---|---|
| 1 | Migrate Python → TypeScript? | **No. Stay Python for the engine; TS stays in Electron shell.** | High |
| 2 | Library boundary — stay a library or merge into backend? | **Stay a library. Vendor it as an editable path dependency in the monorepo. Don't publish to PyPI yet.** See §2.5. | High |
| 2b | Hexagonal architecture inside the library? | **No. Keep onnx-asr's flat layout. Add one internal model-strategy ABC, no full ports/adapters.** | High |
| 3 | Beam search + temperature fallback + decode params? | **Yes — major work item. Tiered exposure: 6 "hot" knobs, ~8 "advanced" knobs, ~6 "default-only".** See §3. | High |
| 4 | Streaming transcription? | **Whisper streaming is mandatory.** Per-model technique routed by capability flag. Whisper: LocalAgreement-2 + `_timestamped` ONNX exports for buffer trim. Parakeet TDT (when streaming export available): native cache-aware. Plus separate preview model + main model architecture (RealtimeSTT pattern). See §4. | High |
| 5 | Generalized Whisper module? | **Yes — refactor `whisper.py` into a base `_WhisperBase` with capability flags (timestamps, beam, fallback, streaming).** | High |
| 6 | VAD architecture? | **Keep dual-VAD (WebRTC cheap pre-filter + Silero confirm). The CPU-saving trick matters for always-on listening, laptops, low-end hardware.** See §6. | High |
| 6b | Swappable inference engine + everything else? | **Every component behind a port. No lock-in to ONNX, to Whisper, to Silero, to any specific LLM.** New `§2.6` enumerates the full port surface. | High |
| 7 | Server framework — stay or move to FastAPI? | **Move to FastAPI + native `WebSocketRoute`.** Low-risk DX win. | Medium |
| 8 | RealtimeSTT features to port? | **~15 capabilities flagged "must have" — see §9.** Realtime cadence, Silero VAD, callbacks, pre-recording buffer top the list. | High |

---

## 1. Language: Python vs TypeScript

### The question
Rewrite the STT engine in TypeScript for type safety + "AI-agent friendliness", or keep it Python?

### Evidence — what comparable Electron STT apps actually do

| Repo (in `examples/`) | UI | ASR engine actually used | Pure-JS ASR? |
|---|---|---|---|
| voicetypr | Tauri/React/TS | Rust backend + **Swift sidecar** (FluidAudio Parakeet, 1.2 MB) | No |
| openwhispr | Electron/React | **whisper.cpp binary** + **sherpa-onnx binary** + onnxruntime-node in isolated child process; **hand-rolled 130-line FFT+mel filterbank** (`src/workers/onnxWorker.js`) | No |
| whishpy | Python (py2app/rumps) | Groq cloud + OpenAI | n/a — cloud |
| epicenter/whispering | Tauri/SvelteKit | Cloud APIs + `@ricky0123/vad-web` (browser-only) | No (cloud) |
| WinSTT (current) | Electron/Next.js | Python WS server | No |

**Zero of these run production Whisper inference in pure JS.** Every offline one either embeds a binary or runs ORT in an isolated process.

### Library-by-library parity check

| Capability | Python today | TS option | Status | Net |
|---|---|---|---|---|
| ONNX Runtime (CPU) | onnxruntime | onnxruntime-node | Parity | tie |
| ONNX Runtime (CUDA Windows) | onnxruntime-gpu | **No official CUDA EP** — community fork `onnxruntime-node-gpu` (dakenf, lags releases) or sherpa-onnx prebuilds | Python wins | **Python** |
| ONNX Runtime (DirectML Win) | DML EP | DML EP available | Parity | tie |
| DLL hell (cuDNN/cublas) | Painful | Identically painful | Equal | tie |
| Whisper tokenizer | `tokenizers` (Rust) | `@huggingface/transformers` v3 | HF docs warn "Whisper not yet supported by fast tokenizers, may produce slightly inaccurate results" | Python edge |
| Log-mel / FFT | librosa / torchaudio | None production-grade — OpenWhispr **hand-wrote it** | **No library parity** | **Python wins decisively** |
| Mic capture (server-side) | PyAudio | naudiodon ("recommended for prototypes only") | Python far ahead | Python |
| Silero VAD (Node) | silero-vad PyPI | **`@ricky0123/vad-node` DISCONTINUED Oct 2024** — only `vad-web` (browser) | Dead in Node | **Python** |
| OpenWakeWord | Official Python | No JS port | Missing | Python |
| HuggingFace Hub progress callback | Native (used in our fork) | **Open issue `huggingface.js#1331`** — not implemented | Missing | Python |
| Streaming runtime | sherpa-onnx-python | sherpa-onnx (npm 1.12.37) | Parity | tie |
| WebSocket server | `websockets` | `ws` / `uWebSockets.js` | Parity | tie |
| Type safety | mypy --strict | tsc strict | TS slight edge | TS |

### Verdict

**Stay Python for the engine. Keep TS in the Electron shell.**

A full TS rewrite would force us to:
1. Hand-write Whisper's log-mel + FFT pipeline (no library matches `librosa`/`torchaudio` — OpenWhispr proves this with 130 lines of custom Cooley-Tukey).
2. Depend on an unofficial CUDA fork (`onnxruntime-node-gpu`) on Windows, or bundle sherpa-onnx binaries per platform.
3. Lose Silero VAD in Node entirely (port discontinued).
4. Lose HuggingFace Hub progress (the feature we just landed) until upstream fixes it.
5. Re-prove Whisper tokenizer correctness on a port that HF itself disclaims for Whisper.

The "type safety + AI ergonomics" win does not recoup five concrete library losses. Python with `mypy --strict` is already strict; ruff catches what TS-style linting would.

**Where TS earns its keep:** Electron main process, IPC contract typed from OpenAPI, settings, hotkeys, tray, UI. Everything WinSTT already does. No change needed.

### Aside: optional future hedge
Keep `sherpa-onnx` (npm) on the radar as a **second engine** behind a feature flag if we ever need a Python-free distribution path. Don't build for it now.

---

## 2. Architecture: Hexagonal vs Flat

### The question
Should the onnx-asr fork adopt the same hexagonal layout as `examples/WinSTT-old-history` (and our current `server/`)?

### Evidence
- **WinSTT-old-history** is an *app* with 671 Python files. Hexagonal pays for itself there: real `TranscriptionEnginePort` Protocol, `SimpleTranscriptionAdapter`, swappable VAD strategies, mockable for tests. But also: **4 hops of indirection** (`AudioToTextService → SimpleTranscriptionAdapter → ONNXTranscriptionService → OnnxModelLoader`) to change a model parameter, and 56 transcription-related `.py` files.
- **onnx-asr is a library, not an app.** Users do `load_model("whisper-base")` → `.recognize(audio)`. They never instantiate the DI graph.
- **Mature ASR libraries are all flat:** OpenAI Whisper (monolithic `model.py`, single `transcribe()`), faster-whisper (single `WhisperModel` class with VAD as constructor kwarg, ~1500 LOC). None use ports/adapters at the package boundary.
- **Our own server already proves the right pattern:** `OnnxAsrTranscriber` in `server/src/recorder/infrastructure/onnxasr_transcriber.py` is **63 lines** wrapping `onnx_asr.load_model()` as a blackbox behind the `ITranscriber` port. The hexagonal layer lives in the *application*, not the *library*.

### Decision
**Keep onnx-asr's flat `models/ + preprocessors/ + loader.py + resolver.py` layout.** Public API stays:

```python
from onnx_asr import load_model
model = load_model("whisper-large-v3-turbo")
text = model.recognize(audio, sample_rate=16000, language="en")
```

**One light internal abstraction worth adding:** a private `_ModelImplementation` ABC (or Protocol) that every model in `models/` inherits. Underscore-prefixed so it never escapes the public API. Justified because:
- We're about to fork-add multiple Whisper variants (Lite-Whisper, Distil-Whisper, turbo, timestamped variants). A shared base prevents drift.
- Enables `FakeModel` fixture for tests without 100 MB downloads.
- Costs ~30 LOC base + 5 LOC of `@override` per existing model.

**What we will NOT do:** introduce `domain/`, `application/`, `infrastructure/`, `ports/`, `bootstrap/`, EventBus, Kink DI inside the library. That belongs to the *server* (where it already exists), not the engine.

---

## 2.5 Library Boundary — When the Engine Stops Being a Library

### The question (user's framing)
> "In WinSTT the inference that the lib does today was a part of the backend. When and why should it stay a library? Or be merged into the backend? And how does that affect the product?"

This is a separate axis from §2 (which is about *internal* architecture). §2.5 is about whether onnx-asr deserves a package boundary at all.

### Current state
- onnx-asr is a fork at `examples/onnx-asr/`, installed by `server/pyproject.toml` via `[tool.uv.sources]` as an editable path dependency.
- The server consumes it through a 63-line `OnnxAsrTranscriber` adapter (`server/src/recorder/infrastructure/onnxasr_transcriber.py`) implementing the `ITranscriber` port.
- The lib has zero knowledge of WinSTT-specific concepts (no events, no settings schemas, no IPC).

### When a library boundary pays for itself

| Argument | Verdict for WinSTT |
|---|---|
| Independent versioning — engine can stabilize while server iterates | ✓ True; useful when we want to pin a known-good engine while refactoring the server |
| Test isolation — engine tests don't pull in server fixtures | ✓ True; today the lib has its own 100% test target separate from server |
| Forces public-API discipline — can't reach into internals | ✓ True; this is the strongest argument |
| Reuse — CLI tools, notebooks, other apps, third parties | ✓ True for our own CLI demos; weak for third parties unless we open-source |
| Open-source contribution path — easier upstream if needed | ✓ True; we're already a fork of istupakov/onnx-asr |
| Easier to swap engines — replace with sherpa-onnx, FunASR, etc. | ✓ True; the `ITranscriber` port pattern proves this |

### When a library boundary becomes a tax

| Pain | Verdict for WinSTT |
|---|---|
| Cross-cutting changes need two commits (lib + server) | ✓ Real but manageable — atomic via path dependency |
| API stability friction — every breaking change is awkward | ⚠ Watch closely. While we're rapidly evolving decode params, streaming, etc., we'll churn the API a lot. |
| Drift risk — lib starts importing server concepts | ✗ Hasn't happened; signal to watch |
| Mental overhead of two test suites | Marginal — already running both |

### Decision: keep as a library, vendored

**Recommendation:** Keep `winstt/onnx-asr` as a separate Python package, vendored in the monorepo at `examples/onnx-asr/` (or moved to `engine/` later — see below). Don't publish to PyPI yet. Use `uv`'s editable path dependency so engine changes are immediate.

**Concretely:**
1. **Path stays `examples/onnx-asr/` for now.** It's a fork we're heavily modifying. The `examples/` location reflects that it's reference / vendored code, not first-party.
2. **Promote to `engine/onnx-asr/` if we make ≥3 substantial features (streaming, beam, generalized Whisper module).** That's the signal that we own this fork operationally and aren't just maintaining a small patch set.
3. **No PyPI publish until SaaS launches.** Premature publishing locks API. Internal-use semver is overrated.
4. **Treat the lib's public API as a frozen contract for the server.** Breaking change to the lib triggers a server adapter update in the same PR. The `OnnxAsrTranscriber` adapter is the shock absorber — if a lib change requires more than 20 lines of adapter churn, the lib's API got worse.

### When to merge into the backend

Merge — i.e., absorb the lib's code into `server/src/recorder/infrastructure/onnxasr/` and delete the separate package — only if **two of these three** are true:

1. **The lib starts importing from the server domain.** E.g., `from winstt.domain import RecorderEvent`. That's a Conway's law violation; either move the type to a shared lib or merge.
2. **Bilateral API changes per week become routine.** If for two consecutive months every engine PR also needs a server PR, the boundary isn't paying for itself.
3. **We commit to a single product-bound engine architecture.** E.g., if we decide WinSTT will permanently ship one tightly-coupled engine variant. Today we have multi-engine optionality (Parakeet streaming + Whisper offline) — that argues for the boundary.

### Product implications

- **Multi-tenant model loading for SaaS:** A clean library API lets us load different engines per tenant (e.g., enterprise tier gets Parakeet TDT-1.1B; free tier gets distil-whisper-small) by swapping the adapter, not branching the server.
- **Engine licensing path:** If the engine ever has commercial value separately (e.g., we sell it as a Python lib to other Electron STT apps), the boundary is already there.
- **Offline desktop SKU:** A future "WinSTT Offline" SKU could ship the engine without the server (run inference in a CLI / embedded subprocess). The library boundary enables this without refactoring.
- **Vendor swap insurance:** If a better ONNX ASR library appears (or NVIDIA ships an official Parakeet Python package with first-class streaming), we can swap behind `ITranscriber` without touching application code.

The cost of the boundary today is small (one path dependency, one 63-line adapter). The optionality it preserves is large. Keep it.

---

## 2.6 Swappability — every component behind a port

The product principle: **nothing is hard-wired.** Users (or operators in SaaS) pick the model, the engine, the realtime path, the LLM, and the wake-word — at runtime, via settings. The codebase ships defaults, never lock-in.

### Full port surface

Every component below sits behind an ABC in `server/src/recorder/domain/ports/`. Adapters live in `server/src/recorder/infrastructure/`. Bootstrap wires user settings → concrete adapter selection.

| Port | Purpose | Concrete adapters (initial) | Future adapters |
|---|---|---|---|
| `ITranscriber` | Offline / final-pass transcription | `OnnxAsrTranscriber` | `FasterWhisperTranscriber`, `SherpaOnnxTranscriber`, `MlxWhisperTranscriber`, `CloudWhisperTranscriber` (OpenAI/Groq) |
| `IRealtimeTranscriber` | Streaming preview transcription | `WhisperLocalAgreementAdapter`, `ParakeetStreamingAdapter` (when streaming ONNX export available), `SameModelAdapter` (reuses main model with smaller settings) | Custom user-supplied adapter via plugin contract |
| `IVoiceActivityDetector` | Speech endpointing | `SileroVadAdapter` (ONNX), `WebRtcVadAdapter` (DSP), `CompositeVadAdapter` (WebRTC AND Silero — default, see §6) | Pyannote VAD, energy-only fallback |
| `IWakeWordDetector` | Wake-word detection | `OpenWakeWordAdapter` (ONNX, default), `PorcupineAdapter` (commercial), `NoneAdapter` (disabled) | Custom user-trained OWW models |
| `IAudioSource` | PCM input | `PyAudioSource` (mic), `FileAudioSource` (file), `WebSocketAudioSource` (network stream) | DirectSound, WASAPI exclusive, virtual audio cable |
| `ITextPostProcessor` | LLM polish / formatting / translation after transcription | `NoneAdapter` (passthrough), `OllamaAdapter` (local), `OpenAIAdapter`, `AnthropicAdapter` | Custom prompt templates, local llama.cpp, MLX |
| `IInferenceEngine` (provider-level abstraction inside engine adapters) | Hides ONNX Runtime vs alternatives | `OnnxRuntimeEngine` (CUDA/DML/CPU/TRT) | `MlxEngine`, `OpenVinoEngine`, `CtranslateEngine` (faster-whisper-style) |
| `IModelCatalog` | List + describe available models | `LocalModelCatalog` (static registry), `HuggingFaceCatalog` (live HF search) | Tenant-scoped catalog for SaaS |

### Three swap dimensions per component

For every port, surface three runtime knobs in the settings schema:

1. **Provider** — which adapter class is instantiated (e.g., `transcriber.provider = "onnx-asr" | "faster-whisper" | "cloud-openai"`).
2. **Model / variant** — within a provider, which weights (e.g., `transcriber.model = "whisper-large-v3-turbo" | "distil-large-v3.5"`).
3. **Provider-specific options** — passthrough kwargs (`transcriber.options = {beam_size: 5, temperature: [0.0, ...]}`).

This three-layer shape mirrors how `aiohttp.ClientSession`, OpenAI's API, and most plugin systems do swap surfaces.

### LLM post-processing — where it lives

User noted the LLM-polish step is currently a frontend job (Electron renderer calls a cloud LLM) and they suspect that's the wrong place.

**Recommendation: server-side, behind `ITextPostProcessor`.** Reasons:

- **API key safety.** Frontend-hosted means the user's API key is in renderer code or main-process env — at minimum visible in dev tools when the user inspects. Server-side keeps secrets in one place.
- **Streaming responses.** Server can stream LLM tokens over the existing WS channel as they arrive. Frontend streaming requires CORS-friendly endpoints from each LLM provider — most have them, but the path is harder.
- **Composability with future server-side features.** Translation, glossary, content moderation, RAG over user history — all server jobs.
- **Cost control / tenant accounting.** Server can rate-limit, count tokens per tenant, enforce budgets.
- **Offline mode.** Local Ollama runs on the same box as the server in single-user deployments — keep it close.

When to keep on frontend: if the user explicitly wants their own API key local-only with no server roundtrip, expose a "client-side LLM" toggle that bypasses `ITextPostProcessor`. Default is server-side.

### Plugin contract (future-proofing)

For "user supplies their own adapter", define a Python entry-point group `winstt.adapters.transcriber` (and one per port). Users `pip install` a third-party package, it registers its class, server's bootstrap discovers it via `importlib.metadata.entry_points()`. Standard pattern (used by pytest plugins, gunicorn workers, etc.). Don't build this on day one — just don't preclude it.

### What this changes in the roadmap

- §9.0 contract grows to include `IRealtimeTranscriber`, `ITextPostProcessor`, `IModelCatalog`.
- §9 Track B grows new phase **B0 (port enumeration)** — formalize every port and write fakes for all of them, before B1 starts. ~3 days.
- §9 Track B's B4 (streaming) splits the realtime adapter into per-engine implementations behind `IRealtimeTranscriber`.
- Settings UI in the frontend gets a generic "provider + model + options" shape for each component, not bespoke per-component forms.

The cost is a few extra ABCs and adapter files (each ~50-100 LOC). The benefit is permanent — the codebase never inherits "couldn't easily swap X" debt.

---

## 2.7 Architecture for the Backend Rewrite — Decision

**Architecture:** Hexagonal / Ports & Adapters (continuation of what exists in `server/src/recorder/`).

**Enforcement:** `import-linter` static analyzer. Add `.importlinter` config to `server/` defining layer contracts (e.g., "domain may not import infrastructure", "application may not import stt_server"). Runs in CI + pre-commit. No new code allowed to violate.

**Template reference:** `examples/cosmic-python/` — Harry Percival's *Architecture Patterns with Python* canonical codebase. Demonstrates ports/adapters, repository pattern, unit-of-work, FastAPI integration, message bus, test pyramid. We adopt the patterns, not the code.

Backup reference: `examples/hexagonal-architecture-python/` — FastAPI + MongoDB hexagonal example with docker-compose. Good for FastAPI + DI wiring patterns; less rigorous than cosmic-python.

**What this looks like concretely in `server/`:**

- `domain/` — ports (ABCs), domain events, state machine, errors. Pure Python, stdlib only. No imports from `application/` or `infrastructure/`.
- `application/` — services, orchestrators, message handlers. Imports `domain/` only.
- `infrastructure/` — adapters implementing domain ports. Imports `domain/` only (never `application/`).
- `bootstrap.py` — composition root. The single place allowed to import everything.
- `stt_server/` — FastAPI surface. Imports `application/` and `bootstrap.py`.

**Import-linter contracts (proposed `.importlinter`):**

```ini
[importlinter]
root_package = recorder

[importlinter:contract:layers]
name = Hexagonal layers
type = layers
layers =
    recorder.bootstrap
    recorder.application
    recorder.domain
    recorder.building_blocks

[importlinter:contract:domain-isolation]
name = Domain may not depend on infrastructure
type = forbidden
source_modules = recorder.domain
forbidden_modules = recorder.infrastructure

[importlinter:contract:infrastructure-isolation]
name = Infrastructure may not depend on application
type = forbidden
source_modules = recorder.infrastructure
forbidden_modules = recorder.application
```

**What this does NOT change in the engine (onnx-asr):** Engine stays flat per §2. No domain/application/infrastructure inside the library. The hexagonal architecture lives in the server, consuming the engine as a flat dependency.

**Sequencing:** Adopt import-linter as part of Track B's Phase B0 (port enumeration). Not blocking onnx-asr Track A work.

---

## 3. Decode Parameters — Tiered Exposure

### Current state (cited)
`src/onnx_asr/models/whisper.py`:

- **WhisperOrt** (lines 105–143): single decoder path, `num_beams=1` **hardcoded** (line 135), `length_penalty=1.0` hardcoded (line 137), `repetition_penalty=1.0` hardcoded (line 138).
- **WhisperHf** (lines 146–227): pure autoregressive **greedy** loop with `argmax` at each step. KV-cache present (lines 215–227), but no beam, no sampling, no fallback.
- **Missing entirely:** temperature, `no_speech_threshold`, `compression_ratio_threshold`, `suppress_tokens`, `suppress_blank`, `condition_on_previous_text`, `initial_prompt`.

### Re-evaluation: which params actually move the output

Whisper has 20+ documented decode knobs (OpenAI reference, faster-whisper, HF Transformers). Most users — even technical ones — should never touch most of them. Splitting them into tiers prevents UI clutter while still giving power users escape hatches.

#### Tier 1: hot knobs — exposed in the settings UI

These directly determine whether output is "usable" or "garbage" on adversarial input. Every one is justified by a specific failure mode that ships with a default-Whisper config.

| Param | Effect on output | Default | Why expose |
|---|---|---|---|
| `temperature` (ladder) | Single biggest hallucination guard. Default `(0.0, 0.2, 0.4, 0.6, 0.8, 1.0)`: try greedy first, only fall back when guards fail. | OpenAI's 6-step ladder | Without it, Whisper loops or hallucinates on silence/music. Non-negotiable. |
| `no_speech_threshold` | If `no_speech_prob > thresh` AND `avg_logprob < logprob_thresh`, segment becomes silence. | `0.6` | Directly controls silence-into-text false positives. Users with quiet mics need this knob. |
| `compression_ratio_threshold` | If gzip(text)/len(text) > thresh, treat as repetition loop and retry with higher temp. | `2.4` | Catches "the the the" / repeating-segment failure mode. |
| `initial_prompt` | Free-text seed that goes into the decoder's prompt slot. Whisper uses it for domain vocab and style. | `None` | Single biggest WER win for jargon-heavy domains (medical, legal, programming). |
| `beam_size` | 1 = greedy (fast). 5 = OpenAI default (better WER, ~5× slower). Real WER delta: 5–15% relative on benchmarks. | `1` for realtime, `5` for offline final-pass | Latency-vs-quality knob users feel directly. |
| `return_timestamps` | Off / segment-level / word-level. | `False` (segment when on) | Feature flag, not a quality knob, but visible to users. |

**Default profile:** greedy + temperature ladder + guards on + `no_speech_threshold=0.6` + `compression_ratio_threshold=2.4`. This matches OpenAI's reference and is the right "1 setting fits everyone" baseline.

#### Tier 2: advanced knobs — exposed behind a `WhisperAdvancedConfig`

Power-user escape hatches. Almost never needed, but when needed they're the only fix.

| Param | When it matters | Default |
|---|---|---|
| `suppress_tokens` | Suppress a specific bad token ID you observed in output (e.g., known-bad continuation, language tag leaking into transcript). | `(-1,)` — Whisper's curated suppress set |
| `condition_on_previous_text` | Long files: previous-segment context improves continuity, but can also propagate hallucinations forward. Disable for adversarial long audio. | `True` |
| `logprob_threshold` | Couples with `no_speech_threshold`. Tighten for stricter silence detection. | `-1.0` |
| `best_of` | Only used when `temperature > 0` (sampling). Number of samples to draw per attempt. | `5` |
| `prefix` | Force the output to start with given text. Used by tools that need exact-prefix behavior. | `None` |
| `prompt_tokens` | Like `initial_prompt` but token-IDs (advanced; pre-tokenized prompt). | `None` |
| `patience` | Beam-search patience multiplier. Slightly improves quality on hard segments. | `1.0` |
| `hotwords` (faster-whisper-ism) | Like initial_prompt but space-separated phrase list with internal handling. Equivalent to a structured initial_prompt. | `None` |

#### Tier 3: hidden / default-only

Knobs whose defaults are almost always optimal and exposure adds confusion without benefit. Code them as module-level constants, not as configurable.

| Param | Default | Why hidden |
|---|---|---|
| `length_penalty` | `1.0` | Effect is sub-WER-noise at beam ≤ 5. |
| `repetition_penalty` | `1.0` | OpenAI's reference uses 1.0; alternative values cause more problems than they solve. |
| `suppress_blank` | `True` | Almost always wanted; disabling breaks Whisper's segment alignment. |
| `max_initial_timestamp_index` | Whisper default | Bounded internally; not a tuning knob. |
| `prepend_punctuations` / `append_punctuations` | OpenAI defaults | Used for word-timestamp post-processing; tied to that feature, not a separate knob. |
| `without_timestamps` | inverse of `return_timestamps` | Redundant with `return_timestamps`. |

### API shape

Public surface — keep `recognize()` flat with the 6 hot knobs, gate the rest behind an opt-in dataclass:

```python
def recognize(
    audio,
    *,
    sample_rate: int = 16_000,
    language: str | None = None,
    # Tier 1 — hot
    temperature: float | tuple[float, ...] = (0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
    no_speech_threshold: float | None = 0.6,
    compression_ratio_threshold: float | None = 2.4,
    initial_prompt: str | None = None,
    beam_size: int = 1,
    return_timestamps: bool | Literal["word"] = False,
    # Tier 2 — advanced escape hatch
    advanced: WhisperAdvancedConfig | None = None,
) -> str | TimestampedResult: ...
```

This shape is what `openai-whisper` and faster-whisper converged on — flat for the common knobs, struct for the rare ones. Avoids the "Pydantic settings explosion" anti-pattern while staying open to escape hatches.

### Implementation order
1. **Phase A — Greedy + guards:** Add `no_speech_threshold`, `compression_ratio_threshold`, `logprob_threshold`, `suppress_tokens`, `suppress_blank`, `initial_prompt`. Still greedy. Massive quality jump.
2. **Phase B — Temperature fallback ladder:** Each segment tries `temperature[0]`; on guard failure, retry with next temperature.
3. **Phase C — Beam search:** Implement beam in `WhisperHf._decoding` with log-sum batching. `WhisperOrt` stays greedy-only (its beam is export-baked).
4. **Phase D — Timestamps:** Segment-level via `<|t|>` tokens (already in the vocab; currently suppressed via `<|notimestamps|>` at `whisper.py:59`). Word-level via cross-attention DTW is Phase D2 and depends on ONNX exports that expose cross-attention.

### Decode config for non-Whisper models
- **NeMo Conformer CTC / RNN-T / TDT**, **GigaAM**, **Kaldi**, **TOne** — CTC has no beam by default; RNN-T has `max_tokens_per_step` (`models/nemo.py:93`, default 10). Add `max_symbols_per_step` and CTC `beam_width` as constructor kwargs.
- These models have far fewer "hot" knobs than Whisper because they don't have Whisper's hallucination failure mode (no LM head, no autoregressive drift). The temperature ladder isn't a thing for CTC/RNN-T.

---

## 4. Streaming Transcription — Required, Per-Model

### Principles (corrected)
1. **Whisper streaming is required**, not optional. Many users will prefer Whisper for multilingual, code-switching, and rare-language support that Parakeet doesn't cover. The product must stream Whisper.
2. **Per-model streaming technique.** Streaming method is chosen by the model's `ModelCapabilities` flags (§5), not by global config. Parakeet TDT uses cache-aware streaming; Whisper uses LocalAgreement-2 over timestamped exports; future models pick whichever they support.
3. **Preview model + main model.** Two-model architecture (per RealtimeSTT) is the right answer for live visual feedback. A small fast preview model drives realtime updates while a large accurate main model produces the final committed transcript. Both behind the same `ITranscriber` / `IRealtimeTranscriber` ports — user picks.
4. **We are porting, not inventing.** Every streaming approach has a permissively-licensed reference (UFAL whisper_streaming, sherpa-onnx, whisper-flow). Implementation = adapt these to our ONNX surface, not write from scratch.

### What onnx-asr supports today (re-verified)
**Still nothing user-facing.** Verified:
- `__init__.py:5-10` — public API is `load_model`, `load_vad`, `DownloadProgress`, `ProgressCallback`. Nothing else.
- `asr.py:54-65` — Asr protocol exposes only `recognize_batch(waveforms, waveforms_len)`.
- `models/whisper.py:215-227` — decoder runs `for _ in range(tokens.shape[-1], max_length)` until EOS for all beams. No partial yields.
- `models/tone.py:62-86` — T-one has an **internal** chunked encoder with carried RNN state, but the chunking lives inside one `_encode` call and is not exposed. README at line 82 confirms: *"T-Tech T-one (with CTC decoder, no streaming support yet)"*.
- Grep across `src/` for `stream|online|partial|feed_audio|AsrStream` returns zero user-facing API hits.

**Streaming must be added from scratch.** Where to add it is the question.

### Approach taxonomy (from cloned repo inspection)

| Approach | Core trick | ONNX-compatible? | Latency | Quality | LOC |
|---|---|---|---|---|---|
| **whisper_streaming / UFAL** (LocalAgreement-2) | Run Whisper on overlapping windows; commit longest n-gram prefix shared by 2 successive runs | **Yes** — engine-agnostic | ~1 s | Good, conservative | ~600 |
| **SimulStreaming (AlignAtt)** | Cross-attention says "token attended near buffer end → discard" | **No** — needs decoder ONNX with `cross_attentions` output; onnx-community Whisper exports don't expose this | ~1 s | Best (IWSLT 2025 SOTA) | ~2000 |
| **simul_whisper** (AlignAtt + CIF) | Same as SimulStreaming + Continuous Integrate-and-Fire for word-boundary | **No** — same reason | ~1 s | Best | ~1500 |
| **VoiceStreamAI** | VAD-cut chunks, full re-transcribe per chunk | Yes (trivial) | 1–3 s | OK (no overlap → boundary errors) | ~200 |
| **TheWhisper** | Sliding window + word-timestamp commit by punctuation/pause | **Conditionally** — needs fine-tuned weights that don't require 30-s padding (TheStageAI/thewhisper-large-v3-turbo open on HF) | ~500 ms | Very good | ~500 |
| **whisper-flow** (stability) | Re-transcribe growing buffer; commit when text repeats for N cycles | **Yes** — trivial | 150–470 ms | OK (drift on long buffers) | ~30 |
| **RealtimeSTT** (LCP watermark) | Realtime tiny-model preview + final on speech-end; LCP between successive partials | **Yes** — engine-agnostic | ~300 ms preview | Good (cost: 2 models) | (already in WinSTT-old) |

### The Parakeet pivot

The key insight from the streaming research: **don't stream Whisper at all. Stream Parakeet TDT.**

NVIDIA's Parakeet TDT (Token-and-Duration Transducer) is an **RNN-T model** — frame-synchronous, stateful decoder, *streaming-native by design*. onnx-asr already supports `nemo-parakeet-tdt-0.6b-v3` (`resolver.py:29`, `models/nemo.py: NemoConformerTdt`). The transducer decoder in `asr.py:179-229` is already a frame-synchronous `while t < encodings_len` loop.

What's missing for true streaming: NVIDIA publishes **cache-aware streaming** Parakeet variants whose ONNX exports expose `cache_last_channel` / `cache_last_time` state inputs. The decoder loop needs surface changes (persist state across calls, feed audio in fixed-size chunks). That's an order of magnitude less work than bolt-on streaming for Whisper.

**Trade-off:** Parakeet is English-only at 0.6B; Whisper is multilingual. Parakeet has slightly higher WER on adversarial English benchmarks; Whisper handles code-switching and rare languages better. For English-only desktop dictation (the WinSTT use case today), Parakeet wins on latency and quality-per-CPU.

### Architecture: preview model + main model, capability-routed streaming

The setup mirrors RealtimeSTT but with proper abstractions and ONNX-only models:

```
                        ┌──────────────────────────────┐
                        │   IRealtimeTranscriber       │
audio frames ──VAD──┬──>│   (per-model streaming impl) │──> on_realtime_update(text)
                    │   └──────────────────────────────┘
                    │
                    │   ┌──────────────────────────────┐
                    └──>│   ITranscriber               │
                        │   (final-pass on speech end) │──> on_transcription_complete(text)
                        └──────────────────────────────┘
```

Two model instances run in parallel:
- **Preview model** (small, fast): drives the live transcription update. Default `whisper-base` ONNX or smaller (`whisper-tiny.en` for English-only). User-swappable.
- **Main model** (large, accurate): runs once on VAD endpoint to produce the canonical transcript. Default `whisper-large-v3-turbo`. User-swappable.

User can also set preview = main (same instance, no extra RAM) for a single-model setup — slower preview, lower memory.

### Capability-routed streaming choice

Each `ITranscriber` adapter declares its streaming capability via `ModelCapabilities`. The `IRealtimeTranscriber` adapter wraps the appropriate strategy:

| Model architecture | Streaming method | Reference for porting |
|---|---|---|
| Whisper (any) | LocalAgreement-2 over `_timestamped` ONNX exports | UFAL whisper_streaming (MIT) — algorithm; openai-whisper `decoding.py` + `transcribe.py` for the encode/decode primitives |
| Parakeet TDT cache-aware | Native streaming via cache state tensors | `examples/sherpa-onnx/csrc/online-transducer-nemo-model.{h,cc}` — full ONNX-side reference (Apache 2.0); `NeMo` `streaming_utils.py:1557-1730` — buffer policy |
| NeMo Conformer-streaming | Native streaming (cache-aware) | Same as Parakeet, same files |
| Other Whisper-style (Distil-Whisper, Lite-Whisper) | Same as Whisper: LocalAgreement-2 | Same as Whisper |

**Routing logic** (in `server/src/recorder/bootstrap.py`):
1. Query `preview_model.capabilities.streaming_native` — if true, use the native streaming adapter (e.g., `ParakeetStreamingAdapter`).
2. Otherwise, use `WhisperLocalAgreementAdapter` over the preview model.
3. If `preview_model is main_model` (single-model mode), apply the same heuristic.

### Whisper streaming: LocalAgreement-2 over timestamped exports

**The chosen approach for ONNX Whisper streaming.** Justified by:

- **Engine-agnostic.** LocalAgreement-2 is a pure-Python algorithm operating on token strings + timestamps. No model-internal access (unlike AlignAtt which needs cross-attention).
- **Validated.** UFAL whisper_streaming is the ACL/IWSLT reference for streaming Whisper. Used in production by multiple teams.
- **ONNX-compatible.** Works on any Whisper export that produces tokens. Bonus: with `_timestamped` exports (`onnx-community/whisper-base_timestamped`, `whisper-medium.en_timestamped`, `whisper-large-v3_timestamped`), we can extract `<|t|>` segment timestamps and **trim the audio buffer** at commit boundaries, bounding compute as utterances grow.
- **Works for any Whisper variant.** Same code path handles whisper-tiny through large-v3-turbo, distil-large-v3.5, lite-whisper-large-v3-acc.

**Algorithm in one paragraph (citations only — algorithm is in UFAL whisper_streaming):**

Maintain a growing audio buffer. Every `min_chunk_size` seconds (default ~1.0 s), re-encode + decode the whole buffer to get a token sequence with timestamps. Diff the new sequence against the previous one; the **longest common prefix** is "stable" (committed). Trim the audio buffer up to the timestamp of the last committed segment using the `<|t|>` tokens, then loop. On Silero VAD endpoint, force-final the residual buffer. Reference: UFAL `whisper_streaming/whisper_online.py` `OnlineASRProcessor` class — port the algorithm structure, replace the faster-whisper backend with onnx-asr's `recognize()`.

**Latency targets:**
- Partial cadence: ~1.0 s (tunable via `realtime_processing_pause` setting).
- Commit lag: ~2.0 s (one cadence cycle to see the same prefix twice).
- Endpoint-to-final: ~`post_speech_silence_duration` + main-model inference time (large-v3-turbo on GPU is ~0.5× realtime → ~5 s for a 10 s utterance on CUDA).

### Parakeet TDT cache-aware streaming (additional, English-only)

For users who want sub-300 ms partial latency on English speech and can use Parakeet:

- Cache-aware encoder with `cache_last_channel` / `cache_last_time` state tensors (recipe in `examples/sherpa-onnx/csrc/online-transducer-nemo-model.cc:293-385`).
- Frame-synchronous TDT decoder (recipe in `examples/sherpa-onnx/csrc/online-transducer-greedy-search-nemo-parakeet-unified-decoder.cc:29-107`).
- Ring buffer of one encoder chunk; persistent predictor state across `feed_chunk()` calls.

**Prerequisite:** A cache-aware streaming Parakeet TDT ONNX export must be findable on HF or sherpa-onnx releases (e.g., `csukuangfj/sherpa-onnx-streaming-parakeet-tdt-*`). If not, this adapter is deferred.

### Why both — not Whisper-only or Parakeet-only

- **Whisper-only:** loses 200-500 ms of preview latency for English users who'd prefer the snappier feel. Multilingual users are fine.
- **Parakeet-only:** loses every non-English language and code-switching. Unacceptable for SaaS.
- **Both, with `IRealtimeTranscriber` swappable:** users pick. English-heavy users default to Parakeet preview + Whisper final. Multilingual users default to Whisper preview + Whisper final. Power users mix arbitrarily.

### Where the streaming layer lives

**Outside the engine library, in the server.** New module: `server/src/recorder/application/realtime_stream.py`. Reasons:

1. The engine library's `model.recognize(audio)` stays single-shot — clean API.
2. Capability-based routing needs to know about user config and the available models — those concepts live in the server.
3. Event-bus firing and callback bridging is already in `server/src/recorder/domain/events.py`.
4. Hexagonal layering pays for itself — `IRealtimeTranscriber` port with multiple adapters.

### Implementation order

1. **Phase 2a — `IRealtimeTranscriber` port + `WhisperLocalAgreementAdapter`.** Whisper streaming first because it's the broader-applicable path. Port LocalAgreement-2 algorithm from UFAL whisper_streaming.
2. **Phase 2b — `_timestamped` ONNX support in onnx-asr's `WhisperHf`.** Bind `<|t|>` tokens (currently suppressed at `whisper.py:59`); expose segment timestamps in `recognize()` output. Enables buffer-trim in 2a.
3. **Phase 2c — Preview + main model orchestration.** Two `ITranscriber` instances, wired by bootstrap. Single-model mode supported (preview = main).
4. **Phase 2d — Final-pass on VAD endpoint.** Send completed utterance to main model; emit `TranscriptionCompleted(text)` to replace the preview's last `RealtimeTranscriptionStabilized(text)`.
5. **Phase 2e — `ParakeetStreamingAdapter`** (when cache-aware ONNX export verified). Optional — gated on export availability.
6. **Phase 2f — Auto-route heuristic + override settings.** Defaults by language: English → Parakeet preview if available; else Whisper preview. Settings override.

---

## 5. Generalized Whisper Module

### The user's framing (paraphrased)
> "Not about Lite-Whisper specifically. Make a generalized whisper inference module that, given a Whisper-architecture ONNX, supports flags for timestamped/non-timestamped, streaming/not, etc. — increasing model support over time. Plus support for non-Whisper architectures (NVIDIA Parakeet, Canary)."

### Today's structure
- `WhisperOrt` (single-export ONNX with built-in beam search graph, used by `istupakov/whisper-base-onnx`).
- `WhisperHf` (HF Optimum export — separate `encoder_model.onnx` + `decoder_model_merged.onnx` with KV-cache, used by `onnx-community/whisper-*`).
- Both inherit from `_Whisper` base (lines 34–100ish) but the base is thin.

### Target structure

```
src/onnx_asr/models/whisper/
    __init__.py              # Re-exports
    base.py                  # _WhisperBase with capability flags
    decoding/
        greedy.py            # GreedyDecoder
        beam.py              # BeamDecoder
        guards.py            # no_speech, compression_ratio, logprob checks
        timestamps.py        # Token-stream timestamp extraction
        suppress.py          # Token-suppress logic
    ort_beam.py              # WhisperOrt (ONNX with built-in beam)
    hf_kvcache.py            # WhisperHf (encoder + decoder_merged)
    lite.py                  # LiteWhisper variants (when added)
    distil.py                # Distil-Whisper variants
    turbo.py                 # large-v3-turbo (4-decoder layer variant)
```

**Capability flags** on `_WhisperBase`:

```python
class _WhisperBase:
    supports_beam_search: bool       # WhisperHf yes; WhisperOrt no (export-baked)
    supports_temperature_fallback: bool
    supports_word_timestamps: bool   # Needs cross-attention head extraction
    supports_kv_cache: bool
    encoder_layer_count: int         # turbo=4, large=32 etc — for diagnostics
    expected_mel_filters: int        # 80 for v1/v2, 128 for v3
    mel_n_fft: int                   # 400 default
```

The base handles tokenizer, preprocessing dispatch, language detection, and decode-config plumbing. Subclasses provide the ONNX-call layer.

**Why this scales:**
- Lite-Whisper / Distil-Whisper / turbo / large-v3 / medium / small — all the same architecture, different layer counts and mel counts. They become one-file subclasses.
- New architectures (Moonshine, when added; Parakeet TDT — already in `models/nemo.py`) get their own sibling tree (`models/parakeet/`, `models/moonshine/`).

### Non-Whisper umbrella
Mirror the same flag-based base for **CTC** and **RNN-T** families:
- `_CtcBase` with `vocab_size`, `blank_idx`, `subsampling_factor`, `supports_beam_decoding`, `supports_lm_fusion` (future).
- `_RnntBase` with `max_tokens_per_step`, `supports_tdt` (token-and-duration), `supports_aed` (attention encoder-decoder, Canary).

Most of this structure already exists in `models/nemo.py` (NemoConformerCtc, NemoConformerRnnt, NemoConformerTdt, NemoConformerAED). The refactor is extracting common bits into a documented base.

---

## 6. Realtime VAD + Wake Word — ONNX-Only Feasibility

### Why RealtimeSTT uses both (the actual answer)

The previous draft said "drop WebRTC, Silero only" without explaining the rationale. The user pushed back; on re-investigation, the dual VAD is **purely a CPU-saving gate**, not a detection-quality choice. Citations:

- `audio_recorder.py:2598-2607` — explicit comment: WebRTC is the *"First quick performing check"*; Silero is *"intensive check in a separate thread"*.
- `audio_recorder.py:2599` — `if self.is_webrtc_speech_active: ... threading.Thread(target=self._is_silero_speech, ...).start()` — **Silero only runs when WebRTC fires.**
- `audio_recorder.py:2630` — final decision is `webrtc AND silero`. AND logic = noise suppression (WebRTC fires on any energy; Silero confirms it's speech-like).
- `audio_recorder.py:2145-2147` — `silero_deactivity_detection` param controls whether end-of-speech detection uses WebRTC (default, strict) or Silero (semantic, catches trailing quiet syllables).

**Cost analysis:**

| | WebRTC | Silero |
|---|---|---|
| Algorithm | DSP energy + low-pass | ONNX neural network |
| Per-frame latency | ~100 µs | ~1–2 ms |
| Skipped when other says "no speech"? | Always runs | Skipped 70–80% of the time during silence |
| CPU effective cost | <1% | 3–5% if always-on; ~1% when WebRTC-gated |

**The composite saves CPU.** On modern hardware with ONNX-accelerated Silero (already what onnx-asr uses — `silero_use_onnx=True` is default in our stack), the savings are small and the complexity tax (two thresholds, two scales — WebRTC's is inverse 0-3, Silero's forward 0-1 — plus event ordering bugs noted in RealtimeSTT issues #215, #258) is real.

### Decision (revised)

**Keep the dual-VAD CPU-saving trick.** WebRTC as cheap pre-filter, Silero as semantic confirm, AND-gate for noise suppression. This is the right default for an always-on assistant.

Reasons to keep it (revised from prior draft):

- **Always-on listening matters.** In an assistant that listens continuously (wake-word mode), Silero running on every frame consumes meaningful CPU. WebRTC gating cuts ~70-80% of Silero invocations during silence — directly proportional to battery / fan-noise / thermals on laptops.
- **AND-gate noise suppression is real.** WebRTC catches "is there any acoustic energy" (typing, fan, breath, music). Silero catches "is this speech-like." AND-ing them rejects non-speech energy that Silero alone would mistakenly flag. Cited at `examples/RealtimeSTT/RealtimeSTT/audio_recorder.py:2630`.
- **Negligible code-complexity tax once the abstraction is right.** `CompositeVadAdapter` wraps both — callers see one VAD via `IVoiceActivityDetector`. The dual-threshold concern only surfaces in settings UI.

**Architecture under `IVoiceActivityDetector`:**

Three adapters ship by default, user picks via settings:
| Adapter | Behavior | Use when |
|---|---|---|
| `CompositeVadAdapter` (default) | WebRTC pre-filter ANDed with Silero confirm | Always-on, laptops, battery-sensitive |
| `SileroVadAdapter` | Silero only | High-end desktop, want simplicity, all VAD on GPU |
| `WebRtcVadAdapter` | WebRTC only | Extreme low-resource (embedded), no ONNX inference budget |

The composite is the default because its strengths align with the product's main target: desktop dictation assistants with wake-word always-on listening.

**Configuration knobs surfaced in settings:**
- `vad.provider` — `composite` / `silero` / `webrtc`
- `vad.silero_sensitivity` (0.0-1.0, default 0.5)
- `vad.webrtc_aggressiveness` (0-3, default 3 — RealtimeSTT default)
- `vad.deactivity_detection` — which VAD handles end-of-speech (`webrtc` strict, `silero` semantic, `composite`)

**Implementation references** (from prior research, all already cited in §9.6):
- `examples/RealtimeSTT/RealtimeSTT/audio_recorder.py:2596-2630` — the composite logic + threaded Silero invocation behind WebRTC gate.
- `examples/RealtimeSTT/RealtimeSTT/audio_recorder.py:2145-2147` — `silero_deactivity_detection` semantics for end-of-speech.
- `examples/onnx-asr/src/onnx_asr/models/silero.py` — Silero ONNX session already wired.
- `webrtcvad` PyPI package — thin Python binding to Google's C WebRTC VAD; ~10 LOC to wrap behind the port.

### Wake word
**RealtimeSTT** supports two backends (`audio_recorder.py:1591–1629`):
- **Porcupine (pvporcupine)** — commercial, free tier with AccessKey, high quality.
- **OpenWakeWord (oww)** — open-source, ONNX or TFLite, custom models supported.

For an OSS-leaning SaaS path: **OpenWakeWord (ONNX path)**. It's already ONNX. We add it as `src/onnx_asr/models/openwakeword.py` (new) and expose `load_wake_word(name, **kwargs)` in the loader.

**Porcupine stays as an optional plugin** for users who want proprietary best-in-class quality, but it's not a hard dependency. Implemented as a sibling adapter not loaded by default.

---

## 7. Server Framework

### Current state
`server/src/stt_server/server.py` uses the `websockets` library directly, dual-channel (control JSON port + binary audio port). Works; tests pass; ~100% coverage.

### FastAPI option
- FastAPI has first-class `WebSocketRoute` since 0.95.
- Single uvicorn server can serve HTTP (health, version, auth, model catalog endpoints) **and** WS in one process.
- Built-in OpenAPI generation — though we already have a hand-rolled OpenAPI spec at `spec/openapi.yaml` as the source of truth for shared types.
- DX wins: pydantic-validated request models, dependency injection, easy auth middleware (for SaaS).
- Mature deployment ecosystem (uvicorn, gunicorn workers, ASGI).

### Trade-offs
- `websockets` is lighter; FastAPI adds Starlette + uvicorn + pydantic-as-validation.
- Cost: small migration (~150 LOC of glue), tests need updating to use FastAPI's `TestClient`/`WebSocketTestSession`.
- Benefit: when we add auth, billing, user management, model selection per-tenant — these belong in HTTP routes, not the WS channel.

### Decision
**Migrate to FastAPI.** Justified by the SaaS direction. Keep the same dual-channel WS layout (control + data) — FastAPI just hosts them. The OpenAPI spec at `spec/openapi.yaml` remains the contract authority; FastAPI's auto-generated schema is supplementary, not authoritative.

**Sequence:** do this *after* the decode-config and streaming work lands. Don't reshape the server while we're still moving the engine API.

---

## 8. RealtimeSTT Feature Audit — Port Inventory

Sourced from `audio_recorder.py` line citations. Status column reflects what to do in the onnx-asr-based stack.

### Must Have (15)

| Feature | RealtimeSTT location | Notes |
|---|---|---|
| Cumulative-buffer realtime transcription + LCP stabilizer | `audio_recorder.py:2313–2502` | Core differentiator. §4. |
| Composite VAD (drop WebRTC, keep Silero) | `:2503–2630` | Simplified — Silero only. §6. |
| `post_speech_silence_duration` endpointing | `:286–287, 1960–2160` | Tunable end-of-turn timer. |
| `min_length_of_recording` | `:288` | Reject sub-threshold captures. |
| `pre_recording_buffer_duration` | `:291` | Pre-roll buffer for VAD latency comp. |
| `realtime_processing_pause` | `:274` | Inference cadence. |
| `enable_realtime_transcription` toggle | `:271` | Master switch. |
| `use_main_model_for_realtime` | `:272` | Saves RAM vs separate small model. |
| `beam_size` + `beam_size_realtime` | `:323, 324` | Routed through `WhisperDecodeConfig`. §3. |
| `initial_prompt` / `initial_prompt_realtime` | `:327, 328` | Domain vocab injection. §3. |
| `suppress_tokens` | `:329` | §3. |
| OpenWakeWord backend | `:1591–1629` | ONNX path. §6. |
| `wake_word_timeout` + `wake_word_buffer_duration` | `:314, 315` | Window-after-wake semantics. |
| Full callback set (15 events) | `:261–320, 600–611` | Bridge to `EventBus` per `server/CLAUDE.md`. |
| `feed_audio()` (file/stream mode) | `:1777–1815` | Non-mic input path — used by `frontend/electron/ipc/file-transcribe.ts`. |

### Nice to Have (6)

| Feature | Notes |
|---|---|
| Porcupine wake-word backend | Add behind a feature flag for users who want it. |
| Language auto-detection per realtime model | RealtimeSTT does this separately for realtime model. Useful for multilingual users. |
| Multi-GPU support (`gpu_device_index` as list) | Lower priority; SaaS deployment concern. |
| `normalize_audio` (peak normalize to −0.95 dBFS) | Helps low-SNR mics. ~5 LOC. |
| `print_transcription_time` instrumentation | Cheap to add; useful for SaaS metrics. |
| `early_transcription_on_silence` | Latency win — start transcribing on detected silence before silence-duration timer expires. |

### Skip for SaaS pivot (4)

| Feature | Why skip |
|---|---|
| Built-in WebSocket server CLI (`RealtimeSTT_server/stt_server.py`) | We have our own server. |
| `safepipe.py` multiprocessing pipe wrapper | Specific to RealtimeSTT's process model. Our hexagonal server uses queues + EventBus. |
| `silero_use_onnx=False` (PyTorch fallback) | We're ONNX-only. |
| `compute_type` knob | Ours is `quantization` at load_model time + provider list. Different model. |

### Already in WinSTT/onnx-asr
- `language` / auto-detect — onnx-asr supports it.
- `device` → handled by `providers` list in our hotkey demo.
- Quantization tiers — onnx-asr supports via `quantization` kwarg.
- VAD — onnx-asr ships Silero + PyAnnote.

---

## 9. Implementation Roadmap — Two Tracks

The work splits cleanly along the library boundary (§2.5). **Track A** is everything that lives inside `winstt/onnx-asr` (the engine fork). **Track B** is everything in `server/` (orchestration around the engine). The two tracks have an API contract — engine exposes capabilities, server composes them — and that contract is what §9.0 below pins down.

### 9.0 The engine ↔ server contract

This is the surface the server uses. Both tracks must agree on it before A and B can proceed in parallel.

**Engine exposes (Track A delivers):**
| Capability | API shape |
|---|---|
| Batch transcribe with decode config | `model.recognize(audio, *, language, temperature, no_speech_threshold, compression_ratio_threshold, initial_prompt, beam_size, return_timestamps, advanced) → str \| TimestampedResult` |
| Timestamped output (segment-level) | `TimestampedResult(text, segments=[(start, end, text), ...])` |
| Stateful streaming session (RNN-T family — Parakeet, Conformer-streaming, etc.) | `model.create_stream() → AsrStream`; `stream.feed_chunk(pcm) → list[TokenEvent]`; `stream.finalize() → str` |
| Stateless ASR session (Whisper, single-pass) | Continues to use `recognize()` — server orchestrates chunking + LocalAgreement-2 on top |
| VAD | `vad.detect(chunk) → VADResult` (already exists in `vad.py`) |
| Wake-word | `wake.detect(chunk) → WakeWordResult` (new — Track A) |
| Download progress | `progress_callback` (already shipped on `feat/progress-callback`) |
| Model capability flags | `model.capabilities → ModelCapabilities{streaming_native, supports_timestamps, supports_beam, supports_word_timestamps, is_multilingual, ...}` |

**Server consumes & orchestrates (Track B delivers):**
| Orchestration concern | Port | Where it lives |
|---|---|---|
| Offline / final-pass transcription | `ITranscriber` | `server/src/recorder/domain/ports/transcriber.py` (exists) |
| Streaming preview transcription | `IRealtimeTranscriber` | NEW — `server/src/recorder/domain/ports/realtime_transcriber.py` |
| Speech endpointing | `IVoiceActivityDetector` | `server/src/recorder/domain/ports/vad.py` (exists) |
| Wake-word detection | `IWakeWordDetector` | `server/src/recorder/domain/ports/wake_word.py` (exists) |
| PCM input | `IAudioSource` | `server/src/recorder/domain/ports/audio_source.py` (exists) |
| LLM post-processing (polish, format, translate) | `ITextPostProcessor` | NEW — `server/src/recorder/domain/ports/text_post_processor.py` |
| Model catalog / discovery | `IModelCatalog` | NEW — `server/src/recorder/domain/ports/model_catalog.py` |
| Cumulative audio buffer + LocalAgreement-2 | n/a (application service) | `server/src/recorder/application/realtime_stream.py` (new) |
| Preview model + main model two-instance bootstrap | n/a (composition root) | `server/src/recorder/bootstrap.py` (exists) |
| Capability-routed adapter selection | n/a (bootstrap logic) | Same — reads `model.capabilities` |
| Final-pass invocation on speech end | n/a (orchestrator) | Server pipeline |
| Hotkey → recording state | n/a | `server/src/recorder/application/recorder_service.py` (exists) |
| WebSocket / FastAPI surface | n/a | `server/src/stt_server/` |
| Settings schema + OpenAPI spec | n/a | `spec/openapi.yaml` — extended with provider/model/options shape per §2.6 |
| Pre-recording buffer, post-speech-silence-duration, etc. | n/a | Server pipeline |

**Seam rules:**
- Stateless models (Whisper) — engine exposes `recognize()`; server orchestrates streaming via `WhisperLocalAgreementAdapter` over the buffer.
- Stateful models (Parakeet TDT, future Conformer-streaming) — engine exposes `create_stream()`; server delegates via `ParakeetStreamingAdapter`.
- The server's `IRealtimeTranscriber` port hides both — caller sees a single streaming surface.
- Engine swappability (ONNX vs faster-whisper vs MLX) lives at the **adapter** level. `OnnxAsrTranscriber`, `FasterWhisperTranscriber`, etc. all implement `ITranscriber`. The engine doesn't need an internal `IInferenceEngine` ABC — that abstraction is at the wrong layer.

---

### Track A — onnx-asr fork (engine)

Work lives in `examples/onnx-asr/` on branch `feat/*` per topic; pushed to `winstt/onnx-asr`. Each A-phase ends with a tagged version that the server pins.

#### A1 — Whisper decode config (4–5 weeks)
A1.1 Refactor `models/whisper.py` → `models/whisper/` directory (base + decoders) — §5.
A1.2 `_WhisperBase` ABC with capability flags. WhisperOrt + WhisperHf inherit.
A1.3 Tier 1 + Tier 2 decode params plumbed through `recognize()` — §3.
A1.4 Guards: `no_speech_threshold`, `compression_ratio_threshold`, `logprob_threshold`, `suppress_tokens`, `suppress_blank`. **Greedy still.**
A1.5 `initial_prompt` token plumbing through encoder context.
A1.6 Temperature fallback ladder.
A1.7 Beam search in `WhisperHf._decoding` (log-sum batching, length_penalty, repetition_penalty).
A1.8 Tests: one per Tier 1 param, plus integration tests with adversarial inputs (silence, music, repetition). 100% coverage.
**Deliverable:** `winstt/onnx-asr` tag `v0.x-decode-config`.

#### A2 — Timestamps (1–2 weeks)
A2.1 Enable `<|t|>` tokens in vocab (currently suppressed via `<|notimestamps|>` at `whisper.py:59`).
A2.2 Segment-level timestamp extraction from token stream.
A2.3 `TimestampedResult` return type already exists for CTC/RNN-T (asr.py); extend to Whisper.
A2.4 Word-level (DTW over cross-attention) **deferred** — depends on ONNX exports with cross-attention output.
**Deliverable:** Tag `v0.x-timestamps`.

#### A3 — Streaming session API (3–4 weeks)
A3.1 New protocol `AsrStream` in `asr.py`: `feed_chunk(pcm) → list[TokenEvent]`, `finalize() → str`, `reset()`. Engine-side only — no buffer policy, no endpoint detection.
A3.2 `ModelCapabilities` dataclass exposed via `model.capabilities`. Includes `supports_streaming: bool`, `supports_timestamps: bool`, `supports_beam: bool`, `is_multilingual: bool`.
A3.3 `NemoConformerTdtStreaming` adapter — plumbs `cache_last_channel`/`cache_last_time` state across `feed_chunk()` calls. Frame-synchronous emission.
A3.4 Verify cache-aware ONNX export from NVIDIA for parakeet-tdt-0.6b-v3-streaming loads cleanly.
A3.5 Document the contract (`docs/streaming.md` inside the onnx-asr repo).
**Deliverable:** Tag `v0.x-streaming`.

#### A4 — Wake word (1 week)
A4.1 `models/openwakeword.py` — ONNX path. Mirror `models/silero.py` structure.
A4.2 `load_wake_word(name, **kwargs)` in `loader.py`.
A4.3 `WakeWordResult` dataclass (analogous to `VADResult`).
A4.4 Optional Porcupine adapter in a separate file, not in default loader registry. User opts in by importing directly.
**Deliverable:** Tag `v0.x-wake-word`.

#### A5 — Model coverage (ongoing, in parallel)
A5.1 Register Lite-Whisper variants in `resolver.py` `model_repos`.
A5.2 Register Distil-Whisper variants.
A5.3 Set whisper-large-v3-turbo as the default for `model="whisper-turbo"` alias.
A5.4 Verify cache-aware Parakeet streaming variants (depends on NVIDIA HF releases).
A5.5 Moonshine model_type registration when needed.
**Deliverable:** Continuous — minor version bumps.

#### A6 — Engine-internal cleanup (deferred, 1–2 weeks)
A6.1 `_ModelImplementation` private ABC for `models/*.py` — §2.
A6.2 `FakeModel` test fixture (no download).
A6.3 Documentation: contribution guide, model-adding cookbook.
**Deliverable:** Tag `v0.x-internals`.

---

### Track B — backend (server orchestration)

Work lives in `server/` on feature branches. Track B depends on Track A tags but can stage work behind feature flags while waiting.

#### B1 — FastAPI migration (1 week)
B1.1 Replace `websockets` server in `server/src/stt_server/server.py` with FastAPI + `WebSocketRoute`.
B1.2 Add HTTP routes: `/health`, `/version`, `/models` (model catalog), `/transcribe` (one-shot file upload).
B1.3 Keep dual WS layout (control JSON + binary audio data) — FastAPI just hosts both.
B1.4 Move CORS / auth middleware setup to FastAPI's standard stack.
B1.5 Update tests to FastAPI's `TestClient` / `WebSocketTestSession`.
B1.6 Update `frontend/electron/ws/stt-client.ts` only if URLs change (should be transparent).
**Dependency:** None — can start immediately.

#### B2 — Decode config plumbing through the server (1 week)
B2.1 Update `spec/openapi.yaml` with new settings schema covering the 6 Tier-1 decode knobs.
B2.2 Regenerate TS types (`bun generate` in `frontend/`).
B2.3 Update `server/src/recorder/domain/config.py` Pydantic config with `WhisperDecodeConfig`.
B2.4 Plumb through `OnnxAsrTranscriber` adapter (currently 63 lines, will grow to ~120).
B2.5 Settings UI in `frontend/src/widgets/general-settings/` — surface the 6 hot knobs.
**Dependency:** Track A1 tag.

#### B3 — VAD simplification (3 days)
B3.1 Remove `webrtcvad` dependency from `server/pyproject.toml`.
B3.2 Drop `CompositeVAD` — server now uses `SileroVAD` adapter directly (already in `server/src/recorder/infrastructure/`).
B3.3 Adjust `silero_sensitivity` default to 0.5 (a hair tighter than RealtimeSTT's 0.4 since no WebRTC AND-gate).
B3.4 Keep `silero_deactivity_detection=True` — Silero handles end-of-speech too.
**Dependency:** None — can land now.

#### B4 — Streaming orchestration (3–4 weeks)
B4.1 New port `IRealtimeTranscriber` in `server/src/recorder/domain/ports/`.
B4.2 Adapter `ParakeetStreamingAdapter` — wraps engine's `AsrStream`. Owns audio chunking, batching, callback firing.
B4.3 Adapter `WhisperLocalAgreementAdapter` — Tier 3 fallback. Growing-buffer + LCP accumulator + `<|t|>` based trim.
B4.4 Engine-tier selection in `server/src/recorder/bootstrap.py`: query `model.capabilities`, pick adapter.
B4.5 Wire `RealtimeTranscriptionUpdate(text)` / `RealtimeTranscriptionStabilized(text)` events (already in `domain/events.py`).
B4.6 Cumulative-buffer optimization: feed previous committed text as `initial_prompt` to next Whisper call (Tier 3 path).
B4.7 Final-pass wiring: on VAD endpoint, send completed utterance through whisper-large-v3-turbo for canonical transcript; emit `TranscriptionCompleted(text)`.
**Dependency:** Track A3 tag.

#### B5 — Wake word integration (1 week)
B5.1 New port `IWakeWordDetector` already exists in `server/src/recorder/domain/ports/`.
B5.2 Adapter `OpenWakeWordAdapter` — wraps engine's `load_wake_word()`.
B5.3 Wire into existing wake-word state in `RecordingPipeline`.
B5.4 Settings: wake-word selection, sensitivity, timeout. Surface in frontend.
**Dependency:** Track A4 tag.

#### B6 — RealtimeSTT feature port (2–3 weeks, mostly server-side)
B6.1 `pre_recording_buffer_duration` — pre-roll ring buffer in audio reader.
B6.2 `min_length_of_recording` — reject sub-threshold utterances.
B6.3 `min_gap_between_recordings` — cooldown timer in pipeline state machine.
B6.4 `early_transcription_on_silence` — kick off transcription before silence-duration timer expires.
B6.5 `normalize_audio` — peak normalize to −0.95 dBFS in audio path.
B6.6 `feed_audio()` — non-mic input path. Already partially wired via `frontend/electron/ipc/file-transcribe.ts`; finalize on the server side.
B6.7 All 15 callbacks / events — bridge via `wire_callback()` in bootstrap (pattern already exists).
**Dependency:** Track A1, A3 tags for the engine surface; otherwise self-contained.

#### B7 — SaaS hooks (out of scope, future)
Auth, billing, multi-tenant model loading, rate limiting, model-tier gating. Punt until B1–B6 land.

---

### Dependency graph

```
A1 (decode config) ──────────────┬──> B2 (decode plumbing) ──> B6 (RealtimeSTT port)
                                 │
A2 (timestamps) ─────────────────┼──> B4.3 (Whisper LCA trim by <|t|>)
                                 │
A3 (streaming session API) ──────┴──> B4 (streaming orchestration)
                                              ▲
A4 (wake word) ──────────────────────────────────> B5 (wake word integration)
                                              │
A5 (model coverage) ──────────────────────────┘  (model menu in settings)

B1 (FastAPI) — independent, can start now
B3 (VAD simplification) — independent, can start now
A6 (engine internals) — opportunistic, lowest priority
```

**Parallelism plan:**
- **Weeks 1–2:** B1 (FastAPI) + B3 (VAD) run in parallel; A1 (decode config) starts.
- **Weeks 3–6:** A1 continues; A4 (wake word) can be done by a second contributor; B2 lands as soon as A1 is taggable.
- **Weeks 7–10:** A3 (streaming API) is the longest pole; B4 begins behind a feature flag pulling from A3's dev branch.
- **Weeks 11–13:** B4 finalize, B5, B6 polish.

---

### Track A vs Track B at a glance

| Concern | Engine (A) | Server (B) |
|---|---|---|
| ONNX session lifecycle | ✓ | — |
| Tokenizer / preprocessing | ✓ | — |
| Decode params (temp ladder, beam, guards, prompt) | ✓ | — pass-through |
| Timestamps token extraction | ✓ | — pass-through |
| Streaming state (Parakeet cache tensors) | ✓ | — |
| Wake-word ONNX session | ✓ | — |
| VAD ONNX session | ✓ already | — |
| Model file discovery / download | ✓ already | — |
| Audio capture (PyAudio) | — | ✓ already |
| Cumulative buffer / windowing | — | ✓ |
| VAD endpoint detection (silence timer) | — | ✓ already |
| LCP accumulator (Tier 3) | — | ✓ |
| Tier auto-selection | — | ✓ |
| Hotkeys / PTT | — | ✓ already |
| WebSocket / HTTP | — | ✓ |
| Settings schema | — | ✓ (OpenAPI) |
| Event bus / callbacks | — | ✓ already |
| Authentication / billing | — | ✓ (B7) |
| Model catalog UI | — | ✓ |

**Rule of thumb:** if it requires ONNX session state, vocab, or knowledge of a specific model architecture, it's Track A. If it requires knowledge of the user, the WebSocket, the audio device, or product logic, it's Track B.

---

### 9.5 Track A — atomic items sorted by difficulty (hardest → easiest)

Use this list to plan execution. Note that "hardest first" is a *de-risking* order — you may prefer "easiest-first to unblock parallelism" for practical scheduling. Both orderings are useful; pick per work session.

#### Tier 1 — Hardest (algorithmic risk, novel ONNX surface, hard to verify)

**1. Beam search for `WhisperHf._decoding`** (A1.7) — ~1–2 weeks
Maintain N parallel beams with their own KV-cache slices and log-prob accumulators across the autoregressive loop. Length-penalty normalization, repetition-penalty rescoring, beam pruning, per-beam EOS, log-sum-exp numerical stability. KV-cache duplication on beam expansion is the trickiest sub-problem (each beam carries its own cache; on expansion you slice and re-batch). Pure NumPy implementation must match `openai-whisper`'s output to within tokenization-equivalence on canonical inputs.
*Why hardest:* combinatorial state, subtle numerics, golden-value testing required.

**2. Parakeet TDT cache-aware streaming adapter** (A3.3, A3.4) — ~2 weeks
Requires NVIDIA's cache-aware ONNX export to actually exist and load (verify first — A3.4 is a *prerequisite* that could block A3.3 if exports aren't published). Persist `cache_last_channel` / `cache_last_time` state tensors across `feed_chunk()` calls. TDT-specific token-and-duration emission (decoder emits both a token and a duration count per step). Frame-synchronous greedy emission with blank handling.
*Why hard:* unfamiliar ONNX surface (NeMo cache tensors aren't documented like Whisper's KV), TDT semantics on top of base RNN-T, integration with existing `NemoConformerTdt` class in `models/nemo.py`.

**3. Temperature fallback ladder + sampling** (A1.6) — ~1 week
Greedy at `temperature[0]=0.0` first. On guard failure, sample with `temperature>0` (new code path — requires multinomial sampling from logits). Implement `best_of` (draw N samples per attempt, pick best by logprob). Combine with `no_speech_threshold`, `compression_ratio_threshold`, `logprob_threshold` guards. Reference is `openai-whisper/whisper/transcribe.py` (~150 LOC for the full recipe).
*Why hard:* lots of moving parts, easy to get the guard-failure → retry semantics subtly wrong.

**4. `AsrStream` protocol design** (A3.1) — ~3–5 days
Designing the right surface is harder than coding it. Decisions: chunk size policy (engine-imposed or caller-chosen?), how to signal "more data needed", how to handle reset/error, whether to expose intermediate hypotheses or only finalized tokens, how to make it work for stateless models (Whisper wrapper) and stateful models (Parakeet) under the same protocol.
*Why hard:* it's the engine ↔ server contract. Getting it wrong creates churn.

#### Tier 2 — Medium (clear algorithm, careful implementation)

**5. Segment-level timestamp extraction** (A2.1–A2.3) — ~3–5 days
Enable `<|t|>` tokens in vocab (today suppressed via `<|notimestamps|>` at `whisper.py:59`). Parse the token stream for timestamp markers (`<|0.00|>` … `<|30.00|>` in 0.02 s steps). Build segment list with start/end times. Edge cases: open-ended segment at end, two consecutive timestamps with no content, timestamps mid-word.

**6. No-speech / compression-ratio / logprob guards** (A1.4) — ~3–5 days
Extract `no_speech_prob` from first decoder logits (specific index in vocab). Compute compression ratio via `len(gzip(text)) / len(text)`. Track running `avg_logprob` across decode. Combine into boolean "retry needed" flag. Clean code paths in `openai-whisper` to copy from.

**7. `_WhisperBase` refactor + `models/whisper/` directory restructure** (A1.1, A1.2) — ~3–5 days
Mostly mechanical: move `whisper.py` → `whisper/` dir, extract shared init/tokenizer/preprocessing into `_WhisperBase`, `WhisperOrt` and `WhisperHf` become subclasses. Risk: subtle behavior changes during the move (test parity carefully before/after).

**8. OpenWakeWord ONNX adapter** (A4.1) — ~3–4 days
New model class mirroring `models/silero.py` structure. OWW has its own log-mel preprocessing (different from Whisper's). Supports multiple wake-word models loaded simultaneously (one ONNX session per wake-word). Threshold + custom-model paths.

**9. Suppress tokens + suppress blank** (A1.4 sub-item) — ~2–3 days
Set forbidden logit indices to `-inf` before argmax/softmax. Whisper has a default suppress set encoded in its tokenizer config (`suppress_tokens=-1` means "use the default set"). Need to load that set from the model's `generation_config.json` or hardcode it. Test: known-bad tokens never appear in any output.

**10. `initial_prompt` token plumbing** (A1.5) — ~2–3 days
Tokenize the prompt text via Whisper's BPE tokenizer (we already have one inlined in `_Whisper`). Prepend prompt tokens to the input sequence, within the 224-token prompt window. Whisper's special-token sequence already has a `<|startofprev|>` slot for prior-context.

#### Tier 3 — Easy (mostly registration / boilerplate)

**11. Lite-Whisper / Distil-Whisper / turbo registration** (A5.1–A5.3) — ~1 day each
Add entries to `model_repos` in `resolver.py`. Verify the existing `WhisperHf` class loads them (turbo has 4 decoder layers vs. large's 32 — same architecture, no code change expected). Smoke-test loading + transcription. Distil-Whisper similar — same architecture.

**12. `ModelCapabilities` dataclass + capability flags** (A3.2) — ~1 day
Frozen dataclass with `supports_streaming`, `supports_timestamps`, `supports_beam`, `is_multilingual`, etc. Each model class exposes `capabilities: ClassVar[ModelCapabilities]`. Used by server-side tier-selection.

**13. `load_wake_word(name, **kwargs)` in `loader.py`** (A4.2, A4.3) — ~1 day
Mirror the existing `load_vad()` function structure. Resolver registration, type registry, `WakeWordResult` dataclass analogous to `VADResult`.

**14. `_ModelImplementation` private ABC** (A6.1) — ~1 day
Pure-refactor ABC defining the shared interface for all `models/*.py` classes. Add `@override` to existing methods. Zero behavior change.

**15. `FakeModel` test fixture** (A6.2) — ~half a day
Stub of the `Asr` protocol returning canned text without ONNX session creation. Lives under `tests/fakes/`. Used by integration tests to avoid 100 MB downloads.

**16. Porcupine optional adapter** (A4.4) — ~half a day
Separate file `models/porcupine.py` wrapping `pvporcupine`. Not in default loader registry; user imports directly: `from onnx_asr.models.porcupine import PorcupineWakeWord`.

#### Deferred (depends on external ONNX export availability)

**17. Word-level timestamps via cross-attention DTW** — Tier 1 hard, but blocked
Requires ONNX exports of Whisper that include cross-attention tensors as outputs. The `onnx-community/whisper-*` exports do not expose these by default. Either custom export work (significant) or wait for community exports. Algorithm itself: DTW alignment on cross-attention weights from selected heads, per OpenAI's whisper.utils. Defer until exports exist.

---

#### Suggested execution order (NOT strictly hardest-first)

A pragmatic order that minimizes blocking and de-risks early:

1. **#14, #15** (ABCs, fakes) — half-day each, unblocks testing infrastructure.
2. **#11** (model registration) — 1 day, immediate user-visible win (large-v3-turbo as default).
3. **#7** (`_WhisperBase` refactor) — 3–5 days, prereq for almost everything in Whisper.
4. **#10, #9** (initial_prompt, suppress_tokens) — easy decode-config wins, sets up the param plumbing.
5. **#6** (guards) — sets up the framework #3 (temperature fallback) will reuse.
6. **#5** (segment timestamps) — independent, unblocks B4 Whisper LCA path.
7. **#3** (temperature fallback ladder) — the second-biggest quality win after guards.
8. **#4** (AsrStream design) — design first, code second.
9. **#1** (beam search) — biggest single quality jump for offline / final-pass.
10. **#12, #13, #8** (capabilities, load_wake_word, OpenWakeWord) — wake-word track in parallel with #1.
11. **#2** (Parakeet streaming) — biggest streaming win; needs #4 done first.
12. **#16** (Porcupine optional) — anytime.
13. **#17** (word timestamps) — when ONNX exports allow.

If you want strict hardest-first (de-risk by tackling unknowns first): swap the order to #4 → #2 → #1 → #3 → (everything else). Costs more in blocking but eliminates the "what if Parakeet exports don't exist" surprise early.

---

### 9.6 References per work item — port-not-implement

Every item below has at least one authoritative reference implementation we can port from rather than write from scratch. Cited with file:line for code we'd actually copy/adapt. License-checked: every reference is **MIT, Apache 2.0, or BSD** — compatible with our fork.

**Reference repos cloned into `examples/` for this pass:**
- `examples/openai-whisper/` (MIT — the canonical Whisper reference)
- `examples/sherpa-onnx/` (Apache 2.0 — production ONNX streaming runtime)
- `examples/NeMo/` (Apache 2.0 — NVIDIA's Parakeet authors)
- `examples/openWakeWord/` (Apache 2.0 — wake-word ONNX models)
- `examples/whisperX/` (BSD 2-Clause — confirmed negative reference for word timestamps)
- Previously cloned: `examples/SimulStreaming/`, `examples/TheWhisper/`, `examples/whisper-flow/`, `examples/VoiceStreamAI/`, `examples/RealtimeSTT/`, `examples/onnx-asr/`, `examples/faster-whisper/`

Attribution requirement: add `NOTICE` entries to our fork for OpenAI (Whisper), NVIDIA (NeMo), Xiaomi (sherpa-onnx), David Scripka (openWakeWord) when porting code.

---

#### #1 — Beam search for `WhisperHf`

**Primary reference — `examples/openai-whisper/whisper/decoding.py` (MIT)**:
- `decoding.py:130-141` — `Inference` ABC with `logits()`, `rearrange_kv_cache()`, `cleanup_caching()`. The KV-cache reorder API is exactly what beam search calls.
- `decoding.py:144-176` — `PyTorchInference` concrete; the "pass only last token after initial_token_length" optimization at lines 159-161 and the identity-check `source_indices != list(range(...))` at line 173 — port verbatim.
- `decoding.py:179-213` — `MaximumLikelihoodRanker` with Google-NMT length penalty `((5 + length) / 6) ** length_penalty` at line 207. Pure Python.
- `decoding.py:272-298` — `GreedyDecoder` (T=0 argmax / T>0 Categorical sample). `sum_logprobs * (tokens[:, -1] != eot)` masking at line 287.
- `decoding.py:301-404` — **`BeamSearchDecoder`** — the load-bearing port. Lines 333 logsoftmax, 339-346 topk continuations, 348-362 finished-buffering, 365 calls `rearrange_kv_cache(source_indices)`. Patience `max_candidates = round(beam_size * patience)` at line 313.
- `decoding.py:508-585` — `DecodingTask.__init__` composition root; validation rules (beam XOR best_of, T=0 incompatible with best_of, patience requires beam_size) at 572-585.
- `decoding.py:680-710` — `_main_loop` orchestration; no-speech extraction at `logits[:, sot_index]` step 0 only (lines 689-693).
- `decoding.py:713-789` — `DecodingTask.run` top-level: encode → repeat by n_group → main loop → reshape → rank → decode text. `avg_logprob = sum_logprobs / (len(tokens)+1)` at line 761 (the `+1` matters).

**Torch swaps required:**
- `F.log_softmax(x)` → `x - logsumexp(x, axis=-1, keepdims=True)` (numerically stable NumPy)
- `logprobs.topk(k)` → `np.argpartition(-logprobs, k)[:k]` + sort
- `Categorical(...).sample()` → `np.random.default_rng().choice(p=softmax(logits/T))`
- `torch.tensor(x, device=...)` → `np.asarray(x)`

**Port total:** ~435 LOC. Status: ready to start — no external blockers.

---

#### #2 — Parakeet TDT cache-aware streaming

**Primary reference — `examples/sherpa-onnx/` (Apache 2.0)** — they already do this with ONNX:
- `sherpa-onnx/csrc/online-transducer-nemo-model.h:22-122` — complete API contract: `RunEncoder(features, states) → [enc_out, next_states]`, `GetEncoderInitStates()` returning the 3-tuple `(cache_last_channel, cache_last_time, cache_last_channel_len)`. **This is the API shape we mirror in `NemoConformerTdtStream`.**
- `sherpa-onnx/csrc/online-transducer-nemo-model.cc:82-127` — exact ONNX call signature. Input names: `[features, length, cache_last_channel, cache_last_time, cache_last_channel_len]`. Outputs: `[encoder_out, encoded_lengths, next_cache_last_channel, next_cache_last_time, next_cache_last_channel_len]`. Transpose (B,T,C)→(B,C,T) before encoder.
- `sherpa-onnx/csrc/online-transducer-nemo-model.cc:293-385` — `InitEncoder()` reads cache dims from ONNX model metadata (`cache_last_channel_dim1/2/3`, `cache_last_time_dim1/2/3`, `window_size`, `chunk_shift`, `pred_rnn_layers`, `pred_hidden`). **Critical: read these from the .onnx file's metadata, not hard-code.**
- `sherpa-onnx/csrc/online-recognizer-transducer-nemo-impl.h:88-202` — orchestration loop: `CreateStream`, `IsReady() = numProcessedFrames + ChunkSize() < NumFramesReady()`, `DecodeStreams()`, `Reset()`. **This control flow is what `AsrStream.feed_chunk()` / `AsrStream.flush()` encapsulates.**
- `sherpa-onnx/csrc/online-transducer-greedy-search-nemo-parakeet-unified-decoder.cc:29-107` — **TDT-specific frame-synchronous greedy decoder**. Note `max_symbols_per_frame = 10` inner loop; predictor state persisted only on emission (lines 93, 103) — critical detail.
- `sherpa-onnx/python/sherpa_onnx/online_recognizer.py:979-1025` — final Python surface: `create_stream()`, `decode_stream(s)`, `is_ready(s)`, `get_result(s)`, `is_endpoint(s)`, `reset(s)`.

**Algorithmic ground truth — `examples/NeMo/` (Apache 2.0)**:
- `nemo/collections/asr/parts/mixins/streaming.py:18-77` — `StreamingEncoder` ABC. Method signatures: `get_initial_cache_state(batch_size, dtype, device, max_dim)`, `cache_aware_stream_step(processed_signal, length, cache_last_channel, cache_last_time, cache_last_channel_len, keep_all_outputs, drop_extra_pre_encoded, bypass_pre_encode)`.
- `nemo/collections/asr/modules/conformer_encoder.py:1087-1125` — cache tensor shapes: `cache_last_channel` is `(num_layers, B, streaming_cfg.last_channel_cache_size, d_model)`; `cache_last_time` is `(num_layers, B, d_model, conv_context_size[0])`; `cache_last_channel_len` is `(B,)` int64. **Validate against ONNX metadata dims.**
- `nemo/collections/asr/parts/utils/streaming_utils.py:1557-1730` — `CacheAwareStreamingAudioBuffer` — canonical ring buffer. Pre-encode cache lookback (1640-1675), chunk_size vs shift_size distinction (1602-1624). **Port `__iter__` logic into `AsrStream._consume_chunk()`.**
- `nemo/collections/asr/parts/submodules/transducer_decoding/tdt_label_looping.py:41-166, 191-540` — `GreedyBatchedTDTLabelLoopingComputer`. TDT logits split: `logits[:, :-num_durations]` (vocab+blank) vs `logits[:, -num_durations:]` (duration head); `time_indices += durations * active_mask` advances time by predicted duration per step.
- `examples/asr/asr_cache_aware_streaming/speech_to_text_cache_aware_streaming_infer.py:212-299` — end-to-end demo. `keep_all_outputs=True` only on the last step.

**Local current state — `examples/onnx-asr/src/onnx_asr/models/nemo.py`**:
- `NemoConformerTdt` already correctly handles TDT logits split: `output[:vocab_size]` is label head, `output[vocab_size:].argmax()` is duration. Offline-only today.
- The frame-synchronous decode loop exists in `asr.py:192-229` (`_AsrWithTransducerDecoding._decoding`). Adapt to run on **one encoder chunk at a time**, persisting `prev_state` across `feed_chunk()` calls.

**Prerequisite to verify before starting:** A cache-aware streaming ONNX export of Parakeet TDT must exist (check HuggingFace `nvidia/parakeet-tdt-0.6b-v3` streaming variants and `csukuangfj/sherpa-onnx-streaming-parakeet-tdt-*`). If absent, this work blocks on export tooling.

**Port total:** ~300-400 LOC (ring buffer + cache state + chunked encoder call + persistent predictor state). Status: **prerequisite check first** — verify streaming ONNX export.

---

#### #3 — Temperature fallback ladder + sampling

**Primary reference — `examples/openai-whisper/whisper/transcribe.py:184-224` (MIT)** — the canonical recipe:
- `transcribe.py:38-46` — defaults: `temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0)`, `compression_ratio_threshold=2.4`, `logprob_threshold=-1.0`, `no_speech_threshold=0.6`. Copy verbatim.
- `transcribe.py:184-224` — `decode_with_fallback` nested function. Loops temperatures; pops `beam_size`+`patience` when `t > 0` (lines 192-195); pops `best_of` when `t == 0` (lines 197-198). **Subtle silence override at lines 214-220:** if both `no_speech_prob > no_speech_threshold` AND `avg_logprob < logprob_threshold`, treat as silence and stop the ladder (sets `needs_fallback = False`).

Pure Python orchestration; no torch ops in the fallback loop itself.

**Port total:** ~45 LOC. Status: ready to start.

---

#### #4 — `AsrStream` protocol design

Common patterns observed across 5 reference implementations (sherpa-onnx, NeMo, SimulStreaming, whisper-flow, HuggingFace `TextIteratorStreamer`):

| Method | sherpa-onnx | NeMo | SimulStreaming | whisper-flow |
|---|---|---|---|---|
| Push audio | `OnlineStream.AcceptWaveform(sr, pcm, n)` `online-stream.h:38` | `CacheAwareStreamingAudioBuffer.append_audio(audio)` `streaming_utils.py:1733` | `PaddedAlignAttWhisper.insert_audio(segment)` `simul_whisper.py:269` | `TranscribeSession.add_chunk(bytes)` `streaming.py:73` |
| Finalize | `InputFinished()` `online-stream.h:47` | implicit (buffer drains) | `infer(is_last=True)` `simul_whisper.py:333` | `should_stop[0] = True` |
| Ready check | `IsReady(stream)` `online-recognizer.h:190` | `is_buffer_empty()` `streaming_utils.py:1697` | none (sync) | none (poll) |
| Decode step | `DecodeStream(s)` `online-recognizer.h:193` | `conformer_stream_step(...)` `mixins.py:592` | `infer()` blocking | `transcribe()` async |
| Read result | `GetResult(s) → OnlineRecognizerResult{text, tokens, timestamps, is_final, is_eof}` `online-recognizer.h:24-81` | `(pred_out, transcribed_texts, ...new_caches..., hypotheses)` tuple | `(token_ids, debug_dict)` | `result["data"]` dict |
| Reset | `Reset(s)` `online-recognizer.h:223` (keeps audio) | `reset_buffer()` `streaming_utils.py:1706` | none | recreate session |
| Endpoint | `IsEndpoint(s)` `online-recognizer.h:219` | external VAD | external VAD | "no change for N cycles" |

**Invariant API surface (non-negotiable):**
1. Factory method on Asr: `create_stream() → AsrStream`
2. Push-audio with sample rate
3. Explicit finalize signal (whisper-flow's heuristic is too lossy)
4. Poll + step methods
5. Typed result snapshot with `is_partial` / `is_final` flag (sherpa-onnx's `OnlineRecognizerResult` is the most complete shape)
6. Reset that zeros predictor state but keeps audio (sherpa-onnx pattern)

**Port total:** ~3-5 days design, ~100 LOC for the protocol + reference adapter. Status: ready to start.

---

#### #5 — Segment-level timestamps

**Primary local reference — `examples/onnx-asr/src/onnx_asr/`** — the timestamp infrastructure already exists for CTC/RNN-T:
- `asr.py:20-31` — `TimestampedResult` dataclass (`text, timestamps, tokens, logprobs`).
- `asr.py:160-176` — `_AsrWithCtcDecoding._decoding()` yields token IDs + frame indices.
- `asr.py:179-229` — `_AsrWithTransducerDecoding._decoding()` appends encoder time per emitted token (line 217).
- `asr.py:148-150` — timestamp scaling: `window_step * subsampling_factor * frame_indices`.
- `adapters.py:165-167` — `TextResultsAsrAdapter.with_timestamps()` adapter pattern.

**For Whisper specifically — `examples/openai-whisper/whisper/`**:
- `whisper/tokenizer.py:175-209` — special token IDs including `timestamp_begin` (`<|0.00|>`). Timestamps follow at 0.02 s steps (50 per second).
- `whisper/decoding.py` `ApplyTimestampRules` filter — enforces well-formed timestamp pairs in the token stream.

**Local — `examples/onnx-asr/src/onnx_asr/models/whisper.py`**: line 59 currently suppresses timestamps via `<|notimestamps|>`. Remove that suppression for timestamped mode.

**Port total:** ~3-5 days. Status: ready to start.

---

#### #6 — No-speech / compression-ratio / logprob guards

**Primary reference — `examples/openai-whisper/whisper/` (MIT)**:
- `utils.py:5, 45-47` — `compression_ratio()`: `text.encode("utf-8"); return len(text_bytes) / len(zlib.compress(text_bytes))`. Three lines, pure stdlib.
- `decoding.py:689-693` — no_speech_prob extraction at **step 0 only**: `softmax(logits[:, sot_index])` then column `tokenizer.no_speech`. **Important: at `sot_index`, not last position, before filter chain.**
- `decoding.py:760-762` — `avg_logprob = sum_logprob / (len(tokens) + 1)` — the `+1` matters for parity with openai-whisper.
- `transcribe.py:203-220` — guard combination (the three branches).
- `transcribe.py:298-310` — segment-skip logic for confident-silence detection.

**Port total:** ~20 LOC. Status: ready to start. Pairs naturally with #3.

---

#### #7 — `_WhisperBase` refactor

**Primary local reference — `examples/onnx-asr/src/onnx_asr/`** — the pattern already exists:
- `asr.py:54-65` — `Asr` protocol (abstract surface).
- `asr.py:68-93` — `BaseAsr` shared parent (config loading, preprocessor factory, ONNX options).
- `asr.py:108-157` — `_AsrWithDecoding` private base ABC. Defines `_encode()`, `_decoding()`, `_decode_tokens()` contract.
- `asr.py:160-176` — `_AsrWithCtcDecoding` — pattern to mirror for `_WhisperBase`.
- `asr.py:179-229` — `_AsrWithTransducerDecoding` — pattern to mirror.
- `models/whisper.py:34-65` — current `_Whisper` partial base. Refactor into proper `_WhisperBase` with capability flags.
- `models/whisper.py:78-81` — abstract `_decoding()` method (already in subclass-overrride pattern).
- `models/nemo.py:38` — pattern for multiple-inheritance: `NemoConformerCtc(_AsrWithCtcDecoding, _NemoConformer)`.

**Port total:** ~3-5 days, almost zero net LOC change (move + extract). Status: ready to start; this is the prerequisite for #1, #3, #6, #9, #10.

---

#### #8 — OpenWakeWord ONNX adapter

**Primary reference — `examples/openWakeWord/` (Apache 2.0)** — three-stage ONNX pipeline:
- `openwakeword/model.py:32-213` — main `Model` class.
  - Constructor `:38-48`: kwargs `wakeword_models: List[str]`, `class_mapping_dicts`, `vad_threshold`, `custom_verifier_models`, `inference_framework`.
  - ONNX session config `:149-159`: `SessionOptions` with `inter_op_num_threads=1` / `intra_op_num_threads=1`.
  - Single-input run `:137-138`: `onnx_model.run(None, {onnx_model.get_inputs()[0].name: x})`.
  - `predict(x)` `:232-386`: 1280-sample chunks (80 ms @ 16 kHz `:237-241`), 30-frame deque `:198`.
- `openwakeword/utils.py:33-463` — `AudioFeatures`:
  - Constructor + dual ONNX sessions `:38-93`. Mel input name `input` `:87`; embedding input name `input_1` `:93`.
  - Frame conventions: 1280-sample audio chunks; mel hop 160, window 400 (`:393-394`); 32 mel bins; 76-frame embedding window with 8-frame (80 ms) hop; 96-dim embeddings.
  - **Calibration constant** `:180`: `lambda x: x/10 + 2` — recalibrates ONNX mel against TF original. Critical.
  - Streaming state machine `:403-452`: `_buffer_raw_data`, `_streaming_melspectrogram`, `_streaming_features`.
  - `get_features(n=16, start_ndx=-1)` `:454-460`.
- `openwakeword/__init__.py:8-69` — model resolution: `MODELS` dict, `FEATURE_MODELS` (melspec + embedding), `get_pretrained_model_paths()`. Files at `resources/models/`, lazy download via `utils.download_models()`.
- `openwakeword/model.py:84-100` — custom-model loading (path or fuzzy-match name).

**Local pattern to mirror — `examples/onnx-asr/src/onnx_asr/models/silero.py:17-37`**, `vad.py:33-47, 50-60` (the VAD protocol + base class). RealtimeSTT integration reference: `RealtimeSTT/audio_recorder.py:856-896, 1605-1624`.

**Port estimate:** ~200-250 LOC. Status: ready to start; depends on #13 (`load_wake_word()`) being landed first.

---

#### #9 — Suppress tokens + suppress blank

**Primary reference — `examples/openai-whisper/whisper/decoding.py` (MIT)**:
- `decoding.py:423-431` — `SuppressBlank`: first-step only (`tokens.shape[1] == sample_begin`), set `logits[:, tokenizer.encode(" ") + [tokenizer.eot]] = -inf`. ~5 LOC.
- `decoding.py:433-438` — `SuppressTokens`: unconditional `logits[:, suppress_tokens] = -inf`. ~4 LOC.
- `decoding.py:615-642` — `_get_suppress_tokens`: resolves `-1` sentinel to `tokenizer.non_speech_tokens`; always appends `transcribe`, `translate`, `sot`, `sot_prev`, `sot_lm`, `no_speech`. ~25 LOC.
- `whisper/tokenizer.py:242-285` — `non_speech_tokens` property: punctuation, brackets, repeated dashes, ♪♫. ~40 LOC.

**Port total:** ~75 LOC. Status: ready to start; tokenizer-dependent (verify our BPE produces same IDs).

---

#### #10 — `initial_prompt` token plumbing

**Primary reference — `examples/openai-whisper/whisper/` (MIT)**:
- `decoding.py:587-613` — `_get_initial_tokens` prompt handling. **Window: `prompt_tokens[-(n_ctx // 2 - 1):]`** → 223 tokens max + `<|startofprev|>` marker = 224.
- `transcribe.py:238-244` — encoding: `tokenizer.encode(" " + initial_prompt.strip())`. **Critical: leading space required by GPT-2 BPE for proper subword merging.**
- `transcribe.py:288-293` — rolling prompt + `carry_initial_prompt` mode for domain vocab.
- `tokenizer.py:175-209` — `sot_prev`, `sot`, `sot_lm`, `no_timestamps` special tokens.

**Port total:** ~45 LOC. Status: ready to start.

---

#### #11 — Lite / Distil / turbo registration

**Verified HuggingFace availability (corrected):**

| Model ID | Status | Notes |
|---|---|---|
| `onnx-community/whisper-large-v3-turbo` | **Exists** | High-traffic. Add to `model_repos`. |
| `onnx-community/distil-large-v3.5-ONNX` | **Exists** | Distil-Whisper v3.5, ONNX form, Transformers.js compatible. Use directly. |
| `onnx-community/lite-whisper-large-v3-acc-ONNX` | **Exists** | Lite-Whisper "accuracy" variant, ONNX form, Transformers.js compatible. Base model `efficient-speech/lite-whisper-large-v3-acc`. Use directly. |
| `onnx-community/whisper-base_timestamped` | **Exists** | Exposes cross-attention — unblocks word-level timestamps (#17). |
| `onnx-community/whisper-medium.en_timestamped` | **Exists** | Same. |
| `onnx-community/whisper-large-v3_timestamped` | **Exists** | Same. |

All exports follow the same Optimum/Transformers.js convention — `encoder_model.onnx` + `decoder_model_merged.onnx` with optional `_q4`/`_q8`/`_uint8` quantizations. Our existing `WhisperHf` class (`models/whisper.py:146-227`) loads them as-is.

**Primary local references**:
- `examples/onnx-asr/src/onnx_asr/resolver.py:18-34` — `model_repos` dict.
- `examples/onnx-asr/src/onnx_asr/loader.py:37-55` — `AsrNames` Literal.
- `examples/onnx-asr/src/onnx_asr/loader.py:98-125` — `create_asr_resolver` class dict.

**Three-line change pattern:** add to `model_repos`, add to `AsrNames` Literal, add to resolver class dict. Status: all four Whisper variants (turbo, distil-v3.5, lite-v3-acc, timestamped) ready today — no custom export needed.

---

#### #12 — `ModelCapabilities` dataclass

**Local pattern — `examples/onnx-asr/src/onnx_asr/adapters.py:28-220`**: runtime capability composition via `.with_vad()`, `.with_timestamps()`. We want metadata alongside these — frozen dataclass with `ClassVar[ModelCapabilities]` per model class.

**No external reference needed.** ~30 LOC. Status: ready.

---

#### #13 — `load_wake_word()`

**Primary local reference — `examples/onnx-asr/src/onnx_asr/loader.py:373-416`**: `load_vad()` function. **Copy verbatim**, swap VAD dispatch for wake-word class dispatch. Mirror in `__init__.py:1-10` exports.

**Port total:** ~50 LOC, 1 day. Status: ready.

---

#### #14 — `_ModelImplementation` private ABC

**Local pattern already exists — `examples/onnx-asr/src/onnx_asr/asr.py`**:
- `:54-65` `Asr` Protocol — public surface.
- `:108-157` `_AsrWithDecoding` private base ABC.
- `:160-176` `_AsrWithCtcDecoding` private ABC.
- `:179-229` `_AsrWithTransducerDecoding` private ABC.
- `resolver.py:37-39` `_Model` protocol with `_get_model_files()`.

**Mostly already done.** ~1 day to formalize and document.

---

#### #15 — `FakeModel` test fixture

**Primary local references — `server/tests/fakes/`**:
- `fake_transcriber.py:9-52` — implements `ITranscriber`, stores result/call count.
- `fake_vad.py:9-38` — implements `IVoiceActivityDetector`, pattern-driven results.
- `fake_wake_word.py` — implements `IWakeWordDetector`.

**Mirror at `examples/onnx-asr/tests/fakes/`** for the `Asr` and `Vad` protocols. ~½ day. Status: ready.

---

#### #16 — Porcupine optional adapter

**Integration reference — `examples/RealtimeSTT/RealtimeSTT/audio_recorder.py:834-854, 1591-1603`**:
- Init pattern: `pvporcupine.create(keywords=..., sensitivities=...)`. **Modern API requires `access_key=`** (RealtimeSTT omits but new pvporcupine versions need it).
- Frame: `pcm = struct.unpack_from("h" * 512, data)` → `porcupine.process(pcm)` returns -1 or 0..N-1.
- Cleanup: `self.porcupine.delete()`.

**Picovoice Python SDK API**:
- `pvporcupine.create(access_key, keywords | keyword_paths, sensitivities) → Porcupine`
- `handle.process(pcm)` → int (-1 or keyword index)
- `handle.frame_length` (512), `handle.sample_rate` (16000)
- Built-ins via `pvporcupine.KEYWORDS`

**Port total:** ~40-60 LOC, separate file `models/porcupine.py`. Not in default loader registry. License: pvporcupine Apache 2.0; **model files require free AccessKey** (keep unbundled). Status: ready.

---

#### #17 — Word-level timestamps via cross-attention DTW

**Critical update: NOT blocked anymore.** `onnx-community/whisper-base_timestamped` (and `whisper-medium.en_timestamped`, `whisper-large-v3_timestamped`) exports include cross-attention outputs. Transformers.js uses these for its word-timestamps feature.

**Primary reference — `examples/openai-whisper/whisper/timing.py` (MIT)**:
- `whisper/__init__.py:34-51` — `_ALIGNMENT_HEADS` dict: base85-encoded `(n_layers, n_heads)` boolean masks per model. **Ship verbatim** — decode via `base64.b85decode(blob)` → gzip → reshape.
- `timing.py:19-54` — `median_filter` (width 7 default). Replace with `scipy.ndimage.median_filter(x, size=(1,1,w), mode='reflect')` or hand-roll. Triton path (37-45) — drop.
- `timing.py:57-79` — `backtrace` DP. Drop `@numba.jit` (small inputs).
- `timing.py:82-105` — `dtw_cpu` forward DP. **Strict-less tie-break at lines 95-100 is load-bearing.**
- `timing.py:108-151` — Triton kernel path. **Delete.**
- `timing.py:155-160` — `WordTiming` dataclass.
- `timing.py:163-244` — **`find_alignment`** core: extract cross-attention QKs, stack heads from `alignment_heads`, crop to `num_frames // 2`, softmax + per-token z-score normalize, median filter, mean across heads, DTW on negated matrix.
- `timing.py:245-277` — `merge_punctuations`.
- `timing.py:279-388` — `add_word_timestamps`. `TOKENS_PER_SECOND = 50`.

**Negative reference — `examples/whisperX/whisperx/alignment.py`**: confirmed uses **Wav2Vec2 CTC forced alignment**, NOT cross-attention DTW. Imports `Wav2Vec2ForCTC` at `alignment.py:12`; default models per language at `:41-76`; trellis Viterbi at `:425-540`. Cited as negative reference — don't follow this path (would need 30+ per-language models).

**ONNX-side prerequisite**: Our `models/whisper.py:196-206` currently binds `encoder_hidden_states` and logits only. Add cross-attention outputs to IO binding for `_timestamped` model variants. Optimum custom export config recipe at `https://huggingface.co/docs/optimum-onnx/en/onnx/usage_guides/export_a_model` if we ever need to re-export turbo with timestamps.

**Port total:** ~280 LOC numpy-only, plus IO binding work. Status: **was blocked, now unblocked** — `_timestamped` variants exist for base / medium.en / large-v3. For turbo, custom Optimum re-export.

---

### Bonus: log-mel sanity check

`examples/openai-whisper/whisper/audio.py:13-22, 110-157` — verify our `preprocessors/` against:
- Constants: `SAMPLE_RATE=16000`, `N_FFT=400`, `HOP_LENGTH=160`, `N_FRAMES=3000`, `N_SAMPLES=480000`, `TOKENS_PER_SECOND=50`.
- Normalization (`:154-156`): `log10(clamp(spec, 1e-10))` → `max(log_spec, log_spec.max() - 8.0)` → `(log_spec + 4.0) / 4.0`. **The `-8.0` floor and `/4.0` scale are easy to get wrong.**
- Mel filter bank shipped as `whisper/assets/mel_filters.npz` — load directly to avoid librosa version drift.

---

### Summary: liftable LOC by item

| Item | Reference LOC | Status |
|---|---|---|
| #1 Beam search | ~435 (openai-whisper) | Ready |
| #2 Parakeet streaming | ~300-400 (sherpa-onnx + NeMo) | **Verify ONNX export first** |
| #3 Temperature fallback | ~45 (openai-whisper) | Ready |
| #4 AsrStream design | ~100 (sherpa-onnx surface) | Ready |
| #5 Segment timestamps | ~50 (local + openai-whisper) | Ready |
| #6 Guards | ~20 (openai-whisper) | Ready |
| #7 `_WhisperBase` | ~0 net (local refactor) | Ready (prereq for many) |
| #8 OpenWakeWord | ~200-250 (openWakeWord) | Ready after #13 |
| #9 Suppress tokens | ~75 (openai-whisper) | Ready |
| #10 initial_prompt | ~45 (openai-whisper) | Ready |
| #11 Model registration | ~10 per model (local) | Turbo ready; Lite/Distil need export |
| #12 ModelCapabilities | ~30 (no ext ref needed) | Ready |
| #13 `load_wake_word()` | ~50 (local) | Ready |
| #14 `_ModelImplementation` | ~50 (already exists in spirit) | Ready |
| #15 FakeModel | ~30 (server pattern) | Ready |
| #16 Porcupine | ~50 (RealtimeSTT) | Ready |
| #17 Word timestamps | ~280 (openai-whisper) | **Unblocked** by `_timestamped` exports |

**Grand total of liftable Python from openai-whisper alone:** ~900 LOC. Adding sherpa-onnx/NeMo for streaming and openWakeWord for wake-word: ~1500 LOC of reference code to adapt. Roughly 60-70% port effort vs. write-from-scratch.

---

## 10. What We Will NOT Do

These were considered and rejected, with reasons:

- **Rewrite engine in TypeScript** — §1. Five concrete library losses with no offsetting win.
- **Full hexagonal architecture inside onnx-asr** — §2. It's a library, not an app. The server is hexagonal; the engine doesn't need to be.
- **Build streaming into the onnx-asr public API** — §4. Composition pattern, not inheritance.
- **Adopt sherpa-onnx as primary engine** — its Python and Node bindings are real, but the ONNX-only Whisper-with-controls path is exactly what we're already building. No reason to add another runtime.
- **Move to gRPC for the server** — WebSockets work, FastAPI handles HTTP, gRPC adds binary-protocol complexity without a current need.
- **Hardcode any provider — model, engine, VAD, wake-word, LLM** — §2.6. Every component is behind a port with multiple adapters. User picks via settings.
- **Skip Whisper streaming** — §4. Whisper streaming is required (some users prefer Whisper; some languages aren't covered by Parakeet). Port LocalAgreement-2 from UFAL whisper_streaming.
- **Single-model preview** — §4. Two-model architecture (small preview + large final) is the right default for live visual feedback. Single-model mode is an option, not the default.
- **Publish onnx-asr to PyPI now** — §2.5. Premature. Internal-use semver during heavy API churn is a tax for no benefit. Vendor as editable path dep until SaaS launches.

---

## 11. Open Questions

1. **Word-level timestamps via cross-attention DTW** — defer until segment-level lands. Whisper-X is the reference; their algorithm requires extracting specific cross-attention heads at decode time. Whether the ONNX exports we use expose those heads needs verification per model.
2. **GPU EP order** — current resolver uses `rt.get_available_providers()` order. We confirmed in the smoke test that TRT EP fails without `nvinfer_10.dll`. Decide: detect TRT availability at load time and skip silently, or force users to opt in via explicit `providers=` list. Lean toward auto-detect (less surprise).
3. **CUDA on Windows distribution path** — currently relies on `import torch` to populate the DLL search path. For users without torch, we'd need to either bundle CUDA DLLs (large) or call `ort.preload_dlls()` after installing `nvidia-*-cu12` pip packages. Address before public release.
4. **Lite-Whisper licensing & model id resolution** — confirm the actual HF repo path and any license constraints before adding to `model_repos`.

---

## Methodology

This document was produced by `/deep-research` with six agent investigations inspecting real code. Initial pass (1–4), revision pass (5–6) after user pushback on two claims.

1. **onnx-asr Architecture Audit** — Explore agent over `examples/onnx-asr/src/` and `tests/`. Output: 25 source files cited with 50+ line-number references. Key finding: greedy-only Whisper, no streaming, clean Asr/Vad protocols.
2. **RealtimeSTT Feature Audit** — Explore agent over `examples/RealtimeSTT/`. Output: full 60-kwarg constructor inventory, LCP streaming pattern documented, callback set enumerated.
3. **WinSTT-old Hexagonal Audit** — Explore agent over `examples/WinSTT-old-history/`. Output: confirmed real ports exist for the *app*; confirmed mature ASR libs (OpenAI Whisper, faster-whisper) are flat.
4. **TypeScript ML Ecosystem Parity** — general-purpose agent inspecting `examples/voicetypr/`, `examples/openwhispr/`, `examples/whishpy/`, `examples/epicenter/`, `examples/electrobun/` plus web research of `onnxruntime-node`, `@huggingface/transformers`, `@ricky0123/vad`, `sherpa-onnx` npm, etc. Output: cited GitHub issues showing CUDA-on-Windows-Node parity gap, discontinued vad-node, missing HF Hub progress.
5. **Streaming Whisper Due Diligence** (revision pass) — general-purpose agent cloned `SimulStreaming`, `VoiceStreamAI`, `TheWhisper`, `whisper-flow` into `examples/`, plus re-verified onnx-asr streaming surface. Output: comparative table of five mature streaming approaches, Parakeet TDT pivot recommendation. **Overturned the prior claim** that "nobody really streams Whisper."
6. **Dual-VAD Rationale** (revision pass) — Explore agent over `examples/RealtimeSTT/` VAD code paths. Output: confirmed dual VAD is a CPU-gating optimization (WebRTC microsecond pre-filter, Silero only runs when WebRTC fires). **Confirmed** Silero-only is correct for an ONNX stack — but for a better reason than the previous draft gave.

All evidence is file:line-cited within agent outputs (preserved in chat transcript). No claim in this document is unsupported by inspection of actual source or a named GitHub issue.

### Claims overturned by the revision pass
- *"Whisper is not a streaming model. There is no way to make it one without re-architecting the encoder."* — False. Five mature implementations bolt streaming on (LocalAgreement, AlignAtt, word-timestamp commit, stability voting, etc.). What's true: it's a workaround, and Parakeet TDT is a better hot-loop choice.
- *"Drop WebRTC because Silero ONNX is fast enough."* — Correct conclusion, weak prior reasoning. The actual rationale: RealtimeSTT's dual VAD is a CPU-gating trick (WebRTC at 100 µs gates Silero at 1–2 ms). When Silero runs ONNX on the same hot path anyway, the saving is small and the dual-threshold complexity tax is real.

### Materiality assumptions surfaced
- We assume the SaaS pivot proceeds. Decisions about server framework (FastAPI) and wake-word backend (OpenWakeWord) shift if the product stays single-user desktop.
- We assume Windows is the primary platform. Linux/macOS get the same Python engine for free; the CUDA-DLL discussion is Windows-specific.
- We assume the current Electron+Next.js+FSD frontend stays. None of the engine decisions affect it.

---

## 11. Implementation Progress (live)

This section tracks every Track A item that has actually shipped to `winstt/onnx-asr` — one branch per item, each with tests. Branches are listed in the order they were merged into the local `feat/demo-combined` integration branch.

### Track A — onnx-asr fork

| # | Plan item | Branch on `winstt/onnx-asr` | Tests | Status |
|---|---|---|---|---|
| **#1** | Beam search for `WhisperHf._decoding` | `feat/whisper-beam-search` | 12 | ✅ pushed |
| **#3** | Temperature fallback ladder + quality guards | `feat/whisper-temperature-fallback` | 18 | ✅ pushed (covers #6 guards) |
| **#4** | `AsrStream` protocol + `ModelCapabilities` | `feat/asr-stream-protocol` | 9 | ✅ pushed |
| | Buffered ASR stream (model-agnostic) | `feat/buffered-asr-stream` | 13 | ✅ pushed |
| | Whisper-specific LocalAgreement-2 stream | `feat/whisper-stream-local-agreement` | 26 | ✅ pushed |
| **#5** | Segment-level timestamps (`return_timestamps=True`) | `feat/whisper-segment-timestamps` | 10 | ✅ pushed |
| | Audio-buffer trimming on commit (consumes #5) | `feat/whisper-stream-buffer-trim` | 7 | ✅ pushed |
| **#7** | `_WhisperBase` refactor + `models/whisper/` package split | `feat/whisper-package-refactor` | 147 parity | ✅ pushed |
| **#8** | OpenWakeWord ONNX adapter | `feat/openwakeword-adapter` | 20 | ✅ pushed |
| **#9** | `suppress_tokens` / `suppress_blank` | `feat/whisper-suppress-tokens` | 8 | ✅ pushed |
| **#10** | `initial_prompt` token plumbing | `feat/whisper-initial-prompt` | 14 | ✅ pushed |
| **#11** | Lite-Whisper / Distil-Whisper / turbo / timestamped registrations | `feat/whisper-model-registrations` | 15 | ✅ pushed |
| | + `lite-whisper` / `distil-whisper` config-type routing | `feat/whisper-model-types-routing` | 5 (incl. real lite-whisper-large load) | ✅ pushed |
| **#12** | `ModelCapabilities` dataclass | merged with #4 | (covered in #4 tests) | ✅ pushed |
| **#13** | `load_wake_word(name, **kwargs)` in `loader.py` | `feat/load-wake-word` | 8 | ✅ pushed |
| **#14** | `_ModelImplementation` private ABC | `feat/model-implementation-abc` | 78 (15 classes × ~5 checks) | ✅ pushed |
| **#15** | `FakeAsr` / `FakeResampler` test fixtures | `feat/fake-model-fixture` | 13 (run in 0.28 s, no network) | ✅ pushed |
| **#16** | Porcupine optional adapter | `feat/porcupine-adapter` | 19 (18 active + 1 conditionally skipped) | ✅ pushed |
| **#17** | Word-level timestamps via cross-attention DTW | `feat/whisper-word-timestamps` | 23 (21 unit + 2 real-model E2E) | ✅ pushed |
| | New Whisper kwarg: `task` (transcribe / translate) | `feat/whisper-task` | 9 | ✅ pushed |
| | New Whisper kwarg: `max_new_tokens` | `feat/whisper-max-new-tokens` | 8 | ✅ pushed |
| | HuggingFace download progress callback | `feat/progress-callback` | — | ✅ pushed |
| | Explicit `close()` / context-manager memory lifecycle | `feat/lifecycle-close` | 18 (incl. bounded-RSS regression) | ✅ pushed |
| **#2** | Parakeet TDT cache-aware streaming | — | — | 🚫 deferred (no upstream cache-aware ONNX export) |
| **#6** | No-speech / compression-ratio / logprob guards | merged into #3 | — | ✅ shipped via #3 |

**Track A totals (against the original 16-item plan):**
- **Shipped: #1, #3, #4, #5, #7, #8, #9, #10, #11, #12, #13, #14, #15, #16, #17** (15 of 16)
- **Plus bonus engine work** not in the original plan: 3-class buffered/whisper stream split, audio-buffer trim, lite-whisper config routing, task/max-new-tokens/progress-callback kwargs, package refactor
- **Deferred: #2** (Parakeet TDT cache-aware streaming) — NVIDIA still hasn't published a cache-aware ONNX export; would require either an export-tooling effort or waiting on upstream

**Test totals across new code:**
- ~340 new unit tests run in <2 minutes (mostly synthetic-input / fake-session driven)
- Integration tests hit real Hub-cached models: `whisper-base`, `whisper-tiny`, `whisper-base_timestamped`, `lite-whisper-large-v3-acc-ONNX`
- Cross-branch parity verified: `_WhisperBase` refactor produced **0 test regressions** (147 → 147 pass on the same Whisper suite, 312 → 312 pass on the broader cross-module sweep)

### Server-side (local-only, `server/examples/` — directory is gitignored)

| Demo | Purpose | Status |
|---|---|---|
| `onnx_asr_progress_smoke.py` | Verify HF download progress callback wiring; polished KB/s / MB/s / MB rendering | ✅ working |
| `onnx_asr_stream_demo.py` | Hotkey-driven live streaming transcription via `WhisperStream`. Lite-Whisper-large-v3-acc by default | ✅ working |
| `onnx_asr_word_timestamps_demo.py` | Live streaming preview + per-word `[start–end s]` timestamps on commit (uses `whisper-base_timestamped`) | ✅ working |
| `server/tests/integration/test_stream_demo_e2e.py` | 12-test E2E suite for the demo Transcript / ChunkRecorder / MegabyteColumn logic | ✅ pushed |

### Track B — backend (server orchestration)

Track B is the hexagonal server refactor (`server/src/recorder/`, `server/src/stt_server/`) that will replace the current bespoke pipeline with onnx-asr. Engine surface is stable, so Track B has begun.

| Step | Slice | Branch | Status |
|---|---|---|---|
| B-1 | **Drop torch + faster_whisper.** Removes torch / torchaudio / faster-whisper / transformers / onnxruntime-gpu from main deps. New `server[cpu]` and `server[gpu]` extras (mutually exclusive via uv `conflicts`). `silero_vad.py` rewritten on top of `onnx_asr.load_vad("silero")`; `device.py` switched to ORT execution-provider detection; `whisper_transcriber.py` and `realtime_transcriber.py` deleted; bootstrap unified on `OnnxAsrTranscriber`; `ModelCatalog` Whisper entries rerouted to `onnx-community/whisper-*` with `large-v1`/`large-v2` dropped (no upstream ONNX export); `TranscriberBackend.FASTER_WHISPER` kept as legacy alias for config back-compat; `src/stt_server/file_transcribe.py` rewritten to use `model.with_timestamps().recognize(..., return_timestamps=True)` plus ffmpeg-subprocess media decoding; 28 obsolete tests removed. 285 passing / 0 failing. ruff + mypy --strict clean. | `feat/server-drop-torch` | ✅ pushed |
| B-2 | FastAPI rewrite of `src/stt_server/server.py` — replace bespoke websockets with FastAPI WebSocket routes; reuse the existing dual-channel control + binary protocol. | — | ⏳ next |
| B-3 | Frontend OpenAPI regen + electron WebSocket-client sweep against the FastAPI server. | — | ⏳ pending |

### Outstanding items

- **#2 Parakeet TDT cache-aware streaming** — blocked on NVIDIA upstream; revisit when a cache-aware ONNX export appears on Hugging Face or NGC
- **Track B server hexagonal rewrite** — Step B-1 shipped; B-2 / B-3 pending
- **Word-timestamp UI polish on the demo** — separate non-plan demo refinement
- **Cross-branch upstream PRs** — each `feat/*` branch is independently pushed and PR-able to `istupakov/onnx-asr` (or kept on the fork). Merge ordering matters because some branches build on others (e.g. word timestamps merges in segment timestamps; refactor merges everything).

