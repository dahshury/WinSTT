import { create } from "zustand";
import type { PresetKey } from "@/shared/lib/preset-prompts";

/** Which view the preview pill is showing. `edit` = the editable transcript +
 *  toolbar; `enhance` = the magic-button post-process configurator;
 *  `review` = the LLM result awaiting approve/discard. */
export type PreviewView = "edit" | "enhance" | "review";

/** Re-process source: the RAW transcript (`original`) or the CURRENT editable
 *  text (which, after a first approved enhance, is the already-processed text).
 *  Mirrors the user's "reprocess the original or the first-processed text". */
export type EnhanceSource = "original" | "current";

/** Whether enhance runs over the whole text or only the current selection. */
export type EnhanceScope = "whole" | "selection";

export interface PreviewState {
	/** Whether the editable preview pill is open (gates the overlay reveal). */
	isActive: boolean;
	/** Raw transcript — the re-process "Original" source. Immutable while open. */
	original: string;
	/** Editable draft — what Send pastes. Starts as the auto-processed text. */
	text: string;
	view: PreviewView;

	/** Caret/selection in the editable textarea, tracked for scope="selection". */
	selStart: number;
	selEnd: number;

	// ── enhance configurator draft ──
	source: EnhanceSource;
	scope: EnhanceScope;
	/** Toggled built-in preset keys (e.g. "formal", "concise"). */
	selectedPresetKeys: PresetKey[];
	/** Toggled custom-modifier ids (from `llm.dictation.customModifiers`). */
	selectedModifierIds: string[];
	/** Free-text custom instruction layered on top of any selected modifiers. */
	customInstruction: string;

	// ── processing / review ──
	isProcessing: boolean;
	processStartedAt: number | null;
	reasoning: string;
	/** Last LLM result, shown in the review view. */
	candidate: string | null;
	/** Where to splice the candidate back when scope was "selection". */
	candidateRange: { start: number; end: number } | null;

	// ── actions ──
	open: (payload: { original: string; text: string }) => void;
	reset: () => void;
	setText: (text: string) => void;
	setSelection: (start: number, end: number) => void;
	setView: (view: PreviewView) => void;
	setSource: (source: EnhanceSource) => void;
	setScope: (scope: EnhanceScope) => void;
	setCustomInstruction: (value: string) => void;
	togglePreset: (key: PresetKey) => void;
	toggleModifier: (id: string) => void;
	/** Seed the enhance config from the dictation settings (called when the
	 *  magic button opens the enhance view). */
	seedEnhance: (presetKeys: PresetKey[], modifierIds: string[]) => void;
	beginProcessing: (range: { start: number; end: number } | null) => void;
	appendReasoning: (chunk: string) => void;
	finishProcessing: (candidate: string | null) => void;
	/** Approve the candidate: splice it into `text` (whole or selection range),
	 *  drop the candidate, and return to the edit view. */
	approve: () => void;
	/** Discard the candidate and return to the enhance view unchanged. */
	discard: () => void;
}

const INITIAL = {
	isActive: false,
	original: "",
	text: "",
	view: "edit" as PreviewView,
	selStart: 0,
	selEnd: 0,
	source: "current" as EnhanceSource,
	scope: "whole" as EnhanceScope,
	selectedPresetKeys: [] as PresetKey[],
	selectedModifierIds: [] as string[],
	customInstruction: "",
	isProcessing: false,
	processStartedAt: null as number | null,
	reasoning: "",
	candidate: null as string | null,
	candidateRange: null as { start: number; end: number } | null,
};

export const useTranscriptPreviewStore = create<PreviewState>((set, get) => ({
	...INITIAL,

	open: ({ original, text }) =>
		set({ ...INITIAL, isActive: true, original, text }),

	reset: () => set({ ...INITIAL }),

	setText: (text) => set({ text }),

	setSelection: (start, end) => set({ selStart: start, selEnd: end }),

	setView: (view) => set({ view }),

	setSource: (source) => set({ source }),

	setScope: (scope) => set({ scope }),

	setCustomInstruction: (customInstruction) => set({ customInstruction }),

	togglePreset: (key) =>
		set((s) => ({
			selectedPresetKeys: s.selectedPresetKeys.includes(key)
				? s.selectedPresetKeys.filter((k) => k !== key)
				: [...s.selectedPresetKeys, key],
		})),

	toggleModifier: (id) =>
		set((s) => ({
			selectedModifierIds: s.selectedModifierIds.includes(id)
				? s.selectedModifierIds.filter((m) => m !== id)
				: [...s.selectedModifierIds, id],
		})),

	seedEnhance: (presetKeys, modifierIds) =>
		set({ selectedPresetKeys: presetKeys, selectedModifierIds: modifierIds }),

	beginProcessing: (range) =>
		set({
			isProcessing: true,
			processStartedAt: Date.now(),
			reasoning: "",
			candidate: null,
			candidateRange: range,
		}),

	appendReasoning: (chunk) => {
		if (!chunk) {
			return;
		}
		set((s) => ({ reasoning: s.reasoning + chunk }));
	},

	finishProcessing: (candidate) =>
		set({
			isProcessing: false,
			candidate,
			view: candidate === null ? "enhance" : "review",
		}),

	approve: () => {
		const { candidate, candidateRange, text } = get();
		if (candidate === null) {
			set({ view: "edit" });
			return;
		}
		const next =
			candidateRange === null
				? candidate
				: text.slice(0, candidateRange.start) + candidate + text.slice(candidateRange.end);
		set({
			text: next,
			candidate: null,
			candidateRange: null,
			reasoning: "",
			view: "edit",
		});
	},

	discard: () =>
		set({ candidate: null, candidateRange: null, reasoning: "", view: "enhance" }),
}));
