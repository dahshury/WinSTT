import type { PresetEntry } from "../../../src/shared/lib/preset-prompts";

// User-prompt assembly for the modifier benchmark. Mirrors the shape the
// runtime composes (`active_modifier_user_prompt` in
// src-tauri/src/winstt/llm/prompts.rs): a base cleanup instruction plus a
// summary of each active operation. Everything here is general — no phrase is
// lifted from the corpus inputs.

export const BASE_USER_CLEANUP =
	'First apply base cleanup: fix punctuation, capitalization, grammar, spelling, spacing, and sentence boundaries; split run-on speech into natural sentences and keep dictated questions as questions; convert spoken numbers, dates, times, currency, percentages, units, versions, and equations to figures and symbols (for example, "one" -> "1", "twenty five dollars" -> "$25", "one percent" -> "1%", "one plus one equals two" -> "1 + 1 = 2"); preserve compact product/model/API/release version labels, keeping v plus a number joined and normalizing model/release "version N" to vN when clearly part of a name; convert spoken flags and separators inside code, command lines, URLs, file paths, email addresses, identifiers, and sensitive values to literal characters while preserving the spoken flag form (for example, "dash dash save" -> "--save", "dash m" -> "-m", and "c colon backslash temp backslash logs" -> "C:\\\\temp\\\\logs" in the final text for a backslash-based path) without masking the value; if the whole dictation is a bare email, URL, file path, command, code token, identifier, or field value, return only that literal after separator conversion without prose casing or terminal punctuation; never canonicalize, alias, or expand short CLI flags into long aliases (for example, "git commit dash m" must stay "git commit -m", not "git commit --message"); quote literal labels, values, error messages, and quote/unquote text, keeping punctuation outside quoted literals unless it was part of the literal; remove fillers, repeats, false starts, and adjacent restatements where a later clause replaces earlier words; later means the second or last adjacent alternative, never the first; when the same action, field, sentence frame, or predicate repeats back-to-back with a different subject, object, or value, keep only the later one unless additive wording clearly asks for both; abstract pattern: old value plus repeated frame followed immediately by new value plus same repeated frame means keep only the new-value frame; if both adjacent alternatives remain in the output, fix it before returning; the earlier replaced value is not a separate idea to preserve, even when it is a name, role, team, product, or other durable term; preserve the speaker\'s meaning and every idea.';

export function operationSummary(entry: PresetEntry): string | null {
	if ("id" in entry) {
		const label = entry.name.trim() || "custom modifier";
		return `apply the custom modifier "${label}" while preserving durable names, literal values, and identifiers`;
	}
	switch (entry.key) {
		case "neutral":
			return null;
		case "formal":
			return "rewrite in a polished, formal, professional tone";
		case "friendly":
			return "visibly rewrite in a warmer, friendly, conversational tone";
		case "technical":
			return "rewrite with precise technical terminology and rigorous structure while preserving product/model names, compact version labels, code identifiers, and literal values";
		case "concise":
			return "make the text concise while preserving every important idea";
		case "summarize":
			return "shorten lightly while preserving the key points, durable names, literal values, and point of view";
		case "reorder":
			return "reorder for logical flow only when it improves the sequence while keeping all content";
		case "restructure":
			return "actively structure announced counts, ordered steps, parallel items, inventories, and label-value mappings into numbered or `* ` bullet lists with the lead-in kept as prose, ending each list where the speech moves to a new topic, and keeping everything else prose";
		case "rewordForClarity":
			return "visibly rewrite unclear or awkward phrasing into clearer natural language while preserving meaning, point of view, names, literal values, and trailing fragments";
		case "translate": {
			const target = entry.targetLang?.trim() || "English";
			return `translate the final result into ${target} while preserving people names, organization names, product names, project names, app names, code, command lines, URLs, file paths, email addresses, identifiers, and quoted UI labels exactly unless the quoted text is ordinary prose being translated; button, menu, mode, value, and error labels introduced by phrases like "button says" or "labeled" must still be in quote marks after translation`;
		}
	}
}

export function buildUserPromptForPresets(
	before: string,
	presets: readonly PresetEntry[],
): string {
	const operations = presets
		.map(operationSummary)
		.filter((value): value is string => value !== null);
	if (operations.length === 0) {
		return [
			BASE_USER_CLEANUP,
			"Before returning, check that adjacent self-correction alternatives keep only the later restatement.",
			"Transform the following text according to the style guide above. Return ONLY the transformed text with no commentary, explanations, labels, or JSON formatting.",
			"",
			`Text to transform:\n${before}`,
		].join("\n");
	}
	const opLabel =
		operations.length === 1 ? "Active operation" : "Active operations";
	return [
		BASE_USER_CLEANUP,
		`${opLabel} to apply exactly: ${operations.join("; ")}.`,
		"Apply the active operation visibly unless the input is empty or pure noise. Before returning, do a final check: durable names, literal quoted text, code, command lines, URLs, file paths, email addresses, identifiers, and the speaker's meaning are preserved, except earlier adjacent self-correction alternatives that were replaced by a later restatement; run-on sentences are split; no markdown emphasis or highlighting is added unless explicitly dictated.",
		"Transform the following text according to the style guide above and these active operations. Return ONLY the transformed text with no commentary, explanations, labels, or JSON formatting.",
		"",
		`Text to transform:\n${before}`,
	].join("\n");
}
