import type { BuiltinPresetEntry, CustomModifier } from "@/entities/llm-catalog";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";

type LlmProvider = AppSettingsOutput["llm"]["dictation"]["provider"];
type ThinkingEffort = "off" | "low" | "medium" | "high";
type EffortLevel = "low" | "medium" | "high";

/**
 * A full, self-contained LLM configuration the Playground can run against —
 * tone + modifiers + provider/model. Structurally a superset of the
 * electron-main `FeatureLlmConfig` (the preview override) AND of the panel's
 * `LlmFeatureDraft & PresetCarrier`, so the SAME provider/model picker
 * (`ProviderSection`) the settings panel uses can drive this draft directly.
 * `enabled` / `reasoningEffort` / `verbosity` / `maxOutputTokens` are carried
 * only to satisfy that picker's prop shape — the preview ignores them.
 */
export interface PlaygroundConfig {
	customModifiers: CustomModifier[];
	enabled: boolean;
	maxOutputTokens: number | null;
	model: string;
	openrouterFallbackModel: string;
	openrouterModel: string;
	presets: BuiltinPresetEntry[];
	provider: LlmProvider;
	reasoningEffort: EffortLevel;
	thinkingEffort: ThinkingEffort;
	verbosity: EffortLevel;
}

/** A user-saved, named Playground configuration. */
export interface PlaygroundPreset {
	config: PlaygroundConfig;
	id: string;
	name: string;
}

const STORAGE_KEY = "winstt:llm-playground-presets";

/** Deep-ish clone so editing the draft never mutates a stored preset (or the
 *  live settings snapshot it was seeded from). Arrays of plain entry objects
 *  are copied one level deep — entries themselves are flat. */
export function clonePlaygroundConfig(config: PlaygroundConfig): PlaygroundConfig {
	return {
		...config,
		presets: config.presets.map((p) => ({ ...p })),
		customModifiers: config.customModifiers.map((m) => ({ ...m })),
	};
}

export function makePlaygroundPresetId(): string {
	return `pp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isPlaygroundPreset(value: unknown): value is PlaygroundPreset {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<PlaygroundPreset>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.name === "string" &&
		Boolean(candidate.config) &&
		typeof candidate.config === "object"
	);
}

/** Load saved presets from localStorage. Returns [] on any read/parse error —
 *  presets are a non-critical convenience, never block the playground. */
export function loadPlaygroundPresets(): PlaygroundPreset[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return [];
		}
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter(isPlaygroundPreset) : [];
	} catch {
		return [];
	}
}

export function savePlaygroundPresets(presets: readonly PlaygroundPreset[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
	} catch {
		// Quota / serialization failures are non-fatal — the in-memory list
		// still works for the current session.
	}
}
