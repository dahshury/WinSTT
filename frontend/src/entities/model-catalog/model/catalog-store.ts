"use client";

import { create } from "zustand";
import { fetchModelCatalog, onModelCatalog } from "@/shared/api/ipc-client";

export interface ModelInfo {
	id: string;
	displayName: string;
	backend: "faster_whisper" | "onnx_asr";
	family: "whisper" | "nemo" | "gigaam" | "kaldi" | "t-one";
	languages: string[];
	supportsLanguageDetection: boolean;
	sizeLabel: string;
	supportsRealtime: boolean;
	onnxModelName: string | null;
	description: string;
}

/** Server sends snake_case keys; map to camelCase ModelInfo. */
interface RawModelInfo {
	id: string;
	display_name: string;
	backend: string;
	family: string;
	languages: string[];
	supports_language_detection: boolean;
	size_label: string;
	supports_realtime: boolean;
	onnx_model_name: string | null;
	description: string;
}

function mapModel(raw: RawModelInfo): ModelInfo {
	return {
		id: raw.id,
		displayName: raw.display_name,
		backend: raw.backend as ModelInfo["backend"],
		family: raw.family as ModelInfo["family"],
		languages: raw.languages,
		supportsLanguageDetection: raw.supports_language_detection,
		sizeLabel: raw.size_label,
		supportsRealtime: raw.supports_realtime,
		onnxModelName: raw.onnx_model_name,
		description: raw.description,
	};
}

interface CatalogState {
	models: ModelInfo[];
	isLoaded: boolean;
	setModels: (raw: unknown[]) => void;
	getModel: (id: string) => ModelInfo | undefined;
	getFamilies: () => string[];
}

function applyRaw(raw: unknown[]): { models: ModelInfo[]; isLoaded: boolean } {
	return { models: (raw as RawModelInfo[]).map(mapModel), isLoaded: true };
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
	models: [],
	isLoaded: false,
	setModels: (raw) => set(applyRaw(raw)),
	getModel: (id) => get().models.find((m) => m.id === id),
	getFamilies: () => [...new Set(get().models.map((m) => m.family))],
}));

// Self-initializing: fetch cached catalog from main process on import,
// and subscribe to live updates. Works in every window (main + settings).
if (typeof window !== "undefined" && window.electronAPI != null) {
	fetchModelCatalog().then((raw) => {
		if (Array.isArray(raw) && raw.length > 0) {
			useCatalogStore.getState().setModels(raw);
		}
	});
	onModelCatalog((raw) => useCatalogStore.getState().setModels(raw));
}
