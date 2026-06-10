# Contributing to WinSTT

Thanks for your interest in contributing! WinSTT is a Windows speech-to-text desktop app that pairs a Python STT server with an Electron + Vite multi-page React frontend. The goal of this document is to make it easy for you to find your way around the codebase and get a PR landed.

> **New here?** Start with [`AGENTS.md`](AGENTS.md) at the repo root — it's the canonical map of "what the rules are" for both humans and AI coding assistants. This document is the human-process companion (workflow, PR etiquette, governance).

## Philosophy

WinSTT is built around four ideas. New code should reinforce them:

- **Local-first.** All transcription runs on the user's machine. Audio never leaves the device.
- **Hexagonal & FSD.** The Python server uses ports/adapters; the frontend uses Feature-Sliced Design. Both architectures exist so changes stay isolated to one layer.
- **One model engine.** Every supported STT model runs on the same ONNX engine via `onnx-asr`. New model families should plug into the existing pipeline, not introduce a new runtime.
- **OpenAPI spec is the contract.** Shared types (WebSocket events, control commands, settings, IPC payloads) all originate from `spec/openapi.yaml`.

## Getting Started

### Prerequisites

- [Git](https://git-scm.com/)
- [uv](https://docs.astral.sh/uv/) — Python toolchain manager
- [Bun](https://bun.sh/) — JS runtime and package manager
- Optional: NVIDIA GPU + recent driver (only used by the legacy `gpu` extra; the default DirectML build needs only a D3D12-capable GPU)
- Optional: Visual Studio Build Tools — only needed if you rebuild the `uiohook-napi` / native helpers in `frontend/electron/native/`

For detailed platform setup see [BUILD.md](BUILD.md).

### One-shot setup

From the repo root:

```bat
setup-dev.bat
```

This installs uv (if missing), Python 3.11, server deps, and frontend deps. Pass `--flavor cpu`, `--flavor directml`, or `--flavor openvino` to pin the ONNX runtime extra.

### Running locally

Open two terminals.

```bash
# Terminal 1 — STT server
cd server
uv run stt-server

# Terminal 2 — Electron frontend
cd frontend
bun electron:dev
```

The server opens two WebSockets — control (JSON) on `8011`, audio (binary) on `8012`. The Electron main process is the only WebSocket client; the renderer talks to the main process via IPC.

## Project Layout

```
WinSTT/
├── server/          Python STT + TTS engine (hexagonal architecture)
├── frontend/        Electron + Vite multi-page React 19 desktop app (FSD architecture)
├── docs/            Fumadocs documentation site
├── spec/            OpenAPI spec — single source of truth for shared types
├── packaging/       electron-builder configs + PyInstaller output
├── tools/           One-off build helpers (e.g. apple-intelligence-cli)
└── examples/        Reference monolith and skill guides
```

Each sub-project has its own deeper `CLAUDE.md` rulebook:
- `server/CLAUDE.md` — hexagonal architecture, layer hierarchy, port/adapter pattern, threading model
- `frontend/CLAUDE.md` — FSD layers/segments/slices, import contract, multi-window Vite setup

## Reporting Bugs

Before opening an issue:

1. Search [open](https://github.com/winstt/WinSTT/issues) and [closed](https://github.com/winstt/WinSTT/issues?q=is%3Aissue+is%3Aclosed) issues.
2. Update to the latest release in case it's already fixed.
3. Reproduce with `--debug` to surface verbose logs (see [Debug Mode](docs/content/docs/debug-mode.mdx)).
4. Generate a diagnostic bundle: **Settings → Advanced → Save Diagnostic Bundle…** This writes a single zip containing `debug.log`, `stt-server.log`, GPU info, and the redacted settings file — please attach it to the issue.

A good bug report has:

- WinSTT version (Settings → About).
- OS + build (e.g. `Windows 11 Pro 24H2 26100.x`).
- CPU, GPU (model + driver version).
- Installer flavor — CPU or DirectML (default GPU).
- Active STT model + quantization (e.g. `whisper-tiny.en` / `q4`).
- Recording mode — PTT / Toggle / Listen / Wake Word.
- Steps to reproduce, expected vs actual behavior.
- The diagnostic bundle.

## Suggesting Features

Feature requests go in [Discussions](https://github.com/winstt/WinSTT/discussions), not Issues. Issues are reserved for bugs and well-scoped tasks. When proposing a feature, describe:

- the problem you're trying to solve,
- the proposed user-facing behavior,
- alternatives you considered,
- whether it fits the "local-first / one engine" philosophy.

Features with a working sketch (even rough) are much more likely to land — open a draft PR alongside the discussion.

## Making Code Contributions

### Before You Start

1. Search open and closed PRs — your idea may already be in flight or rejected.
2. For non-trivial changes (new STT family, new recording mode, schema additions, IPC channels), open a Discussion first so we can agree on the shape.
3. Keep PRs focused. One feature/fix per PR.

### Workflow

```bash
# 1. Fork on GitHub, then:
git clone git@github.com:YOUR_USERNAME/WinSTT.git
cd WinSTT
git remote add upstream git@github.com:winstt/WinSTT.git

# 2. Branch off main
git checkout -b feat/your-feature
# or
git checkout -b fix/your-bug-fix

# 3. Make focused commits

# 4. Keep your branch fresh
git fetch upstream
git rebase upstream/main

# 5. Push and open a PR
git push -u origin feat/your-feature
```

### Commit Messages

Conventional Commits, single-line subject focused on **why**:

- `feat:` — new user-facing capability
- `fix:` — bug fix
- `refactor:` — code change with no behavior change
- `docs:` — docs / comments / README
- `test:` — test-only changes
- `chore:` — tooling, deps, CI
- `perf:` — performance work

If a commit changes the WebSocket contract or settings schema, mention it in the body so reviewers can re-run `bun generate`.

### Code Style

**Python (server/):**

- `from __future__ import annotations` in every file.
- `@override` on every concrete ABC method.
- `TYPE_CHECKING` guards for annotation-only imports.
- Run `make` before pushing — it fans out to `ruff format`, `ruff check`, `mypy --strict`, `pytest`.
- mypy must be zero errors. Coverage gate is 100% on the files you touch (the suite as a whole has a known pre-existing `model_registry.py` residual; see `memory/project_server_coverage_preexisting_gap.md`).

**TypeScript (frontend/):**

- FSD import contract: layers only import from layers **below** them (`app → views → widgets → features → entities → shared`). No sideways imports.
- Public API per slice: every slice has one `index.ts` with **named** exports only — no `export *`.
- Path aliases: `@/*` → `src/`, `@spec/*` → `spec/`, `@electron/*` → `electron/`.
- Biome: tabs, double quotes, 100-char width. Run `bun lint:fix && bun format` before pushing.
- `bun typecheck` must be clean.
- **No `useMemo` / `useCallback`** — the frontend uses `babel-plugin-react-compiler`. Compute inline; the compiler memoizes.

**OpenAPI:**

- Edit `spec/openapi.yaml` first.
- Run `bun --cwd frontend run generate` to regenerate `spec/generated/ts/schema.d.ts`.
- The Python server reads the same schemas via its domain events/config — keep names aligned.

### Testing

| Area | Command | Notes |
|---|---|---|
| Server unit + integration | `cd server && uv run pytest` | Domain layer has zero I/O; integration tests use Fake adapters + fixed clocks |
| Server type check | `cd server && uv run mypy src/ --strict` | Must be zero errors |
| Server lint/format | `cd server && uv run ruff check . --fix && uv run ruff format .` | |
| Frontend tests | `cd frontend && bun test` | Bun test runner |
| Frontend type check | `cd frontend && bun typecheck` | |
| Frontend lint/format | `cd frontend && bun lint:fix && bun format` | Biome |
| Frontend dead code | `cd frontend && bun knip` | |

For UI work, also exercise the change in `bun electron:dev` and attach a screen recording to the PR.

### AI Assistance Disclosure

AI-assisted PRs are welcome. In the PR description please note:

- whether AI was used,
- which tools (e.g. Claude Code, Copilot, Cursor),
- roughly how much (boilerplate, debugging help, most of the code, etc.).

That's it — no judgement, just transparency for reviewers.

## Documentation

Docs improvements are first-class contributions. Two places to edit:

- `README.md` and the per-subproject `CLAUDE.md` files for repo-level guidance.
- `docs/content/docs/*.mdx` for the user-facing Fumadocs site (run `cd docs && bun dev`).

When adding a new docs page, register it in `docs/content/docs/meta.json` so it appears in the navigation.

## Translations

The UI ships with six localized strings files under `frontend/messages/` (`en`, `es`, `fr`, `ar`, `hi`, `zh`). When you add a user-facing string:

1. Add the key to `en.json` (source of truth).
2. Add the same key to every other language. Use machine translation as a starting point but flag it in the PR so a native speaker can review.

Never hardcode user-facing strings in JSX — the renderer uses `use-intl` and the ICU message format. The Electron main process uses the same JSON files for tray/menu items.

## Community

- **Issues** — [github.com/winstt/WinSTT/issues](https://github.com/winstt/WinSTT/issues) (bugs only)
- **Discussions** — [github.com/winstt/WinSTT/discussions](https://github.com/winstt/WinSTT/discussions) (features, questions, ideas)

Be kind, be patient, be specific. The maintainer set is small — clear repros and minimal repros land faster than long bug essays.

## License

By contributing you agree your contributions are licensed under the MIT License (see [LICENSE](LICENSE)). Third-party model licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
