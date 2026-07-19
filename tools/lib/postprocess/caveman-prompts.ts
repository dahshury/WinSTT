import {
	buildSystemPrompt,
	type PresetEntry,
} from "../../../src/shared/lib/preset-prompts";
import { buildUserPromptForPresets, operationSummary } from "./prompts";

// Backward-compatible experiment exports. Caveman-v2 is now production.
export const buildCavemanSystemPrompt = buildSystemPrompt;
export const buildCavemanUserPrompt = buildUserPromptForPresets;

export function cavemanOperationSummary(
	presets: readonly PresetEntry[],
): readonly string[] {
	const regular: PresetEntry[] = [];
	const translations: PresetEntry[] = [];
	const cavemanFinalPasses: PresetEntry[] = [];

	for (const entry of presets) {
		if (!("id" in entry) && entry.key === "translate") {
			translations.push(entry);
		} else if (
			!("id" in entry) &&
			entry.key === "concise" &&
			entry.level === "caveman"
		) {
			cavemanFinalPasses.push(entry);
		} else {
			regular.push(entry);
		}
	}

	const summaries: string[] = [];
	for (const entry of regular.concat(translations, cavemanFinalPasses)) {
		const summary = operationSummary(entry);
		if (summary !== null) summaries.push(summary);
	}
	return summaries;
}
