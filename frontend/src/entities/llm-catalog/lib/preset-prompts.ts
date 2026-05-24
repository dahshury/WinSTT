// Canonical definition lives in the process-neutral cross-process contract
// (`shared/lib`) so Electron main (`electron/ipc/llm.ts`) can consume the
// same preset prompts without leaking into the renderer FSD tree. This slice
// re-exports it unchanged to keep the `llm-catalog` public barrel and all
// renderer consumers stable.
export {
	ALL_PRESET_KEYS,
	type BuiltinPresetEntry,
	buildSystemPrompt,
	type CustomModifier,
	type CustomModifierEntry,
	getPresetPrompt,
	hasLevels,
	INDEPENDENT_PRESETS,
	isCustomEntry,
	isToneKey,
	mergePresetsWithCustomModifiers,
	PRESET_LEVELS,
	PRESETS_WITH_LEVELS,
	type PresetEntry,
	type PresetKey,
	type PresetLevel,
	TONE_GROUP,
} from "@/shared/lib/preset-prompts";
