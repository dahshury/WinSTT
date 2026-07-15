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
	const caveman = presets.filter(
		(entry) =>
			!("id" in entry) && entry.key === "concise" && entry.level === "caveman",
	);
	const rest = presets.filter(
		(entry) =>
			"id" in entry || (entry.key !== "translate" && !caveman.includes(entry)),
	);
	const translate = presets.filter(
		(entry) => !("id" in entry) && entry.key === "translate",
	);
	return [...rest, ...translate, ...caveman]
		.map(operationSummary)
		.filter((value): value is string => value !== null);
}
