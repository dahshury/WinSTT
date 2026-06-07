import type { UseCloudTtsVoices } from "../model/use-cloud-tts-voices";

// Shown when the ElevenLabs character quota is spent (free OR paid) — Cloud is
// locked until it resets / the plan upgrades. Plain const (not an i18n key) to
// avoid touching the 20 locale files the cleanup sweep is editing.
export const OUT_OF_CREDITS_NOTE =
  "Out of ElevenLabs credits — cloud text-to-speech is paused until your quota resets or you upgrade.";

export interface CloudGate {
  /** Cloud source is selectable (key verified AND voices available/loading). */
  cloudAllowed: boolean;
  /** Verified key that authenticated but can't list voices — drives the notice. */
  noVoiceAccess: boolean;
}

// Derive the cloud-source gate from the live voice-catalog probe. A verified
// ElevenLabs key proves authentication (dictation / cloud STT work), but cloud
// TTS additionally needs the `voices_read` scope. An in-flight fetch is treated
// as optimistically allowed (most keys grant the scope, so the switch shouldn't
// flicker to local while we confirm); we lock only once the catalog resolves
// empty, surfacing the server's permission message via `noVoiceAccess`. Pulled
// out of the component to keep it under the complexity budget.
export function deriveCloudGate(
  elevenVerified: boolean,
  cloud: UseCloudTtsVoices,
): CloudGate {
  if (!elevenVerified) {
    return { cloudAllowed: false, noVoiceAccess: false };
  }
  // Out of ElevenLabs credits (free OR paid) → cloud is unusable regardless of
  // voices, so lock the whole source. The reason is surfaced by the caller.
  if (cloud.creditsExhausted) {
    return { cloudAllowed: false, noVoiceAccess: false };
  }
  if (cloud.isLoading) {
    return { cloudAllowed: true, noVoiceAccess: false };
  }
  const hasVoices = cloud.voices.length > 0;
  return {
    cloudAllowed: hasVoices,
    noVoiceAccess: !hasVoices && cloud.error !== null,
  };
}

// Tooltip footer for the locked Cloud switch: prefer the out-of-credits note,
// then the server's voice/permission error, else the generic "add a key" hint.
// Extracted to keep `TtsModelSection` under the complexity budget.
export function cloudLockFooterText(
  elevenVerified: boolean,
  cloud: UseCloudTtsVoices,
  fallbackHint: string,
): string {
  if (cloud.creditsExhausted) {
    return OUT_OF_CREDITS_NOTE;
  }
  if (elevenVerified && cloud.error) {
    return cloud.error;
  }
  return fallbackHint;
}
