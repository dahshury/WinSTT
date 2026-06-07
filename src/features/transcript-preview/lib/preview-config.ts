import { confirmPaste, type LlmPreviewConfig } from "@/shared/api/ipc-client";
import {
	type CustomModifier,
	type PresetEntry,
	type PresetKey,
} from "@/shared/lib/preset-prompts";
import type { useSettingsStore } from "@/entities/setting";
import { useTranscriptPreviewStore } from "../model/preview-store";

/** Built-in preset key → `llm` i18n label key (matches the LLM settings panel). */
export const PRESET_LABEL_KEY = {
	neutral: "presetNeutral",
	formal: "presetFormal",
	friendly: "presetFriendly",
	technical: "presetTechnical",
	concise: "presetConcise",
	summarize: "presetSummarize",
	reorder: "presetReorder",
	restructure: "presetRestructure",
	rewordForClarity: "presetRewordForClarity",
	translate: "presetTranslate",
} as const satisfies Record<PresetKey, string>;

export type AppSettings = ReturnType<
	typeof useSettingsStore.getState
>["settings"];
export type LlmSettings = AppSettings["llm"];

export function hasRunnableDictationPreviewLlm(
	llm: LlmSettings | undefined,
): boolean {
	const dictation = llm?.dictation;
	if (!dictation) {
		return false;
	}
	if (dictation.provider === "apple-intelligence") {
		return true;
	}
	if (dictation.provider === "openrouter") {
		return (
			(llm?.openrouterApiKey ?? "").trim().length > 0 &&
			dictation.openrouterModel.trim().length > 0
		);
	}
	return dictation.model.trim().length > 0;
}

function selectedCustomModifierToRuntime(
	modifier: CustomModifier,
): CustomModifier {
	const base: CustomModifier = {
		enabled: modifier.enabled,
		id: modifier.id,
		levelsEnabled: modifier.levelsEnabled,
		name: modifier.name,
		prompt: modifier.prompt,
	};
	return modifier.level === undefined
		? base
		: { ...base, level: modifier.level };
}

/** Send the committed transcript (the real paste) and tear down the preview. */
export function sendPreview(): void {
	const text = useTranscriptPreviewStore.getState().text;
	void confirmPaste(text);
	useTranscriptPreviewStore.getState().reset();
}

export interface EnhanceConfigDraft {
	config: LlmPreviewConfig;
	input: string;
	range: { start: number; end: number } | null;
}

/** Build the dictation-config override + the input/range for the current draft. */
export function buildEnhanceRun(
	dictation: LlmSettings["dictation"] | undefined,
	customModifiers: CustomModifier[],
): EnhanceConfigDraft {
	const s = useTranscriptPreviewStore.getState();
	const sourceText = s.source === "original" ? s.original : s.text;
	let range: { start: number; end: number } | null = null;
	let input = sourceText;
	if (
		s.scope === "selection" &&
		s.source === "current" &&
		s.selEnd > s.selStart
	) {
		range = { start: s.selStart, end: s.selEnd };
		input = s.text.slice(range.start, range.end);
	}
	const presets: PresetEntry[] = s.selectedPresetKeys.map((key) => {
		const existing = dictation?.presets?.find((p) => p.key === key);
		return existing ?? { key };
	});
	const mods: CustomModifier[] = s.selectedModifierIds
		.map((id) => customModifiers.find((m) => m.id === id))
		.filter((m): m is CustomModifier => m !== undefined)
		.map(selectedCustomModifierToRuntime);
	const instruction = s.customInstruction.trim();
	if (instruction) {
		mods.push({
			id: "__preview_custom__",
			enabled: true,
			name: "custom",
			prompt: instruction,
			levelsEnabled: false,
		});
	}
	const config: LlmPreviewConfig = {
		provider: dictation?.provider ?? "ollama",
		model: dictation?.model ?? "",
		openrouterModel: dictation?.openrouterModel ?? "",
		openrouterFallbackModel: dictation?.openrouterFallbackModel ?? "",
		reasoningEffort: dictation?.reasoningEffort ?? "medium",
		verbosity: dictation?.verbosity ?? "medium",
		maxOutputTokens: dictation?.maxOutputTokens ?? null,
		thinkingEffort: dictation?.thinkingEffort ?? "off",
		presets,
		customModifiers: mods,
	};
	return { config, input, range };
}
