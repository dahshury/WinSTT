import { useConnectionStore } from "@/entities/connection";
import { useLlmCatalogStore } from "@/entities/llm-catalog";
import { useModelStateStore } from "@/entities/model-catalog";
import { largestGpuVram } from "@/entities/model-suggestion";
import type { CommittedModel } from "@/entities/model-suggestion";
import { useSettingsStore } from "@/entities/setting";
import {
	useTtsCatalogStore,
	useTtsModelStateStore,
} from "@/entities/tts-catalog";
import { buildCommittedModels, findOllamaModel } from "../lib/committed-models";

/**
 * Live `CommittedModel[]` for the suggestion budget calculator: which
 * modalities are enabled and what each one's runtime footprint costs, read
 * from the SAME stores as the status-bar breakdown
 * (`useRuntimeModelBreakdown` in connect-server).
 *
 * Read-only — no store refresh side effects. Every hosting surface (settings
 * panels, picker windows) already populates the model-state / TTS / Ollama
 * stores it renders from, and the Suggested list must stay stable while the
 * picker is open (plan Part 3.2: totals-based, not live-free-based).
 */
export function useCommittedModels(): CommittedModel[] {
	const runtimeInfo = useConnectionStore((s) => s.runtimeInfo);
	const modelSettings = useSettingsStore((s) => s.settings.model);
	const ttsSettings = useSettingsStore((s) => s.settings.tts);
	const encoderDictEnabled = useSettingsStore(
		(s) => s.settings.general?.encoderDictionaryEnabled ?? false,
	);
	const dictation = useSettingsStore((s) => s.settings.llm?.dictation);

	const sttStates = useModelStateStore((s) => s.statesById);
	const systemInfo = useModelStateStore((s) => s.systemInfo);
	const ttsStates = useTtsModelStateStore((s) => s.statesById);
	const ttsModels = useTtsCatalogStore((s) => s.models);
	const ollamaModels = useLlmCatalogStore((s) => s.models);

	const hasGpu = largestGpuVram(systemInfo?.gpus ?? []) > 0;
	return buildCommittedModels({
		hasGpu,
		isGpuAccelerator: runtimeInfo?.is_gpu ?? hasGpu,
		mainModelId: runtimeInfo?.model ?? modelSettings?.model ?? null,
		realtimeModelId: runtimeInfo?.realtime_model ?? null,
		sttQuant: modelSettings?.onnxQuantization ?? "auto",
		getSttState: (id) => sttStates[id],
		tts: {
			enabled: ttsSettings?.enabled ?? false,
			source: ttsSettings?.source ?? "local",
			modelId: ttsSettings?.model ?? "",
		},
		getTtsState: (id) => ttsStates[id],
		getTtsModel: (id) => ttsModels.find((m) => m.id === id),
		encoderDictEnabled,
		llmCleanup: {
			enabled: dictation?.enabled ?? false,
			provider: dictation?.provider ?? "ollama",
			model: dictation?.model ?? "",
		},
		getOllamaModel: (name) => findOllamaModel(ollamaModels, name),
	});
}
