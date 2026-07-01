# Third-Party Notices

WinSTT is a Rust + Tauri v2 desktop application. It bundles, links to, or
downloads on demand a number of third-party open-source components and
machine-learning models. Each component is the property of its respective
copyright holder and is licensed to you under its own terms. The terms in this
document take precedence over the WinSTT End User License Agreement with respect
to the listed component.

The information below is provided for compliance and attribution. Where a
license requires its full text to be reproduced (Apache-2.0, MPL-2.0, GPL-3.0,
CC-BY-4.0, etc.), the canonical text is available at the URL given for each
component. For Rust crates the authoritative license is the `license` field of
each crate's manifest (resolved via `cargo metadata`); for JavaScript packages
it is the `license` field of each package's `package.json` under
`node_modules/`.

## Contents

- [Rust crates (direct dependencies)](#rust-crates-direct-dependencies)
- [JavaScript packages (direct dependencies)](#javascript-packages-direct-dependencies)
- [Bundled and on-demand native binaries & data](#bundled-and-on-demand-native-binaries--data)
- [Speech-to-text models](#speech-to-text-models)
- [Text-to-speech models](#text-to-speech-models)
- [Speaker diarization models](#speaker-diarization-models)
- [Wake-word engines](#wake-word-engines)
- [Voice-activity detection](#voice-activity-detection)
- [Icons, fonts, and other assets](#icons-fonts-and-other-assets)
- [Cloud and third-party services](#cloud-and-third-party-services)
- [Required license texts](#required-license-texts)

---

## Rust crates (direct dependencies)

These are the direct dependencies declared in `src-tauri/Cargo.toml`, statically
linked into the `winstt` binary (target-conditional crates are linked only on
the platform noted). Dual-license entries (`A OR B`) may be used under either
license at the recipient's choice. Full license texts are hosted by each
crate's upstream repository, linked below.

| Crate                                     | License                       | Repository / notes                                                                                                         |
| ----------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| once_cell                                 | MIT OR Apache-2.0             | <https://github.com/matklad/once_cell>                                                                                     |
| tauri                                     | Apache-2.0 OR MIT             | <https://github.com/tauri-apps/tauri>                                                                                      |
| tauri-build (build)                       | Apache-2.0 OR MIT             | <https://github.com/tauri-apps/tauri>                                                                                      |
| tauri-plugin-log                          | Apache-2.0 OR MIT             | <https://github.com/tauri-apps/plugins-workspace>                                                                          |
| tauri-plugin-opener                       | Apache-2.0 OR MIT             | <https://github.com/tauri-apps/plugins-workspace>                                                                          |
| tauri-plugin-store                        | Apache-2.0 OR MIT             | <https://github.com/tauri-apps/plugins-workspace>                                                                          |
| tauri-plugin-os                           | Apache-2.0 OR MIT             | <https://github.com/tauri-apps/plugins-workspace>                                                                          |
| tauri-plugin-clipboard-manager            | Apache-2.0 OR MIT             | <https://github.com/tauri-apps/plugins-workspace>                                                                          |
| tauri-plugin-macos-permissions            | MIT                           | <https://github.com/ayangweb/tauri-plugin-macos-permissions>                                                               |
| tauri-plugin-dialog                       | Apache-2.0 OR MIT             | <https://github.com/tauri-apps/plugins-workspace>                                                                          |
| tauri-plugin-autostart (non-mobile)       | Apache-2.0 OR MIT             | <https://github.com/tauri-apps/plugins-workspace>                                                                          |
| tauri-plugin-global-shortcut (non-mobile) | Apache-2.0 OR MIT             | <https://github.com/tauri-apps/plugins-workspace>                                                                          |
| tauri-plugin-single-instance (non-mobile) | Apache-2.0 OR MIT             | <https://github.com/tauri-apps/plugins-workspace>                                                                          |
| tauri-plugin-updater (non-mobile)         | Apache-2.0 OR MIT             | <https://github.com/tauri-apps/plugins-workspace>                                                                          |
| specta                                    | MIT                           | <https://github.com/oscartbeaumont/specta>                                                                                 |
| specta-typescript                         | MIT                           | <https://github.com/oscartbeaumont/specta>                                                                                 |
| tauri-specta                              | MIT                           | <https://github.com/oscartbeaumont/tauri-specta>                                                                           |
| serde                                     | MIT OR Apache-2.0             | <https://github.com/serde-rs/serde>                                                                                        |
| serde_json                                | MIT OR Apache-2.0             | <https://github.com/serde-rs/json>                                                                                         |
| semver                                    | MIT OR Apache-2.0             | <https://github.com/dtolnay/semver>                                                                                        |
| anyhow                                    | MIT OR Apache-2.0             | <https://github.com/dtolnay/anyhow>                                                                                        |
| thiserror                                 | MIT OR Apache-2.0             | <https://github.com/dtolnay/thiserror>                                                                                     |
| log                                       | MIT OR Apache-2.0             | <https://github.com/rust-lang/log>                                                                                         |
| env_filter                                | MIT OR Apache-2.0             | <https://github.com/rust-cli/env_logger>                                                                                   |
| chrono                                    | MIT OR Apache-2.0             | <https://github.com/chronotope/chrono>                                                                                     |
| regex                                     | MIT OR Apache-2.0             | <https://github.com/rust-lang/regex>                                                                                       |
| unicode-normalization                     | MIT OR Apache-2.0             | <https://github.com/unicode-rs/unicode-normalization>                                                                      |
| clap                                      | MIT OR Apache-2.0             | <https://github.com/clap-rs/clap>                                                                                          |
| tokio                                     | MIT                           | <https://github.com/tokio-rs/tokio>                                                                                        |
| tokio-util                                | MIT                           | <https://github.com/tokio-rs/tokio>                                                                                        |
| futures-util                              | MIT OR Apache-2.0             | <https://github.com/rust-lang/futures-rs>                                                                                  |
| reqwest                                   | MIT OR Apache-2.0             | <https://github.com/seanmonstar/reqwest>                                                                                   |
| genai                                     | MIT OR Apache-2.0             | Cloud LLM transport. <https://github.com/jeremychone/rust-genai>                                                           |
| hf-hub                                    | Apache-2.0                    | Hugging Face snapshot resolver. <https://github.com/huggingface/hf-hub>                                                    |
| tokenizers                                | Apache-2.0                    | <https://github.com/huggingface/tokenizers>                                                                                |
| sentencepiece-rs                          | Apache-2.0                    | <https://github.com/Rayato159/sentencepiece-rs>                                                                            |
| ort                                       | MIT OR Apache-2.0             | ONNX Runtime bindings; `directml` feature on Windows. <https://github.com/pykeio/ort>                                      |
| ndarray                                   | MIT OR Apache-2.0             | <https://github.com/rust-ndarray/ndarray>                                                                                  |
| half                                      | MIT OR Apache-2.0             | <https://github.com/VoidStarKat/half-rs>                                                                                   |
| rustfft                                   | MIT OR Apache-2.0             | <https://github.com/ejmahler/RustFFT>                                                                                      |
| rayon                                     | MIT OR Apache-2.0             | <https://github.com/rayon-rs/rayon>                                                                                        |
| num_cpus                                  | MIT OR Apache-2.0             | <https://github.com/seanmonstar/num_cpus>                                                                                  |
| sherpa-onnx                               | Apache-2.0                    | KWS wake word + speaker-embedding diarization (linked as a shared DLL on Windows). <https://github.com/k2-fsa/sherpa-onnx> |
| vad-rs (git)                              | MIT                           | Silero VAD wrapper, git rev `2a412ed`. <https://github.com/cjpais/vad-rs>                                                  |
| ferrous-opencc                            | Apache-2.0                    | Chinese text conversion for TTS. <https://github.com/apoint123/ferrous-opencc>                                             |
| libloading                                | ISC                           | `dlopen` of the espeak-ng shared lib. <https://github.com/nagisa/rust_libloading>                                          |
| enigo                                     | MIT                           | Synthetic keyboard input for paste. <https://github.com/enigo-rs/enigo>                                                    |
| cpal                                      | Apache-2.0                    | Audio device I/O. <https://github.com/RustAudio/cpal>                                                                      |
| rodio                                     | MIT OR Apache-2.0             | Audio feedback playback. <https://github.com/RustAudio/rodio>                                                              |
| rubato                                    | MIT                           | Sample-rate conversion. <https://github.com/HEnquist/rubato>                                                               |
| hound                                     | Apache-2.0                    | WAV I/O. <https://github.com/ruuda/hound>                                                                                  |
| symphonia                                 | MPL-2.0                       | File-transcribe audio decode. <https://github.com/pdeljanov/Symphonia>                                                     |
| sysinfo                                   | MIT                           | RAM detection for model-fit heuristics. <https://github.com/GuillaumeGomez/sysinfo>                                        |
| rusqlite                                  | MIT                           | History DB (`bundled` SQLite). <https://github.com/rusqlite/rusqlite>                                                      |
| rusqlite_migration                        | Apache-2.0                    | <https://github.com/cljoly/rusqlite_migration>                                                                             |
| globset                                   | Unlicense OR MIT              | STT resolver glob matching. <https://github.com/BurntSushi/ripgrep>                                                        |
| prost                                     | Apache-2.0                    | ONNX-proto edit for the fp16 decoder patch. <https://github.com/tokio-rs/prost>                                            |
| strsim                                    | MIT                           | <https://github.com/rapidfuzz/strsim-rs>                                                                                   |
| natural                                   | MIT                           | <https://github.com/cjqed/rs-natural>                                                                                      |
| tar                                       | MIT OR Apache-2.0             | <https://github.com/alexcrichton/tar-rs>                                                                                   |
| flate2                                    | MIT OR Apache-2.0             | <https://github.com/rust-lang/flate2-rs>                                                                                   |
| bzip2                                     | MIT OR Apache-2.0             | <https://github.com/alexcrichton/bzip2-rs>                                                                                 |
| zip                                       | MIT                           | <https://github.com/zip-rs/zip2>                                                                                           |
| sha2                                      | MIT OR Apache-2.0             | <https://github.com/RustCrypto/hashes>                                                                                     |
| base64                                    | MIT OR Apache-2.0             | <https://github.com/marshallpierce/rust-base64>                                                                            |
| base85                                    | MPL-2.0-no-copyleft-exception | Whisper alignment-heads table (RFC 1924). <https://github.com/darkwyrm/base85>                                             |
| signal-hook (unix)                        | MIT OR Apache-2.0             | <https://github.com/vorner/signal-hook>                                                                                    |
| wasapi (windows)                          | MIT                           | WASAPI loopback capture. <https://github.com/HEnquist/wasapi-rs>                                                           |
| windows (windows)                         | MIT OR Apache-2.0             | <https://github.com/microsoft/windows-rs>                                                                                  |
| windows-core (windows)                    | MIT OR Apache-2.0             | <https://github.com/microsoft/windows-rs>                                                                                  |
| winreg (windows)                          | MIT                           | <https://github.com/gentoo90/winreg-rs>                                                                                    |
| tauri-nspanel (macOS, git)                | Apache-2.0 OR MIT             | git branch `v2.1`; ships `LICENSE_APACHE-2.0` + `LICENSE_MIT`. <https://github.com/ahkohd/tauri-nspanel>                   |
| objc2-core-audio (macOS)                  | Zlib OR Apache-2.0 OR MIT     | <https://github.com/madsmtm/objc2>                                                                                         |
| gtk-layer-shell (linux)                   | MIT                           | <https://github.com/pentamassiv/gtk-layer-shell-gir>                                                                       |
| gtk (linux)                               | MIT                           | <https://github.com/gtk-rs/gtk3-rs>                                                                                        |
| tempfile (dev)                            | MIT OR Apache-2.0             | Test-only. <https://github.com/Stebalien/tempfile>                                                                         |

> The build dependencies `serde`, `serde_json`, and `tauri-build` carry the same
> licenses as their runtime entries above. The full transitive dependency set
> (~1,100 crates) is resolvable from `Cargo.lock`; their license texts are the
> union of every crate's manifest license and bundled `LICENSE*` files.

---

## JavaScript packages (direct dependencies)

These are the direct dependencies declared in the root `package.json`. The
renderer is bundled by Vite at build time, so runtime packages are compiled into
the shipped asset bundle. `@base-ui/react`, `@hugeicons/react`,
`@hugeicons/core-free-icons`, and `virtua` are also used by the
in-tree model-picker widget (`src/widgets/model-picker`). Dev-only packages are used during
build/test and are not redistributed; they are listed for completeness.

### Runtime dependencies

| Package                              | License           | Notes                                   |
| ------------------------------------ | ----------------- | --------------------------------------- |
| react                                | MIT               | (c) Meta Platforms                      |
| react-dom                            | MIT               | (c) Meta Platforms                      |
| @base-ui/react                       | MIT               | (c) MUI                                 |
| @hugeicons/react                     | MIT               | See Icons section for attribution terms |
| @hugeicons/core-free-icons           | MIT               | See Icons section for attribution terms |
| @tanstack/react-table                | MIT               |                                         |
| @tailwindcss/vite                    | MIT               |                                         |
| tailwindcss                          | MIT               |                                         |
| tailwind-merge                       | MIT               |                                         |
| clsx                                 | MIT               |                                         |
| class-variance-authority             | Apache-2.0        |                                         |
| motion                               | MIT               | (framer-motion successor)               |
| virtua                               | MIT               |                                         |
| zustand                              | MIT               |                                         |
| zod                                  | MIT               |                                         |
| use-intl                             | MIT               | i18n runtime (next-intl core)           |
| double-metaphone                     | MIT               |                                         |
| @tauri-apps/api                      | Apache-2.0 OR MIT |                                         |
| @tauri-apps/plugin-autostart         | MIT OR Apache-2.0 |                                         |
| @tauri-apps/plugin-clipboard-manager | MIT OR Apache-2.0 |                                         |
| @tauri-apps/plugin-dialog            | MIT OR Apache-2.0 |                                         |
| @tauri-apps/plugin-opener            | MIT OR Apache-2.0 |                                         |
| @tauri-apps/plugin-os                | MIT OR Apache-2.0 |                                         |

### Development / build dependencies (not redistributed)

| Package                                                 | License               |
| ------------------------------------------------------- | --------------------- |
| vite                                                    | MIT                   |
| @vitejs/plugin-react                                    | MIT                   |
| @rolldown/plugin-babel                                  | MIT                   |
| babel-plugin-react-compiler                             | MIT                   |
| typescript                                              | Apache-2.0            |
| eslint                                                  | MIT                   |
| @typescript-eslint/eslint-plugin                        | MIT                   |
| @typescript-eslint/parser                               | MIT                   |
| eslint-plugin-i18next                                   | ISC                   |
| prettier                                                | MIT                   |
| knip                                                    | ISC                   |
| fast-check                                              | MIT                   |
| @testing-library/react                                  | MIT                   |
| @happy-dom/global-registrator                           | MIT                   |
| rollup-plugin-visualizer                                | MIT                   |
| @tauri-apps/cli                                         | Apache-2.0 OR MIT     |
| @types/bun, @types/node, @types/react, @types/react-dom | MIT (DefinitelyTyped) |

---

## Bundled and on-demand native binaries & data

WinSTT links several native components and fetches a few large runtime packs on
demand rather than shipping them in the installer.

### ONNX Runtime + DirectML (bundled)

- The `ort` crate links the Microsoft ONNX Runtime native library, which the
  build resolves and places alongside the executable. The Windows build also
  uses the DirectML execution provider (`directml.dll`).
- ONNX Runtime — MIT, (c) Microsoft.
  <https://github.com/microsoft/onnxruntime>
- DirectML — distributed by Microsoft; redistributable under the
  DirectML/Windows SDK redistribution terms. **(verify per Microsoft's current
  redistribution terms before commercial distribution.)**
  <https://github.com/microsoft/DirectML>

### sherpa-onnx (bundled shared DLL)

- The `sherpa-onnx` crate is linked in `shared` mode on Windows, so
  `sherpa-onnx-c-api.dll` is shipped alongside the executable. Apache-2.0,
  (c) the k2-fsa / sherpa-onnx authors.
  <https://github.com/k2-fsa/sherpa-onnx>

### Silero VAD model (bundled)

- `src-tauri/resources/models/silero_vad_v4.onnx` is bundled in the installer.
  Silero VAD — MIT, (c) Silero Team.
  <https://github.com/snakers4/silero-vad>

### eSpeak NG runtime (downloaded on demand — GPL-3.0)

- The TTS phonemizer (G2P) uses eSpeak NG. WinSTT does **not** bundle eSpeak NG
  in the installer. When a TTS model that requires phonemization is first used,
  WinSTT downloads the pinned `espeakng_loader` Python wheel
  (`espeakng_loader-0.2.4`, from PyPI / files.pythonhosted.org) into
  `%LOCALAPPDATA%\winstt\tts\runtime\espeakng_loader` and loads
  `espeak-ng.dll` + `espeak-ng-data` from it at runtime.
- eSpeak NG — **GPL-3.0-or-later**, (c) the eSpeak NG contributors.
  Corresponding source is available from the upstream repository.
  <https://github.com/espeak-ng/espeak-ng/blob/master/COPYING>
- `espeakng_loader` (the wheel that ships the eSpeak NG binary + data) — MIT.
  <https://github.com/thewh1teagle/espeakng-loader>
- Because eSpeak NG is GPL-3.0, it is obtained as a separate, user-triggered
  download under its own GPL-3.0 terms; the core WinSTT binary does not include
  or statically link it.

### macOS Apple Intelligence bridge

- On Apple-silicon macOS, the build optionally compiles a small Swift bridge
  (`src-tauri/swift/apple_intelligence.swift`) that weak-links Apple's
  `FoundationModels` framework. That framework is part of macOS and is governed
  by Apple's SDK / Software License Agreement. <https://developer.apple.com>

---

## Speech-to-text models

STT models are downloaded on demand into the user's Hugging Face cache
(`%USERPROFILE%\.cache\huggingface` on Windows). The catalogue is defined in
`src-tauri/src/winstt/catalog.rs` (71 entries across 10 families: Whisper,
Moonshine, NeMo, Kaldi, GigaAM, Cohere, Granite, SenseVoice, T-One, Dolphin).

### OpenAI Whisper / Lite-Whisper (family: Whisper)

- Whisper variants (tiny/base/small/medium/large-v3/large-v3-turbo and `*.en`)
  plus Lite-Whisper turbo variants. ONNX exports authored by the Hugging Face
  `onnx-community` and `Xenova` organisations.
- Original Whisper weights (c) OpenAI, Inc. — MIT.
  <https://github.com/openai/whisper/blob/main/LICENSE>
- Lite-Whisper (Efficient-ML) — Apache-2.0.
  <https://huggingface.co/Efficient-ML/lite-whisper-large-v3-turbo>

### NVIDIA NeMo — Parakeet / Canary / FastConformer / Nemotron (family: NeMo)

- Includes `nemo-parakeet-{ctc,rnnt,tdt}`, `nemo-canary-1b-v2`,
  `nemo-canary-180m-flash`, `nemo-fastconformer-ru-{ctc,rnnt}`, and the
  streaming NeMo/Parakeet/Nemotron variants.
- Copyright (c) NVIDIA Corporation. — **CC-BY-4.0.**
  <https://creativecommons.org/licenses/by/4.0/>
- **Required attribution:** "This product uses NVIDIA NeMo
  Parakeet / Canary / FastConformer / Nemotron models, licensed under CC-BY-4.0."

### Moonshine (family: Moonshine)

- Useful Sensors Moonshine ONNX variants (10 entries). — MIT.
  <https://github.com/usefulsensors/moonshine>

### Sber/Salute GigaAM (family: GigaAM)

- `gigaam-v3-e2e-ctc`, `gigaam-v3-e2e-rnnt`. (c) Sber. — MIT.
  <https://github.com/salute-developers/GigaAM>

### Kaldi / Vosk (family: Kaldi)

- Kaldi-/Vosk-format Russian models (e.g. Alphacephei Vosk). (c) Alpha Cephei
  Inc. — Apache-2.0. <https://alphacephei.com/vosk/models>

### Cohere ASR (family: Cohere)

- Cohere Aya-class ASR ONNX export. — **CC-BY-NC-4.0 (verify per the model
  card before any commercial use).** <https://huggingface.co/CohereLabs>

### IBM Granite Speech (family: Granite)

- IBM Granite speech ASR (2 entries). — Apache-2.0.
  <https://huggingface.co/ibm-granite>

### SenseVoice (family: SenseVoice)

- FunAudioLLM SenseVoice. — Apache-2.0.
  <https://github.com/FunAudioLLM/SenseVoice>

### T-Bank T-One (family: T-One)

- `t-tech/t-one` Russian streaming ASR. — Apache-2.0.
  <https://huggingface.co/t-tech/T-one>

### Dolphin (family: Dolphin)

- DataoceanAI Dolphin multilingual ASR. — Apache-2.0.
  <https://huggingface.co/DataoceanAI>

---

## Text-to-speech models

TTS models are downloaded on demand from Hugging Face. The catalogue is in
`src-tauri/src/winstt/tts/catalog.rs`.

- **Kokoro-82M** — `onnx-community/Kokoro-82M-v1.0-ONNX` (ONNX re-export of
  hexgrad/Kokoro-82M). Apache-2.0, (c) hexgrad.
  <https://huggingface.co/hexgrad/Kokoro-82M>
- **Kitten TTS Nano** — `KittenML/kitten-tts-nano-0.2`. — Apache-2.0 (verify
  per the model card). <https://huggingface.co/KittenML>
- **Piper voices** — `rhasspy/piper-voices`. — MIT (voices vary; per-voice
  licenses are noted in the Piper repo). <https://github.com/rhasspy/piper>
- **Supertonic** — `Supertone/supertonic-3`. — see the model card for terms
  **(verify before commercial use).** <https://huggingface.co/Supertone>

The Piper recipe is derived from `OHF-Voice/piper1-gpl` (GPL-3.0); WinSTT's
Piper inference is a clean-room ONNX runner and does not link GPL Piper code.

---

## Speaker diarization models

Downloaded only if the user enables Speaker Diarization. They are gated on
Hugging Face — the user must accept upstream model terms before download.

- `pyannote/segmentation-3.0` — MIT, (c) CNRS / pyannote.
  <https://huggingface.co/pyannote/segmentation-3.0>
- WeSpeaker `voxceleb-resnet34-LM` speaker-embedding extractor (run via
  sherpa-onnx) — Apache-2.0, (c) the WeSpeaker authors.
  <https://github.com/wenet-e2e/wespeaker>

---

## Wake-word engines

### sherpa-onnx KWS (default)

- The default wake-word path downloads the sherpa-onnx KWS Zipformer model
  (`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`) from the
  k2-fsa/sherpa-onnx GitHub releases. Apache-2.0.
  <https://github.com/k2-fsa/sherpa-onnx>

### Picovoice Porcupine (legacy, on-demand)

- The legacy wake-word path downloads the `pvporcupine-1.9.5` Python wheel from
  PyPI to obtain the no-access-key Porcupine runtime and its bundled `.ppn`
  model files.
- Picovoice Porcupine source/runtime — Apache-2.0, (c) Picovoice Inc.
  <https://github.com/Picovoice/porcupine>
- **The bundled `.ppn` model files inside the wheel are licensed under
  Picovoice's personal-use / non-commercial terms.** Commercial distribution of
  those model files requires a paid Picovoice commercial license. If you intend
  to redistribute WinSTT commercially, either obtain a Picovoice commercial
  license or ship a build that uses only the sherpa-onnx KWS path.

---

## Voice-activity detection

- Silero VAD — MIT, (c) Silero Team. Bundled as `silero_vad_v4.onnx`; driven by
  the `vad-rs` crate (MIT). <https://github.com/snakers4/silero-vad>

---

## Icons, fonts, and other assets

### Hugeicons Free

WinSTT's UI uses the icon set distributed by Hugeicons via the
`@hugeicons/core-free-icons` and `@hugeicons/react` packages. The npm packages
are MIT-licensed, but use of the icon glyphs themselves is subject to the
**Hugeicons Free License**, which requires attribution to Hugeicons. The
following attribution is included in the application's "About" screen and here:

> **Icons by Hugeicons — <https://hugeicons.com>. Used under the
> Hugeicons Free License.**

For full license terms see <https://hugeicons.com/license>.

### Audio (recording-start / -stop SFX)

User-selectable recording sounds shipped in `src-tauri/resources/*.wav`
(marimba, pop) are either created by the WinSTT authors and released
under the WinSTT EULA, or sourced from Creative Commons Zero (CC0) sound
libraries with no attribution required. If a specific bundled file requires
attribution, that attribution is reproduced here on update.

---

## Cloud and third-party services

When the user explicitly enables a cloud integration in Settings, WinSTT acts as
a client of that provider's API using a key supplied by the user. The user
remains responsible for complying with the provider's terms of service. No
provider API key is bundled.

- **OpenRouter** — LLM gateway (post-processing), cloud STT
  (`/audio/transcriptions`), and cloud TTS (`/audio/speech`).
  <https://openrouter.ai/terms>
- **ElevenLabs** — cloud STT (`/v1/speech-to-text`).
  <https://elevenlabs.io/terms>
- **Cloud LLM providers via the `genai` crate** — OpenRouter, Anthropic-native,
  and other OpenAI-compatible endpoints the user configures. Each is governed by
  its own provider terms.
- **Ollama** — optional local LLM runtime. The Ollama software is MIT-licensed;
  WinSTT only speaks to a locally running Ollama instance.
  <https://github.com/ollama/ollama>

---

## Required license texts

Several of the licenses above (MIT, ISC, BSD, Apache-2.0, MPL-2.0, GPL-3.0,
CC-BY-4.0, Unlicense, Zlib) require their full text to be available to
recipients. The canonical text of each is hosted by the relevant upstream
project (links inline above). The `LICENSE` (MIT) and this
`THIRD_PARTY_NOTICES.md` are bundled with the application
(`src-tauri/tauri.conf.json` → `bundle.resources`). For Rust crates, the full
per-crate license text is contained in each crate's source under the Cargo
registry/cache; for JavaScript packages it is the `LICENSE` file inside each
package directory under `node_modules/`.

If you received WinSTT without a license file you require, open an issue at the
project repository and a copy will be provided at no cost.

---

_Last updated: 2026-06-10._
