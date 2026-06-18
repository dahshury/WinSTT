import { useShallow } from "zustand/react/shallow";
import {
	assessOllamaFit,
	RECOMMENDED_OLLAMA_MODELS,
	useLlmCatalogStore,
	useOllamaLibraryStore,
} from "@/entities/llm-catalog";
import { useModelStateStore } from "@/entities/model-catalog";
import type { OllamaPullProgress } from "@/shared/api/models";
import type { OllamaModelSelectorProps } from "@/widgets/model-picker";

/**
 * Wires the shared Ollama catalog / library / system-info stores into the props
 * the rich inline `OllamaModelSelector` (the SAME picker Settings → LLM uses)
 * needs. The settings panel assembles the identical bundle inside
 * `useLlmSettingsPanel`; FSD forbids importing that widget's slice, so — exactly
 * like `recording-settings-helpers` copies the recording-mode subset — the
 * relevant catalog→selector wiring is reproduced here. The caller supplies only
 * `value` / `onChange` (the feature-specific bits).
 */
export type OnboardingOllamaPickerProps = Omit<
	OllamaModelSelectorProps,
	"value" | "onChange" | "placeholder" | "uiStorageKey"
>;

export function useOnboardingOllamaPicker(): OnboardingOllamaPickerProps {
	const {
		models,
		isScanning,
		scanModels,
		pulls: pullsRaw,
		pausedPulls,
		pullModel,
		cancelPull,
		resumePull,
		discardPausedPull,
		deleteModel,
	} = useLlmCatalogStore(
		useShallow((s) => ({
			models: s.models,
			isScanning: s.isScanning,
			scanModels: s.scanModels,
			pulls: s.pulls,
			pausedPulls: s.pausedPulls,
			pullModel: s.pullModel,
			cancelPull: s.cancelPull,
			resumePull: s.resumePull,
			discardPausedPull: s.discardPausedPull,
			deleteModel: s.deleteModel,
		})),
	);

	// Flatten the store's `{ progress, startedAt }` shape down to the plain
	// `{ [name]: OllamaPullProgress }` the selector expects.
	const pulls: Record<string, OllamaPullProgress> = {};
	for (const [name, state] of Object.entries(pullsRaw)) {
		pulls[name] = state.progress;
	}

	const library = useOllamaLibraryStore(
		useShallow((s) => ({
			catalog: s.catalog,
			error: s.error,
			isLoaded: s.isLoaded,
			isLoading: s.isLoading,
			tagsByModel: s.tagsByModel,
			loadCatalog: s.loadCatalog,
			fetchTags: s.fetchTags,
		})),
	);

	const systemInfo = useModelStateStore((s) => s.systemInfo);

	return {
		isLoading: isScanning,
		librarySearch: {
			catalog: library.catalog,
			error: library.error,
			isLoaded: library.isLoaded,
			isLoading: library.isLoading,
			tagsByModel: library.tagsByModel,
			loadCatalog: () => {
				library.loadCatalog().catch(() => undefined);
			},
			fetchTags: (m) => {
				library.fetchTags(m).catch(() => undefined);
			},
		},
		models,
		onDelete: (name) => {
			deleteModel(name).catch(() => undefined);
		},
		onDiscardPull: discardPausedPull,
		onOpen: () => {
			scanModels().catch(() => undefined);
		},
		onPull: (name) => {
			pullModel(name).catch(() => undefined);
		},
		onResumePull: (name) => {
			resumePull(name).catch(() => undefined);
		},
		onStopPull: (name) => {
			cancelPull(name).catch(() => undefined);
		},
		pausedPulls,
		pulls,
		recommendedModels: RECOMMENDED_OLLAMA_MODELS,
		systemFit: (sizeBytes: number) => {
			const fit = assessOllamaFit(sizeBytes, systemInfo);
			return {
				availableBytes: fit.availableBytes,
				fits: fit.fits,
				requiredBytes: fit.requiredBytes,
				shortfall: fit.shortfall,
			};
		},
	};
}
