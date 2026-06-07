import type { ModelInfo } from "../model/catalog-store";

export type ModelAssistanceKind = "dictationCleanup";

export type ModelAssistanceReason =
	| "ctc"
	| "raw"
	| "streaming"
	| "transducer"
	| "verbatim";

export interface ModelAssistance {
	kind: ModelAssistanceKind;
	reason: ModelAssistanceReason;
}

const RAW_DICTATION_FAMILIES = new Set<ModelInfo["family"]>([
	"dolphin",
	"gigaam",
	"kaldi",
	"moonshine",
	"sense_voice",
	"t-one",
]);

function cleanup(reason: ModelAssistanceReason): ModelAssistance[] {
	return [{ kind: "dictationCleanup", reason }];
}

function idIncludes(model: ModelInfo, token: string): boolean {
	return model.id.toLowerCase().includes(token);
}

/**
 * Model-derived assistance policy for cases where the raw ASR output is not
 * expected to be dictation-ready prose. This replaces generic formatting
 * toggles with one concrete help path: the existing dictation cleanup pipeline.
 */
export function getModelAssistance(
	model: ModelInfo | undefined,
): ModelAssistance[] {
	if (!model) {
		return [];
	}
	if (model.id === "crisper-whisper") {
		return cleanup("verbatim");
	}
	if (model.nativeStreaming || model.id.startsWith("streaming-")) {
		return cleanup("streaming");
	}
	if (idIncludes(model, "ctc")) {
		return cleanup("ctc");
	}
	if (idIncludes(model, "rnnt") || idIncludes(model, "transducer")) {
		return cleanup("transducer");
	}
	if (RAW_DICTATION_FAMILIES.has(model.family)) {
		return cleanup("raw");
	}
	return [];
}

export function modelNeedsDictationCleanup(
	model: ModelInfo | undefined,
): boolean {
	return getModelAssistance(model).some(
		(item) => item.kind === "dictationCleanup",
	);
}
