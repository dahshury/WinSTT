/**
 * Per-model read-aloud speed bounds — the single frontend source of truth,
 * mirrored by the Rust engine clamps (`supertonic.rs` `SPEED_MIN`/`SPEED_MAX`).
 *
 * Supertonic 3 is a diffusion duration model: it stretches cleanly when slowed,
 * but near the top of the official range the vocoder can't articulate fast enough
 * and the output TRUNCATES words rather than speaking faster. Its speed-up is
 * therefore capped at 1.3 (the original shipped ceiling, well inside the official
 * 0.9–1.5 recommended range; the engine's +0.05 offset means a UI 1.5 would
 * actually run at 1.55, past the official ceiling — exactly where the trimming
 * starts). The slow end stays wide at 0.4 (stretching is fine). The other local
 * engines drive speed as a continuous model input (Kokoro / Kitten) or
 * `length_scale` (Piper) and handle the full 0.5–2.0.
 */

export const SUPERTONIC_TTS_MODEL_ID = "supertonic-3";

export interface TtsSpeedRange {
	min: number;
	max: number;
}

/** The slider bounds for a local TTS model id. Mirrors the Rust engine clamps. */
export function ttsSpeedRange(model: string | undefined): TtsSpeedRange {
	return model === SUPERTONIC_TTS_MODEL_ID
		? { min: 0.4, max: 1.3 }
		: { min: 0.5, max: 2.0 };
}

/** Clamp a speed into a local model's supported range (so a stale persisted value
 *  above the new ceiling displays/cycles as the clamped value, matching the
 *  engine which clamps too). */
export function clampTtsSpeed(
	model: string | undefined,
	speed: number,
): number {
	const { min, max } = ttsSpeedRange(model);
	return Math.min(max, Math.max(min, speed));
}

// Quick-cycle presets for the dynamic-island speed pill. Cloud (ElevenLabs)
// clamps `voice_settings.speed` to 0.7–1.2; local presets are filtered to the
// active model's ceiling so the pill never offers a speed the engine would clamp
// or truncate (e.g. Supertonic drops the 2× step).
const LOCAL_SPEED_PRESETS = [1, 1.25, 1.5, 2] as const;
const CLOUD_SPEED_PRESETS = [0.9, 1, 1.1, 1.2] as const;

export function ttsSpeedPresets(
	model: string | undefined,
	cloud: boolean,
): readonly number[] {
	if (cloud) {
		return CLOUD_SPEED_PRESETS;
	}
	const { max } = ttsSpeedRange(model);
	return LOCAL_SPEED_PRESETS.filter((preset) => preset <= max + 1e-9);
}

/** The next preset after `current`, wrapping within the model's preset list. */
export function nextTtsSpeedPreset(
	current: number,
	presets: readonly number[],
): number {
	const idx = presets.findIndex((preset) => Math.abs(preset - current) < 0.001);
	if (idx !== -1) {
		return presets[(idx + 1) % presets.length] ?? current;
	}
	return presets.find((preset) => preset > current) ?? presets[0] ?? current;
}
