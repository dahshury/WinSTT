import { z } from "zod";
import { create } from "zustand";
import { fetchModelCatalog, onModelCatalog } from "@/shared/api/ipc-client";

export interface ModelInfo {
	accuracyScore: number;
	availableQuantizations: string[];
	backend: "faster_whisper" | "onnx_asr";
	description: string;
	displayName: string;
	family:
		| "whisper"
		| "lite-whisper"
		| "nemo"
		| "gigaam"
		| "kaldi"
		| "t-one"
		| "moonshine"
		| "cohere"
		| "granite";
	id: string;
	languages: string[];
	onnxModelName: string | null;
	sizeLabel: string;
	speedScore: number;
	supportsLanguageDetection: boolean;
	supportsRealtime: boolean;
}

/** Zod schema for server-sent model catalog items (snake_case). */
const rawModelInfoSchema = z.object({
	id: z.string(),
	display_name: z.string(),
	backend: z.enum(["faster_whisper", "onnx_asr"]),
	family: z.enum([
		"whisper",
		"lite-whisper",
		"nemo",
		"gigaam",
		"kaldi",
		"t-one",
		"moonshine",
		"cohere",
		"granite",
	]),
	languages: z.array(z.string()),
	supports_language_detection: z.boolean(),
	size_label: z.string(),
	supports_realtime: z.boolean(),
	onnx_model_name: z.string().nullable(),
	description: z.string(),
	available_quantizations: z.array(z.string()).default([""]),
	// Server emits these post-v0.X (derived from param_count + family); the
	// catch keeps older bundled servers from breaking the renderer parse.
	speed_score: z.number().min(0).max(1).default(0.5).catch(0.5),
	accuracy_score: z.number().min(0).max(1).default(0.5).catch(0.5),
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
		speedScore: raw.speed_score,
		accuracyScore: raw.accuracy_score,
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
