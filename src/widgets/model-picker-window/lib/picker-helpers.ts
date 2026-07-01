import {
	resolveEffectiveQuant,
	STT_PICKER_WIDTH_PX,
} from "@/widgets/model-picker";
import { providerOf } from "@/entities/cloud-stt-provider/model/catalog";
import type { ModelStatesById as StatesById } from "@/entities/model-catalog";
import type { useQuantActions } from "@/features/model-download";
import { IPC } from "@/shared/api/ipc-channels";
import type { FitAssessmentEntry } from "@/shared/api/ipc-client";
import { ipcSend } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { isRecord } from "@/shared/lib/is-record";
export type {
	CatalogModels,
	ModelStatesById as StatesById,
	ModelSystemInfo as SystemInfo,
} from "@/entities/model-catalog";

// Desired footprint reported once to the main process. Main caps the height
// to whichever side of the chip has more room (never spilling over the screen)
// and sends back the exact panel rect; the panel fills that absolutely-positioned
// box (h-full) and scrolls internally if it ends up shorter.
//
// Width comes from the shared `STT_PICKER_WIDTH_PX` constant so this window
// is sized to exactly the same pixel width the settings popup renders at —
// both surfaces always look identical.
export const DESIRED_WIDTH = STT_PICKER_WIDTH_PX;
export const DESIRED_HEIGHT = 560;
const OPENROUTER_PICKER_WIDTH = 580;
const OLLAMA_PICKER_WIDTH = 620;
const LLM_PICKER_HEIGHT = 620;
export const PANEL_HEIGHT = "h-full";
// Keep in sync with `MODEL_PICKER_CLOSE_MS` in `src-tauri/.../windows.rs` and
// `--dropdown-close-dur` in `src/app/styles/globals.css`.
export const MODEL_PICKER_CLOSE_MS = 150;

export function isPrimaryInlineModelList(element: HTMLElement): boolean {
	return (
		element.getAttribute("role") === "listbox" &&
		element.closest('[data-slot="model-picker-inline"]') !== null
	);
}

// Window-local rect (CSS px) for the visible panel inside the full-screen
// backdrop window. Null until the main process reports it.
export type PanelOrigin =
	| "bottom-left"
	| "bottom-right"
	| "top-left"
	| "top-right";

export interface PanelRect {
	height: number;
	mode?: DetachedModelPickerMode;
	origin?: PanelOrigin;
	width: number;
	x: number;
	y: number;
}

export type PanelPhase = "hidden" | "open" | "closing";

export type DetachedLlmFeature = "dictation" | "transforms";

export type DetachedModelPickerMode =
	| { kind: "stt" }
	/** Realtime-preview STT slot (writes `settings.realtimeModel`). */
	| { kind: "stt-realtime" }
	/** Cloud STT picker, forced regardless of the persisted model's source —
	 *  opened from the Settings Local/Cloud toggle when "Cloud" is selected. */
	| { kind: "stt-cloud" }
	/** Read-aloud (TTS) voice-model picker. */
	| { kind: "tts" }
	| { feature: DetachedLlmFeature; kind: "llm-ollama" }
	| {
			feature: DetachedLlmFeature;
			kind: "llm-openrouter";
			target: "fallback" | "primary";
	  };

export const DEFAULT_MODEL_PICKER_MODE: DetachedModelPickerMode = {
	kind: "stt",
};

function normalizeFeature(value: unknown): DetachedLlmFeature {
	return value === "transforms" ? "transforms" : "dictation";
}

export function normalizeDetachedModelPickerMode(
	value: unknown,
): DetachedModelPickerMode {
	if (!isRecord(value)) {
		return DEFAULT_MODEL_PICKER_MODE;
	}
	if (value["kind"] === "llm-ollama") {
		return {
			kind: "llm-ollama",
			feature: normalizeFeature(value["feature"]),
		};
	}
	if (value["kind"] === "llm-openrouter") {
		return {
			kind: "llm-openrouter",
			feature: normalizeFeature(value["feature"]),
			target: value["target"] === "fallback" ? "fallback" : "primary",
		};
	}
	if (value["kind"] === "stt-realtime") {
		return { kind: "stt-realtime" };
	}
	if (value["kind"] === "stt-cloud") {
		return { kind: "stt-cloud" };
	}
	if (value["kind"] === "tts") {
		return { kind: "tts" };
	}
	return DEFAULT_MODEL_PICKER_MODE;
}

export function desiredSizeForMode(mode: DetachedModelPickerMode): {
	height: number;
	width: number;
} {
	switch (mode.kind) {
		case "llm-ollama":
			return { width: OLLAMA_PICKER_WIDTH, height: LLM_PICKER_HEIGHT };
		case "llm-openrouter":
			return { width: OPENROUTER_PICKER_WIDTH, height: LLM_PICKER_HEIGHT };
		// STT main / realtime / cloud and TTS all share the STT picker footprint —
		// the renderer-reported width is the FLOOR; Rust widens the panel to the
		// trigger combobox's measured width when it is wider (see place_model_picker).
		case "stt":
		case "stt-realtime":
		case "stt-cloud":
		case "tts":
			return { width: DESIRED_WIDTH, height: DESIRED_HEIGHT };
	}
}

export function close(): void {
	ipcSend(IPC.MODEL_PICKER_CLOSE);
}

export type QuantActions = ReturnType<typeof useQuantActions>;
export type GetFitAssessment = (modelId: string) => FitAssessmentEntry | null;

export function localModelIdOrNull(modelId: string | undefined): string | null {
	if (!modelId || providerOf(modelId) !== null) {
		return null;
	}
	return modelId;
}

export function quantForFit(
	statesById: StatesById,
	modelId: string | null,
	currentQuantization: OnnxQuantization,
): string {
	return modelId
		? resolveEffectiveQuant(statesById[modelId], currentQuantization)
		: "";
}

export function requestedDeviceForFit(
	deviceValue: "auto" | "cpu",
): string | null {
	return deviceValue === "cpu" ? "cpu" : null;
}
