import type { PresetEntry } from "../../../src/shared/lib/preset-prompts";

function custom(
	entry: PresetEntry,
): entry is Extract<PresetEntry, { id: string }> {
	return "id" in entry;
}

export function operationSummary(entry: PresetEntry): string | null {
	if (custom(entry)) {
		const label = entry.name.trim() || "modifier";
		return `apply custom "${label}"`;
	}
	switch (entry.key) {
		case "neutral":
			return null;
		case "formal":
			return "formal professional tone";
		case "friendly":
			return "warm friendly conversational tone";
		case "technical":
			return "exact technical terminology and rigorous structure";
		case "concise":
			return entry.level === "caveman"
				? "FINAL CAVEMAN PASS, highest priority after all other operations: rewrite ordinary prose as terse telegraphic text; remove a/an/the, filler, pleasantries, hedging, repeated meaning, optional conjunctions; prefer fragments and direct commands; target 40–60% fewer prose tokens; if polite framing or normal conversational sentences remain, rewrite again; keep every fact and intent; preserve every technical literal exactly"
				: `concise ${entry.level ?? "medium"}; keep every distinct idea`;
		case "summarize":
			return `summarize ${entry.level === "caveman" ? "high" : (entry.level ?? "medium")}`;
		case "reorder":
			return "reorder only for clearer logical flow; keep all content";
		case "restructure":
			return "number counted/ordered items; bullet parallel items; keep narrative prose";
		case "rewordForClarity":
			return "visibly rewrite awkward wording clearly; keep voice and meaning";
		case "translate":
			return `translate result into ${entry.targetLang?.trim() || "English"}`;
	}
}

export function buildUserPromptForPresets(
	before: string,
	presets: readonly PresetEntry[],
): string {
	const operations = [...presets]
		.sort((left, right) => {
			const finalPass = (entry: PresetEntry) =>
				!custom(entry) && entry.key === "concise" && entry.level === "caveman";
			return Number(finalPass(left)) - Number(finalPass(right));
		})
		.map(operationSummary)
		.filter((value): value is string => value !== null);
	const has = (key: string) =>
		presets.some((entry) => !custom(entry) && entry.key === key);
	const translate = presets.find(
		(entry) => !custom(entry) && entry.key === "translate",
	);
	const reminders = [
		operations.length > 0
			? `ACTIVE: ${operations.join("; ")}. Apply visibly.`
			: null,
		has("restructure")
			? 'Structure mandatory. "There are two choices: first wait, second retry" becomes "There are two choices:\n\n1. Wait.\n2. Retry." Parallel actions use `* ` lines; new topic returns to prose.'
			: null,
		has("technical")
			? 'Technical must be visible: remove casual/vague wording such as "basically".'
			: null,
		has("friendly") && has("concise")
			? "Friendly affects word choice only; Caveman still controls final sentence shape and length."
			: null,
		translate && !custom(translate)
			? `FINAL OUTPUT LANGUAGE: ${translate.targetLang?.trim() || "English"}. Translate all ordinary prose.`
			: null,
		presets.some(
			(entry) =>
				!custom(entry) && entry.key === "concise" && entry.level === "caveman",
		)
			? 'FINAL CAVEMAN PASS NOW: output must look telegraphic, not conversational. Drop a/an/the, polite framing, filler, hedges, repeated meaning, optional conjunctions. Prefer fragments/direct commands. Aim 40–60% fewer prose tokens. If normal full sentences remain, rewrite. Examples: "I would like you to check the logs and restart the service." => "Check logs. Restart service." "The API is failing because the token has expired." => "API fails: token expired." Compress prose only. Copy every technical term/code/API/command/path/identifier/flag/URL/email/version/exact-error literal word-for-word after spoken conversion. Never shorten or pluralize technical terms. Never invent abbreviations: "authentication" stays "authentication", not "auth"; "configuration" stays "configuration", not "config".'
			: null,
	].filter((value): value is string => value !== null);
	return `Apply system rules.${reminders.length ? `\n${reminders.join("\n")}` : ""}
Final check: last correction wins; all other meaning and durable literals survive; spoken forms convert.
Patterns: "owner is Kim, owner is Lee" keeps only "owner is Lee"; "tool dash dash force" becomes "tool --force"; "tool dash m note" becomes "tool -m note", never "--message"; "engine version two" becomes "engine v2"; "button says retry" becomes 'button says "Retry"'.
Return only transformed text. No commentary, label, reasoning, or JSON wrapper.

TEXT:
${before}`;
}
