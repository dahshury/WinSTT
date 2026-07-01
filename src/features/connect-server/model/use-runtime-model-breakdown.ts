import { useEffect } from "react";
import { useConnectionStore } from "@/entities/connection";
import { useCatalogStore, useModelStateStore } from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useLlmCatalogStore } from "@/entities/llm-catalog";
import { useTtsCatalogStore } from "@/entities/tts-catalog";
import type { OllamaModel } from "@/shared/api/ipc-client";
import { publicAsset } from "@/shared/lib/public-asset";
// Deep-import the lightweight logo/maker resolvers (NOT the
// `@/widgets/model-picker` barrel) so the heavy picker UI trees stay out of the
// main window's chunk — the same guard FooterModelChip uses for its STT helpers.
import {
	getAuthorLabel,
	getFamilyConfig,
} from "@/widgets/model-picker/stt/lib/family-helpers";
import {
	getEngineConfig,
	getEngineLogoSrc,
} from "@/widgets/model-picker/tts/lib/tts-helpers";
import {
	type BreakdownSection,
	buildRuntimeBreakdown,
} from "../lib/runtime-model-breakdown";

/** Resolve a family/engine brand-logo path for the active renderer (dev server
 *  vs packaged `file://`), or `null` when the maker has no bundled mark. */
function resolveLogo(path: string | null | undefined): string | null {
	return path ? publicAsset(path) : null;
}

/** Match an Ollama model by exact name, tolerating an implicit `:latest` tag
 *  on either side (the settings store and the API may disagree on the tag). */
function findOllamaModel(
	models: OllamaModel[],
	name: string,
): OllamaModel | undefined {
	if (name === "") {
		return undefined;
	}
	return models.find(
		(m) =>
			m.name === name ||
			m.name === `${name}:latest` ||
			`${m.name}:latest` === name,
	);
}

/**
 * Assembles the live STT / TTS / Dictionary / Post-processing footprint
 * breakdown for the status-bar chip tooltip.
 *
 * Reads the same stores the settings surfaces use; both the STT model-state
 * store (runtime byte estimates) and the TTS catalog self-populate, but the
 * main window never triggers them on its own, so we nudge them here. The
 * Ollama scan is only fired when a local cleanup LLM is actually configured —
 * we don't want to wake Ollama just to render the chip.
 */
export function useRuntimeModelBreakdown(isGpu: boolean): BreakdownSection[] {
	const runtimeInfo = useConnectionStore((s) => s.runtimeInfo);
	const modelSettings = useSettingsStore((s) => s.settings.model);
	const ttsSettings = useSettingsStore((s) => s.settings.tts);
	const encoderDictEnabled = useSettingsStore(
		(s) => s.settings.general?.encoderDictionaryEnabled ?? false,
	);
	const dictation = useSettingsStore((s) => s.settings.llm?.dictation);

	const sttModels = useCatalogStore((s) => s.models);
	const sttStates = useModelStateStore((s) => s.statesById);
	const ttsModels = useTtsCatalogStore((s) => s.models);
	const ollamaModels = useLlmCatalogStore((s) => s.models);

	const dictationEnabled = dictation?.enabled ?? false;
	const dictationProvider = dictation?.provider ?? "ollama";
	const dictationModel = dictation?.model ?? "";

	// Populate the STT runtime byte estimates once — the main window never
	// mounts a settings surface that would otherwise refresh them.
	useEffect(() => {
		void useModelStateStore.getState().refresh();
	}, []);

	// Pull Ollama model sizes only when a local cleanup LLM is configured.
	useEffect(() => {
		if (dictationEnabled && dictationProvider === "ollama" && dictationModel) {
			void useLlmCatalogStore.getState().scanModels();
		}
	}, [dictationEnabled, dictationProvider, dictationModel]);

	// Augment each catalog entry with its maker logo so the breakdown rows
	// can lead with the model's brand mark (STT family logo / TTS engine logo).
	const sttById = new Map(
		sttModels.map((m) => [
			m.id,
			{
				...m,
				logoSrc: resolveLogo(getFamilyConfig(m.family).logoSrc),
				maker: getAuthorLabel(m.family),
			},
		]),
	);
	const ttsById = new Map(
		ttsModels.map((m) => [
			m.id,
			{
				...m,
				logoSrc: resolveLogo(getEngineLogoSrc(m.engine)),
				maker: getEngineConfig(m.engine).maker,
			},
		]),
	);
	return buildRuntimeBreakdown({
		isGpu,
		mainModelId: runtimeInfo?.model ?? modelSettings?.model ?? null,
		realtimeModelId: runtimeInfo?.realtime_model ?? null,
		sttQuant: modelSettings?.onnxQuantization ?? "auto",
		getSttModel: (id) => sttById.get(id),
		getSttState: (id) => sttStates[id],
		tts: {
			enabled: ttsSettings?.enabled ?? false,
			source: ttsSettings?.source ?? "local",
			modelId: ttsSettings?.model ?? "",
			cloudProvider: ttsSettings?.cloud?.provider ?? "",
		},
		getTtsModel: (id) => ttsById.get(id),
		encoderDictEnabled,
		llmCleanup: {
			enabled: dictationEnabled,
			provider: dictationProvider,
			model: dictationModel,
			openrouterModel: dictation?.openrouterModel ?? "",
		},
		getOllamaModel: (name) => findOllamaModel(ollamaModels, name),
	});
}
