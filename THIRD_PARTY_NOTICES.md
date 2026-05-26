# Third-Party Notices

WinSTT bundles, links to, or downloads on demand a number of third-party
open-source components and machine-learning models. Each component is the
property of its respective copyright holder and is licensed to you under
its own terms. The terms in this document take precedence over the WinSTT
End User License Agreement with respect to the listed component.

The information below is provided for compliance and attribution. If a
license requires the full text of the license to be reproduced (Apache-2.0,
MIT, BSD, MPL, etc.), the full text is available at the URL given for each
component and is also reproduced verbatim where required at the end of
this file.

## Contents

- [Summary table](#summary-table)
- [Speech-to-text models](#speech-to-text-models)
- [Text-to-speech models](#text-to-speech-models)
- [Speaker diarization models](#speaker-diarization-models)
- [Wake-word engines](#wake-word-engines)
- [Voice-activity detection](#voice-activity-detection)
- [Server-side Python dependencies](#server-side-python-dependencies)
- [Desktop runtime — Electron, native, and renderer dependencies](#desktop-runtime--electron-native-and-renderer-dependencies)
- [Icons, fonts, and other assets](#icons-fonts-and-other-assets)
- [Cloud and third-party services](#cloud-and-third-party-services)
- [Required license texts](#required-license-texts)

---

## Summary table

| Component                                | License             | Notes                              |
|------------------------------------------|---------------------|------------------------------------|
| OpenAI Whisper (model weights)           | MIT                 | Bundled via onnx-community / Xenova ports |
| Lite-Whisper                             | Apache-2.0          | Efficient-ML                       |
| NVIDIA NeMo Parakeet (CTC / RNNT / TDT)  | CC-BY-4.0           | Attribution required               |
| NVIDIA NeMo Canary 1B v2                 | CC-BY-4.0           | Attribution required               |
| NVIDIA NeMo FastConformer (Russian)      | CC-BY-4.0           | Attribution required               |
| Sber/Salute GigaAM v3                    | MIT                 |                                    |
| Vosk / Alphacephei Russian models        | Apache-2.0          |                                    |
| T-Bank T-One                             | Apache-2.0          |                                    |
| Kokoro-82M (TTS model)                   | Apache-2.0          |                                    |
| pyannote-segmentation-3.0                | MIT                 | Hugging Face gated; user must accept terms |
| WeSpeaker voxceleb-resnet34-LM           | Apache-2.0          |                                    |
| onnx-asr                                 | MIT                 | github.com/istupakov/onnx-asr      |
| kokoro-onnx                              | MIT                 | github.com/thewh1teagle/kokoro-onnx |
| espeak-ng (via espeakng-loader)          | GPL-3.0             | TTS-only; shipped only when TTS support pack is installed |
| Picovoice Porcupine (pvporcupine 1.x)    | Apache-2.0 source / proprietary model terms | Bundled wake-word PPN models are licensed for personal, non-commercial use; remove or relicense for commercial distribution |
| openWakeWord                             | Apache-2.0          |                                    |
| WebRTC VAD (webrtcvad-wheels)            | BSD-3-Clause        |                                    |
| Silero VAD                               | MIT                 |                                    |
| ONNX Runtime                             | MIT                 |                                    |
| ONNX Runtime GPU + NVIDIA CUDA pip wheels| NVIDIA EULA         | Redistribution permitted for use on NVIDIA hardware |
| PyTorch (optional, sentence-classifier)  | BSD-3-Clause        |                                    |
| Transformers (optional, sentence-classifier) | Apache-2.0      |                                    |
| Hugging Face Hub                         | Apache-2.0          |                                    |
| PyAudio                                  | MIT                 |                                    |
| PyAudioWPatch                            | MIT                 |                                    |
| scipy                                    | BSD-3-Clause        |                                    |
| numpy                                    | BSD-3-Clause        |                                    |
| soundfile (libsndfile)                   | BSD-3-Clause / LGPL-2.1+ | libsndfile is dynamically linked |
| websockets                               | BSD-3-Clause        |                                    |
| Pydantic                                 | MIT                 |                                    |
| Kink (DI)                                | MIT                 |                                    |
| psutil                                   | BSD-3-Clause        |                                    |
| nvidia-ml-py                             | BSD-3-Clause        |                                    |
| Sentry Python SDK                        | MIT                 |                                    |
| Sentry Electron SDK                      | MIT                 |                                    |
| onnx                                     | Apache-2.0          |                                    |
| PyInstaller                              | GPL-2.0 with bootloader exception | Output binaries are not derivative works; exception permits proprietary apps |
| Electron                                 | MIT                 |                                    |
| Node.js                                  | MIT                 |                                    |
| Chromium                                 | BSD-3-Clause + others | See Chromium project for full notices |
| Vite                                     | MIT                 |                                    |
| React 19                                 | MIT                 |                                    |
| Next.js (build tooling)                  | MIT                 |                                    |
| Base UI (@base-ui/react)                 | MIT                 |                                    |
| Tailwind CSS                             | MIT                 |                                    |
| Motion (framer-motion)                   | MIT                 |                                    |
| Zustand                                  | MIT                 |                                    |
| React Hook Form                          | MIT                 |                                    |
| Zod                                      | MIT                 |                                    |
| uiohook-napi                             | MIT                 |                                    |
| Hugeicons Core Free + React              | Hugeicons Free License (attribution required) | See Icons section |
| Vercel AI SDK (`ai`, `@ai-sdk/*`)        | Apache-2.0          |                                    |
| OpenRouter AI SDK provider               | Apache-2.0          |                                    |
| electron-builder, electron-updater       | MIT                 |                                    |
| electron-log                             | MIT                 |                                    |
| adm-zip                                  | MIT                 |                                    |
| fuse.js                                  | Apache-2.0          |                                    |
| double-metaphone                         | MIT                 |                                    |
| virtua                                   | MIT                 |                                    |
| next-intl                                | MIT                 |                                    |
| class-variance-authority                 | Apache-2.0          |                                    |
| clsx                                     | MIT                 |                                    |
| tailwind-merge                           | MIT                 |                                    |
| pngjs                                    | MIT                 |                                    |
| NSIS (installer framework)               | zlib/libpng + Common Public License | Installer-only          |

---

## Speech-to-text models

All STT models are stored or downloaded on demand into the user's Hugging
Face cache (`%USERPROFILE%\.cache\huggingface` on Windows). The full
catalogue is defined in `server/src/recorder/domain/catalog.json`.

### OpenAI Whisper

- Models: `whisper-tiny`, `whisper-base`, `whisper-small`, `whisper-medium`,
  `whisper-large-v3`, `whisper-large-v3-turbo`, and their English-only
  (`*.en`) variants.
- ONNX exports authored by the Hugging Face `onnx-community` and `Xenova`
  organisations.
- Original weights and tokenizer copyright (c) 2022-2024 OpenAI, Inc.
- License: MIT. <https://github.com/openai/whisper/blob/main/LICENSE>

### Lite-Whisper

- Models: `lite-whisper-large-v3-turbo`, `lite-whisper-large-v3-turbo-acc`,
  `lite-whisper-large-v3-turbo-fast`.
- ONNX exports by the Hugging Face `onnx-community` organisation; original
  weights by Efficient-ML.
- License: Apache-2.0.
  <https://huggingface.co/Efficient-ML/lite-whisper-large-v3-turbo>

### NVIDIA NeMo — Parakeet / Canary / FastConformer

- Models: `nemo-parakeet-ctc-0.6b`, `nemo-parakeet-rnnt-0.6b`,
  `nemo-parakeet-tdt-0.6b-v3`,
  `nemo-canary-1b-v2`, `nemo-canary-180m-flash`,
  `nemo-fastconformer-ru-ctc`, `nemo-fastconformer-ru-rnnt`.
- Copyright (c) NVIDIA Corporation. All rights reserved.
- License: **Creative Commons Attribution 4.0 International (CC-BY-4.0).**
  <https://creativecommons.org/licenses/by/4.0/>
- **Required attribution:** "This product uses NVIDIA NeMo
  Parakeet / Canary / FastConformer models, licensed under CC-BY-4.0."

### Sber/Salute GigaAM

- Models: `gigaam-v3-e2e-ctc`, `gigaam-v3-e2e-rnnt`.
- Copyright (c) Sber. License: MIT.
  <https://github.com/salute-developers/GigaAM>

### Vosk / Alphacephei

- Models: `alphacep/vosk-model-ru`, `alphacep/vosk-model-small-ru`.
- Copyright (c) Alpha Cephei Inc. License: Apache-2.0.
  <https://alphacephei.com/vosk/models>

### T-Bank — T-One

- Model: `t-tech/t-one`.
- Copyright (c) T-Bank / T-Tech. License: Apache-2.0.
  <https://huggingface.co/t-tech/t-one>

### onnx-asr loader

- Repository: <https://github.com/istupakov/onnx-asr>
- License: MIT. Copyright (c) 2024 Ilya Stupakov.

---

## Text-to-speech models

### Kokoro-82M (ONNX)

- Model: `hexgrad/Kokoro-82M`, distributed in ONNX form via
  `thewh1teagle/kokoro-onnx` GitHub releases
  (`kokoro-v1.0.fp16.onnx` + `voices-v1.0.bin`).
- License: Apache-2.0. Copyright (c) hexgrad.
  <https://huggingface.co/hexgrad/Kokoro-82M>

### kokoro-onnx (Python loader)

- Repository: <https://github.com/thewh1teagle/kokoro-onnx>
- License: MIT.

### espeak-ng (phonemizer back-end)

- Distributed inside `espeakng-loader`'s Python wheel and loaded at
  runtime by `kokoro-onnx` for non-English text and as a fallback.
- License: **GPL-3.0-or-later.** Copyright (c) the espeak-ng contributors.
  <https://github.com/espeak-ng/espeak-ng/blob/master/COPYING>
- Because espeak-ng is GPL, WinSTT ships it **only as part of the
  separately-installed Text-to-Speech support pack**, which the user
  must explicitly opt in to download. The support pack is provided
  under GPL-3.0 terms with corresponding source available via the
  upstream espeak-ng repository. The core WinSTT installer does not
  contain espeak-ng.

---

## Speaker diarization models

These models are downloaded only if the user enables Speaker Diarization
in the General settings. They are gated on Hugging Face: the user must
accept upstream model terms before the download succeeds.

- `pyannote/segmentation-3.0` — MIT. Copyright (c) CNRS / pyannote.
  <https://huggingface.co/pyannote/segmentation-3.0>
- `wespeaker-voxceleb-resnet34-LM` — Apache-2.0. Copyright (c) the
  WeSpeaker authors. <https://github.com/wenet-e2e/wespeaker>

---

## Wake-word engines

### Picovoice Porcupine (`pvporcupine`)

- Python wheel and source: Apache-2.0, copyright (c) 2018-2023 Picovoice
  Inc. <https://github.com/Picovoice/porcupine>
- **Bundled wake-word `.ppn` model files** shipped inside the
  `pvporcupine` wheel are licensed under Picovoice's personal-use /
  non-commercial terms. Commercial distribution of those model files
  requires a paid Picovoice commercial license. WinSTT pins
  `pvporcupine<2.0` solely to retain the no-access-key code path; this
  pin does **not** grant any additional rights to the bundled models.
- If you intend to redistribute WinSTT commercially, you must either
  (a) obtain a Picovoice commercial license, or (b) build a release in
  which the Porcupine adapter is disabled and only `openWakeWord` is
  used.

### openWakeWord

- Repository: <https://github.com/dscripka/openWakeWord>
- License: Apache-2.0. Copyright (c) David Scripka.

---

## Voice-activity detection

- `webrtcvad-wheels` — BSD-3-Clause. Copyright (c) 2011, The WebRTC
  project authors. <https://github.com/wiseman/py-webrtcvad>
- Silero VAD — MIT. Copyright (c) Silero Team.
  <https://github.com/snakers4/silero-vad>

---

## Server-side Python dependencies

Runtime (always installed):

- onnxruntime — MIT, (c) Microsoft.
  <https://github.com/microsoft/onnxruntime>
- onnx — Apache-2.0.
- numpy — BSD-3-Clause.
- scipy — BSD-3-Clause.
- soundfile — BSD-3-Clause. Wraps libsndfile (LGPL-2.1+), dynamically
  linked. <https://github.com/bastibe/python-soundfile>
- PyAudio — MIT.
- PyAudioWPatch — MIT.
- websockets — BSD-3-Clause.
- pydantic — MIT.
- kink — MIT.
- psutil — BSD-3-Clause.
- nvidia-ml-py — BSD-3-Clause.
- huggingface_hub — Apache-2.0.
- sentry-sdk (Python) — MIT.

GPU extras (installed in the `gpu` flavour):

- onnxruntime-gpu — MIT.
- nvidia-cublas-cu12, nvidia-cudnn-cu12, nvidia-cuda-runtime-cu12,
  nvidia-cuda-nvrtc-cu12, nvidia-cufft-cu12, nvidia-curand-cu12,
  nvidia-cusparse-cu12, nvidia-cusolver-cu12, nvidia-nvjitlink-cu12.
  These wheels are distributed by NVIDIA under the NVIDIA Software
  License Agreement; redistribution is permitted as part of an
  application that uses them on NVIDIA hardware.
  See the per-package license files inside each wheel and
  <https://docs.nvidia.com/cuda/eula/index.html>.

Optional extras:

- `sentence-classifier`: PyTorch (BSD-3-Clause) + Hugging Face
  Transformers (Apache-2.0).
- `tts`: kokoro-onnx (MIT) + espeakng-loader (wraps GPL-3.0 espeak-ng;
  see TTS section).

Build / packaging:

- PyInstaller — GPL-2.0 **with the PyInstaller bootloader exception**,
  which permits the resulting frozen executable to be distributed under
  any license, including a proprietary one. WinSTT does not modify the
  PyInstaller bootloader, so the exception applies.

---

## Desktop runtime — Electron, native, and renderer dependencies

The Electron desktop app bundles a customised Chromium runtime plus the
following key JavaScript dependencies. License texts for each package
are available inside the installed app under `node_modules/<pkg>/LICENSE`
and are reproduced collectively here by reference.

- Electron — MIT. <https://github.com/electron/electron>
- Node.js — MIT. <https://github.com/nodejs/node>
- Chromium — BSD-3-Clause and additional licenses; see the
  `LICENSES.chromium.html` shipped inside Electron's resources for the
  full notice set.
- React, React DOM — MIT, (c) Meta Platforms.
- Vite — MIT. <https://github.com/vitejs/vite>
- Base UI — MIT, (c) MUI.
- Tailwind CSS — MIT.
- Motion (framer-motion) — MIT.
- Zustand — MIT.
- React Hook Form — MIT.
- Zod — MIT.
- next-intl — MIT.
- virtua — MIT.
- fuse.js — Apache-2.0.
- double-metaphone — MIT.
- tailwind-merge, clsx — MIT.
- class-variance-authority — Apache-2.0.
- adm-zip — MIT.
- pngjs — MIT.
- electron-builder, electron-updater, electron-log — MIT.
- uiohook-napi — MIT.
- Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/elevenlabs`) —
  Apache-2.0. <https://github.com/vercel/ai>
- OpenRouter AI SDK provider (`@openrouter/ai-sdk-provider`) —
  Apache-2.0.
- Sentry Electron SDK (`@sentry/electron`) — MIT.

The full machine-readable license list for the installed JavaScript
dependencies is the union of every `LICENSE` file inside the bundled
`node_modules/` directory.

---

## Icons, fonts, and other assets

### Hugeicons Free

WinSTT's user interface uses the icon set distributed by Hugeicons via
the `@hugeicons/core-free-icons` and `@hugeicons/react` packages.

Use of the Hugeicons Free Set in WinSTT is subject to the
**Hugeicons Free License**, which requires attribution to Hugeicons in
the product. The following attribution is included in the application's
"About" screen and in this notices file in compliance with that
requirement:

> **Icons by Hugeicons — <https://hugeicons.com>. Used under the
> Hugeicons Free License.**

For full license terms see <https://hugeicons.com/license>.

### Audio (recording-start / -stop SFX)

User-selectable recording sounds shipped inside the installer in
`sounds/` are either:

- created by the WinSTT authors and released under the WinSTT EULA, or
- sourced from Creative Commons Zero (CC0) sound libraries with no
  attribution required.

If a specific bundled file requires attribution, that attribution is
listed inline in the file's metadata and reproduced here on update.

---

## Cloud and third-party services

When the user explicitly enables a cloud integration in Settings →
Integrations, WinSTT acts as a client of that provider's API using a
key supplied by the user. The user remains responsible for complying
with the provider's terms of service.

- OpenAI (Whisper / gpt-4o-transcribe cloud STT) — <https://openai.com/policies>
- ElevenLabs (cloud STT) — <https://elevenlabs.io/terms>
- OpenRouter (LLM gateway) — <https://openrouter.ai/terms>
- Ollama (local LLM runtime, optional) — MIT.
  <https://github.com/ollama/ollama>
- Sentry (optional crash reporting; the SDK is bundled, the hosted
  service is optional and only used when a DSN is configured) —
  <https://sentry.io/terms>

---

## Required license texts

Several of the licenses above (MIT, BSD-3-Clause, Apache-2.0, CC-BY-4.0,
GPL-3.0, NVIDIA EULA) require their full text to be available to
recipients. The full canonical text of each is hosted by the relevant
upstream project (links inline above). For convenience, copies are also
shipped inside the installed application under
`resources/licenses/<spdx-id>.txt`.

If you have received WinSTT without those license files, contact
dahshury@gmail.com and a copy will be provided at no cost.

---

_Last updated: 2026-05-24._
