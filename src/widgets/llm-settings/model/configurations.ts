import { z } from "zod";
import { create } from "zustand";
import type {
	BuiltinPresetEntry,
	CustomModifier,
} from "@/entities/llm-catalog";
import {
	INDEPENDENT_PRESETS,
	PRESET_LEVELS,
	TONE_GROUP,
} from "@/entities/llm-catalog";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";
import { generateId } from "@/shared/lib/generate-id";
import { writePersistedSelectorState } from "@/shared/lib/persisted-selector-state";
import type { PresetCarrier } from "../lib/llm-settings-panel-test-helpers";

type LlmProvider = AppSettingsOutput["llm"]["dictation"]["provider"];
type ThinkingEffort = "off" | "low" | "medium" | "high";
type EffortLevel = "low" | "medium" | "high";

/**
 * A full, self-contained LLM configuration — tone + modifiers + provider/model.
 *
 * One unified concept drives two places: the per-feature **tone row** (which
 * applies only the tone + modifiers half to its section) and the **Playground**
 * (which additionally drives the provider/model picker). Structurally a superset
 * of the panel's `LlmFeatureDraft & PresetCarrier`, so the SAME provider/model
 * picker (`ProviderSection`) drives this config directly. `enabled` /
 * `reasoningEffort` / `verbosity` / `maxOutputTokens` are carried to satisfy the
 * picker's prop shape — the tone row ignores them.
 */
export interface LlmConfiguration {
	customModifiers: CustomModifier[];
	enabled: boolean;
	maxOutputTokens: number | null;
	model: string;
	openrouterFallbackModel: string;
	openrouterModel: string;
	presets: BuiltinPresetEntry[];
	provider: LlmProvider;
	// Shares the off/low/medium/high scale with `thinkingEffort` (`off` →
	// reasoning disabled). Verbosity stays low/medium/high.
	reasoningEffort: ThinkingEffort;
	thinkingEffort: ThinkingEffort;
	verbosity: EffortLevel;
}

/** A user-saved, named configuration (tone + modifiers + provider/model). The
 *  same saved entry is offered in every Configuration combobox. */
export interface SavedConfiguration {
	config: LlmConfiguration;
	id: string;
	name: string;
}

/** The last config (and the combobox label it was seeded from) the user left
 *  the Playground on. Restored on the next open so the model/tweaks survive
 *  across sessions instead of snapping back to the live dictation config. */
export interface PlaygroundSession {
	config: LlmConfiguration;
	selection: string;
}

// Saved configurations moved from the playground-only key to a neutral one when
// they grew into a shared concept. The legacy key is still read on first load
// (then transparently re-saved under the new key) so configs created before the
// rename aren't lost.
const STORAGE_KEY = "winstt:llm-configurations";
const LEGACY_STORAGE_KEY = "winstt:llm-playground-presets";
const SESSION_KEY = "winstt:llm-playground-session";

/** Deep-ish clone so editing a draft (or applying a config) never mutates a
 *  stored configuration or the live settings snapshot it was seeded from.
 *  Arrays of plain entry objects are copied one level deep — entries are flat. */
export function cloneLlmConfiguration(
	config: LlmConfiguration,
): LlmConfiguration {
	return {
		...config,
		presets: config.presets.map((p) => ({ ...p })),
		customModifiers: config.customModifiers.map((m) => ({ ...m })),
	};
}

// ── Tone + modifiers matching ─────────────────────────────────────────
// The tone-row combobox controls only the tone + modifiers half of a config,
// so it reflects a saved configuration as "selected" iff the section's live
// tone + modifiers (every detail — levels, target language, custom-modifier
// prompts and enabled flags) match exactly. Provider/model is intentionally
// NOT compared: applying a config from the tone row never touches it.

function normalizeCarrier(carrier: PresetCarrier) {
	return {
		presets: carrier.presets.map((p) => ({
			key: p.key,
			level: p.level ?? null,
			targetLang: p.targetLang ?? null,
		})),
		customModifiers: carrier.customModifiers.map((m) => ({
			id: m.id,
			name: m.name,
			prompt: m.prompt,
			enabled: m.enabled,
			levelsEnabled: m.levelsEnabled,
			level: m.level ?? null,
		})),
	};
}

function carrierSignature(carrier: PresetCarrier): string {
	return JSON.stringify(normalizeCarrier(carrier));
}

/** The id of the saved configuration whose tone + modifiers exactly match the
 *  given live carrier, or "" when none does (the user has diverged from / never
 *  applied a saved configuration). `LlmConfiguration` is structurally a
 *  `PresetCarrier`, so a config is compared directly. */
export function matchConfigurationId(
	carrier: PresetCarrier,
	configs: readonly SavedConfiguration[],
): string {
	const sig = carrierSignature(carrier);
	return configs.find((c) => carrierSignature(c.config) === sig)?.id ?? "";
}

const PRESET_KEYS = [...TONE_GROUP, ...INDEPENDENT_PRESETS] as const;

const presetKeySchema = z.enum(PRESET_KEYS);
const presetLevelSchema = z.enum(PRESET_LEVELS);
const thinkingEffortSchema = z.enum(["off", "low", "medium", "high"]);
const effortLevelSchema = z.enum(["low", "medium", "high"]);
const llmProviderSchema = z.enum([
	"ollama",
	"openrouter",
	"apple-intelligence",
]);

const builtinPresetEntrySchema = z.object({
	key: presetKeySchema,
	level: presetLevelSchema.optional(),
	targetLang: z.string().optional(),
});

const customModifierSchema = z.object({
	enabled: z.boolean().default(false),
	id: z.string(),
	level: presetLevelSchema.optional(),
	levelsEnabled: z.boolean().default(false),
	name: z.string().default(""),
	prompt: z.string().default(""),
});

const llmConfigurationSchema = z.object({
	customModifiers: z.array(customModifierSchema).default([]),
	enabled: z.boolean().default(false),
	maxOutputTokens: z.number().int().min(1).nullable().default(null),
	model: z.string().default(""),
	openrouterFallbackModel: z.string().default(""),
	openrouterModel: z.string().default(""),
	presets: z.array(builtinPresetEntrySchema).default([{ key: "neutral" }]),
	provider: llmProviderSchema.default("ollama"),
	reasoningEffort: thinkingEffortSchema.default("medium"),
	thinkingEffort: thinkingEffortSchema.default("off"),
	verbosity: effortLevelSchema.default("medium"),
});

// Validate and default the persisted shape at the localStorage boundary. Extra
// fields are ignored by zod and missing convenience fields receive the same
// defaults as a fresh LLM feature draft.
const savedConfigurationSchema = z.object({
	id: z.string(),
	name: z.string(),
	config: llmConfigurationSchema,
});

/** Load saved configurations from localStorage. Returns [] on any read/parse
 *  error — configurations are a non-critical convenience, never block the UI.
 *  Falls back to the legacy playground-presets key for pre-rename data. */
function loadConfigurations(): SavedConfiguration[] {
	try {
		const raw =
			localStorage.getItem(STORAGE_KEY) ??
			localStorage.getItem(LEGACY_STORAGE_KEY);
		if (!raw) {
			return [];
		}
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		// Single pass: parse each entry and keep only the ones that validate,
		// extracting `.data` inline so a malformed configuration is dropped
		// without iterating the list twice.
		const configs: SavedConfiguration[] = [];
		for (const entry of parsed) {
			const result = savedConfigurationSchema.safeParse(entry);
			if (result.success) {
				configs.push(result.data);
			}
		}
		return configs;
	} catch {
		// localStorage unavailable / quota / parse failure — start empty.
		return [];
	}
}

function persistConfigurations(configs: readonly SavedConfiguration[]): void {
	// Quota / serialization failures are non-fatal — the in-memory list still
	// works for the current session.
	writePersistedSelectorState(STORAGE_KEY, configs);
}

interface ConfigurationsState {
	configurations: SavedConfiguration[];
	removeConfiguration: (id: string) => void;
	/** Save `config` under `name` and return the new id. */
	saveConfiguration: (name: string, config: LlmConfiguration) => string;
}

/**
 * Single source of truth for saved configurations, shared live across every
 * Configuration combobox (both per-feature tone rows AND the Playground). The
 * list is seeded once from localStorage at store creation and every mutation
 * writes straight back through, so a config saved in one combobox appears in the
 * others immediately.
 */
export const useLlmConfigurationsStore = create<ConfigurationsState>()(
	(set, get) => ({
		configurations: loadConfigurations(),
		saveConfiguration: (name, config) => {
			const id = generateId();
			const entry: SavedConfiguration = {
				id,
				name,
				config: cloneLlmConfiguration(config),
			};
			const next = [...get().configurations, entry];
			set({ configurations: next });
			persistConfigurations(next);
			return id;
		},
		removeConfiguration: (id) => {
			const next = get().configurations.filter((c) => c.id !== id);
			set({ configurations: next });
			persistConfigurations(next);
		},
	}),
);

// The persisted session must carry a runnable config, so unlike the loose
// configuration guard we assert the fields the playground actually reads back
// (provider/model plus the two array slots `cloneLlmConfiguration` maps over).
// A partial/corrupt blob fails the parse and falls back to the live seed.
const playgroundSessionSchema = z.object({
	selection: z.string(),
	config: llmConfigurationSchema,
});

/** Load the last Playground session, or null if none/invalid. */
export function loadPlaygroundSession(): PlaygroundSession | null {
	try {
		const raw = localStorage.getItem(SESSION_KEY);
		if (!raw) {
			return null;
		}
		const parsed = playgroundSessionSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			return null;
		}
		return {
			selection: parsed.data.selection,
			config: parsed.data.config,
		};
	} catch {
		return null;
	}
}

export function savePlaygroundSession(session: PlaygroundSession): void {
	// Non-fatal — the current open still works, only cross-open memory is lost.
	writePersistedSelectorState(SESSION_KEY, session);
}
