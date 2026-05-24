import type { CloudSttProvider } from "@/shared/api/models";

/**
 * Hand-curated cloud STT model catalog. No server fetch — these are fixed
 * provider-native model ids that map straight into the AI SDK `transcription`
 * factories on the main process side. Renderer-side picker uses the prefix
 * (`openai:` / `elevenlabs:`) when persisting `settings.model.model` so the
 * Python server's `build_transcriber` can route accordingly.
 *
 * Keep `id` stable — it is appended to the provider prefix verbatim and
 * sent in the WS `model_id` envelope.
 */
export interface CloudModel {
	description?: string;
	displayName: string;
	id: string;
	isDefault?: boolean;
}

export const CLOUD_CATALOG: Record<CloudSttProvider, readonly CloudModel[]> = {
	openai: [
		{
			id: "gpt-4o-mini-transcribe",
			displayName: "GPT-4o mini transcribe",
			description: "Fast and cheap general-purpose transcription.",
			isDefault: true,
		},
		{
			id: "gpt-4o-transcribe",
			displayName: "GPT-4o transcribe",
			description: "Higher-accuracy GPT-4o transcription.",
		},
		{
			id: "gpt-4o-transcribe-diarize",
			displayName: "GPT-4o transcribe (diarize)",
			description: "GPT-4o transcription with per-speaker segmentation.",
		},
		{
			id: "whisper-1",
			displayName: "Whisper v1",
			description: "Legacy Whisper hosted model.",
		},
	],
	elevenlabs: [
		{
			id: "scribe_v1",
			displayName: "Scribe v1",
			description: "ElevenLabs transcription, multilingual.",
			isDefault: true,
		},
		{
			id: "scribe_v1_experimental",
			displayName: "Scribe v1 (experimental)",
			description: "Latest experimental Scribe build.",
		},
	],
};

export const CLOUD_PROVIDERS: readonly CloudSttProvider[] = ["openai", "elevenlabs"];

export function providerOf(modelId: string): CloudSttProvider | null {
	if (modelId.startsWith("openai:")) {
		return "openai";
	}
	if (modelId.startsWith("elevenlabs:")) {
		return "elevenlabs";
	}
	return null;
}

export function defaultCloudModelId(provider: CloudSttProvider): string {
	const catalog = CLOUD_CATALOG[provider];
	const def = catalog.find((m) => m.isDefault) ?? catalog[0];
	if (!def) {
		throw new Error(`No models defined for cloud provider ${provider}`);
	}
	return `${provider}:${def.id}`;
}

export function getApiKeyUrl(provider: CloudSttProvider): string {
	return provider === "openai"
		? "https://platform.openai.com/api-keys"
		: "https://elevenlabs.io/app/settings/api-keys";
}

export function providerDisplayName(provider: CloudSttProvider): string {
	return provider === "openai" ? "OpenAI" : "ElevenLabs";
}
