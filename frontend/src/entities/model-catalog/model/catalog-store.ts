import { z } from "zod";
import { create } from "zustand";
import { fetchModelCatalog, onModelCatalog } from "@/shared/api/ipc-client";

export interface ModelInfo {
	/**
	 * `true` for shipped catalog rows. `false` only for user-provided custom
	 * model folders that failed the discovery contract (missing encoder /
	 * decoder / tokenizer / config). The picker greys these out and shows
	 * {@link errorMessage} as a tooltip so the user knows what's wrong with
	 * their drop without having to inspect the folder by hand.
	 */
	available: boolean;
	availableQuantizations: string[];
	backend: "faster_whisper" | "onnx_asr";
	description: string;
	displayName: string;
	/** Non-empty only for broken custom-model entries; renders as a tooltip. */
	errorMessage: string;
	family: "whisper" | "lite-whisper" | "nemo" | "gigaam" | "kaldi" | "t-one" | "custom";
	id: string;
	languages: string[];
	/**
	 * Absolute path to the user-provided model folder when the entry is a
	 * custom drop. `null` for every shipped catalog row. Driven by the
	 * server-side scanner under `{userData}/models/custom/`.
	 */
	localPath: string | null;
	onnxModelName: string | null;
	sizeLabel: string;
	supportsLanguageDetection: boolean;
	supportsRealtime: boolean;
}

/** Zod schema for server-sent model catalog items (snake_case). */
const rawModelInfoSchema = z.object({
	id: z.string(),
	display_name: z.string(),
	backend: z.enum(["faster_whisper", "onnx_asr"]),
	family: z.enum(["whisper", "lite-whisper", "nemo", "gigaam", "kaldi", "t-one", "custom"]),
	languages: z.array(z.string()),
	supports_language_detection: z.boolean(),
	size_label: z.string(),
	supports_realtime: z.boolean(),
	onnx_model_name: z.string().nullable(),
	description: z.string(),
	available_quantizations: z.array(z.string()).default([""]),
	// `available` / `error_message` / `local_path` are additive fields the
	// server started emitting alongside the custom-model scanner. Older
	// servers that haven't been redeployed yet won't send them; the defaults
	// preserve the pre-custom-models shape ("every entry is available").
	available: z.boolean().default(true),
	error_message: z.string().default(""),
	local_path: z.string().nullable().default(null),
});

type RawModelInfo = z.infer<typeof rawModelInfoSchema>;

function mapModel(raw: RawModelInfo): ModelInfo {
	return {
		id: raw.id,
		displayName: raw.display_name,
		backend: raw.backend,
		family: raw.family,
		languages: raw.languages,
		supportsLanguageDetection: raw.supports_language_detection,
		sizeLabel: raw.size_label,
		supportsRealtime: raw.supports_realtime,
		onnxModelName: raw.onnx_model_name,
		description: raw.description,
		availableQuantizations: raw.available_quantizations,
		available: raw.available,
		errorMessage: raw.error_message,
		localPath: raw.local_path,
	};
}

interface CatalogState {
	getFamilies: () => string[];
	getModel: (id: string) => ModelInfo | undefined;
	isLoaded: boolean;
	models: ModelInfo[];
	setModels: (raw: unknown[]) => void;
}

function applyRaw(raw: unknown[]): { models: ModelInfo[]; isLoaded: boolean } {
	const models: ModelInfo[] = [];
	for (const item of raw) {
		const parsed = rawModelInfoSchema.safeParse(item);
		if (parsed.success) {
			models.push(mapModel(parsed.data));
		}
	}
	return { models, isLoaded: true };
}

export const useCatalogStore = create<CatalogState>()((set, get) => ({
	models: [],
	isLoaded: false,
	setModels: (raw) => set(applyRaw(raw)),
	getModel: (id) => get().models.find((m) => m.id === id),
	getFamilies: () => [...new Set(get().models.map((m) => m.family))],
}));

/**
 * Fetches the cached model catalog from the main process and subscribes to
 * live catalog updates. Called automatically on module load in Electron windows.
 * Exported for unit tests that need to trigger initialization manually.
 */
export function initCatalogStore(): void {
	fetchModelCatalog().then((raw) => {
		if (Array.isArray(raw) && raw.length > 0) {
			useCatalogStore.getState().setModels(raw);
		}
	});
	onModelCatalog((raw) => useCatalogStore.getState().setModels(raw));
}

// Self-initializing: fetch cached catalog from main process on import,
// and subscribe to live updates. Works in every window (main + settings).
// Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,StringLiteral,BlockStatement: guard for non-electron environments (SSR / tests w/o electronAPI). Mutating this branch is an equivalent mutant in unit tests since initCatalogStore() is also called explicitly elsewhere.
if (typeof window !== "undefined" && window.electronAPI != null) {
	initCatalogStore();
}
