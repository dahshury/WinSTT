# Model Settings Inventory - WinSTT

The Model Settings panel governs STT model selection, quantization, realtime transcription, device allocation, and translate-to-English behavior. This inventory covers every user-facing control and its underlying mechanics.

## Source (Local vs Cloud)

**What it does:** Toggles between locally-cached ONNX models (40 models across 7 families in the on-device catalog) and cloud providers (OpenAI Whisper, ElevenLabs).

**Options:**
- `local` - Runs models bundled locally or downloaded on-demand via HuggingFace (default)
- `cloud` - Transcribes via OpenAI Whisper API or ElevenLabs; requires active API key in Integrations tab

**Default:** `local`

**Conditional visibility:** Cloud option is disabled (padlocked) when no provider API keys are configured.

**Setting key:** Persisted on the active model ID (no dedicated on/off toggle).

**Gotchas:**
- When a user removes a cloud API key, any persisted cloud selection is silently reverted to the last local model
- The source picker is re-mounted whenever the persisted model's source changes OR API-key availability flips

---

## Model Selector

**What it does:** Displays a searchable, filterable list of STT models grouped by family (Whisper, NeMo, Cohere, Moonshine, GigaAM, Kaldi/Vosk, Canary). For local models, each model row shows quantization options as badges.

**Options:** ~40 STT models across 7 families in `server/src/recorder/domain/catalog.json`

**Default:** `"tiny"` (Whisper Tiny q4, vendored in the offline base)

**Setting key:** `model.model`

**Download lifecycle actions (local only):**
- **Start:** Begins downloading the selected quantization
- **Pause:** Stops the download; resume picks up where it left off
- **Resume:** Resumes a paused download
- **Cancel:** Aborts the download and deletes partial files
- **Delete:** Removes a fully-cached quantization from disk (confirmed via alert dialog)

---

## Available Quantizations and What Each Means

**ONNX quantization types:**

| Type | Display | What It Is | Size | Speed |
|---|---|---|---|---|
| `""` (empty) | Auto | Default fp32 weights - always present | Full (e.g., 149 MB) | Baseline |
| `"fp16"` | fp16 | Half-precision floats (16-bit) | ~500f fp32 | Fastest on GPU |
| `"int8"` | int8 | 8-bit integers | ~250f fp32 | ~30 0.000000aster |
| `"uint8"` | uint8 | Unsigned 8-bit integers | ~250f fp32 | ~30 0.000000aster |
| `"q4"` | q4 | 4-bit quantization | ~130f fp32 | ~50 0.000000aster |
| `"q4f16"` | q4f16 | Mixed 4-bit + 16-bit | ~200f fp32 | ~40 0.000000aster |
| `"bnb4"` | bnb4 | BitsAndBytes 4-bit (nf4) | ~130f fp32 | ~50 0.000000aster |

**Catalog policy:**
- Each model's `available_quantizations` array lists variants the upstream HuggingFace repo publishes
- The picker only shows badges for variants in this array
- The server silently falls back to `""` (fp32) if the user picks a variant that isn't available

**Setting key:** `model.onnxQuantization`

---

## Language

**What it does:** Restricts the STT model to a specific language or enables language auto-detection.

**Options:**
- `""` (empty) - Auto-detect: the model detects the language from audio
- `"en"` - English
- `"es"` - Spanish
- ... (~99 total language codes from ISO 639-1/2, plus auto-detect)

**Default:** `"en"`

**Conditional visibility:** Hidden entirely when the selected model advertises exactly one language.

**Setting key:** `model.language`

---

## Device (Auto / CPU)

**What it does:** Selects whether to run the model on GPU (if available) or force CPU-only execution.

**Options:**
- `"auto"` - Use GPU when available; fall back to CPU if no GPU
- `"cpu"` - Force CPU-only (GPU is ignored)

**Default:** `"auto"` (if GPU present); if no GPU detected, only `"cpu"` is shown.

**Setting key:** `model.device`

---

## Model Unload Timeout

**What it does:** Configures how long the server waits idle before unloading the ONNX session.

**Options:**
- `"immediately"` - Unload right after each transcription
- `"never"` - Keep the model resident forever
- `"min2"` - Wait 2 minutes
- `"min5"` - Wait 5 minutes (default)
- `"min10"` - Wait 10 minutes
- `"min15"` - Wait 15 minutes
- `"hour1"` - Wait 1 hour

**Default:** `"min5"`

**Setting key:** `model.modelUnloadTimeout`

---

## Translate to English

**What it does:** Enables Whisper's native `task=translate` path for non-English to English translation in a single pass.

**Type:** Toggle (checkbox)

**Default:** `false` (disabled)

**Conditional visibility:** Hidden unless the selected model supports the translate task (multilingual Whisper or NeMo Canary) AND advertises language detection capability.

**Setting key:** `model.translateToEnglish`

---

## Realtime Model

**What it does:** Configures a separate, smaller STT model for live-preview transcription.

**Options:** Any model in the catalog that satisfies `isRealtimeViable(model)` (parameter count <= 700M).

**Default:** `"tiny"` (Whisper Tiny)

**Setting key:** `model.realtimeModel`

**Realtime-locked-to-main behavior:**
- If the selected main model is small enough to be realtime-viable, the realtime slot is force-bound to the main model
- The picker becomes read-only (disabled)
- The "Use Main Model" button is hidden

---

## Update Interval

**What it does:** Sets the minimum time (in seconds) between realtime transcription updates.

**Type:** Number stepper

**Range:** `0.01` to infinity (typical: 0.01-1.0)

**Default:** `0.02` (20 milliseconds)

**Setting key:** `quality.realtimeProcessingPause`

---

## Summary

Eight core controls documented: Source, Model Selector, Quantizations, Language, Device, Model Unload Timeout, Translate to English, Realtime Model, Update Interval.
