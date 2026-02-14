export const PRESET_PROMPTS = {
	neutral: "Fix grammar and punctuation only. Preserve the original tone and style.",
	formal: "Convert to professional business English with formal tone.",
	friendly: "Make the text warm, conversational, and approachable.",
	technical: "Use precise technical terminology and formal structure.",
	casual: "Make relaxed and conversational with natural contractions.",
	concise: "Remove unnecessary words while keeping all key information.",
} as const;

export type PresetKey = keyof typeof PRESET_PROMPTS;
