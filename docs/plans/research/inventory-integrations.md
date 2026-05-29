# Cloud STT Integrations Inventory

WinSTT supports cloud speech-to-text transcription via **OpenAI** and **ElevenLabs**. Both integrations live in a unified settings panel under **Integrations** and share infrastructure for API key storage (encrypted at rest via Electron's `safeStorage`), credential verification (600ms-debounced probe), and lifecycle management. Audio never touches the Python server — cloud requests flow through electron-main via the Vercel AI SDK, while the Python server retains audio for local models only.

---

## LLM Endpoint (Shared Infrastructure)

**Control:** Text input field labeled "Endpoint"

**What it does:** Specifies the base URL for local Ollama or compatible LLM services (e.g., fallback inference, future local STT models, dictation/transform LLM features).

**Options/Range:** Any valid HTTP(S) URL. No validation of reachability at input time.

**Default:** `http://localhost:11434`

**Conditional visibility:** Always visible. Applies to all local LLM features (dictation, text transforms) but not cloud STT, which uses provider-specific endpoints.

**Setting key:** `settings.llm.endpoint`

**Gotchas:**
- This is **shared infrastructure** — one Ollama instance across the entire app. If dictation + transforms both run, they hit the same endpoint.
- The endpoint value is NOT validated on input; invalid URLs persist silently until a feature tries to call it. The verify probe only exists for cloud providers, not for Ollama.
- Changing this does NOT auto-reconnect or test the new address; features continue using the old value until restart or manual reconnect.

---

## OpenAI API Key Integration

**Control:** Password field labeled "OpenAI API Key" under the OpenAI section

**What it does:** Stores and verifies an OpenAI API key for cloud transcription (GPT-4o models, Whisper v1). Key is encrypted at rest, persisted to electron-store, and sent to OpenAI on every transcription request.

**Options/Range:** Any non-empty string (validated by OpenAI's `/v1/models` endpoint on verify).

**Default:** Empty string `""`

**Conditional visibility:** Always visible in the Integrations panel.

**Setting key:** `settings.integrations.openai.apiKey`

**Storage mechanism:** Encrypted at rest via Electron `safeStorage` (DPAPI on Windows).

**Verification:**
- **Trigger:** 600ms after the last keystroke (debounced)
- **Endpoint:** OpenAI `/v1/models` (GET request with `Authorization: Bearer <key>`)
- **Debounce window:** 600ms — long enough that pasting produces one probe, short enough for user feedback before navigation
- **Non-blocking:** Key persists immediately on keystroke; verify probe runs in background.

**Metadata fields:**
- `settings.integrations.openai.verified` (boolean|null) — last verification result (null = never probed)
- `settings.integrations.openai.lastVerifiedAt` (number|null) — epoch-ms of last successful verification

**Status pill states:** idle / verifying (spinner) / verified (green) / invalid (red) / offline (yellow)

**Gotchas:**
- Key is NOT validated when entered — only when the debounce fires.
- Status pill only appears if a key is present.
- If user removes key mid-session while OpenAI is active, confirmation dialog blocks removal.
- Verification failure does NOT revert the key; user can fix it inline.

---

## ElevenLabs API Key Integration

**Control:** Password field labeled "ElevenLabs API Key"

**What it does:** Stores and verifies an ElevenLabs API key for cloud transcription (Scribe v1 models).

**Options/Range:** Any non-empty string (validated by ElevenLabs `/v1/user` endpoint).

**Default:** Empty string `""`

**Conditional visibility:** Always visible in the Integrations panel.

**Setting key:** `settings.integrations.elevenlabs.apiKey`

**Verification:**
- **Trigger:** 600ms after the last keystroke (debounced)
- **Endpoint:** ElevenLabs `/v1/user` (GET with `xi-api-key: <key>` header — NOT Bearer auth)
- **Debounce window:** 600ms
- **Non-blocking:** Key persists on keystroke; verify probe runs in background.

**Metadata fields:**
- `settings.integrations.elevenlabs.verified` (boolean|null)
- `settings.integrations.elevenlabs.lastVerifiedAt` (number|null)

**Gotchas:**
- ElevenLabs uses custom `xi-api-key` header instead of Bearer auth.
- Status pill only appears if key is present.
- Same confirm-on-removal behavior as OpenAI.

---

## OpenRouter API Key

**Control:** Password field labeled "OpenRouter API Key"

**What it does:** Stores an OpenRouter API key for LLM inference (dictation, text transforms) — NOT for cloud STT.

**Options/Range:** Any non-empty string.

**Default:** Empty string `""`

**Setting key:** `settings.llm.openrouterApiKey`

**Verification:**
- **Trigger:** 600ms after the last keystroke (debounced)
- **Debounce window:** 600ms
- **Status pill:** idle / verifying / verified / invalid / offline

**Gotchas:**
- NOT a cloud STT provider; it's for text-based LLM features only.

---

## Summary of Controls

1. **LLM Endpoint** — URL text input, shared Ollama base, default http://localhost:11434
2. **OpenAI API Key** — Password field, 600ms verify debounce, encrypted, confirm on active-model removal
3. **ElevenLabs API Key** — Password field (xi-api-key header), 600ms verify debounce, encrypted
4. **OpenRouter API Key** — Password field, separate from cloud STT, 600ms verify debounce, encrypted

All keys persist immediately on keystroke; verification is non-blocking and async. Status pills reflect live verification state. Removal of active cloud key triggers confirmation gate to prevent silent transcription failure.
