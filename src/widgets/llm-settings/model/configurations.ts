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
import {
	createTransientNotificationStore,
	type TransientNotificationMeta,
} from "@/shared/lib/create-transient-notification-store";
import { generateId } from "@/shared/lib/generate-id";
import {
	isStringArray,
	readPersistedSelectorState,
	writePersistedSelectorState,
} from "@/shared/lib/persisted-selector-state";
import type { PresetCarrier } from "../lib/llm-settings-panel-test-helpers";

/** Which saved-configuration mutation failed to reach localStorage. Drives the
 *  toast so a "saved"/"deleted" that never actually persisted is observable
 *  instead of a silent lie. */
export type ConfigurationPersistenceAction =
	| "save"
	| "update"
	| "delete"
	| "reorder";

export interface ConfigurationPersistenceError
	extends TransientNotificationMeta {
	action: ConfigurationPersistenceAction;
}

/**
 * Single-slot notice raised when persisting the saved-configuration list to
 * localStorage fails (quota, disabled storage, serialization). The list still
 * works in-memory for the session, but the write did NOT land — surfaced via a
 * toast so the user isn't told a config was saved when it wasn't.
 */
export const useConfigurationPersistenceErrorStore =
	createTransientNotificationStore<ConfigurationPersistenceError>();

function reportPersistenceFailure(
	action: ConfigurationPersistenceAction,
): void {
	useConfigurationPersistenceErrorStore.getState().show({ action });
}

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
	/** Persisted-shape version, stamped on save for future migrations. Optional
	 *  because entries written before versioning existed omit it. */
	version?: number;
}

export type ConfigurationDropPlacement = "before" | "after";

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
// Ids of the built-in configurations already seeded into a user's list. Tracked
// separately from the list itself so a built-in is seeded exactly ONCE: deleting
// it keeps it gone (the id stays recorded here), while a brand-new built-in
// shipped in a later app update — whose id is absent here — still gets seeded.
const SEEDED_BUILTINS_KEY = "winstt:llm-configurations-seeded-builtins";

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

// Presets/modifiers are matched as SETS, not sequences: toggling a modifier off
// then on reorders the stored array but is a no-net-change, so the signature is
// sorted by a stable key (preset key / modifier id) before stringify. Otherwise
// that reorder would falsely read as "modified". Sorting is signature-only; the
// stored arrays keep their display order.
function normalizeCarrier(carrier: PresetCarrier) {
	return {
		presets: carrier.presets
			.map((p) => ({
				key: p.key,
				level: p.level ?? null,
				targetLang: p.targetLang ?? null,
			}))
			.sort((a, b) => a.key.localeCompare(b.key)),
		customModifiers: carrier.customModifiers
			.map((m) => ({
				id: m.id,
				name: m.name,
				prompt: m.prompt,
				enabled: m.enabled,
				levelsEnabled: m.levelsEnabled,
				level: m.level ?? null,
			}))
			.sort((a, b) => a.id.localeCompare(b.id)),
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

function normalizeConfiguration(config: LlmConfiguration) {
	return {
		...normalizeCarrier(config),
		maxOutputTokens: config.maxOutputTokens,
		model: config.model,
		openrouterFallbackModel: config.openrouterFallbackModel,
		openrouterModel: config.openrouterModel,
		provider: config.provider,
		reasoningEffort: config.reasoningEffort,
		thinkingEffort: config.thinkingEffort,
		verbosity: config.verbosity,
	};
}

function configurationSignature(config: LlmConfiguration): string {
	return JSON.stringify(normalizeConfiguration(config));
}

/** Full post-processing profile match. Unlike `matchConfigurationId`, this
 * compares provider/model and request-tuning fields too. `enabled` is excluded:
 * the profile picker/hotkey swaps profile content, while the visible toggle
 * remains the single on/off control. */
export function matchFullConfigurationId(
	config: LlmConfiguration,
	configs: readonly SavedConfiguration[],
): string {
	const sig = configurationSignature(config);
	return (
		configs.find((c) => configurationSignature(c.config) === sig)?.id ?? ""
	);
}

export function matchPostProcessingProfileId(
	config: LlmConfiguration,
	configs: readonly SavedConfiguration[],
): string {
	return (
		matchFullConfigurationId(config, configs) ||
		matchConfigurationId(config, configs)
	);
}

/** True when two configurations are equivalent for post-processing (same
 *  provider/model, tone, modifiers and request-tuning). `enabled` is excluded —
 *  the visible toggle owns on/off, not profile content. Drives the "modified"
 *  (dirty) state that reveals the save/reset actions on the active preset. */
export function configurationsEqual(
	a: LlmConfiguration,
	b: LlmConfiguration,
): boolean {
	return configurationSignature(a) === configurationSignature(b);
}

/** Coerce a config's provider back to local when it targets a cloud provider
 *  whose API key is absent. A saved preset can point at OpenRouter (e.g. it was
 *  created while a key was installed, since removed); applying it verbatim would
 *  strand the feature on an unusable provider with no key-entry affordance at the
 *  call site. Only the provider is swapped to `ollama` — tone/modifiers and the
 *  stored model fields are kept, so re-adding the key and re-applying restores the
 *  cloud target. Ollama and Apple Intelligence are local and always available. */
export function withAvailableLlmProvider(
	config: LlmConfiguration,
	openrouterApiKey: string,
): LlmConfiguration {
	if (config.provider === "openrouter" && openrouterApiKey.trim() === "") {
		return { ...config, provider: "ollama" };
	}
	return config;
}

export function postProcessingPatchFromConfiguration(
	config: LlmConfiguration,
): Partial<LlmConfiguration> {
	const clone = cloneLlmConfiguration(config);
	const { enabled: _enabled, ...patch } = clone;
	return patch;
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

// Bumped when the persisted shape changes in a way future loads must migrate.
// Stamped onto every entry on save so an older build can recognise (and a newer
// build can migrate) what it's reading instead of guessing.
const SAVED_CONFIGURATION_VERSION = 1;

// Validate and default the persisted shape at the localStorage boundary. Extra
// fields are ignored by zod and missing convenience fields receive the same
// defaults as a fresh LLM feature draft.
const savedConfigurationSchema = z.object({
	id: z.string(),
	name: z.string(),
	config: llmConfigurationSchema,
	// Optional so pre-versioning entries still parse; defaulted on the way in.
	version: z.number().int().optional().default(SAVED_CONFIGURATION_VERSION),
});

/** Result of parsing the persisted list. `repaired` is set when the raw value
 *  was unreadable or any entry had to be salvaged/dropped, so the caller
 *  rewrites storage to heal it (see `loadConfigurations`). */
interface ParsedConfigurations {
	configs: SavedConfiguration[];
	repaired: boolean;
}

/** Best-effort repair of one persisted entry that failed the strict parse:
 *  drop preset entries whose key is no longer known (schema evolution / a
 *  removed preset) and drop custom modifiers that can't be coerced, rather than
 *  discarding the whole named configuration over a single bad field. Returns
 *  null only when even the id/name shell is unusable. */
function salvageSavedConfiguration(entry: unknown): SavedConfiguration | null {
	if (typeof entry !== "object" || entry === null) {
		return null;
	}
	const record = { ...(entry as Record<string, unknown>) };
	const configValue = record["config"];
	const rawConfig: Record<string, unknown> =
		typeof configValue === "object" && configValue !== null
			? { ...(configValue as Record<string, unknown>) }
			: {};
	const rawPresets = rawConfig["presets"];
	if (Array.isArray(rawPresets)) {
		const presets = rawPresets.filter(
			(p) => builtinPresetEntrySchema.safeParse(p).success,
		);
		// A stack that lost its tone / every preset falls back to the neutral
		// default so the entry still renders instead of a tone-less config.
		rawConfig["presets"] = presets.length > 0 ? presets : [{ key: "neutral" }];
	}
	const rawModifiers = rawConfig["customModifiers"];
	if (Array.isArray(rawModifiers)) {
		rawConfig["customModifiers"] = rawModifiers.filter(
			(m) => customModifierSchema.safeParse(m).success,
		);
	}
	const result = savedConfigurationSchema.safeParse({
		...record,
		config: rawConfig,
	});
	return result.success ? result.data : null;
}

function parseConfigArray(value: unknown): ParsedConfigurations {
	if (!Array.isArray(value)) {
		// A non-array root (object, string, …) is unusable but recoverable — signal
		// a repair so the caller rewrites clean, seeded storage.
		return { configs: [], repaired: value != null };
	}
	const configs: SavedConfiguration[] = [];
	let repaired = false;
	for (const entry of value) {
		const strict = savedConfigurationSchema.safeParse(entry);
		if (strict.success) {
			configs.push(strict.data);
			continue;
		}
		const salvaged = salvageSavedConfiguration(entry);
		repaired = true;
		if (salvaged) {
			configs.push(salvaged);
			console.warn(
				"[llm-configurations] repaired a saved configuration entry with invalid fields",
			);
		} else {
			console.warn(
				"[llm-configurations] dropped an unrecoverable saved configuration entry",
			);
		}
	}
	return { configs, repaired };
}

function parseSavedConfigurations(raw: string | null): ParsedConfigurations {
	if (!raw) {
		return { configs: [], repaired: false };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// A single corrupt character used to throw here on EVERY launch (the outer
		// loadConfigurations catch swallowed it and returned []), permanently
		// blanking the list — built-ins included. Guard locally and flag a repair
		// so the bad key is rewritten and built-ins re-seed.
		console.warn(
			"[llm-configurations] dropping unparseable saved-configuration blob",
		);
		return { configs: [], repaired: true };
	}
	return parseConfigArray(parsed);
}

export function mergeSavedConfigurations(
	primary: readonly SavedConfiguration[],
	legacy: readonly SavedConfiguration[],
): SavedConfiguration[] {
	const seen = new Set<string>();
	const merged: SavedConfiguration[] = [];
	for (const config of [...primary, ...legacy]) {
		if (seen.has(config.id)) {
			continue;
		}
		seen.add(config.id);
		merged.push(config);
	}
	return merged;
}

export function reorderSavedConfigurations(
	configs: readonly SavedConfiguration[],
	id: string,
	targetId: string,
	placement: ConfigurationDropPlacement,
): SavedConfiguration[] {
	if (id === targetId) {
		return [...configs];
	}
	const source = configs.find((config) => config.id === id);
	if (!(source && configs.some((config) => config.id === targetId))) {
		return [...configs];
	}
	const withoutSource = configs.filter((config) => config.id !== id);
	const targetIndex = withoutSource.findIndex(
		(config) => config.id === targetId,
	);
	if (targetIndex < 0) {
		return [...configs];
	}
	const insertIndex = placement === "after" ? targetIndex + 1 : targetIndex;
	return [
		...withoutSource.slice(0, insertIndex),
		source,
		...withoutSource.slice(insertIndex),
	];
}

// ── Shipped (built-in) configurations ─────────────────────────────────
// Curated presets that ship with the app and appear pre-configured on first
// load, so common dictation targets are usable without the user assembling a
// tone + modifier stack by hand. Each has a stable `builtin:` id (seeded once —
// see `SEEDED_BUILTINS_KEY`) and, like any saved configuration, can be applied,
// edited, renamed, or deleted afterwards.

/** A shipped configuration distinguished only by its tone + modifier stack.
 *  Provider/model are left at the neutral defaults on purpose: applying a
 *  configuration from the tone row never touches that half, and a shipped preset
 *  must not assume a model the user hasn't installed. Modifier entries follow the
 *  canonical `INDEPENDENT_PRESETS` order (summarize, concise, reorder,
 *  restructure, rewordForClarity, translate) after the leading tone. */
function builtinConfiguration(
	id: string,
	name: string,
	presets: BuiltinPresetEntry[],
): SavedConfiguration {
	return {
		id,
		name,
		config: {
			enabled: false,
			maxOutputTokens: null,
			model: "",
			openrouterFallbackModel: "",
			openrouterModel: "",
			provider: "ollama",
			reasoningEffort: "medium",
			thinkingEffort: "off",
			verbosity: "medium",
			presets,
			customModifiers: [],
		},
	};
}

/** Configurations shipped with the app, offered in every Configuration combobox
 *  once seeded. Append future presets here — each new id is seeded on the next
 *  load without disturbing configs the user already reordered or deleted. */
export const BUILTIN_CONFIGURATIONS: readonly SavedConfiguration[] = [
	// Dictating a prompt to an AI assistant: the Polish base cleans the speech,
	// then Concise (high) + Reorder + Restructure + Reword for Clarity turn a
	// rambling spoken request into a tight, well-ordered, unambiguous prompt.
	builtinConfiguration("builtin:ai-prompt", "AI Prompt", [
		{ key: "neutral" },
		{ key: "concise", level: "high" },
		{ key: "reorder" },
		{ key: "restructure" },
		{ key: "rewordForClarity" },
	]),
	// Chatting with a person: a warm, conversational Friendly tone, trimmed of
	// filler and reworded to read naturally as a short message. No lists or
	// summarizing — a casual chat is neither bulleted nor content-dropped.
	builtinConfiguration("builtin:casual-chat", "Casual Chat", [
		{ key: "friendly" },
		{ key: "concise", level: "medium" },
		{ key: "rewordForClarity" },
	]),
	// A formal email: professional Formal wording, led by its purpose (Reorder),
	// action items broken into lists (Restructure), clean phrasing (Reword), and
	// filler trimmed (Concise). No summarize — an email must not drop content.
	builtinConfiguration("builtin:formal-email", "Formal Email", [
		{ key: "formal" },
		{ key: "concise", level: "medium" },
		{ key: "reorder" },
		{ key: "restructure" },
		{ key: "rewordForClarity" },
	]),
	// Note taking: condense the dictation to its key points (Summarize), group
	// them logically (Reorder), and shape them into bullet/numbered structure
	// (Restructure) — the essence of notes. Plain Polish tone, no restyling.
	builtinConfiguration("builtin:note-taking", "Note Taking", [
		{ key: "neutral" },
		{ key: "summarize", level: "medium" },
		{ key: "reorder" },
		{ key: "restructure" },
	]),
];

/** Legacy separate seeded-ids key, read once for migration into the unified
 *  combined blob (see `persistCombined`). */
function loadLegacySeededBuiltinIds(): string[] {
	return readPersistedSelectorState(SEEDED_BUILTINS_KEY, isStringArray, []);
}

/** Append built-in configurations that have never been seeded into the loaded
 *  list. A built-in already recorded in `seededIds` is skipped even when it is no
 *  longer present (the user deleted it), so shipped presets are added exactly once
 *  and stay gone once removed. New built-ins are appended after the user's own
 *  entries to preserve their ordering. Pure — the caller persists the results. */
export function seedBuiltinConfigurations(
	loaded: readonly SavedConfiguration[],
	seededIds: ReadonlySet<string>,
	builtins: readonly SavedConfiguration[] = BUILTIN_CONFIGURATIONS,
): {
	changed: boolean;
	configurations: SavedConfiguration[];
	seededIds: string[];
} {
	const existingIds = new Set(loaded.map((c) => c.id));
	const nextSeeded = new Set(seededIds);
	const additions: SavedConfiguration[] = [];
	for (const builtin of builtins) {
		if (nextSeeded.has(builtin.id)) {
			continue;
		}
		nextSeeded.add(builtin.id);
		if (!existingIds.has(builtin.id)) {
			additions.push({
				...builtin,
				config: cloneLlmConfiguration(builtin.config),
			});
		}
	}
	return {
		changed: additions.length > 0 || nextSeeded.size !== seededIds.size,
		configurations:
			additions.length > 0 ? [...loaded, ...additions] : [...loaded],
		seededIds: [...nextSeeded],
	};
}

/** The store's persisted seed: the resolved list plus the seeded-built-in
 *  bookkeeping that travels with it in ONE key. */
interface ConfigurationsSeed {
	configurations: SavedConfiguration[];
	seededBuiltinIds: string[];
}

/** Parse the primary key, tolerating BOTH the current combined
 *  `{ configurations, seededBuiltinIds }` object and the legacy top-level array
 *  (whose seeded ids lived in a separate key — `seededBuiltinIds: null` signals
 *  that migration). */
function parseStoredPrimary(raw: string | null): {
	configs: SavedConfiguration[];
	seededBuiltinIds: string[] | null;
	repaired: boolean;
} {
	if (!raw) {
		return { configs: [], seededBuiltinIds: null, repaired: false };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		console.warn(
			"[llm-configurations] dropping unparseable saved-configuration blob",
		);
		return { configs: [], seededBuiltinIds: null, repaired: true };
	}
	if (Array.isArray(parsed)) {
		const { configs, repaired } = parseConfigArray(parsed);
		return { configs, seededBuiltinIds: null, repaired };
	}
	if (parsed && typeof parsed === "object") {
		const record = parsed as Record<string, unknown>;
		const { configs, repaired } = parseConfigArray(record["configurations"]);
		const rawSeeded = record["seededBuiltinIds"];
		const seededBuiltinIds = isStringArray(rawSeeded) ? rawSeeded : [];
		return { configs, seededBuiltinIds, repaired };
	}
	return { configs: [], seededBuiltinIds: null, repaired: true };
}

/** Load saved configurations from localStorage. Returns an empty seed on any
 *  read/parse error — configurations are a non-critical convenience, never
 *  block the UI. Merges the legacy playground-presets key so older presets
 *  remain visible, then seeds any not-yet-seeded built-in configuration. When
 *  the stored value was corrupt/repaired or still in a legacy shape, the healed,
 *  unified blob is written straight back. */
function loadConfigurations(): ConfigurationsSeed {
	try {
		const primary = parseStoredPrimary(localStorage.getItem(STORAGE_KEY));
		const legacy = parseSavedConfigurations(
			localStorage.getItem(LEGACY_STORAGE_KEY),
		);
		const merged = mergeSavedConfigurations(primary.configs, legacy.configs);
		// Seeded ids come from the combined blob when present, else the legacy
		// separate key (one-time migration into the single-source combined key).
		const priorSeeded =
			primary.seededBuiltinIds ?? loadLegacySeededBuiltinIds();
		const seeded = seedBuiltinConfigurations(merged, new Set(priorSeeded));
		const legacyMigrated =
			legacy.configs.length > 0 && merged.length > primary.configs.length;
		// `seededBuiltinIds === null` ⇒ the primary key was still a legacy array,
		// so we rewrite it in the unified shape even if nothing else changed.
		const needsUnify = primary.seededBuiltinIds === null && merged.length > 0;
		if (
			seeded.changed ||
			legacyMigrated ||
			primary.repaired ||
			legacy.repaired ||
			needsUnify
		) {
			persistCombined(seeded.configurations, seeded.seededIds);
		}
		return {
			configurations: seeded.configurations,
			seededBuiltinIds: seeded.seededIds,
		};
	} catch {
		// localStorage unavailable / quota / parse failure — start empty.
		return { configurations: [], seededBuiltinIds: [] };
	}
}

/** Persist the list and its seeded-built-in bookkeeping together in ONE key so
 *  they can never desync: a lost/rewritten seeded set can't resurrect a deleted
 *  built-in, and clearing the list clears the bookkeeping with it (letting a
 *  genuinely empty store re-seed the built-ins). Returns whether the write
 *  landed so callers can surface a failure instead of a silent no-op. */
function persistCombined(
	configurations: readonly SavedConfiguration[],
	seededBuiltinIds: readonly string[],
): boolean {
	return writePersistedSelectorState(STORAGE_KEY, {
		version: SAVED_CONFIGURATION_VERSION,
		configurations,
		seededBuiltinIds,
	});
}

interface ConfigurationsState {
	activeConfigurationId: string | null;
	configurations: SavedConfiguration[];
	moveConfiguration: (
		id: string,
		targetId: string,
		placement: ConfigurationDropPlacement,
	) => void;
	removeConfiguration: (id: string) => void;
	/** Save `config` under `name` and return the new id. */
	saveConfiguration: (name: string, config: LlmConfiguration) => string;
	// Seeded-built-in bookkeeping, carried in state so every mutation persists it
	// atomically alongside the list (single source of truth — see persistCombined).
	seededBuiltinIds: string[];
	setActiveConfiguration: (id: string | null) => void;
	/** Overwrite an existing saved config's content in place (id + name kept) and
	 *  make it active — the "save changes to this preset" path. */
	updateConfiguration: (id: string, config: LlmConfiguration) => void;
}

const initialConfigurationsSeed = loadConfigurations();

/**
 * Single source of truth for saved configurations, shared live across every
 * Configuration combobox (both per-feature tone rows AND the Playground). The
 * list is seeded once from localStorage at store creation and every mutation
 * writes straight back through, so a config saved in one combobox appears in the
 * others immediately. Writes that fail to persist raise a toast via
 * `useConfigurationPersistenceErrorStore` and leave the config un-activated, so
 * the UI never claims a save that never landed.
 */
export const useLlmConfigurationsStore = create<ConfigurationsState>()(
	(set, get) => ({
		activeConfigurationId: null,
		configurations: initialConfigurationsSeed.configurations,
		seededBuiltinIds: initialConfigurationsSeed.seededBuiltinIds,
		saveConfiguration: (name, config) => {
			const id = generateId();
			const entry: SavedConfiguration = {
				id,
				name,
				config: cloneLlmConfiguration(config),
				version: SAVED_CONFIGURATION_VERSION,
			};
			const next = [...get().configurations, entry];
			const ok = persistCombined(next, get().seededBuiltinIds);
			// The entry stays in the in-memory list (usable this session), but it is
			// only marked active/selected when the write actually landed — otherwise
			// the UI would present a "saved & active" preset that vanishes on restart.
			set({
				configurations: next,
				...(ok ? { activeConfigurationId: id } : {}),
			});
			if (!ok) {
				reportPersistenceFailure("save");
			}
			return id;
		},
		setActiveConfiguration: (id) => set({ activeConfigurationId: id }),
		moveConfiguration: (id, targetId, placement) => {
			const next = reorderSavedConfigurations(
				get().configurations,
				id,
				targetId,
				placement,
			);
			const ok = persistCombined(next, get().seededBuiltinIds);
			set({ configurations: next });
			if (!ok) {
				reportPersistenceFailure("reorder");
			}
		},
		removeConfiguration: (id) => {
			const next = get().configurations.filter((c) => c.id !== id);
			const ok = persistCombined(next, get().seededBuiltinIds);
			set({
				configurations: next,
				activeConfigurationId:
					get().activeConfigurationId === id
						? null
						: get().activeConfigurationId,
			});
			if (!ok) {
				reportPersistenceFailure("delete");
			}
		},
		updateConfiguration: (id, config) => {
			const next = get().configurations.map((c) =>
				c.id === id
					? {
							...c,
							config: cloneLlmConfiguration(config),
							version: SAVED_CONFIGURATION_VERSION,
						}
					: c,
			);
			const ok = persistCombined(next, get().seededBuiltinIds);
			set({
				configurations: next,
				...(ok ? { activeConfigurationId: id } : {}),
			});
			if (!ok) {
				reportPersistenceFailure("update");
			}
		},
	}),
);

// Cross-window live sync: the saved-configuration list is shared by every
// WinSTT window (same origin ⇒ same localStorage). When another window
// saves/edits/deletes/reorders, mirror the freshly-written value here so open
// comboboxes reflect it live — the same storage-event hand-off the Settings
// deep-link uses. The event fires only in OTHER windows, and the handler never
// re-persists, so there's no write loop.
if (typeof window !== "undefined") {
	window.addEventListener("storage", (event) => {
		if (event.key !== STORAGE_KEY || event.newValue == null) {
			return;
		}
		const primary = parseStoredPrimary(event.newValue);
		useLlmConfigurationsStore.setState({
			configurations: primary.configs,
			seededBuiltinIds:
				primary.seededBuiltinIds ??
				useLlmConfigurationsStore.getState().seededBuiltinIds,
		});
	});
}

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
