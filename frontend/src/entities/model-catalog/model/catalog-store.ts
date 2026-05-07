"use client";

import { z } from "zod";
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

/** Zod schema for server-sent model catalog items (snake_case). */
const rawModelInfoSchema = z.object({
	id: z.string(),
	display_name: z.string(),
	backend: z.enum(["faster_whisper", "onnx_asr"]),
	family: z.enum(["whisper", "nemo", "gigaam", "kaldi", "t-one"]),
	languages: z.array(z.string()),
	supports_language_detection: z.boolean(),
	size_label: z.string(),
	supports_realtime: z.boolean(),
	onnx_model_name: z.string().nullable(),
	description: z.string(),
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
	const validated = raw
		.map((item) => rawModelInfoSchema.safeParse(item))
		.filter((r) => r.success)
		.map((r) => r.data);
	return { models: validated.map(mapModel), isLoaded: true };
}

export const useCatalogStore = create<CatalogState>()((set, get) => ({
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
