# AGENTS.md

> **Audience:** anyone editing the WinSTT repo — humans and AI coding assistants alike. This is the canonical "what the rules are" map. For workflow / PR etiquette / community process see [CONTRIBUTING.md](CONTRIBUTING.md). For per-subproject details see `server/CLAUDE.md` and `frontend/CLAUDE.md`.

This file is short on purpose. It points you at the rules, then enforces a small number of non-negotiables.

---

## 1. What WinSTT is

- A Windows speech-to-text desktop app, **local-first by default**.
- Two processes: a **Python STT server** (hexagonal architecture, ports/adapters) and an **Electron + Vite multi-page React 19 frontend** (Feature-Sliced Design).
- They communicate over **two WebSocket channels**: control JSON on 8011, binary audio on 8012.
- The shared type contract lives in **`spec/openapi.yaml`** (OpenAPI 3.1). TS types + Zod schemas regen via `bun generate`; Pydantic models in `server/src/recorder/domain/` consume the same shape.

## 2. The four ideas every change should reinforce

1. **Local-first.** Audio never leaves the machine. Cloud STT (OpenAI / ElevenLabs) is opt-in and lives in the Electron main process via the Vercel AI SDK — keys are stored in OS `safeStorage`, never sent to the renderer.
2. **Hexagonal & FSD.** Server: domain → ports → infrastructure, dependencies point inward. Frontend: `app → views → widgets → features → entities → shared`, no sideways imports. Both are enforced — server by 100 % coverage gate + mypy strict, frontend by `bun check:fsd` (~123 rules).
3. **One model engine.** Every STT model runs on the same ONNX engine via our `onnx-asr` fork. Adding a model family means a catalog entry + fork commit, NOT a new runtime. Whisper-cpp / GGML are not used (see `examples/Handy` for the alternative we evaluated).
4. **OpenAPI as the contract.** Any change to a shared type starts in `spec/openapi.yaml`. Then `bun generate`. Then Python.

## 3. Hard rules (non-negotiable)

These are encoded in tooling — overriding them is almost always a bug, not a feature.

- 🛑 **NEVER run `git stash` in any form.** Pre-commit hook blocks stash refs; `.claude/settings.local.json` denies the bash command; the harness denylist blocks `git stash pop` / `git stash apply`. See `memory/feedback_no_git_stash.md` for the two incidents. Side copies: `cp file file.bak`. Compare against HEAD: `git show HEAD:<path>`. Isolated work: `git worktree add ../winstt-scratch`.
- 🛑 **No `useMemo` / `useCallback` in renderer code.** `babel-plugin-react-compiler` handles memoization (gated on `command === "build"` so dev startup stays fast). Manual wrapping is dead code.
- 🛑 **No `electron` import outside `electron/preload.ts`.** The preload bridge is the only seam. Renderer code uses `window.electronAPI.*` (typed via `spec/generated/ts/schema.d.ts`).
- 🛑 **Never split React from `@base-ui/react` in `manualChunks`.** Circular ESM chunks crash packaged builds with `Cannot read properties of undefined (reading 'useLayoutEffect')`. Dev doesn't reproduce. See `memory/project_vite_chunk_circular_react.md`.
- 🛑 **Never run downloads / model loads inline in async IPC handlers.** They freeze the WS pump. Use the background-task pattern. See `memory/project_ws_request_response_value_envelope.md`.
- 🛑 **Don't trim the `[gpu]` extra's NVIDIA wheels.** ORT's CUDA EP delay-loads `cublas / cudnn / cufft / cusparse / cusolver / curand / nvjitlink / cuda-runtime / cuda-nvrtc` at session-create time regardless of the model graph. Dropping any silently demotes to CPU. See `memory/project_ort_cuda_ep_deps.md`.
- 🛑 **No PyTorch in the STT hot path.** The transcription stack is ONNX-only. Torch is allowed *only* inside the optional `[sentence-classifier]` extra (DistilBERT for end-of-turn detection, fail-soft).

## 4. The maps you actually need

| Where you are | Read this first |
|---|---|
| Anywhere in the repo | This file → [`CLAUDE.md`](CLAUDE.md) |
| `server/` (Python) | [`server/CLAUDE.md`](server/CLAUDE.md) — hexagonal layers, 6 ports, application services, threading model, 100 % coverage gate |
| `frontend/` (TS) | [`frontend/CLAUDE.md`](frontend/CLAUDE.md) — FSD layers (`views/` not `pages/`), Vite multi-page, IPC data layer, Zustand-only |
| `spec/openapi.yaml` | The contract — edit here first, then `bun generate` in `frontend/` |
| `docs/` | Fumadocs site; per-page MDX. Architecture map at `docs/content/docs/architecture/` |
| `packaging/` | `electron-builder.{cpu,directml,openvino}.yml` + PyInstaller staging |
| `.github/workflows/` | CI matrix; the release workflow fans out to CPU / DirectML / OpenVINO jobs |
| `memory/` | Long-term notes from past sessions (debug recipes, gotchas, postmortems) |

## 5. Architecture in one screen

```
            ┌────────────────────────────────────────────────────────────────┐
            │                       Electron app                             │
            │                                                                │
            │  Renderer (Vite multi-page, React 19, FSD)                     │
            │      ▲                                                         │
            │      │ IPC via window.electronAPI (typed by OpenAPI schema)    │
            │      ▼                                                         │
            │  Electron main (Node)                                          │
            │      • 50+ IPC handlers under electron/ipc/                    │
            │      • 8 BrowserWindows (main, settings, overlay, tray-menu,   │
            │        model-picker, device-picker, onboarding, history)       │
            │      • Native: uiohook-napi, winstt-paste.exe (C),             │
            │        winstt-context.exe (C)                                  │
            │      • Cloud STT via Vercel AI SDK                             │
            └─────────────────────────────────────────────────────────────────┘
                            │ dual-channel WebSocket (control JSON + binary audio)
                            ▼
            ┌────────────────────────────────────────────────────────────────┐
            │                Python STT server (hexagonal)                   │
            │                                                                │
            │  application/  RecorderService · RecordingPipeline ·           │
            │                RealtimeStabilizer · DiarizationStream ·        │
            │                VadCalibrator · WavWriter · SwapBenchmark       │
            │                                                                │
            │  infrastructure/  PyAudio · CompositeVAD · OnnxAsrTranscriber  │
            │                   · RemoteTranscriber · OnnxAsrDiarizer ·      │
            │                   DistilbertClassifier · device.py (EP probe)  │
            │                                                                │
            │  domain/       6 ports (IAudioSource, ITranscriber,            │
            │                IVoiceActivityDetector, IWakeWordDetector,      │
            │                IDiarizer, ISentenceClassifier) + state machine │
            │                + ~30 events + Pydantic config                  │
            │                                                                │
            │  bootstrap.py  Builder helpers shared between facade init      │
            │                and live model swaps (NOT a Kink container)     │
            │                                                                │
            │  Facade:  AudioToTextRecorder (100+ kwargs, lazy init,         │
            │           sole composition root)                               │
            │                                                                │
            │  Synthesizer sibling (Kokoro-ONNX TTS, opt-in support pack)    │
            └─────────────────────────────────────────────────────────────────┘
```

## 6. Tooling chains

| Layer | Linter / formatter | Type checker | Test runner | Lint extras |
|---|---|---|---|---|
| `server/` | ruff (`E W F I UP B SIM ANN RUF`, line-length 120) | mypy --strict (Pydantic plugin) | pytest (`fail_under = 100`); hypothesis property tests | — |
| `frontend/` | Biome 2.x + ultracite (tabs, double quotes, 100-char) | tsgo (default) / TypeScript | Bun test + Playwright (e2e/visual) + Stryker (mutation) + fast-check | `bun check:fsd`, `bun check:i18n`, `bun check:react-doctor`, `bun crap:gate`, `bun coverage:gate`, `bun knip` |

## 7. The release shape

Three portable installers per release; all three wrap the same Electron app, only the bundled `stt-server.exe` differs:

- **`WinSTT-Portable-<v>.exe`** — DirectML, ~200 MB, **unmarked default GPU**.
- **`WinSTT-CPU-Portable-<v>.exe`** — CPU-only, ~150 MB.
- **`WinSTT-OpenVINO-Portable-<v>.exe`** — Intel ARC / Iris Xe / Arc iGPU, ~250 MB.

The release workflow (`.github/workflows/electron-release.yml`) fans the three jobs out in parallel and publishes them to the same GitHub Release. Every artifact gets a parallel `.minisig` sidecar (offline-verifiable trust layer alongside Authenticode).

## 8. Process expectations

- **Feature requests go in [Discussions](https://github.com/dahshury/WinSTT/discussions), not Issues.** Issues are reserved for bugs and well-scoped tasks. New features land best when sketched in Discussions first, then PR'd with the discussion link in the body.
- **One feature/fix per PR.** Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md) — every PR has a Human-Written Summary and a Community Feedback section.
- **AI-assisted PRs are welcome** but must disclose AI usage in the PR description (tools, scope). See the AI Assistance Disclosure section in `CONTRIBUTING.md`.
- **No commits without explicit ask.** If you're an AI assistant: do not run `git commit` unless the human asked for it. Show the diff, let the human decide.

## 9. When in doubt

- Check `memory/` for prior incidents and decisions.
- Read the existing tests — they're the cheapest spec we have.
- Open a Discussion before a non-trivial change. The maintainer set is small; alignment saves rework.
