import { z } from "zod";

// Kokoro-82M ONNX text-to-speech. Opt-in feature — `enabled` defaults to
// false; the engine only loads on first synthesis request. `voice` and
// `lang` mirror the Kokoro voice catalog (see
// ``server/src/synthesizer/infrastructure/voice_catalog.py``); `speed` is
// a multiplier clamped 0.5..2.0. `hotkey` is the global combo that
// captures the active selection and reads it aloud; defaults to
// LCtrl+Space so the binding is always present when TTS is enabled
// (users can rebind from settings). There is no per-TTS compute device:
// the synthesizer shares the main STT model's device (`model.device`),
// which the spawn layer mirrors onto the server's `--tts-device` flag.
export const ttsSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  // Local TTS catalog id selecting WHICH engine/model synthesizes (Kokoro,
  // Kitten, Piper, Supertonic). `voice` below is the voice WITHIN this model.
  // Default "kokoro-82m" preserves the historical Kokoro-only behaviour.
  model: z.string().default("kokoro-82m"),
  voice: z.string().default("af_heart"),
  lang: z.string().default("en-us"),
  speed: z.number().min(0.5).max(2.0).default(1.0),
  // Always non-empty: TTS the feature stays gated by `enabled`, but the
  // hotkey itself must always carry a valid combo so the conflict checker
  // can compare against it and the recorder UI never renders an empty chip.
  hotkey: z.string().min(1).default("LCtrl+Space").catch("LCtrl+Space"),
  // Local ⇄ Cloud switch mirroring the STT/LLM source toggles. "local" =
  // Kokoro ONNX (the `voice`/`lang`/`speed` fields above); "cloud" routes
  // synthesis through ElevenLabs entirely in the reference main process (see
  // `electron/ipc/tts-cloud.ts`). Cloud is only selectable when the
  // ElevenLabs key is present AND verified (`integrations.elevenlabs.verified`);
  // the renderer gates the option, and the cloud path reuses the same
  // encrypted `integrations.elevenlabs.apiKey` secret — no new key storage.
  source: z.enum(["local", "cloud"]).default("local"),
  // ElevenLabs tuning, active only when `source === "cloud"`. `voice` is the
  // account voice_id (fetched live via /v2/voices, so cloned voices appear);
  // `model` is one of the streaming-PCM-capable model ids (see
  // `widgets/tts-settings/config/cloud-tts-models`). `stability`/`similarity`/`style` are the
  // 0..1 voice-settings knobs, `speed` the 0.7..1.2 multiplier, and
  // `speakerBoost` the use_speaker_boost flag — passed verbatim into the
  // ElevenLabs `voice_settings` payload. `.prefault({})` lets the whole
  // sub-object default cleanly when absent from persisted JSON.
  cloud: z
    .object({
      voice: z.string().default(""),
      model: z.string().default("eleven_multilingual_v2"),
      stability: z.number().min(0).max(1).default(0.5),
      similarity: z.number().min(0).max(1).default(0.75),
      style: z.number().min(0).max(1).default(0),
      speed: z.number().min(0.7).max(1.2).default(1.0),
      speakerBoost: z.boolean().default(true),
    })
    .prefault({}),
});

// Per-provider integration record. `apiKey` is encrypted at rest via
// the reference `safeStorage` (DPAPI on Windows) — the wire/in-memory shape
// is plaintext but the persisted JSON contains `enc:v1:<base64>`; the
// secret-storage layer transparently encrypts on save and decrypts on
// read (see `electron/lib/secret-storage.ts`). `verified` is the result
// of the last successful probe (null = never probed); `lastVerifiedAt`
// is epoch-ms. Matches the existing `llm.openrouterApiKey` pattern so
// the UI can use `PasswordField` directly against the store value.
const providerIntegrationStatusSchema = z.object({
  apiKey: z.string().default(""),
  verified: z.boolean().nullable().default(null),
  lastVerifiedAt: z.number().nullable().default(null),
});

export const integrationsSchema = z.object({
  openai: providerIntegrationStatusSchema.prefault({}),
  elevenlabs: providerIntegrationStatusSchema.prefault({}),
});
