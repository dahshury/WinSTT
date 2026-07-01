import { IPC } from "./ipc-channels";
import { ipcSend } from "./ipc-client";

export type ModelPickerKind =
	| "llm-ollama"
	| "llm-openrouter"
	| "stt"
	| "stt-cloud"
	| "stt-realtime"
	| "tts";

interface OpenModelPickerOptions {
	pickerFeature?: "dictation" | "transforms";
	pickerKind?: ModelPickerKind;
	pickerTarget?: "fallback" | "primary";
}

export function openModelPickerAtRect(
	rect: Pick<DOMRect, "height" | "width" | "x" | "y">,
	options: OpenModelPickerOptions = {},
): void {
	const payload: {
		height: number;
		pickerFeature?: "dictation" | "transforms";
		pickerKind?: ModelPickerKind;
		pickerTarget?: "fallback" | "primary";
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
	ipcSend(IPC.MODEL_PICKER_OPEN, payload);
}

export function closeModelPicker(): void {
	ipcSend(IPC.MODEL_PICKER_CLOSE);
}
