import { commands } from "@/bindings";

export type ModelPickerKind =
	| "llm-ollama"
	| "llm-openrouter"
	| "output-device"
	| "stt"
	| "stt-cloud"
	| "stt-realtime"
	| "tts";

export type LlmModelPickerFeature = "dictation" | "transforms";
type LlmModelPickerTarget = "enable-on-install" | "fallback" | "primary";

type LlmModelPickerOptions =
	| {
			enableOnInstall?: boolean;
			feature: LlmModelPickerFeature;
			pickerKind: "llm-ollama";
	  }
	| {
			feature: LlmModelPickerFeature;
			pickerKind: "llm-openrouter";
			pickerTarget: LlmModelPickerTarget;
	  };

interface OpenModelPickerOptions {
	pickerFeature?: LlmModelPickerFeature;
	pickerKind?: ModelPickerKind;
	pickerTarget?: LlmModelPickerTarget;
}

export function openModelPickerAtRect(
	rect: Pick<DOMRect, "height" | "width" | "x" | "y">,
	options: OpenModelPickerOptions = {},
): void {
	const payload: {
		height: number;
		pickerFeature?: LlmModelPickerFeature;
		pickerKind?: ModelPickerKind;
		pickerTarget?: LlmModelPickerTarget;
		width: number;
		x: number;
		y: number;
	} = {
		x: rect.x,
		y: rect.y,
		width: rect.width,
		height: rect.height,
	};
	if (options.pickerKind !== undefined) {
		payload.pickerKind = options.pickerKind;
	}
	if (options.pickerFeature !== undefined) {
		payload.pickerFeature = options.pickerFeature;
	}
	if (options.pickerTarget !== undefined) {
		payload.pickerTarget = options.pickerTarget;
	}
	void commands.openWindow(
		"model-picker",
		payload.x,
		payload.y,
		payload.width,
		payload.height,
		payload.pickerKind ?? null,
		payload.pickerFeature ?? null,
		payload.pickerTarget ?? null,
	);
}

/** Open either LLM selector in the shared detached picker window. */
export function openLlmModelPickerAtRect(
	rect: Pick<DOMRect, "height" | "width" | "x" | "y">,
	options: LlmModelPickerOptions,
): void {
	openModelPickerAtRect(rect, {
		pickerKind: options.pickerKind,
		pickerFeature: options.feature,
		...(options.pickerKind === "llm-openrouter"
			? { pickerTarget: options.pickerTarget }
			: options.enableOnInstall
				? { pickerTarget: "enable-on-install" as const }
				: {}),
	});
}

export function closeModelPicker(): void {
	void commands.closeWindow("model-picker");
}
