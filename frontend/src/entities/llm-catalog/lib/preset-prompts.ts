export type PresetKey =
	| "neutral"
	| "formal"
	| "friendly"
	| "technical"
	| "casual"
	| "concise"
	| "summarize"
	| "reorder"
	| "restructure"
	| "rewordForClarity";

export type PresetLevel = "light" | "medium" | "high";

export interface PresetEntry {
	key: PresetKey;
	level?: PresetLevel;
}

const NEUTRAL_PROMPT =
	"Fix grammar, punctuation, and spelling only. Do not reword. Preserve tone, style, and structure.";

const LEVELED_PROMPTS = {
	concise: {
		light: "Tighten wording. Cut filler and redundancy. Preserve every idea, structure, and tone.",
		medium: "Compress wording. Cut filler, hedging, and repetition. Preserve every idea and tone.",
		high: "Minimize word count. Strip every non-load-bearing word. Preserve every idea and tone.",
	},
	summarize: {
		light:
			"Shorten by cutting low-priority details. Preserve core meaning, key points, structure, and tone.",
		medium:
			"Shorten substantially. Drop non-essential details, examples, and asides. Preserve every key point and the tone.",
		high: "Compress to core meaning only. Keep the central message and critical points; cut all supporting detail.",
	},
} as const satisfies Record<"concise" | "summarize", Record<PresetLevel, string>>;

const DEFAULT_LEVEL: PresetLevel = "medium";

const PROMPT_RESOLVERS: Record<PresetKey, (level?: PresetLevel) => string> = {
	neutral: () => NEUTRAL_PROMPT,
	formal: () =>
		"Rewrite in professional business English. Remove contractions, slang, and casual phrasing. Preserve meaning and structure.",
	friendly: () =>
		"Rewrite in a warm, conversational tone with approachable wording. Preserve meaning and ideas.",
	technical: () =>
		"Rewrite with precise technical terminology and rigorous structure. Replace vague terms with exact ones. Preserve meaning.",
	casual: () =>
		"Rewrite in a relaxed, conversational register with natural contractions and casual phrasing. Preserve meaning.",
	concise: (level) => LEVELED_PROMPTS.concise[level ?? DEFAULT_LEVEL],
	summarize: (level) => LEVELED_PROMPTS.summarize[level ?? DEFAULT_LEVEL],
	reorder: () =>
		"Reorder sentences for logical flow without rewording them. Lead with the most important point; group related ideas.",
	restructure: () =>
		"Reorganize the text into a clearer shape: group by topic, split long sentences, add transitions. Preserve meaning.",
	rewordForClarity: () =>
		"Rewrite confusing or awkward phrasing into clearer language. Preserve meaning and tone; change wording only where it aids comprehension.",
};

export const TONE_GROUP = [
	"neutral",
	"formal",
	"friendly",
	"technical",
	"casual",
] as const satisfies readonly PresetKey[];

export const INDEPENDENT_PRESETS = [
	"summarize",
	"concise",
	"reorder",
	"restructure",
	"rewordForClarity",
] as const satisfies readonly PresetKey[];

export const PRESETS_WITH_LEVELS = ["summarize", "concise"] as const satisfies readonly PresetKey[];

export const ALL_PRESET_KEYS = [
	...TONE_GROUP,
	...INDEPENDENT_PRESETS,
] as const satisfies readonly PresetKey[];

export const PRESET_LEVELS = ["light", "medium", "high"] as const satisfies readonly PresetLevel[];

export function isToneKey(key: PresetKey): boolean {
	return (TONE_GROUP as readonly PresetKey[]).includes(key);
}

export function hasLevels(key: PresetKey): boolean {
	return (PRESETS_WITH_LEVELS as readonly PresetKey[]).includes(key);
}

export function getPresetPrompt(key: PresetKey, level?: PresetLevel): string {
	return PROMPT_RESOLVERS[key](level);
}

export function buildSystemPrompt(presets: readonly PresetEntry[]): string {
	if (presets.length === 0) {
		return NEUTRAL_PROMPT;
	}
	if (presets.length === 1) {
		const only = presets[0] as PresetEntry;
		return getPresetPrompt(only.key, only.level);
	}
	const numbered = presets.map((p, i) => `${i + 1}. ${getPresetPrompt(p.key, p.level)}`).join("\n");
	return `Apply the following transformations to the user's text, in order:\n${numbered}`;
}
