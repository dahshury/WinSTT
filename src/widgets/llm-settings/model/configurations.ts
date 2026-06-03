import { z } from "zod";
import { create } from "zustand";
import type { BuiltinPresetEntry, CustomModifier } from "@/entities/llm-catalog";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";
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
	reasoningEffort: EffortLevel;
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
export function cloneLlmConfiguration(config: LlmConfiguration): LlmConfiguration {
	return {
		...config,
		presets: config.presets.map((p) => ({ ...p })),
		customModifiers: config.customModifiers.map((m) => ({ ...m })),
	};
}

function makeConfigurationId(): string {
	return `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
	configs: readonly SavedConfiguration[]
): string {
	const sig = carrierSignature(carrier);
	return configs.find((c) => carrierSignature(c.config) === sig)?.id ?? "";
}

// Validate the persisted shape at the localStorage boundary. We keep this as
// loose as the previous hand-rolled guard (id/name strings + a `config` object):
// configurations are a non-critical convenience and `cloneLlmConfiguration` is
// tolerant of extra/missing fields. The `config` widens back to
// `LlmConfiguration` on the way out.
const savedConfigurationSchema = z.object({
	id: z.string(),
	name: z.string(),
	config: z.looseObject({}),
});

/** Load saved configurations from localStorage. Returns [] on any read/parse
 *  error — configurations are a non-critical convenience, never block the UI.
 *  Falls back to the legacy playground-presets key for pre-rename data. */
function loadConfigurations(): SavedConfiguration[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
		if (!raw) {
			return [];
		}
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		// Validate per-entry so one malformed configuration doesn't discard the
		// rest. `config` widens from the validated object back to
		// `LlmConfiguration` — a boundary cast (validated input → richer domain
		// type), not raw input.
		return parsed
			.map((entry) => savedConfigurationSchema.safeParse(entry))
			.filter((result) => result.success)
			.map((result) => result.data as unknown as SavedConfiguration);
	} catch {
		// localStorage unavailable / quota / parse failure — start empty.
		return [];
	}
}

function persistConfigurations(configs: readonly SavedConfiguration[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
	} catch {
		// Quota / serialization failures are non-fatal — the in-memory list
		// still works for the current session.
	}
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
export const useLlmConfigurationsStore = create<ConfigurationsState>()((set, get) => ({
	configurations: loadConfigurations(),
	saveConfiguration: (name, config) => {
		const id = makeConfigurationId();
		const entry: SavedConfiguration = { id, name, config: cloneLlmConfiguration(config) };
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
}));

// The persisted session must carry a runnable config, so unlike the loose
// configuration guard we assert the fields the playground actually reads back
// (provider/model plus the two array slots `cloneLlmConfiguration` maps over).
// A partial/corrupt blob fails the parse and falls back to the live seed.
const playgroundSessionSchema = z.object({
	selection: z.string(),
	config: z.looseObject({
		provider: z.string(),
		model: z.string(),
		presets: z.array(z.unknown()),
		customModifiers: z.array(z.unknown()),
	}),
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
		// `config` widens from the validated object back to `LlmConfiguration` —
		// a boundary cast (validated input → richer domain type).
		return {
			selection: parsed.data.selection,
			config: parsed.data.config as unknown as LlmConfiguration,
		};
	} catch {
		return null;
	}
}

export function savePlaygroundSession(session: PlaygroundSession): void {
	try {
		localStorage.setItem(SESSION_KEY, JSON.stringify(session));
	} catch {
		// Non-fatal — the current open still works, only cross-open memory is lost.
	}
}
