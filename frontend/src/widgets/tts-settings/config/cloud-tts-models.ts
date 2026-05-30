/**
 * Hand-curated cloud TTS model catalog for ElevenLabs synthesis. No account
 * fetch — these are fixed `model_id` values streamed PCM-capable enough for the
 * main-process synthesis path (`electron/ipc/tts-cloud.ts`). Persisted verbatim
 * to `tts.cloud.model` and sent as the ElevenLabs `model_id`.
 *
 * `eleven_v3` is intentionally excluded — it has no stable PCM streaming, which
 * the gap-free playback queue (`features/tts-playback`) requires. Voices are
 * fetched live from the account; only models stay a curated constant list.
 *
 * Lives in the `tts-settings` widget (not a standalone entity) because the
 * `CloudTtsControls` picker is its sole consumer — FSD v2.1 inlines
 * single-consumer slices.
 */
interface CloudTtsModel {
	description?: string;
	displayName: string;
	id: string;
	isDefault?: boolean;
}

export const CLOUD_TTS_MODELS: readonly CloudTtsModel[] = [
	{
		id: "eleven_multilingual_v2",
		displayName: "Multilingual v2",
		description: "Highest quality, 29 languages",
		isDefault: true,
	},
	{
		id: "eleven_turbo_v2_5",
		displayName: "Turbo v2.5",
		description: "Low latency, 32 languages",
	},
	{
		id: "eleven_flash_v2_5",
		displayName: "Flash v2.5",
		description: "Lowest latency (~75ms)",
	},
];
