import { extractJsonObject } from "./clients";

// LLM-as-judge layer. Scores the non-deterministic axes a metric can't see —
// did the output actually achieve the requested tone/register, is the meaning
// intact, is the amount of change appropriate. Rationale-before-scores (CoT)
// improves judge reliability; output is grammar-constrained JSON.

/** What "good" looks like per modifier profile, injected into the rubric. */
const MODIFIER_TARGET: Record<string, string> = {
	neutral:
		"Neutral cleanup only: fix punctuation, capitalization, grammar, spelling and sentence boundaries. The tone, wording, and structure should stay essentially the same — this is NOT a rewrite. Penalize any tonal shift or paraphrasing.",
	formal:
		"Formal register: polished, professional business English; contractions and slang removed; measured phrasing. It must NOT invent an email wrapper, greeting, or sign-off (no 'Dear', 'Regards', 'Sincerely').",
	friendly:
		"Friendly register: visibly warmer, more conversational and approachable, natural contractions allowed. It should read noticeably warmer than the input while keeping every fact.",
	technical:
		"Technical register: precise terminology, rigorous and unambiguous phrasing, while preserving product/model names, compact version labels (e.g. v3), code identifiers, and literal values exactly.",
	concise:
		"Concise: tighten wording and remove redundancy so it is meaningfully shorter, WITHOUT dropping any important idea, name, or value.",
	summarize:
		"Summarize: compress to the key points and preserve the point of view, durable names and literal values. Losing minor detail is expected; losing a key point is a failure.",
	reorder:
		"Reorder: improve the logical sequence only where it helps; keep ALL content and add nothing. Wording should stay close to the original.",
	restructure:
		"Restructure: turn announced counts, ordered steps, parallel items, inventories, and label→value mappings into numbered or bulleted lists with REAL line breaks and the lead-in kept as prose; everything else stays prose. Nothing may be dropped.",
	rewordForClarity:
		"Reword for clarity: rewrite awkward or unclear phrasing into clearer natural language, fixing obvious wrong-word slips, while preserving meaning, point of view, names, and literal values.",
	translate:
		"Translate: render the cleaned result fully in the target language (Spanish). People/organization/product/project names, code, command lines, URLs, file paths, email addresses, and identifiers stay in their original form; quoted UI labels stay quoted. Leaving text in the source language is a failure.",
	"friendly-concise":
		"Two goals together: a visibly warmer, friendlier tone AND tighter, less redundant wording — without dropping any important idea, name, or value.",
	"default-stack":
		"Clean up the transcript, structure announced counts/steps/parallel items/inventories into lists with real line breaks, and reword awkward phrasing for clarity — all while preserving every idea, name, and literal value.",
};

export function modifierTarget(modifierId: string): string {
	return (
		MODIFIER_TARGET[modifierId] ??
		"Apply the requested transformation while preserving the speaker's meaning, names, and literal values."
	);
}

export const JUDGE_SCHEMA = {
	type: "object",
	properties: {
		analysis: { type: "string" },
		style_match: { type: "integer", minimum: 0, maximum: 100 },
		meaning_preservation: { type: "integer", minimum: 0, maximum: 100 },
		fidelity: { type: "integer", minimum: 0, maximum: 100 },
		fluency: { type: "integer", minimum: 0, maximum: 100 },
		degree: { type: "integer", minimum: 0, maximum: 100 },
	},
	required: [
		"analysis",
		"style_match",
		"meaning_preservation",
		"fidelity",
		"fluency",
		"degree",
	],
	additionalProperties: false,
} as const;

export const JUDGE_SYSTEM =
	"You are a strict, calibrated evaluation judge for a speech-to-text post-processing feature. " +
	"You are given a raw dictated TRANSCRIPT, the TRANSFORMATION that was requested, and a CANDIDATE rewrite produced by another model. " +
	"Grade the candidate ONLY on how well it fulfills the requested transformation. Be critical: reserve scores above 85 for genuinely excellent output, use the middle of the range for partial success, and score near 0 when a criterion is clearly failed. " +
	"Reward faithful transformation; penalize hallucinated content, dropped ideas, over-transformation (doing far more than asked), and under-transformation (barely changing the text when a change was requested). " +
	"Score each criterion 0-100:\n" +
	"- style_match: how fully the output achieves the requested transformation's intent.\n" +
	"- meaning_preservation: every idea from the transcript is preserved (except detail intentionally dropped by summarize/concise, and earlier halves of self-corrections).\n" +
	"- fidelity: names, quoted labels, code, commands, URLs, paths and literal values are intact and nothing is fabricated.\n" +
	"- fluency: the result is grammatical, natural and clean.\n" +
	"- degree: the amount of change is appropriate — not a near-no-op, not over-done.\n" +
	"First write a one- or two-sentence analysis, then the five integer scores. Respond with a single JSON object only.";

export function buildJudgeUser(opts: {
	modifierId: string;
	before: string;
	after: string;
	reference?: string | undefined;
}): string {
	const parts = [
		`REQUESTED TRANSFORMATION (${opts.modifierId}): ${modifierTarget(opts.modifierId)}`,
		"",
		`TRANSCRIPT (raw input):\n${opts.before}`,
		"",
		`CANDIDATE (output to grade):\n${opts.after}`,
	];
	if (opts.reference) {
		parts.push(
			"",
			`REFERENCE (one acceptable rewrite for calibration — the candidate need not match it word for word; judge the candidate on the criteria, not on similarity to this):\n${opts.reference}`,
		);
	}
	parts.push(
		"",
		"Return the JSON object with your analysis and the five scores.",
	);
	return parts.join("\n");
}

export interface JudgeScores {
	styleMatch: number;
	meaningPreservation: number;
	fidelity: number;
	fluency: number;
	degree: number;
	analysis: string;
}

function clampScore(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return 0;
	return Math.min(100, Math.max(0, Math.round(n)));
}

export function parseJudge(raw: string): JudgeScores | null {
	const obj = extractJsonObject(raw);
	if (!obj) return null;
	const hasAll = [
		"style_match",
		"meaning_preservation",
		"fidelity",
		"fluency",
		"degree",
	].every((k) => k in obj);
	if (!hasAll) return null;
	return {
		styleMatch: clampScore(obj["style_match"]),
		meaningPreservation: clampScore(obj["meaning_preservation"]),
		fidelity: clampScore(obj["fidelity"]),
		fluency: clampScore(obj["fluency"]),
		degree: clampScore(obj["degree"]),
		analysis: typeof obj["analysis"] === "string" ? obj["analysis"] : "",
	};
}
