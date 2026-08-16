import { useSettingsStore } from "@/entities/setting";
import {
	type IntegrationProvider,
	type ProviderCapability,
	providerCapabilities,
} from "./provider-capabilities";

/**
 * Live capability chips for one provider card. Every selector reads a PRIMITIVE
 * so the store's default identity comparison actually holds — selecting the
 * assembled snapshot object would allocate a fresh one per store notification
 * and re-render on unrelated settings writes.
 *
 * All decision logic lives in `providerCapabilities`; this hook only supplies
 * the current values, so the model stays unit-testable without rendering.
 */
export function useProviderCapabilities(
	provider: IntegrationProvider,
): ProviderCapability[] {
	const dictationProvider = useSettingsStore(
		(s) => s.settings.llm.dictation.provider,
	);
	const readAloudProvider = useSettingsStore(
		(s) => s.settings.llm.readAloud.provider,
	);
	const transformsProvider = useSettingsStore(
		(s) => s.settings.llm.transforms.provider,
	);
	// Subscribed as separate slices, like the providers: a keyless provider's
	// chips mean "running here now", which a provider match alone cannot answer.
	const dictationEnabled = useSettingsStore(
		(s) => s.settings.llm.dictation.enabled,
	);
	const readAloudEnabled = useSettingsStore(
		(s) => s.settings.llm.readAloud.enabled,
	);
	const transformsEnabled = useSettingsStore(
		(s) => s.settings.llm.transforms.enabled,
	);
	const ttsProvider = useSettingsStore((s) => s.settings.tts.cloud.provider);
	const ttsSource = useSettingsStore((s) => s.settings.tts.source);
	// The main STT slot: the persisted selection, which is what a cloud-model
	// prefix (`openrouter:` / `elevenlabs:`) is read from.
	const activeModelId = useSettingsStore((s) => s.settings.model?.model ?? "");

	return providerCapabilities(
		provider,
		{
			llm: {
				dictation: { enabled: dictationEnabled, provider: dictationProvider },
				readAloud: { enabled: readAloudEnabled, provider: readAloudProvider },
				transforms: {
					enabled: transformsEnabled,
					provider: transformsProvider,
				},
			},
			tts: { cloud: { provider: ttsProvider }, source: ttsSource },
		},
		activeModelId,
	);
}
