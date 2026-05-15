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

const NEUTRAL_PROMPT = "Fix grammar and punctuation only. Preserve the original tone and style.";

const LEVELED_PROMPTS = {
	concise: {
		light: "Trim filler words and minor redundancy. Keep the original phrasing and length closely.",
		medium: "Tighten the prose. Cut redundant phrasing, merge repetitive sentences, drop hedging.",
		high: "Compress to the minimum word count. Drop every word that isn't load-bearing while preserving all key information.",
	},
	summarize: {
		light:
			"Summarize aggressively into note form. Keep only the core action or decision and its key reason. Drop pleasantries, rhetorical questions, hedging, and indecision. Sentence fragments and lowercase are acceptable.",
		medium:
			'Summarize while preserving the message\'s structure. Keep greetings, questions, and key points intact. Remove hedging ("I think maybe"), filler, and redundancy. Rewrite into clean, complete short sentences with a natural conversational tone.',
		high: "Summarize into a polished, refined message. Keep all key points and questions, but rewrite freely for clarity and economy. Combine related ideas — e.g., merge an action with its reason — using direct, idiomatic phrasing.",
	},
} as const satisfies Record<"concise" | "summarize", Record<PresetLevel, string>>;

const DEFAULT_LEVEL: PresetLevel = "medium";

const PROMPT_RESOLVERS: Record<PresetKey, (level?: PresetLevel) => string> = {
	neutral: () => NEUTRAL_PROMPT,
	formal: () => "Convert to professional business English with formal tone.",
	friendly: () => "Make the text warm, conversational, and approachable.",
	technical: () => "Use precise technical terminology and formal structure.",
	casual: () => "Make relaxed and conversational with natural contractions.",
	concise: (level) => LEVELED_PROMPTS.concise[level ?? DEFAULT_LEVEL],
	summarize: (level) => LEVELED_PROMPTS.summarize[level ?? DEFAULT_LEVEL],
	reorder: () =>
		"Reorder the sentences for logical flow without rewriting them. Group related ideas; lead with the most important point.",
	restructure: () =>
		"Restructure the text for clear logical flow. Break long sentences, reorganize paragraphs by topic, and add transitions where needed.",
	rewordForClarity: () =>
		"Reword unclear or awkward phrases for clarity. Keep the original meaning and tone; change wording only where it improves comprehension.",
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
