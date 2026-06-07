import { create } from "zustand";
import { reconstructFromDiff } from "@/shared/lib/transcript-diff";
import type { PresetKey } from "@/shared/lib/preset-prompts";

/** Which view the preview pill is showing. `edit` = the editable transcript +
 *  toolbar (entry / AI-off state); `enhance` = the split layout (top transcript
 *  or diff, bottom AI controls). The old separate `review` view is folded into
 *  `enhance` — the LLM result is reviewed inline as a diff. */
export type PreviewView = "edit" | "enhance";

/** Re-process source: the RAW transcript (`original`) or the CURRENT committed
 *  text (which, after an applied enhance, is the already-processed text). */
export type EnhanceSource = "original" | "current";

/** Whether enhance runs over the whole text or only the current selection. */
export type EnhanceScope = "whole" | "selection";

export interface PreviewState {
	/** Whether the editable preview pill is open (gates the overlay reveal). */
	isActive: boolean;
	/** Raw transcript — the re-process "Original" source. Immutable while open. */
	original: string;
	/** Committed draft — what Send pastes. Starts as the auto-processed text. */
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

	// ── processing / diff review ──
	isProcessing: boolean;
	processStartedAt: number | null;
	reasoning: string;
	/** Last LLM result, shown as a diff against `diffBase` for accept/deny. */
	candidate: string | null;
	/** The "previous transcript" the candidate is diffed against (the input that
	 *  was sent for this run; the selected substring for selection scope). */
	diffBase: string | null;
	/** Where to splice the applied result back when scope was "selection". */
	candidateRange: { start: number; end: number } | null;
	/** Change ordinals (matching the diff's `changes`) the user reverted. Empty =
	 *  every AI change accepted (the default — "default-accept + cherry-pick"). */
	rejectedChanges: number[];

	// ── actions ──
	open: (payload: {
		original: string;
		text: string;
		presetKeys?: PresetKey[];
		modifierIds?: string[];
	}) => void;
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
	/** Start a run: `base` is the input (the "previous transcript" to diff
	 *  against); `range` is the splice target for selection scope (else null). */
	beginProcessing: (base: string, range: { start: number; end: number } | null) => void;
	appendReasoning: (chunk: string) => void;
	finishProcessing: (candidate: string | null) => void;
	/** Toggle one change between accepted and reverted. */
	toggleChangeDecision: (changeIndex: number) => void;
	/** Commit the CURRENT decisions: splice the applied result into `text` (whole
	 *  or selection range), drop the candidate, and stay in the enhance view so
	 *  the new text becomes the next diff base. */
	applyEnhancement: () => void;
	/** Drop the candidate without changing `text`. */
	discardEnhancement: () => void;
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
	diffBase: null as string | null,
	candidateRange: null as { start: number; end: number } | null,
	rejectedChanges: [] as number[],
};

export const useTranscriptPreviewStore = create<PreviewState>((set, get) => ({
	...INITIAL,

	open: ({ original, text, presetKeys = [], modifierIds = [] }) => {
		// When AI post-processing already ran before the preview opened, `text` is
		// the enhanced output and `original` the raw transcript — open straight
		// into the enhance view with that first edit shown as a diff to review.
		const autoEnhanced = original !== text;
		set({
			...INITIAL,
			isActive: true,
			original,
			text,
			selectedPresetKeys: presetKeys,
			selectedModifierIds: modifierIds,
			view: autoEnhanced ? "enhance" : "edit",
			candidate: autoEnhanced ? text : null,
			diffBase: autoEnhanced ? original : null,
		});
	},

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

	beginProcessing: (base, range) =>
		set({
			isProcessing: true,
			processStartedAt: Date.now(),
			reasoning: "",
			candidate: null,
			diffBase: base,
			candidateRange: range,
			rejectedChanges: [],
		}),

	appendReasoning: (chunk) => {
		if (!chunk) {
			return;
		}
		set((s) => ({ reasoning: s.reasoning + chunk }));
	},

	finishProcessing: (candidate) =>
		set({ isProcessing: false, candidate, view: "enhance" }),

	toggleChangeDecision: (changeIndex) =>
		set((s) => ({
			rejectedChanges: s.rejectedChanges.includes(changeIndex)
				? s.rejectedChanges.filter((i) => i !== changeIndex)
				: [...s.rejectedChanges, changeIndex],
		})),

	applyEnhancement: () => {
		const { candidate, diffBase, candidateRange, rejectedChanges, text } = get();
		if (candidate === null) {
			return;
		}
		// All-accepted commits the EXACT candidate (lossless); a cherry-picked
		// partial reconstructs from the word-level diff (normalizes whitespace —
		// the same granularity the diff UI exposes).
		const applied =
			rejectedChanges.length === 0 || diffBase === null
				? candidate
				: reconstructFromDiff(diffBase, candidate, rejectedChanges);
		const next =
			candidateRange === null
				? applied
				: text.slice(0, candidateRange.start) +
					applied +
					text.slice(candidateRange.end);
		set({
			text: next,
			candidate: null,
			diffBase: null,
			candidateRange: null,
			rejectedChanges: [],
			reasoning: "",
			view: "enhance",
		});
	},

	discardEnhancement: () =>
		set({
			candidate: null,
			diffBase: null,
			candidateRange: null,
			rejectedChanges: [],
			reasoning: "",
			view: "enhance",
		}),
}));
